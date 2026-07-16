import { SparseMatrixCSC } from './sparse.js';

/**
 * Parse a peak name string into { chr, start, end }.
 * Handles "chr-start-end", "chr:start-end", and tab-separated formats.
 * @param {string} name
 * @returns {{ chr: string, start: number, end: number }}
 */
export function parsePeakName(name) {
  // colon-separated: "chr1:10000-20000"
  const mc = name.match(/^([^:]+):(\d+)-(\d+)$/);
  if (mc) return { chr: mc[1], start: parseInt(mc[2]), end: parseInt(mc[3]) };
  // dash-separated: "chr1-10000-20000"
  const m = name.match(/^([^-]+)-(\d+)-(\d+)$/);
  if (m) return { chr: m[1], start: parseInt(m[2]), end: parseInt(m[3]) };
  // fallback: tab-separated
  const parts = name.split('\t');
  if (parts.length >= 3) {
    return { chr: parts[0], start: parseInt(parts[1]), end: parseInt(parts[2]) };
  }
  return { chr: name, start: 0, end: 0 };
}

/**
 * Peak name string: chr-start-end
 */
function peakNameStr(p) {
  return `${p.chr}-${p.start}-${p.end}`;
}

/**
 * Chromosome comparison for sorting.
 */
function compareChr(a, b) {
  const na = chrNum(a), nb = chrNum(b);
  if (na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

function chrNum(chr) {
  const s = chr.replace(/^chr/i, '');
  const n = parseInt(s);
  if (!isNaN(n)) return n;
  if (s === 'X') return 23;
  if (s === 'Y') return 24;
  if (s === 'M' || s === 'MT') return 25;
  return 1000;
}

/**
 * Create unified (non-overlapping) peak set from multiple peak arrays
 * by merging overlapping intervals across all samples.
 *
 * @param {Array<Array<{chr: string, start: number, end: number}>>} peakSets
 * @returns {Array<{chr: string, start: number, end: number}>} sorted, non-overlapping unified peaks
 */
export function createUnifiedPeaks(peakSets) {
  const t0 = Date.now();

  const all = [];
  for (let s = 0; s < peakSets.length; s++) {
    for (const p of peakSets[s]) {
      all.push({ chr: p.chr, start: p.start, end: p.end });
    }
  }
  // Sort by chromosome then start
  all.sort((a, b) => {
    const c = compareChr(a.chr, b.chr);
    return c !== 0 ? c : a.start - b.start;
  });

  // Merge overlapping intervals
  const merged = [];
  let cur = null;
  for (const p of all) {
    if (!cur) {
      cur = { chr: p.chr, start: p.start, end: p.end };
    } else if (p.chr === cur.chr && p.start <= cur.end) {
      cur.end = Math.max(cur.end, p.end);
    } else {
      merged.push(cur);
      cur = { chr: p.chr, start: p.start, end: p.end };
    }
  }
  if (cur) merged.push(cur);

  return merged;
}

/**
 * Map original peaks to unified peaks by genomic overlap.
 *
 * @param {Array<{chr: string, start: number, end: number}>} originalPeaks
 * @param {Array<{chr: string, start: number, end: number}>} unifiedPeaks
 * @returns {Int32Array} mapping[i] = unified peak index for original peak i, or -1
 */
export function mapPeaksToUnified(originalPeaks, unifiedPeaks) {
  const chrRanges = new Map();
  for (let i = 0; i < unifiedPeaks.length; i++) {
    const chr = unifiedPeaks[i].chr;
    if (!chrRanges.has(chr)) {
      chrRanges.set(chr, { start: i, end: i + 1 });
    } else {
      chrRanges.get(chr).end = i + 1;
    }
  }

  const mapping = new Int32Array(originalPeaks.length).fill(-1);
  let mapped = 0;

  for (let i = 0; i < originalPeaks.length; i++) {
    const p = originalPeaks[i];
    const range = chrRanges.get(p.chr);
    if (!range) continue;

    let lo = range.start, hi = range.end - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const u = unifiedPeaks[mid];
      if (u.end <= p.start) {
        lo = mid + 1;
      } else if (u.start >= p.end) {
        hi = mid - 1;
      } else {
        mapping[i] = mid;
        mapped++;
        break;
      }
    }
  }

  return mapping;
}

/**
 * Remap a count matrix from original peak space to unified peak space.
 *
 * @param {SparseMatrixCSC} matrix: original peaks x cells
 * @param {Int32Array} peakMapping: original peak index -> unified peak index
 * @param {number} nUnifiedPeaks
 * @returns {SparseMatrixCSC}: unified peaks x cells
 */
export function remapCountMatrix(matrix, peakMapping, nUnifiedPeaks) {
  const t0 = Date.now();

  const { ncols, colPtr, rowIdx, values } = matrix;
  const denseCol = new Float32Array(nUnifiedPeaks);

  // First pass: count nnz per column
  const colNnz = new Int32Array(ncols);
  for (let j = 0; j < ncols; j++) {
    let nUsed = 0;
    for (let p = colPtr[j]; p < colPtr[j + 1]; p++) {
      const uIdx = peakMapping[rowIdx[p]];
      if (uIdx >= 0) {
        if (denseCol[uIdx] === 0) nUsed++;
        denseCol[uIdx] += values[p];
      }
    }
    colNnz[j] = nUsed;
    for (let p = colPtr[j]; p < colPtr[j + 1]; p++) {
      const uIdx = peakMapping[rowIdx[p]];
      if (uIdx >= 0) denseCol[uIdx] = 0;
    }
  }

  const newColPtr = new Int32Array(ncols + 1);
  for (let j = 0; j < ncols; j++) {
    newColPtr[j + 1] = newColPtr[j] + colNnz[j];
  }
  const totalNnz = newColPtr[ncols];

  const newRowIdx = new Int32Array(totalNnz);
  const newValues = new Float32Array(totalNnz);

  const usedList = [];
  for (let j = 0; j < ncols; j++) {
    usedList.length = 0;
    for (let p = colPtr[j]; p < colPtr[j + 1]; p++) {
      const uIdx = peakMapping[rowIdx[p]];
      if (uIdx >= 0) {
        if (denseCol[uIdx] === 0) usedList.push(uIdx);
        denseCol[uIdx] += values[p];
      }
    }
    usedList.sort((a, b) => a - b);

    let pos = newColPtr[j];
    for (let u = 0; u < usedList.length; u++) {
      const idx = usedList[u];
      newRowIdx[pos] = idx;
      newValues[pos] = denseCol[idx];
      pos++;
      denseCol[idx] = 0;
    }
  }
  return new SparseMatrixCSC(nUnifiedPeaks, ncols, newColPtr, newRowIdx, newValues);
}

/**
 * Horizontally concatenate sparse matrices (same number of rows).
 *
 * @param {Array<SparseMatrixCSC>} matrices
 * @returns {SparseMatrixCSC}
 */
export function hconcatMatrices(matrices) {
  const nrows = matrices[0].nrows;
  let totalCols = 0, totalNnz = 0;
  for (const m of matrices) {
    if (m.nrows !== nrows) {
      throw new Error(`Row count mismatch: expected ${nrows}, got ${m.nrows}`);
    }
    totalCols += m.ncols;
    totalNnz += m.nnz;
  }

  const cp = new Int32Array(totalCols + 1);
  const ri = new Int32Array(totalNnz);
  const vl = new Float32Array(totalNnz);

  let colOffset = 0, nnzOffset = 0;
  for (const m of matrices) {
    for (let j = 0; j < m.ncols; j++) {
      cp[colOffset + j] = m.colPtr[j] + nnzOffset;
    }
    ri.set(m.rowIdx, nnzOffset);
    vl.set(m.values, nnzOffset);
    colOffset += m.ncols;
    nnzOffset += m.nnz;
  }
  cp[totalCols] = totalNnz;

  return new SparseMatrixCSC(nrows, totalCols, cp, ri, vl);
}

/**
 * Convert unified peaks array to peak name strings.
 * @param {Array<{chr: string, start: number, end: number}>} peaks
 * @returns {string[]}
 */
export function peaksToNames(peaks) {
  return peaks.map(peakNameStr);
}
