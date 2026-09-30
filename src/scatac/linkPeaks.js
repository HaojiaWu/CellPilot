function cscToCSR(mat) {
  const nnz = mat.values.length;
  const rowPtr = new Int32Array(mat.nrows + 1);

  for (let k = 0; k < nnz; k++) rowPtr[mat.rowIdx[k] + 1]++;
  for (let i = 1; i <= mat.nrows; i++) rowPtr[i] += rowPtr[i - 1];

  const colIdx = new Int32Array(nnz);
  const values = new Float64Array(nnz);
  const pos = rowPtr.slice(0, mat.nrows);

  for (let j = 0; j < mat.ncols; j++) {
    for (let k = mat.colPtr[j]; k < mat.colPtr[j + 1]; k++) {
      const i = mat.rowIdx[k];
      colIdx[pos[i]] = j;
      values[pos[i]] = mat.values[k];
      pos[i]++;
    }
  }

  return { nrows: mat.nrows, ncols: mat.ncols, rowPtr, colIdx, values };
}

function getCSRRowInto(csr, i, out) {
  out.fill(0);
  for (let k = csr.rowPtr[i]; k < csr.rowPtr[i + 1]; k++) {
    out[csr.colIdx[k]] = csr.values[k];
  }
}

function csrRowNNZ(csr, i) {
  return csr.rowPtr[i + 1] - csr.rowPtr[i];
}

function pearsonCorrPrecomp(x, geneMean, geneSumSqDev, geneDevBuf, n) {
  let sx = 0;
  for (let i = 0; i < n; i++) sx += x[i];
  const xMean = sx / n;
  let num = 0, xSS = 0;
  for (let i = 0; i < n; i++) {
    const xd = x[i] - xMean;
    num += xd * geneDevBuf[i];
    xSS += xd * xd;
  }
  const den = Math.sqrt(xSS * geneSumSqDev);
  return den < 1e-12 ? 0 : num / den;
}

