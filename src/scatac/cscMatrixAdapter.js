/**
 * Build CSR (Compressed Sparse Row) from CSC for O(nnz_in_row) row extraction.
 * CSC row(i) is O(ncols) per call; with many rows this causes severe slowdown for large matrices.
 */
function buildCSRFromCSC(csc) {
  const { nrows, ncols, colPtr, rowIdx, values } = csc;
  const nnz = values.length;

  // Count non-zeros per row
  const rowCounts = new Int32Array(nrows);
  for (let p = 0; p < nnz; p++) {
    rowCounts[rowIdx[p]]++;
  }

  // Build rowPtr
  const rowPtr = new Int32Array(nrows + 1);
  for (let i = 0; i < nrows; i++) {
    rowPtr[i + 1] = rowPtr[i] + rowCounts[i];
  }

  // Fill colIdx and values; use rowCounts as write-offset per row
  const colIdx = new Int32Array(nnz);
  const csrValues = new Float64Array(nnz);
  const rowOffsets = new Int32Array(nrows);

  for (let j = 0; j < ncols; j++) {
    for (let p = colPtr[j]; p < colPtr[j + 1]; p++) {
      const r = rowIdx[p];
      const slot = rowPtr[r] + rowOffsets[r];
      colIdx[slot] = j;
      csrValues[slot] = values[p];
      rowOffsets[r]++;
    }
  }

  return { nrows, ncols, rowPtr, colIdx, values: csrValues };
}

/**
 * Adapter that wraps SparseMatrixCSC and exposes scran-like matrix API
 * (row(i), column(j), numberOfRows(), numberOfColumns()) for downstream code.
 * Lazily builds a CSR view for efficient row extraction when the matrix has many rows.
 */
export function createCSCMatrixAdapter(csc) {
  const { nrows, ncols, colPtr, rowIdx, values } = csc;
  let csr = null;

  /** Lazy-build CSR when first row() is called and matrix is large enough to benefit. */
  function ensureCSR() {
    if (csr) return;
    // Build CSR for matrices with many rows (e.g. ATAC peak matrix: 100k+ peaks)
    if (nrows > 5000 && (nrows * ncols > 1000000 || values.length > 100000)) {
      csr = buildCSRFromCSC(csc);
    }
  }

  return {
    numberOfRows() {
      return nrows;
    },
    numberOfColumns() {
      return ncols;
    },
    /** Return row i as a Float64Array of length ncols (peaks x cells: row = peak). */
    row(i) {
      ensureCSR();
      const row = new Float64Array(ncols);
      if (csr) {
        const { rowPtr, colIdx, values: v } = csr;
        for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) {
          row[colIdx[p]] = v[p];
        }
      } else {
        for (let j = 0; j < ncols; j++) {
          for (let p = colPtr[j]; p < colPtr[j + 1]; p++) {
            if (rowIdx[p] === i) {
              row[j] = values[p];
              break;
            }
          }
        }
      }
      return row;
    },
    /** Return column j as a Float64Array of length nrows. */
    column(j) {
      const col = new Float64Array(nrows);
      for (let p = colPtr[j]; p < colPtr[j + 1]; p++) {
        col[rowIdx[p]] = values[p];
      }
      return col;
    },
    /** Expose underlying CSC for pipeline (e.g. runSingleSamplePipeline). */
    getCSC() {
      return csc;
    },
  };
}
