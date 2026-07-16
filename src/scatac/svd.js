/**
 * Randomized truncated SVD (LSI) for scATAC with WASM acceleration and pure-JS fallback.
 * Uses: WASM SIMD for QR, dense matmul, Gram matrix, and optional sparse-dense multiply;
 * pure JS fallback if WASM fails.
 */

import { EigenvalueDecomposition, Matrix } from 'ml-matrix';
import * as wasmOps from './wasmOps.js';

/**
 * Box-Muller transform for normal samples. Uses optional RNG for reproducibility.
 * @param {() => number} [randomFn]: optional PRNG returning [0,1); defaults to Math.random
 */
function randn(randomFn = Math.random) {
  const u1 = randomFn();
  const u2 = randomFn();
  return Math.sqrt(-2 * Math.log(u1 || 1e-300)) * Math.cos(2 * Math.PI * u2);
}

/* ---------- Pure-JS fallbacks ---------- */

function qrJS(A, m, n) {
  const Q = new Float64Array(A);
  const R = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < j; i++) {
      let dot = 0;
      for (let r = 0; r < m; r++) dot += Q[r * n + i] * Q[r * n + j];
      R[i * n + j] = dot;
      for (let r = 0; r < m; r++) Q[r * n + j] -= dot * Q[r * n + i];
    }
    let norm = 0;
    for (let r = 0; r < m; r++) norm += Q[r * n + j] * Q[r * n + j];
    norm = Math.sqrt(norm);
    R[j * n + j] = norm;
    if (norm > 1e-14) {
      const invNorm = 1 / norm;
      for (let r = 0; r < m; r++) Q[r * n + j] *= invNorm;
    }
  }
  return { Q, R };
}

function denseMatmulJS(A, B, m, p, n) {
  const C = new Float64Array(m * n);
  for (let i = 0; i < m; i++) {
    for (let ki = 0; ki < p; ki++) {
      const aik = A[i * p + ki];
      const bBase = ki * n;
      const cBase = i * n;
      for (let j = 0; j < n; j++) C[cBase + j] += aik * B[bBase + j];
    }
  }
  return C;
}

function gramMatrixJS(C, nRows, l) {
  const CTC = new Float64Array(l * l);
  for (let i = 0; i < nRows; i++) {
    for (let p = 0; p < l; p++) {
      const cp = C[i * l + p];
      for (let q = p; q < l; q++) CTC[p * l + q] += cp * C[i * l + q];
    }
  }
  for (let p = 0; p < l; p++) {
    for (let q = 0; q < p; q++) CTC[p * l + q] = CTC[q * l + p];
  }
  return CTC;
}

/**
 * Randomized truncated SVD for sparse matrices (features x cells).
 * Uses WASM for QR, dense matmul, Gram, and optional sparse-dense multiply; falls back to pure JS.
 *
 * @param {import('./sparse.js').SparseMatrixCSC} tfidf: features x cells sparse matrix
 * @param {number} [nComponents=50]
 * @param {number} [nOversamples=10]
 * @param {number} [nIter=2]
 * @param {boolean} [scaleEmbeddings=true]
 * @param {(msg: string) => void} [statusCallback]
 * @param {() => number} [randomFn]: optional PRNG for reproducible SVD (same dataset → same LSI)
 * @returns {Promise<{ cellEmbeddings: Float64Array, singularValues: Float64Array, sdev: Float64Array, nCells: number, nComponents: number }>}
 */
/**
 * Randomized PCA for scRNA-seq (log-normalized sparse data).
 * Matches bakana/scran.js convention: each gene is centered (subtract mean)
 * but NOT scaled by SD.  The centering is applied implicitly during the
 * randomized SVD so the sparse matrix is never densified.
 *
 * For centered matrix  Â = A: μ·1ᵀ  (genes × cells, μ = row means):
 *   Âᵀ·B  =  Aᵀ·B  −  1·(μᵀ·B)      (transpose multiply)
 *   Â·B   =  A·B   −  μ·(1ᵀ·B)       (forward multiply)
 *
 * @param {import('./sparse.js').SparseMatrixCSC} matrix: features × cells log-normalised sparse matrix
 * @param {number} [nComponents=50]
 * @param {number} [nOversamples=20]
 * @param {number} [nIter=5]
 * @param {boolean} [scaleEmbeddings=true]
 * @param {(msg: string) => void} [statusCallback]
 * @param {() => number} [randomFn]
 * @returns {Promise<{ cellEmbeddings: Float64Array, singularValues: Float64Array, sdev: Float64Array, nCells: number, nComponents: number }>}
 */
