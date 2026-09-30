function buildCSRFromCSC(csc) {
  const { nrows, ncols, colPtr, rowIdx, values } = csc;
  const nnz = values.length;

  const rowCounts = new Int32Array(nrows);
  for (let p = 0; p < nnz; p++) {
    rowCounts[rowIdx[p]]++;
  }

  const rowPtr = new Int32Array(nrows + 1);
  for (let i = 0; i < nrows; i++) {
    rowPtr[i + 1] = rowPtr[i] + rowCounts[i];
  }

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

export function createCSCMatrixAdapter(csc) {
  const { nrows, ncols, colPtr, rowIdx, values } = csc;
  let csr = null;

  function ensureCSR() {
    if (csr) return;
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
    column(j) {
      const col = new Float64Array(nrows);
      for (let p = colPtr[j]; p < colPtr[j + 1]; p++) {
        col[rowIdx[p]] = values[p];
      }
      return col;
    },
    getCSC() {
      return csc;
    },
  };
}