function arrayMean(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function arrayStd(arr, mu) {
  if (mu === undefined) mu = arrayMean(arr);
  let v = 0;
  for (let i = 0; i < arr.length; i++) v += (arr[i] - mu) ** 2;
  return Math.sqrt(v / Math.max(arr.length - 1, 1));
}

function zscoreToPvalue(z) {
  const az = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * az);
  const poly = t * (0.319381530 + t * (-0.356563782
    + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * az * az) / 2.506628274631;
  return pdf * poly;
}

export function parsePeakName(name) {
  if (!name || typeof name !== 'string') return null;
  let chr, start, end;
  const colonIdx = name.indexOf(':');
  if (colonIdx > 0) {
    chr = name.slice(0, colonIdx);
    const rest = name.slice(colonIdx + 1);
    const dashIdx = rest.indexOf('-');
    if (dashIdx === -1) return null;
    start = parseInt(rest.slice(0, dashIdx), 10);
    end   = parseInt(rest.slice(dashIdx + 1), 10);
  } else {
    const firstDash = name.indexOf('-');
    if (firstDash === -1) {
      const parts = name.split('_');
      if (parts.length < 3) return null;
      end   = parseInt(parts[parts.length - 1], 10);
      start = parseInt(parts[parts.length - 2], 10);
      chr   = parts.slice(0, parts.length - 2).join('_');
    } else {
      const rest = name.slice(firstDash + 1);
      const secondDash = rest.indexOf('-');
      if (secondDash === -1) return null;
      chr   = name.slice(0, firstDash);
      start = parseInt(rest.slice(0, secondDash), 10);
      end   = parseInt(rest.slice(secondDash + 1), 10);
    }
  }
  if (!chr || isNaN(start) || isNaN(end)) return null;
  return { chr, start, end, mid: (start + end) / 2 };
}

function buildPeakIndex(parsedPeaks) {
  const byChr = {};
  for (let i = 0; i < parsedPeaks.length; i++) {
    const pk = parsedPeaks[i];
    if (!pk) continue;
    if (!byChr[pk.chr]) byChr[pk.chr] = [];
    byChr[pk.chr].push(i);
  }
  const index = {};
  for (const chr of Object.keys(byChr)) {
    const arr = byChr[chr];
    arr.sort((a, b) => parsedPeaks[a].mid - parsedPeaks[b].mid);
    index[chr] = {
      localIndices: new Int32Array(arr),
      mids: new Float64Array(arr.map(i => parsedPeaks[i].mid)),
    };
  }
  return index;
}

function lowerBound(mids, value) {
  let lo = 0, hi = mids.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (mids[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function queryPeakRange(peakIndex, chr, lo, hi) {
  const entry = peakIndex[chr];
  if (!entry) return [];
  const start = lowerBound(entry.mids, lo);
  const result = [];
  for (let i = start; i < entry.mids.length && entry.mids[i] <= hi; i++) {
    result.push(entry.localIndices[i]);
  }
  return result;
}

function buildTransPools(parsedPeaks, filteredPeakIndices) {
  const byChr = new Map();
  const allValid = [];
  for (let i = 0; i < parsedPeaks.length; i++) {
    const pk = parsedPeaks[i];
    if (!pk) continue;
    allValid.push({ globalIdx: filteredPeakIndices[i], chr: pk.chr });
    if (!byChr.has(pk.chr)) byChr.set(pk.chr, true);
  }
  const transPools = {};
  for (const geneChr of byChr.keys()) {
    const pool = [];
    for (const { globalIdx, chr } of allValid) {
      if (chr !== geneChr) pool.push(globalIdx);
    }
    transPools[geneChr] = pool;
  }
  return transPools;
}

function selectBackground(queryPeakGlobalIdx, transPool, peakRowSums, nSample) {
  if (transPool.length <= nSample) return transPool.slice();
  const targetSum = peakRowSums[queryPeakGlobalIdx];

  let candidates;
  if (transPool.length > 5000) {
    const step = transPool.length / 5000;
    const sub = new Array(5000);
    for (let i = 0; i < 5000; i++) sub[i] = transPool[Math.floor(i * step)];
    sub.sort((a, b) => Math.abs(peakRowSums[a] - targetSum) - Math.abs(peakRowSums[b] - targetSum));
    candidates = sub.slice(0, nSample);
  } else {
    const sorted = transPool.slice().sort((a, b) =>
      Math.abs(peakRowSums[a] - targetSum) - Math.abs(peakRowSums[b] - targetSum)
    );
    const K = Math.min(nSample * 3, sorted.length);
    candidates = sorted.slice(0, K);
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    candidates = candidates.slice(0, nSample);
  }
  return candidates;
}

export async function linkPeaks(
  peakMatrix,
  peakNames,
  rnaMatrix,
  geneNames,
  geneTSS,
  {
    distance     = 500_000,
    minCells     = 10,
    scoreCutoff  = 0.05,
    pvalueCutoff = 0.05,
    nSample      = 200,
    onProgress   = null,
  } = {}
) {
  const report = (pct, msg) => onProgress?.(pct, msg);
  const nCells = peakMatrix.ncols;

  report(0, 'Preparing matrices…');

  const atacCSR = cscToCSR(peakMatrix);
  const rnaCSR  = cscToCSR(rnaMatrix);
  const peakRowSums = peakMatrix.rowSums();

  const peakBuf    = new Float64Array(nCells);
  const geneBuf    = new Float64Array(nCells);
  const geneDevBuf = new Float64Array(nCells);
  const bgBuf      = new Float64Array(nCells);

  const filteredPeakIndices = [];
  const filteredPeakNames   = [];
  for (let i = 0; i < peakMatrix.nrows; i++) {
    if (csrRowNNZ(atacCSR, i) >= minCells) {
      filteredPeakIndices.push(i);
      filteredPeakNames.push(peakNames[i]);
    }
  }
  const filteredParsed = filteredPeakNames.map(parsePeakName);

  console.log(`[linkPeaks] Filtered peaks: ${filteredPeakIndices.length}, parsed OK: ${filteredParsed.filter(p => p !== null).length}`);
  if (filteredPeakNames.length > 0) {
    console.log(`[linkPeaks] Sample peaks: ${filteredPeakNames.slice(0, 3).join(', ')}`);
  }

  report(1, 'Building peak spatial index…');
  const peakIndex = buildPeakIndex(filteredParsed);

  const validGenes = [];
  let genesNoTSS = 0, genesLowCells = 0;
  for (let i = 0; i < rnaMatrix.nrows; i++) {
    const name = geneNames[i];
    if (csrRowNNZ(rnaCSR, i) < minCells) { genesLowCells++; continue; }
    if (!geneTSS[name]) { genesNoTSS++; continue; }
    validGenes.push({ geneIdx: i, geneName: name });
  }
  console.log(`[linkPeaks] Genes: ${geneNames.length} total, ${validGenes.length} valid, ${genesNoTSS} no TSS, ${genesLowCells} low cells`);

  report(3, `Testing ${validGenes.length} genes × ${filteredPeakIndices.length} peaks…`);

  report(4, 'Building background peak pools…');
  const transPools = buildTransPools(filteredParsed, filteredPeakIndices);

  const links = [];
  const nGenes = validGenes.length;
  const startTime = Date.now();

  for (let gi = 0; gi < nGenes; gi++) {
    const { geneIdx, geneName } = validGenes[gi];
    const { chr: geneChr, tss } = geneTSS[geneName];

    const candidateLocalIdx = queryPeakRange(peakIndex, geneChr, tss - distance, tss + distance);
    if (candidateLocalIdx.length < 2) continue;

    getCSRRowInto(rnaCSR, geneIdx, geneBuf);
    let geneSum = 0;
    for (let c = 0; c < nCells; c++) geneSum += geneBuf[c];
    const geneMean = geneSum / nCells;
    let geneSumSqDev = 0;
    for (let c = 0; c < nCells; c++) {
      geneDevBuf[c] = geneBuf[c] - geneMean;
      geneSumSqDev += geneDevBuf[c] * geneDevBuf[c];
    }
    if (geneSumSqDev < 1e-12) continue;

    const passedLocalIdx = [];
    const passedCorrs    = [];
    for (const pi of candidateLocalIdx) {
      getCSRRowInto(atacCSR, filteredPeakIndices[pi], peakBuf);
      const r = pearsonCorrPrecomp(peakBuf, geneMean, geneSumSqDev, geneDevBuf, nCells);
      if (Math.abs(r) > scoreCutoff) {
        passedLocalIdx.push(pi);
        passedCorrs.push(r);
      }
    }
    if (passedLocalIdx.length === 0) continue;

    const transPool = transPools[geneChr] || [];
    for (let j = 0; j < passedLocalIdx.length; j++) {
      const pi            = passedLocalIdx[j];
      const globalPeakIdx = filteredPeakIndices[pi];
      const observedR     = passedCorrs[j];

      const bgIndices = selectBackground(globalPeakIdx, transPool, peakRowSums, nSample);
      if (bgIndices.length < 5) continue;

      const bgCorrs = new Float64Array(bgIndices.length);
      for (let b = 0; b < bgIndices.length; b++) {
        getCSRRowInto(atacCSR, bgIndices[b], bgBuf);
        bgCorrs[b] = pearsonCorrPrecomp(bgBuf, geneMean, geneSumSqDev, geneDevBuf, nCells);
      }

      const mu    = arrayMean(bgCorrs);
      const sigma = arrayStd(bgCorrs, mu);
      if (sigma < 1e-10) continue;

      const zscore = (observedR - mu) / sigma;
      const pvalue = zscoreToPvalue(zscore);

      if (pvalue < pvalueCutoff) {
        const pk = filteredParsed[pi];
        links.push({
          gene: geneName, peak: filteredPeakNames[pi],
          score: observedR, zscore, pvalue,
          distance: Math.abs(pk.mid - tss),
          chr: pk.chr, peakStart: pk.start, peakEnd: pk.end, tss,
        });
      }
    }

    if (gi % 200 === 0) {
      const pct = 5 + Math.round((gi / nGenes) * 90);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const eta = gi > 0 ? (((Date.now() - startTime) / gi * (nGenes - gi)) / 1000).toFixed(0) : '?';
      report(pct, `Gene ${gi + 1} / ${nGenes} (${elapsed}s, ~${eta}s left)…`);
      await new Promise(r => setTimeout(r, 0));
    }
  }

  links.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  report(100, `Found ${links.length} significant peak–gene links in ${totalTime}s`);
  console.log(`[linkPeaks] Complete: ${links.length} links in ${totalTime}s`);
  return links;
}

export function indexLinksByGene(links) {
  const idx = new Map();
  for (const link of links) {
    if (!idx.has(link.gene)) idx.set(link.gene, []);
    idx.get(link.gene).push(link);
  }
  return idx;
}

export function getLinksInRegion(links, chr, start, end) {
  return links.filter(l =>
    l.chr === chr && l.peakStart < end && l.peakEnd > start
  );
}