export async function runPCA(matrix, nComponents = 50, nOversamples = 20, nIter = 5, scaleEmbeddings = true, statusCallback = null, randomFn = null) {
  const post = (msg) => { if (statusCallback) statusCallback(msg); };
  const rng = randomFn || Math.random;

  const nFeatures = matrix.nrows;
  const nCells = matrix.ncols;
  const l = Math.min(nComponents + nOversamples, Math.min(nFeatures, nCells));
  const k = Math.min(nComponents, l);

  post(`Running PCA (${k} components)...`);

  // Compute row (gene) means from sparse matrix for centering (matching bakana/scran.js)
  const geneMeans = new Float64Array(nFeatures);
  for (let c = 0; c < nCells; c++) {
    const lo = matrix.colPtr[c];
    const hi = matrix.colPtr[c + 1];
    for (let p = lo; p < hi; p++) {
      geneMeans[matrix.rowIdx[p]] += matrix.values[p];
    }
  }
  for (let g = 0; g < nFeatures; g++) geneMeans[g] /= nCells;
  await wasmOps.init();
  const useWasm = wasmOps.isReady();

  let sparseWasm = useWasm;
  let sparseHandle = null;
  if (sparseWasm) {
    try {
      sparseHandle = wasmOps.loadSparse(matrix.colPtr, matrix.rowIdx, matrix.values, nFeatures, nCells);
    } catch (e) {
      console.warn('PCA: WASM loadSparse OOM, sparse multiply will use pure JS:', e.message);
      sparseWasm = false;
      sparseHandle = null;
    }
  }

  const freeHandle = () => {
    if (sparseHandle) {
      try { sparseHandle.free(); } catch (_) {}
      sparseHandle = null;
    }
  };

  // Implicit centering wrappers for Â = A: μ·1ᵀ:
  //   transposeMultiply(B): Âᵀ B = Aᵀ B: 1·(μᵀ · B)
  //   B is nFeatures × l, result is nCells × l
  const transposeMultiply = async (B) => {
    let AtB;
    if (sparseHandle) {
      try {
        AtB = wasmOps.persistentSpmmTranspose(sparseHandle, B, l);
      } catch (e) {
        console.warn('PCA: WASM transposeMultiply OOM, switching to pure JS:', e.message);
        sparseWasm = false;
        freeHandle();
        AtB = matrix.transposeMultiplyDense(B, l);
      }
    } else {
      AtB = matrix.transposeMultiplyDense(B, l);
    }
    // Subtract centering correction: result -= 1 · (μᵀ · B)
    const muB = new Float64Array(l); // μᵀ · B (1 × l)
    for (let g = 0; g < nFeatures; g++) {
      const m = geneMeans[g];
      if (m === 0) continue;
      for (let j = 0; j < l; j++) {
        muB[j] += m * B[g * l + j];
      }
    }
    for (let c = 0; c < nCells; c++) {
      for (let j = 0; j < l; j++) {
        AtB[c * l + j] -= muB[j];
      }
    }
    return AtB;
  };

  //   forwardMultiply(B): Â B = A B: μ·(1ᵀ B)
  //   B is nCells × l, result is nFeatures × l
  const forwardMultiply = async (B) => {
    let AB;
    if (sparseHandle) {
      try {
        AB = wasmOps.persistentSpmm(sparseHandle, B, l);
      } catch (e) {
        console.warn('PCA: WASM forwardMultiply OOM, switching to pure JS:', e.message);
        sparseWasm = false;
        freeHandle();
        AB = matrix.multiplyDense(B, l);
      }
    } else {
      AB = matrix.multiplyDense(B, l);
    }
    // Subtract centering correction: row g of result -= μ[g] · colSums(B)
    const colSums = new Float64Array(l); // 1ᵀ · B  (1 × l)
    for (let c = 0; c < nCells; c++) {
      for (let j = 0; j < l; j++) {
        colSums[j] += B[c * l + j];
      }
    }
    for (let g = 0; g < nFeatures; g++) {
      const m = geneMeans[g];
      if (m === 0) continue;
      for (let j = 0; j < l; j++) {
        AB[g * l + j] -= m * colSums[j];
      }
    }
    return AB;
  };

  const doQR = (A, m, n) => {
    if (useWasm) {
      try { return wasmOps.qr(A, m, n); } catch (e) {
        console.warn('PCA: WASM QR failed, using JS:', e.message);
      }
    }
    return qrJS(A, m, n);
  };

  // Randomized range finder with power iterations
  const Omega = new Float64Array(nFeatures * l);
  for (let i = 0; i < Omega.length; i++) Omega[i] = randn(rng);

  let Y = await transposeMultiply(Omega);

  for (let iter = 0; iter < nIter; iter++) {
    post(`PCA iteration ${iter + 1}/${nIter}...`);
    let { Q: Qy } = doQR(Y, nCells, l);
    Y = Qy;
    let Z = await forwardMultiply(Y);
    let { Q: Qz } = doQR(Z, nFeatures, l);
    Z = Qz;
    Y = await transposeMultiply(Z);
  }

  post('Finalizing PCA...');
  const { Q } = doQR(Y, nCells, l);
  const C = await forwardMultiply(Q);

  freeHandle();
  let CTC;
  if (useWasm) {
    try {
      CTC = wasmOps.gramMatrix(C, nFeatures, l);
    } catch (e) {
      console.warn('PCA: WASM gramMatrix failed, using JS:', e.message);
      CTC = gramMatrixJS(C, nFeatures, l);
    }
  } else {
    CTC = gramMatrixJS(C, nFeatures, l);
  }

  const ctcArray = [];
  for (let i = 0; i < l; i++) {
    const row = [];
    for (let j = 0; j < l; j++) row.push(CTC[i * l + j]);
    ctcArray.push(row);
  }
  const ctcMatrix = new Matrix(ctcArray);
  const evd = new EigenvalueDecomposition(ctcMatrix, { assumeSymmetric: true });
  const eigenvalues = evd.realEigenvalues;
  const V = evd.eigenvectorMatrix;

  const idxArr = Array.from({ length: l }, (_, i) => i);
  idxArr.sort((a, b) => eigenvalues[b] - eigenvalues[a]);

  const singularValues = new Float64Array(k);
  const U_small = new Float64Array(l * k);
  for (let ki = 0; ki < k; ki++) {
    const idx = idxArr[ki];
    singularValues[ki] = Math.sqrt(Math.max(0, eigenvalues[idx]));
    for (let p = 0; p < l; p++) U_small[p * k + ki] = V.get(p, idx);
  }

  post('Computing cell embeddings...');
  const cellEmbeddings = useWasm
    ? wasmOps.denseMatmul(Q, U_small, nCells, l, k)
    : denseMatmulJS(Q, U_small, nCells, l, k);

  if (scaleEmbeddings) {
    for (let ki = 0; ki < k; ki++) {
      let sum = 0;
      for (let i = 0; i < nCells; i++) sum += cellEmbeddings[i * k + ki];
      const mean = sum / nCells;
      let sumSq = 0;
      for (let i = 0; i < nCells; i++) {
        const diff = cellEmbeddings[i * k + ki] - mean;
        sumSq += diff * diff;
      }
      const sd = Math.sqrt(sumSq / (nCells - 1));
      if (sd > 1e-14) {
        for (let i = 0; i < nCells; i++) {
          cellEmbeddings[i * k + ki] = (cellEmbeddings[i * k + ki] - mean) / sd;
        }
      }
    }
  }

  const sdev = new Float64Array(k);
  for (let ki = 0; ki < k; ki++) {
    sdev[ki] = singularValues[ki] / Math.sqrt(Math.max(1, nFeatures - 1));
  }

  return {
    cellEmbeddings,
    singularValues,
    sdev,
    nCells,
    nComponents: k
  };
}

