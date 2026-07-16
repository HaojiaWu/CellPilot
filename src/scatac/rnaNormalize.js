/**
 * rnaNormalize.js – RNA-seq normalization and feature selection for the
 * pure-JavaScript large-dataset pipeline.
 *
 * Replaces the TF-IDF normalization used in the scATAC pipeline with
 * standard scRNA-seq log-normalization (Seurat/Scanpy style):
 *   normalised = log1p( count / totalUMI * scaleFactor )
 *
 * Also provides naïve highly-variable-gene (HVG) selection based on
 * variance-to-mean ratio (similar to Scanpy's "seurat" flavor).
 */

import { SparseMatrixCSC } from './sparse.js';

/**
 * Log-normalize a sparse CSC count matrix (genes × cells).
 *
 * For each cell j:
 *   normalised_ij = log1p( count_ij / sum_j * scaleFactor )
 *
 * Returns a **new** SparseMatrixCSC with Float64Array values.
 * The sparsity pattern is preserved (zeros stay zero).
 *
 * @param {SparseMatrixCSC} countMatrix – genes × cells (raw UMI counts)
 * @param {number} [scaleFactor=1e4]
 * @param {(msg: string) => void} [statusCallback]
 * @returns {SparseMatrixCSC}
 */
export function logNormalize(countMatrix, scaleFactor = 1e4, statusCallback = null) {
  if (statusCallback) statusCallback('Log-normalizing...');

  const { nrows, ncols, colPtr, rowIdx, values } = countMatrix;
  const nnz = values.length;

  // Column sums (total UMI per cell)
  const colSums = countMatrix.colSums();

  const normValues = new Float64Array(nnz);

  for (let j = 0; j < ncols; j++) {
    const s = colSums[j];
    if (s === 0) continue;              // skip empty cells
    const factor = scaleFactor / s;
    for (let p = colPtr[j]; p < colPtr[j + 1]; p++) {
      normValues[p] = Math.log1p(values[p] * factor);
    }
  }

  return new SparseMatrixCSC(nrows, ncols, colPtr, rowIdx, normValues);
}

/**
 * Select highly variable genes (HVG) by variance-to-mean ratio.
 *
 * For each gene, compute mean and variance across cells from the
 * **log-normalized** matrix, then rank by (variance / mean) or by raw
 * variance when mean ≈ 0.  Return the top `nTopGenes` row indices (sorted).
 *
 * This is an in-browser approximation of Scanpy's `highly_variable_genes`
 * with `flavor='seurat'`.
 *
 * @param {SparseMatrixCSC} normMatrix – log-normalised genes × cells
 * @param {number} [nTopGenes=2000]
 * @param {(msg: string) => void} [statusCallback]
 * @returns {number[]} – sorted array of row (gene) indices to keep
 */
export function findHighlyVariableGenes(normMatrix, nTopGenes = 2000, statusCallback = null) {
  if (statusCallback) statusCallback('Selecting highly variable genes...');

  const { nrows, ncols, colPtr, rowIdx, values } = normMatrix;

  // Per-gene running sums
  const sums   = new Float64Array(nrows);
  const sumSq  = new Float64Array(nrows);
  const counts = new Float64Array(nrows);    // number of non-zero entries

  for (let p = 0; p < values.length; p++) {
    const i = rowIdx[p];
    const v = values[p];
    sums[i]   += v;
    sumSq[i]  += v * v;
    counts[i] += 1;
  }

  // Compute mean and variance for each gene
  const dispersion = new Float64Array(nrows);
  for (let i = 0; i < nrows; i++) {
    const mean = sums[i] / ncols;
    // variance = E[X²]: (E[X])²
    const variance = sumSq[i] / ncols - mean * mean;
    // dispersion = variance / mean  (avoid division by zero)
    dispersion[i] = mean > 1e-12 ? variance / mean : variance;
  }

  // Rank genes by dispersion (descending) and take top nTopGenes
  const nKeep = Math.min(nTopGenes, nrows);
  const indices = Array.from({ length: nrows }, (_, i) => i);
  indices.sort((a, b) => dispersion[b] - dispersion[a]);

  const topIndices = indices.slice(0, nKeep);
  topIndices.sort((a, b) => a - b);  // sort for efficient subsetRows

  if (statusCallback) statusCallback(`Selected ${nKeep} highly variable genes`);
  return topIndices;
}

/**
 * Basic QC cell filtering: remove cells with too few detected genes.
 *
 * @param {SparseMatrixCSC} countMatrix – raw genes × cells
 * @param {number} [minGenesPerCell=200]
 * @param {(msg: string) => void} [statusCallback]
 * @returns {{ keepIndices: number[], nRemoved: number }}
 */
export function filterCellsByMinGenes(countMatrix, minGenesPerCell = 200, statusCallback = null) {
  if (statusCallback) statusCallback(`Filtering cells (min ${minGenesPerCell} genes)...`);

  const { ncols, colPtr } = countMatrix;
  const keepIndices = [];

  for (let j = 0; j < ncols; j++) {
    const nDetected = colPtr[j + 1] - colPtr[j];  // nnz in this column = # detected genes
    if (nDetected >= minGenesPerCell) {
      keepIndices.push(j);
    }
  }

  const nRemoved = ncols - keepIndices.length;
  if (statusCallback) statusCallback(`Kept ${keepIndices.length.toLocaleString()} / ${ncols.toLocaleString()} cells (removed ${nRemoved.toLocaleString()})`);
  return { keepIndices, nRemoved };
}
