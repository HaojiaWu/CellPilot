/**
 * CSC (Compressed Sparse Column) Sparse Matrix
 * Matches the dgCMatrix format used by R/Matrix package
 */
export class SparseMatrixCSC {
  /**
   * @param {number} nrows
   * @param {number} ncols
   * @param {Int32Array} colPtr: column pointers, length ncols+1
   * @param {Int32Array} rowIdx: row indices for each non-zero
   * @param {Float64Array} values: non-zero values
   */
  constructor(nrows, ncols, colPtr, rowIdx, values) {
    this.nrows = nrows;
    this.ncols = ncols;
    this.colPtr = colPtr;
    this.rowIdx = rowIdx;
    this.values = values;
    this.nnz = values.length;
  }

  /** Column sums (sum of each column) */
  colSums() {
    const sums = new Float64Array(this.ncols);
    for (let j = 0; j < this.ncols; j++) {
      let s = 0;
      for (let p = this.colPtr[j]; p < this.colPtr[j + 1]; p++) {
        s += this.values[p];
      }
      sums[j] = s;
    }
    return sums;
  }

  /** Row sums (sum of each row) */
  rowSums() {
    const sums = new Float64Array(this.nrows);
    for (let p = 0; p < this.nnz; p++) {
      sums[this.rowIdx[p]] += this.values[p];
    }
    return sums;
  }

  /**
   * Subset rows by sorted index array
   * @param {number[]} rowIndices: sorted array of row indices to keep
   * @returns {SparseMatrixCSC}
   */
  subsetRows(rowIndices) {
    const newNrows = rowIndices.length;
    const rowMap = new Int32Array(this.nrows).fill(-1);
    for (let i = 0; i < rowIndices.length; i++) {
      rowMap[rowIndices[i]] = i;
    }

    let newNnz = 0;
    for (let p = 0; p < this.nnz; p++) {
      if (rowMap[this.rowIdx[p]] >= 0) newNnz++;
    }

    const newColPtr = new Int32Array(this.ncols + 1);
    const newRowIdx = new Int32Array(newNnz);
    const ValType = this.values instanceof Float32Array ? Float32Array : Float64Array;
    const newValues = new ValType(newNnz);

    let pos = 0;
    for (let j = 0; j < this.ncols; j++) {
      newColPtr[j] = pos;
      for (let p = this.colPtr[j]; p < this.colPtr[j + 1]; p++) {
        const newRow = rowMap[this.rowIdx[p]];
        if (newRow >= 0) {
          newRowIdx[pos] = newRow;
          newValues[pos] = this.values[p];
          pos++;
        }
      }
    }
    newColPtr[this.ncols] = pos;

    return new SparseMatrixCSC(newNrows, this.ncols, newColPtr, newRowIdx, newValues);
  }

  /**
   * Subset columns by index array (e.g. to filter cells by QC).
   * @param {number[]} colIndices: array of column indices to keep (order preserved)
   * @returns {SparseMatrixCSC}
   */
  subsetCols(colIndices) {
    const newNcols = colIndices.length;
    let newNnz = 0;
    for (let k = 0; k < newNcols; k++) {
      const j = colIndices[k];
      newNnz += this.colPtr[j + 1] - this.colPtr[j];
    }
    const newColPtr = new Int32Array(newNcols + 1);
    const newRowIdx = new Int32Array(newNnz);
    const ValType = this.values instanceof Float32Array ? Float32Array : Float64Array;
    const newValues = new ValType(newNnz);
    let pos = 0;
    for (let k = 0; k < newNcols; k++) {
      const j = colIndices[k];
      newColPtr[k] = pos;
      for (let p = this.colPtr[j]; p < this.colPtr[j + 1]; p++) {
        newRowIdx[pos] = this.rowIdx[p];
        newValues[pos] = this.values[p];
        pos++;
      }
    }
    newColPtr[newNcols] = pos;
    return new SparseMatrixCSC(this.nrows, newNcols, newColPtr, newRowIdx, newValues);
  }

  /**
   * Compute this^T * B (dense)
   * this is (nrows x ncols), B is (nrows x bCols) dense row-major Float64Array
   * result is (ncols x bCols) dense row-major Float64Array
   */
  transposeMultiplyDense(B, bCols) {
    const result = new Float64Array(this.ncols * bCols);

    for (let j = 0; j < this.ncols; j++) {
      const rBase = j * bCols;
      for (let ptr = this.colPtr[j]; ptr < this.colPtr[j + 1]; ptr++) {
        const i = this.rowIdx[ptr];
        const val = this.values[ptr];
        const bBase = i * bCols;
        for (let p = 0; p < bCols; p++) {
          result[rBase + p] += val * B[bBase + p];
        }
      }
    }
    return result;
  }

  /**
   * Compute this * B (dense)
   * this is (nrows x ncols), B is (ncols x bCols) dense row-major Float64Array
   * result is (nrows x bCols) dense row-major Float64Array
   */
  multiplyDense(B, bCols) {
    const result = new Float64Array(this.nrows * bCols);

    for (let j = 0; j < this.ncols; j++) {
      const bBase = j * bCols;
      for (let ptr = this.colPtr[j]; ptr < this.colPtr[j + 1]; ptr++) {
        const i = this.rowIdx[ptr];
        const val = this.values[ptr];
        const rBase = i * bCols;
        for (let p = 0; p < bCols; p++) {
          result[rBase + p] += val * B[bBase + p];
        }
      }
    }
    return result;
  }
}
