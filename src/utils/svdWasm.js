/**
 * WASM-based SVD for ATAC LSI (optional).
 * Uses LAPACK dgesdd when available (e.g. emlapack); otherwise the worker falls back to randomized SVD.
 * Returns left singular vectors U (nCells x nWanted) for matrix A (nCells x nTopSvd), layout: tfidfValues[p + c*nTop].
 */
let emlapackModule = null;

async function getEmlapack() {
  if (emlapackModule) return emlapackModule;
  try {
    const mod = await import('emlapack');
    const M = mod.default || mod;
    if (M && typeof M.cwrap === 'function' && M.HEAPF64) {
      emlapackModule = M;
      return M;
    }
  } catch (_) {
    /* emlapack not available or not ESM */
  }
  return null;
}

/**
 * Run SVD via WASM (LAPACK dgesdd, jobz='S').
 * @param {Float64Array} tfidfValues: matrix A (cells x peaks), A[c][p] = tfidfValues[p + c*nTop]
 * @param {number} nCells: M
 * @param {number} nTopSvd: N (number of columns used)
 * @param {number} nTop: stride for rows (tfidfValues has nTop columns per cell)
 * @param {number} nWanted: number of left singular vectors to return
 * @returns {Promise<Float64Array|null>} U columns (nCells * nWanted), column-major, or null if WASM not available
 */
export async function svdLeft(tfidfValues, nCells, nTopSvd, nTop, nWanted) {
  const M = await getEmlapack();
  if (!M) return null;
  const m = nCells;
  const n = nTopSvd;
  const minMN = Math.min(m, n);
  if (nWanted > minMN) return null;
  try {
    if (typeof M.cwrap !== 'function') return null;
    const dgesdd = M.cwrap('dgesdd_', null, [
      'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'
    ]);
    if (!dgesdd) return null;
    const pjobz = M._malloc(1);
    const pm = M._malloc(4);
    const pn = M._malloc(4);
    const lda = m;
    const ldu = m;
    const ldvt = minMN;
    const pa = M._malloc(m * n * 8);
    const ps = M._malloc(minMN * 8);
    const pu = M._malloc(m * minMN * 8);
    const pvt = M._malloc(minMN * n * 8);
    const pinfo = M._malloc(4);
    M.setValue(pjobz, 'S'.charCodeAt(0), 'i8');
    M.setValue(pm, m, 'i32');
    M.setValue(pn, n, 'i32');
    const heap = new Float64Array(M.HEAPF64.buffer);
    const aOffset = pa / 8;
    for (let c = 0; c < m; c++) {
      for (let p = 0; p < n; p++) {
        heap[aOffset + c + p * m] = tfidfValues[p + c * nTop];
      }
    }
    const plwork = M._malloc(4);
    M.setValue(plwork, -1, 'i32');
    dgesdd(pjobz, pm, pn, pa, lda, ps, pu, ldu, pvt, ldvt, 0, plwork, 0, pinfo);
    const lworkOpt = Math.max(1, M.getValue(plwork, 'i32'));
    const pwork = M._malloc(lworkOpt * 8);
    const piwork = M._malloc(8 * minMN * 4);
    M.setValue(plwork, lworkOpt, 'i32');
    dgesdd(pjobz, pm, pn, pa, lda, ps, pu, ldu, pvt, ldvt, pwork, plwork, piwork, pinfo);
    const info = M.getValue(pinfo, 'i32');
    M._free(pjobz); M._free(pm); M._free(pn); M._free(pa); M._free(ps); M._free(pu); M._free(pvt); M._free(pwork); M._free(plwork); M._free(piwork); M._free(pinfo);
    if (info !== 0) return null;
    const uOffset = pu / 8;
    const out = new Float64Array(nCells * nWanted);
    for (let j = 0; j < nWanted; j++) {
      for (let c = 0; c < nCells; c++) {
        out[c + j * nCells] = heap[uOffset + c + j * m];
      }
    }
    return out;
  } catch (_) {
    return null;
  }
}
