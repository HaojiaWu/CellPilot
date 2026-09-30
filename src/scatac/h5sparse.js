import { SparseMatrixCSC } from './sparse.js';

let _h5wasmReady = null;

async function getH5Wasm() {
  if (!_h5wasmReady) {
    const h5 = await import('h5wasm');
    await h5.ready;
    _h5wasmReady = h5;
  }
  return _h5wasmReady;
}

function toNumericIndptr(arr) {
  if (arr instanceof Float64Array) return arr;
  if (arr instanceof Int32Array) return new Float64Array(arr);
  if (typeof arr[0] === 'bigint') {
    const out = new Float64Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = Number(arr[i]);
    return out;
  }
  return new Float64Array(arr);
}

function toNumberArray(arr) {
  if (typeof arr[0] === 'bigint') {
    return Array.from(arr, (v) => Number(v));
  }
  return arr;
}

const STREAM_BATCH_CELLS = 10_000;

function detectH5Layout(f) {
  const rootKeys = f.keys();

  if (rootKeys.includes('matrix')) {
    let geneNamesPath = null;
    let geneIdsPath   = null;
    const matKeys = f.get('matrix').keys();
    if (matKeys.includes('features')) {
      const fk = f.get('matrix/features').keys();
      if (fk.includes('name')) geneNamesPath = '/matrix/features/name';
      if (fk.includes('id'))   geneIdsPath   = '/matrix/features/id';
    }
    return {
      data:      '/matrix/data',
      indices:   '/matrix/indices',
      indptr:    '/matrix/indptr',
      shape:     '/matrix/shape',
      barcodes:  '/matrix/barcodes',
      geneNames: geneNamesPath,
      geneIds:   geneIdsPath,
    };
  }

  if (rootKeys.includes('data')) {
    return {
      data:      '/data',
      indices:   '/indices',
      indptr:    '/indptr',
      shape:     '/shape',
      barcodes:  '/barcodes',
      geneNames: rootKeys.includes('gene_names') ? '/gene_names' : null,
      geneIds:   rootKeys.includes('genes')      ? '/genes'      : null,
    };
  }

  for (const key of rootKeys) {
    try {
      const grp = f.get(key);
      if (!grp || typeof grp.keys !== 'function') continue;
      const grpKeys = grp.keys();
      if (grpKeys.includes('data') && grpKeys.includes('indices') && grpKeys.includes('indptr')) {
        const p = `/${key}`;
        return {
          data:      `${p}/data`,
          indices:   `${p}/indices`,
          indptr:    `${p}/indptr`,
          shape:     `${p}/shape`,
          barcodes:  grpKeys.includes('barcodes')   ? `${p}/barcodes`   : null,
          geneNames: grpKeys.includes('gene_names') ? `${p}/gene_names` : null,
          geneIds:   grpKeys.includes('genes')      ? `${p}/genes`      : null,
        };
      }
    } catch (_) {  }
  }

  return {
    data:      '/data',
    indices:   '/indices',
    indptr:    '/indptr',
    shape:     '/shape',
    barcodes:  '/barcodes',
    geneNames: null,
    geneIds:   null,
  };
}

