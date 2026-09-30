import { SparseMatrixCSC } from './sparse.js';

export function logNormalize(countMatrix, scaleFactor = 1e4, statusCallback = null) {
  if (statusCallback) statusCallback('Log-normalizing...');

  const { nrows, ncols, colPtr, rowIdx, values } = countMatrix;
  const nnz = values.length;

  const colSums = countMatrix.colSums();

  const normValues = new Float64Array(nnz);

  for (let j = 0; j < ncols; j++) {
    const s = colSums[j];
    if (s === 0) continue;
    const factor = scaleFactor / s;
    for (let p = colPtr[j]; p < colPtr[j + 1]; p++) {
      normValues[p] = Math.log1p(values[p] * factor);
    }
  }

  return new SparseMatrixCSC(nrows, ncols, colPtr, rowIdx, normValues);
}

export function findHighlyVariableGenes(normMatrix, nTopGenes = 2000, statusCallback = null) {
  if (statusCallback) statusCallback('Selecting highly variable genes...');

  const { nrows, ncols, colPtr, rowIdx, values } = normMatrix;

  const sums   = new Float64Array(nrows);
  const sumSq  = new Float64Array(nrows);
  const counts = new Float64Array(nrows);

  for (let p = 0; p < values.length; p++) {
    const i = rowIdx[p];
    const v = values[p];
    sums[i]   += v;
    sumSq[i]  += v * v;
    counts[i] += 1;
  }

  const dispersion = new Float64Array(nrows);
  for (let i = 0; i < nrows; i++) {
    const mean = sums[i] / ncols;
    const variance = sumSq[i] / ncols - mean * mean;
    dispersion[i] = mean > 1e-12 ? variance / mean : variance;
  }

  const nKeep = Math.min(nTopGenes, nrows);
  const indices = Array.from({ length: nrows }, (_, i) => i);
  indices.sort((a, b) => dispersion[b] - dispersion[a]);

  const topIndices = indices.slice(0, nKeep);
  topIndices.sort((a, b) => a - b);

  if (statusCallback) statusCallback(`Selected ${nKeep} highly variable genes`);
  return topIndices;
}

export function filterCellsByMinGenes(countMatrix, minGenesPerCell = 200, statusCallback = null) {
  if (statusCallback) statusCallback(`Filtering cells (min ${minGenesPerCell} genes)...`);

  const { ncols, colPtr } = countMatrix;
  const keepIndices = [];

  for (let j = 0; j < ncols; j++) {
    const nDetected = colPtr[j + 1] - colPtr[j];
    if (nDetected >= minGenesPerCell) {
      keepIndices.push(j);
    }
  }

  const nRemoved = ncols - keepIndices.length;
  if (statusCallback) statusCallback(`Kept ${keepIndices.length.toLocaleString()} / ${ncols.toLocaleString()} cells (removed ${nRemoved.toLocaleString()})`);
  return { keepIndices, nRemoved };
}