export async function randomizedSVD(tfidf, nComponents = 50, nOversamples = 10, nIter = 2, scaleEmbeddings = true, statusCallback = null, randomFn = null) {
  const post = (msg) => { if (statusCallback) statusCallback(msg); };
  const rng = randomFn || Math.random;

  const nFeatures = tfidf.nrows;
  const nCells = tfidf.ncols;
  const l = Math.min(nComponents + nOversamples, Math.min(nFeatures, nCells));
  const k = Math.min(nComponents, l);

  post(`Running randomized SVD (${k} components)...`);
  await wasmOps.init();
  const useWasm = wasmOps.isReady();
  if (useWasm) post('Using WASM SIMD for QR, matmul, and sparse multiply.');
  else post('Using pure JavaScript (WASM unavailable).');

  // Separate WASM tracking for sparse multiply (large, can OOM) vs dense ops (small, safe).
  // Inspired by kana's pattern: WASM for small dense kernels; JS fallback for large sparse ops.
  let sparseWasm = useWasm; // tracks if WASM sparse multiply is still available
  let sparseHandle = null;
  if (sparseWasm) {
    try {
      sparseHandle = wasmOps.loadSparse(tfidf.colPtr, tfidf.rowIdx, tfidf.values, nFeatures, nCells);
      post(`Sparse matrix loaded into WASM (${(tfidf.nnz * 12 / 1e6).toFixed(0)} MB).`);
    } catch (e) {
      // Matrix too large for WASM heap, use pure-JS sparse multiply; QR/gram stay on WASM.
      console.warn('SVD: WASM loadSparse OOM, sparse multiply will use pure JS:', e.message);
      sparseWasm = false;
      sparseHandle = null;
    }
  }

  const freeHandle = () => {
    if (sparseHandle) {
      try { sparseHandle.free(); } catch (_) {}
      sparseHandle = null;
    }
  };

  const transposeMultiply = (B) => {
    if (sparseHandle) {
      try {
        return wasmOps.persistentSpmmTranspose(sparseHandle, B, l);
      } catch (e) {
        console.warn('SVD: WASM transposeMultiply OOM, switching to pure JS:', e.message);
        sparseWasm = false;
        freeHandle();
      }
    }
    // Pure-JS sparse×dense: works directly on Float32/Float64 values without WASM copy.
    return Promise.resolve(tfidf.transposeMultiplyDense(B, l));
  };

  const forwardMultiply = (B) => {
    if (sparseHandle) {
      try {
        return wasmOps.persistentSpmm(sparseHandle, B, l);
      } catch (e) {
        console.warn('SVD: WASM forwardMultiply OOM, switching to pure JS:', e.message);
        sparseWasm = false;
        freeHandle();
      }
    }
    return Promise.resolve(tfidf.multiplyDense(B, l));
  };

  // QR and gramMatrix operate on small dense matrices (nCells×l and nFeatures×l):
  // they never trigger OOM, so always try WASM for these.
  const doQR = (A, m, n) => {
    if (useWasm) {
      try { return wasmOps.qr(A, m, n); } catch (e) {
        console.warn('SVD: WASM QR failed, using JS:', e.message);
      }
    }
    return qrJS(A, m, n);
  };

  const Omega = new Float64Array(nFeatures * l);
  for (let i = 0; i < Omega.length; i++) Omega[i] = randn(rng);

  post('Computing initial projection...');
  let Y = await transposeMultiply(Omega);

  for (let iter = 0; iter < nIter; iter++) {
    post(`SVD power iteration ${iter + 1}/${nIter}...`);
    let { Q: Qy } = doQR(Y, nCells, l);
    Y = Qy;
    let Z = await forwardMultiply(Y);
    let { Q: Qz } = doQR(Z, nFeatures, l);
    Z = Qz;
    Y = await transposeMultiply(Z);
  }

  post('Final QR and C = A * Q...');
  const { Q } = doQR(Y, nCells, l);
  const C = await forwardMultiply(Q);

  freeHandle();

  post('Computing Gram matrix and eigendecomposition...');
  let CTC;
  if (useWasm) {
    try {
      CTC = wasmOps.gramMatrix(C, nFeatures, l);
    } catch (e) {
      console.warn('SVD: WASM gramMatrix failed, using JS:', e.message);
      CTC = gramMatrixJS(C, nFeatures, l);
    }
  } else {
    CTC = gramMatrixJS(C, nFeatures, l);
  }

  const ctcArray = [];
  for (let i = 0; i < l; i++) {
    const row = [];
    for (let j = 0; j < l; j++) row.push(CTC[i * l + j]);
    ctcArray.push(row);
  }
  const ctcMatrix = new Matrix(ctcArray);
  const evd = new EigenvalueDecomposition(ctcMatrix, { assumeSymmetric: true });
  const eigenvalues = evd.realEigenvalues;
  const V = evd.eigenvectorMatrix;

  const idxArr = Array.from({ length: l }, (_, i) => i);
  idxArr.sort((a, b) => eigenvalues[b] - eigenvalues[a]);

  const singularValues = new Float64Array(k);
  const U_small = new Float64Array(l * k);
  for (let ki = 0; ki < k; ki++) {
    const idx = idxArr[ki];
    singularValues[ki] = Math.sqrt(Math.max(0, eigenvalues[idx]));
    for (let p = 0; p < l; p++) U_small[p * k + ki] = V.get(p, idx);
  }

  post('Computing cell embeddings...');
  const cellEmbeddings = useWasm
    ? wasmOps.denseMatmul(Q, U_small, nCells, l, k)
    : denseMatmulJS(Q, U_small, nCells, l, k);

  if (scaleEmbeddings) {
    for (let ki = 0; ki < k; ki++) {
      let sum = 0;
      for (let i = 0; i < nCells; i++) sum += cellEmbeddings[i * k + ki];
      const mean = sum / nCells;
      let sumSq = 0;
      for (let i = 0; i < nCells; i++) {
        const diff = cellEmbeddings[i * k + ki] - mean;
        sumSq += diff * diff;
      }
      const sd = Math.sqrt(sumSq / (nCells - 1));
      if (sd > 1e-14) {
        for (let i = 0; i < nCells; i++) {
          cellEmbeddings[i * k + ki] = (cellEmbeddings[i * k + ki] - mean) / sd;
        }
      }
    }
  }

  const sdev = new Float64Array(k);
  for (let ki = 0; ki < k; ki++) {
    sdev[ki] = singularValues[ki] / Math.sqrt(Math.max(1, nFeatures - 1));
  }

  return {
    cellEmbeddings,
    singularValues,
    sdev,
    nCells,
    nComponents: k
  };
}