export async function readH5StreamingPipeline(h5Input, statusCallback = null, {
  nTopGenes       = 2000,
  minGenesPerCell = 200,
  scaleFactor     = 1e4,
} = {}) {
  const post = (msg) => { if (statusCallback) statusCallback(msg); };

  post('Initialising HDF5 reader…');
  const h5 = await getH5Wasm();

  let tmpName;
  if (typeof h5Input === 'string') {
    tmpName = h5Input;
    post('Using lazy-mounted HDF5 file…');
  } else {
    tmpName = `/_tmp_${Date.now()}.h5`;
    h5.FS.writeFile(tmpName, h5Input);
  }

  let f;
  try {
    f = new h5.File(tmpName, 'r');
    const layout = detectH5Layout(f);

    const shape  = toNumberArray(f.get(layout.shape).value);
    const nGenes = shape[0];
    const nCells = shape[1];
    post(`Matrix: ${nGenes.toLocaleString()} genes × ${nCells.toLocaleString()} cells`);

    const rawIndptr = f.get(layout.indptr).value;
    const indptr = toNumericIndptr(rawIndptr);
    const totalNnz = indptr[nCells];
    post(`Non-zeros: ${totalNnz.toLocaleString()}`);

    const keepCellFlags = new Uint8Array(nCells);
    let nKept = 0;
    for (let c = 0; c < nCells; c++) {
      if (indptr[c + 1] - indptr[c] >= minGenesPerCell) {
        keepCellFlags[c] = 1;
        nKept++;
      }
    }
    post(`Cells passing QC (≥${minGenesPerCell} genes): ${nKept.toLocaleString()} / ${nCells.toLocaleString()}`);

    const keptCellIndices = new Int32Array(nKept);
    { let ki = 0; for (let c = 0; c < nCells; c++) if (keepCellFlags[c]) keptCellIndices[ki++] = c; }

    post('Pass 1/2: Computing gene statistics…');

    const geneSums   = new Float64Array(nGenes);
    const geneSumSq  = new Float64Array(nGenes);
    const geneNnz    = new Uint32Array(nGenes);
    const cellTotals = new Float64Array(nCells);

    const dataDs   = f.get(layout.data);
    const idxDs    = f.get(layout.indices);
    const nBatches = Math.ceil(nCells / STREAM_BATCH_CELLS);

    for (let b = 0; b < nBatches; b++) {
      const cFrom = b * STREAM_BATCH_CELLS;
      const cTo   = Math.min(cFrom + STREAM_BATCH_CELLS, nCells);
      const pFrom = indptr[cFrom];
      const pTo   = indptr[cTo];
      if (pFrom === pTo) continue;

      const dChunk = dataDs.slice([[pFrom, pTo]]);
      const iChunk = idxDs.slice([[pFrom, pTo]]);

      for (let c = cFrom; c < cTo; c++) {
        const lo = indptr[c]     - pFrom;
        const hi = indptr[c + 1] - pFrom;
        for (let p = lo; p < hi; p++) {
          const gene = Number(iChunk[p]);
          const val  = Number(dChunk[p]);
          cellTotals[c] += val;
          if (keepCellFlags[c]) {
            geneSums[gene]  += val;
            geneSumSq[gene] += val * val;
            geneNnz[gene]++;
          }
        }
      }

      if (b % 5 === 0 || b === nBatches - 1) {
        post(`Pass 1/2: ${Math.min(cTo, nCells).toLocaleString()} / ${nCells.toLocaleString()} cells…`);
      }
    }

    post('Selecting highly variable genes…');
    const dispersion = new Float64Array(nGenes);
    for (let g = 0; g < nGenes; g++) {
      const mean = geneSums[g] / nKept;
      const vari = geneSumSq[g] / nKept - mean * mean;
      dispersion[g] = mean > 1e-12 ? vari / mean : vari;
    }
    const nHVG = Math.min(nTopGenes, nGenes);
    const geneOrder = Array.from({ length: nGenes }, (_, i) => i);
    geneOrder.sort((a, b) => dispersion[b] - dispersion[a]);
    let hvgIndices = geneOrder.slice(0, nHVG).sort((a, b) => a - b);

    const origToHvg = new Int32Array(nGenes).fill(-1);
    for (let i = 0; i < hvgIndices.length; i++) origToHvg[hvgIndices[i]] = i;

    let outputNnz = 0;
    for (const g of hvgIndices) outputNnz += geneNnz[g];

    const MAX_SAFE_NNZ = 300_000_000;
    if (outputNnz > MAX_SAFE_NNZ) {
      const reducedNHVG = Math.max(50, Math.floor(hvgIndices.length * MAX_SAFE_NNZ / outputNnz));
      hvgIndices = geneOrder.slice(0, reducedNHVG).sort((a, b) => a - b);
      origToHvg.fill(-1);
      for (let i = 0; i < hvgIndices.length; i++) origToHvg[hvgIndices[i]] = i;
      outputNnz = 0;
      for (const g of hvgIndices) outputNnz += geneNnz[g];
      post(`HVG reduced to ${hvgIndices.length} (memory cap for ${(nKept / 1e6).toFixed(1)}M cells): ${outputNnz.toLocaleString()} non-zeros`);
    } else {
      post(`HVG: ${hvgIndices.length} genes, ${outputNnz.toLocaleString()} non-zeros`);
    }

    post('Pass 2/2: Building HVG matrix…');

    const outColPtr = new Int32Array(nKept + 1);
    const outRowIdx = new Int32Array(outputNnz);
    const outValues = new Float32Array(outputNnz);

    let outPos  = 0;
    let keptCol = 0;

    for (let b = 0; b < nBatches; b++) {
      const cFrom = b * STREAM_BATCH_CELLS;
      const cTo   = Math.min(cFrom + STREAM_BATCH_CELLS, nCells);
      const pFrom = indptr[cFrom];
      const pTo   = indptr[cTo];

      if (pFrom === pTo) {
        for (let c = cFrom; c < cTo; c++) {
          if (keepCellFlags[c]) { outColPtr[keptCol] = outPos; keptCol++; }
        }
        continue;
      }

      const dChunk = dataDs.slice([[pFrom, pTo]]);
      const iChunk = idxDs.slice([[pFrom, pTo]]);

      for (let c = cFrom; c < cTo; c++) {
        if (!keepCellFlags[c]) continue;
        outColPtr[keptCol] = outPos;

        const lo     = indptr[c]     - pFrom;
        const hi     = indptr[c + 1] - pFrom;
        const factor = cellTotals[c] > 0 ? scaleFactor / cellTotals[c] : 0;

        for (let p = lo; p < hi; p++) {
          const hvgIdx = origToHvg[Number(iChunk[p])];
          if (hvgIdx >= 0) {
            outRowIdx[outPos] = hvgIdx;
            outValues[outPos] = Math.fround(Math.log1p(Number(dChunk[p]) * factor));
            outPos++;
          }
        }
        keptCol++;
      }

      if (b % 5 === 0 || b === nBatches - 1) {
        post(`Pass 2/2: ${Math.min(cTo, nCells).toLocaleString()} / ${nCells.toLocaleString()} cells…`);
      }
    }
    outColPtr[nKept] = outPos;

    const finalRowIdx = outPos === outputNnz ? outRowIdx : outRowIdx.slice(0, outPos);
    const finalValues = outPos === outputNnz ? outValues : outValues.slice(0, outPos);

    const normMatrix = new SparseMatrixCSC(nHVG, nKept, outColPtr, finalRowIdx, finalValues);
    post(`HVG matrix: ${normMatrix.nrows} × ${normMatrix.ncols}, ${normMatrix.nnz.toLocaleString()} nnz`);

    post('Reading metadata…');

    let allGeneNames = null;
    let allGeneIds   = null;
    let cellBarcodes = null;

    try { if (layout.geneNames) allGeneNames = Array.from(f.get(layout.geneNames).value); } catch (_) {  }
    try { if (layout.geneIds)   allGeneIds   = Array.from(f.get(layout.geneIds).value);   } catch (_) {  }
    if (!allGeneNames && allGeneIds)   allGeneNames = allGeneIds;
    if (!allGeneIds   && allGeneNames) allGeneIds   = allGeneNames;
    if (!allGeneNames) allGeneNames = Array.from({ length: nGenes }, (_, i) => `gene_${i}`);
    if (!allGeneIds)   allGeneIds   = allGeneNames;

    try {
      const allBarcodes = Array.from(f.get(layout.barcodes).value);
      cellBarcodes = Array.from(keptCellIndices, (idx) => allBarcodes[idx]);
    } catch (_) {
      cellBarcodes = Array.from({ length: nKept }, (_, i) => `cell_${i}`);
    }

    const hvgGeneNames = hvgIndices.map((i) => allGeneNames[i]);
    const hvgGeneIds   = hvgIndices.map((i) => allGeneIds[i]);

    f.close();
    f = null;

    if (typeof h5Input === 'string') {
      try {
        const fsNode = h5.FS.lookupPath(tmpName, {});
        const lazyArr = fsNode?.node?.contents;
        if (lazyArr && typeof lazyArr === 'object' && lazyArr.chunks) {
          const nChunks = Object.keys(lazyArr.chunks).length;
          lazyArr.chunks = {};
          console.log(`[h5sparse] Cleared ${nChunks} lazy-file chunks from heap`);
        }
      } catch (_) {  }
    }

    post(`Streaming pipeline complete, ${nKept.toLocaleString()} cells, ${nHVG} HVG genes`);

    return {
      normMatrix,
      hvgGeneNames,
      hvgGeneIds,
      allGeneNames,
      allGeneIds,
      cellBarcodes,
      keptCellIndices,
      cellTotals,
      keepCellFlags,
      nOrigCells: nCells,
      nOrigGenes: nGenes,
      hvgIndices,
      origToHvg,
      h5TmpFile: tmpName,
    };
  } catch (err) {
    if (f) try { f.close(); } catch (_) {  }
    if (typeof h5Input !== 'string') {
      try { h5.FS.unlink(tmpName); } catch (_) {  }
    }
    throw err;
  }
}

