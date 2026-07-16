import { SparseMatrixCSC } from './sparse.js';

/**
 * Parse Matrix Market format from a buffer (same logic as scATAC io.readMTX).
 * Assumes entries are sorted by column (standard 10x Genomics output).
 * @param {Uint8Array|ArrayBuffer} buffer: raw MTX file bytes (uncompressed)
 * @returns {SparseMatrixCSC} peaks x cells
 */
export function parseMTXFromBuffer(buffer) {
  const buf = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  let pos = 0;

  while (pos < buf.length && buf[pos] === 37) {
    while (pos < buf.length && buf[pos] !== 10) pos++;
    pos++;
  }

  let nrows = 0;
  while (pos < buf.length && buf[pos] >= 48 && buf[pos] <= 57) {
    nrows = nrows * 10 + (buf[pos] - 48);
    pos++;
  }
  pos++;

  let ncols = 0;
  while (pos < buf.length && buf[pos] >= 48 && buf[pos] <= 57) {
    ncols = ncols * 10 + (buf[pos] - 48);
    pos++;
  }
  pos++;

  let nnz = 0;
  while (pos < buf.length && buf[pos] >= 48 && buf[pos] <= 57) {
    nnz = nnz * 10 + (buf[pos] - 48);
    pos++;
  }
  if (pos < buf.length && buf[pos] === 13) pos++;
  pos++;

  const colPtr = new Int32Array(ncols + 1);
  const rowIdx = new Int32Array(nnz);
  const values = new Float64Array(nnz);

  let currentCol = -1;

  for (let idx = 0; idx < nnz && pos < buf.length; idx++) {
    let row = 0;
    while (pos < buf.length && buf[pos] >= 48 && buf[pos] <= 57) {
      row = row * 10 + (buf[pos] - 48);
      pos++;
    }
    pos++;

    let col = 0;
    while (pos < buf.length && buf[pos] >= 48 && buf[pos] <= 57) {
      col = col * 10 + (buf[pos] - 48);
      pos++;
    }
    pos++;

    let val = 0;
    while (pos < buf.length && buf[pos] >= 48 && buf[pos] <= 57) {
      val = val * 10 + (buf[pos] - 48);
      pos++;
    }
    if (pos < buf.length && buf[pos] === 13) pos++;
    pos++;

    row--;
    col--;

    while (currentCol < col) {
      currentCol++;
      colPtr[currentCol] = idx;
    }

    rowIdx[idx] = row;
    values[idx] = val;
  }

  while (currentCol < ncols) {
    currentCol++;
    colPtr[currentCol] = nnz;
  }

  return new SparseMatrixCSC(nrows, ncols, colPtr, rowIdx, values);
}
