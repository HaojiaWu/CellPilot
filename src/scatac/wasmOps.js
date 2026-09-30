let _module = null;
let _ready = false;
let _initPromise = null;

function getWasmUrl() {
  const base = typeof process !== 'undefined' && process.env && process.env.PUBLIC_URL != null
    ? process.env.PUBLIC_URL
    : '';
  return `${base || ''}/wasm/svd_core.wasm`;
}

export async function init() {
  if (_ready) return;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const createSvdCore = (await import('./wasm/svd_core.js')).default;
      const wasmUrl = getWasmUrl();
      _module = await createSvdCore({ locateFile: (name) => (name === 'svd_core.wasm' ? wasmUrl : name) });
      _ready = true;
    } catch (err) {
      console.warn('SVD WASM module failed to load, falling back to pure JS:', err.message);
      _module = null;
      _ready = false;
    }
  })();

  return _initPromise;
}

export function isReady() {
  return _ready && _module !== null;
}

function allocF64(arr) {
  const bytes = arr.length * 8;
  const ptr = _module._malloc(bytes);
  _module.HEAPF64.set(arr, ptr >> 3);
  return ptr;
}

function allocI32(arr) {
  const bytes = arr.length * 4;
  const ptr = _module._malloc(bytes);
  _module.HEAP32.set(arr, ptr >> 2);
  return ptr;
}

function allocF64Out(length) {
  const bytes = length * 8;
  const ptr = _module._malloc(bytes);
  _module.HEAPU8.fill(0, ptr, ptr + bytes);
  return ptr;
}

function readF64(ptr, length) {
  return new Float64Array(_module.HEAPF64.buffer, ptr, length).slice();
}

function free(ptr) {
  _module._free(ptr);
}

export function qr(A, m, n) {
  if (!_ready) throw new Error('wasmOps not initialized');
  const pQ = allocF64(A);
  const pR = allocF64Out(n * n);
  _module._qr_mgs(pQ, pR, m, n);
  const Q = readF64(pQ, m * n);
  const R = readF64(pR, n * n);
  free(pQ);
  free(pR);
  return { Q, R };
}

export function denseMatmul(A, B, m, p, n) {
  if (!_ready) throw new Error('wasmOps not initialized');
  const pA = allocF64(A);
  const pB = allocF64(B);
  const pC = allocF64Out(m * n);
  _module._dense_matmul(pA, pB, pC, m, p, n);
  const C = readF64(pC, m * n);
  free(pA);
  free(pB);
  free(pC);
  return C;
}

export function gramMatrix(C, nRows, l) {
  if (!_ready) throw new Error('wasmOps not initialized');
  const pC = allocF64(C);
  const pCTC = allocF64Out(l * l);
  _module._gram_matrix(pC, pCTC, nRows, l);
  const CTC = readF64(pCTC, l * l);
  free(pC);
  free(pCTC);
  return CTC;
}

export function loadSparse(colPtr, rowIdx, values, nrows, ncols) {
  if (!_ready) throw new Error('wasmOps not initialized');
  const pColPtr = allocI32(colPtr);
  const pRowIdx = allocI32(rowIdx);
  const pValues = allocF64(values);
  return {
    pColPtr,
    pRowIdx,
    pValues,
    nrows,
    ncols,
    free() {
      _module._free(this.pColPtr);
      _module._free(this.pRowIdx);
      _module._free(this.pValues);
      this.pColPtr = this.pRowIdx = this.pValues = 0;
    }
  };
}

export function persistentSpmmTranspose(handle, B, bCols) {
  if (!_ready) throw new Error('wasmOps not initialized');
  const pB = allocF64(B);
  const pResult = allocF64Out(handle.ncols * bCols);
  _module._spmm_transpose(
    handle.pColPtr, handle.pRowIdx, handle.pValues,
    handle.nrows, handle.ncols,
    pB, bCols, pResult
  );
  const result = readF64(pResult, handle.ncols * bCols);
  free(pB);
  free(pResult);
  return result;
}

export function persistentSpmm(handle, B, bCols) {
  if (!_ready) throw new Error('wasmOps not initialized');
  const pB = allocF64(B);
  const pResult = allocF64Out(handle.nrows * bCols);
  _module._spmm(
    handle.pColPtr, handle.pRowIdx, handle.pValues,
    handle.nrows, handle.ncols,
    pB, bCols, pResult
  );
  const result = readF64(pResult, handle.nrows * bCols);
  free(pB);
  free(pResult);
  return result;
}