export async function readSingleGeneFromH5(
  h5TmpFile, geneIndex, keepCellFlags, cellTotals,
  nOrigCells, nKeptCells, scaleFactor = 1e4,
) {
  const h5 = await getH5Wasm();
  const f  = new h5.File(h5TmpFile, 'r');

  try {
    const layout = detectH5Layout(f);

    const rawIndptr = f.get(layout.indptr).value;
    const indptr = toNumericIndptr(rawIndptr);
    const dataDs = f.get(layout.data);
    const idxDs  = f.get(layout.indices);

    const result   = new Float32Array(nKeptCells);
    const nBatches = Math.ceil(nOrigCells / STREAM_BATCH_CELLS);
    let keptIdx = 0;

    for (let b = 0; b < nBatches; b++) {
      const cFrom = b * STREAM_BATCH_CELLS;
      const cTo   = Math.min(cFrom + STREAM_BATCH_CELLS, nOrigCells);
      const pFrom = indptr[cFrom];
      const pTo   = indptr[cTo];

      if (pFrom === pTo) {
        for (let c = cFrom; c < cTo; c++) if (keepCellFlags[c]) keptIdx++;
        continue;
      }

      const dChunk = dataDs.slice([[pFrom, pTo]]);
      const iChunk = idxDs.slice([[pFrom, pTo]]);

      for (let c = cFrom; c < cTo; c++) {
        if (!keepCellFlags[c]) continue;
        const lo     = indptr[c]     - pFrom;
        const hi     = indptr[c + 1] - pFrom;
        const factor = cellTotals[c] > 0 ? scaleFactor / cellTotals[c] : 0;
        for (let p = lo; p < hi; p++) {
          if (Number(iChunk[p]) === geneIndex) {
            result[keptIdx] = Math.fround(Math.log1p(Number(dChunk[p]) * factor));
            break;
          }
        }
        keptIdx++;
      }
    }

    return result;
  } finally {
    try { f.close(); } catch (_) {  }
  }
}

export async function cleanupH5TmpFile(tmpFileName) {
  if (!tmpFileName) return;
  try {
    const h5 = await getH5Wasm();
    h5.FS.unlink(tmpFileName);
  } catch (_) {  }
}
