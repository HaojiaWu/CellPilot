import { SparseMatrixCSC } from './sparse.js';

/**
 * Run TF-IDF normalization (Signac method 1 by default).
 *
 * Method 1 (Stuart & Butler 2019): log1p(TF * IDF * scaleFactor)
 *   TF = count / colSum(cell)
 *   IDF = ncells / rowSum(feature)
 *
 * @param {SparseMatrixCSC} countMatrix: features x cells count matrix
 * @param {number} [method=1]: TF-IDF method (1-4)
 * @param {number} [scaleFactor=1e4]: scale factor
 * @param {(msg: string) => void} [statusCallback]: optional status callback
 * @returns {SparseMatrixCSC}
 */
export function runTFIDF(countMatrix, method = 1, scaleFactor = 1e4, statusCallback = null) {
  if (statusCallback) statusCallback('Running TF-IDF normalization...');
  const t0 = Date.now();

  const { nrows, ncols, colPtr, rowIdx, values } = countMatrix;
  const colS = countMatrix.colSums();
  const rowS = countMatrix.rowSums();

  const newValues = new Float32Array(values.length);

  if (method === 1) {
    for (let j = 0; j < ncols; j++) {
      const cs = colS[j];
      if (cs === 0) continue;
      for (let p = colPtr[j]; p < colPtr[j + 1]; p++) {
        const i = rowIdx[p];
        const rs = rowS[i];
        if (rs === 0) continue;
        const tf = values[p] / cs;
        const idf = ncols / rs;
        newValues[p] = Math.log1p(tf * idf * scaleFactor);
      }
    }
  } else if (method === 2) {
    for (let j = 0; j < ncols; j++) {
      const cs = colS[j];
      if (cs === 0) continue;
      for (let p = colPtr[j]; p < colPtr[j + 1]; p++) {
        const i = rowIdx[p];
        const rs = rowS[i];
        if (rs === 0) continue;
        const tf = values[p] / cs;
        const idf = Math.log(1 + ncols / rs);
        newValues[p] = tf * idf;
      }
    }
  } else if (method === 3) {
    for (let j = 0; j < ncols; j++) {
      const cs = colS[j];
      if (cs === 0) continue;
      for (let p = colPtr[j]; p < colPtr[j + 1]; p++) {
        const i = rowIdx[p];
        const rs = rowS[i];
        if (rs === 0) continue;
        const tf = Math.log1p(values[p] / cs * scaleFactor);
        const idf = Math.log(1 + ncols / rs);
        newValues[p] = tf * idf;
      }
    }
  } else if (method === 4) {
    for (let j = 0; j < ncols; j++) {
      for (let p = colPtr[j]; p < colPtr[j + 1]; p++) {
        const i = rowIdx[p];
        const rs = rowS[i];
        if (rs === 0) continue;
        newValues[p] = ncols / rs;
      }
    }
  }

  for (let p = 0; p < newValues.length; p++) {
    if (isNaN(newValues[p])) newValues[p] = 0;
  }

  if (statusCallback) statusCallback(`TF-IDF completed in ${Date.now() - t0}ms`);
  return new SparseMatrixCSC(nrows, ncols, colPtr, rowIdx, newValues);
}

/**
 * Find top features by count (equivalent to Signac FindTopFeatures).
 * Uses ecdf of row sums, keeps features where percentile > cutoff.
 *
 * @param {SparseMatrixCSC} countMatrix
 * @param {string} [minCutoff='q5']: cutoff percentile (e.g. 'q5' = bottom 5%)
 * @param {(msg: string) => void} [statusCallback]: optional status callback
 * @returns {number[]}: sorted array of feature indices to keep
 */
export function findTopFeatures(countMatrix, minCutoff = 'q5', statusCallback = null) {
  if (statusCallback) statusCallback(`Finding top features (cutoff: ${minCutoff})...`);
  const rowS = countMatrix.rowSums();
  const n = rowS.length;

  const percentileCutoff = parseInt(minCutoff.replace('q', ''), 10) / 100;

  const sorted = Float64Array.from(rowS);
  sorted.sort();

  const indices = [];
  for (let i = 0; i < n; i++) {
    let lo = 0; let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid] <= rowS[i]) lo = mid + 1;
      else hi = mid;
    }
    const percentile = lo / n;
    if (percentile > percentileCutoff) {
      indices.push(i);
    }
  }

  indices.sort((a, b) => a - b);
  if (statusCallback) statusCallback(`Kept ${indices.length} / ${n} features`);
  return indices;
}
