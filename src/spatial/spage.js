import { Matrix, SVD } from 'ml-matrix';

function zscoreColumns(data, nCells, nGenes) {
  const result = new Float64Array(nCells * nGenes);

  for (let g = 0; g < nGenes; g++) {
    let sum = 0;
    for (let c = 0; c < nCells; c++) sum += data[c * nGenes + g];
    const mean = sum / nCells;

    let variance = 0;
    for (let c = 0; c < nCells; c++) {
      const d = data[c * nGenes + g] - mean;
      variance += d * d;
    }
    const std = Math.sqrt(variance / nCells);
    const invStd = std > 1e-12 ? 1.0 / std : 0.0;

    for (let c = 0; c < nCells; c++) {
      result[c * nGenes + g] = (data[c * nGenes + g] - mean) * invStd;
    }
  }
  return result;
}

function computePCA(data, nCells, nGenes, nComp, maxCells = 10000) {
  let X = data;
  let n = nCells;

  if (nCells > maxCells) {
    const step = nCells / maxCells;
    n = maxCells;
    X = new Float64Array(n * nGenes);
    for (let i = 0; i < n; i++) {
      const src = Math.min(nCells - 1, Math.floor(i * step)) * nGenes;
      X.set(data.subarray(src, src + nGenes), i * nGenes);
    }
  }

  const mean = new Float64Array(nGenes);
  for (let c = 0; c < n; c++) {
    for (let g = 0; g < nGenes; g++) mean[g] += X[c * nGenes + g];
  }
  for (let g = 0; g < nGenes; g++) mean[g] /= n;

  const Xc = new Float64Array(n * nGenes);
  for (let c = 0; c < n; c++) {
    for (let g = 0; g < nGenes; g++) {
      Xc[c * nGenes + g] = X[c * nGenes + g] - mean[g];
    }
  }

  const C = new Float64Array(nGenes * nGenes);
  for (let c = 0; c < n; c++) {
    const base = c * nGenes;
    for (let i = 0; i < nGenes; i++) {
      const xi = Xc[base + i];
      if (xi === 0) continue;
      for (let j = i; j < nGenes; j++) {
        C[i * nGenes + j] += xi * Xc[base + j];
      }
    }
  }
  for (let i = 0; i < nGenes; i++) {
    for (let j = i + 1; j < nGenes; j++) {
      C[j * nGenes + i] = C[i * nGenes + j];
    }
  }

  const rows = [];
  for (let i = 0; i < nGenes; i++) {
    rows.push(Array.from(C.subarray(i * nGenes, (i + 1) * nGenes)));
  }
  const svd = new SVD(new Matrix(rows), { autoTranspose: true });
  const V = svd.V;

  const actualComp = Math.min(nComp, V.columns, nGenes);
  const components = new Float64Array(actualComp * nGenes);
  for (let k = 0; k < actualComp; k++) {
    for (let g = 0; g < nGenes; g++) {
      components[k * nGenes + g] = V.get(g, k);
    }
  }
  return components;
}

function orthRows(matrix, nRows, nCols) {
  const result = new Float64Array(matrix);
  for (let i = 0; i < nRows; i++) {
    for (let j = 0; j < i; j++) {
      let dot = 0;
      for (let k = 0; k < nCols; k++) dot += result[i * nCols + k] * result[j * nCols + k];
      for (let k = 0; k < nCols; k++) result[i * nCols + k] -= dot * result[j * nCols + k];
    }
    let norm = 0;
    for (let k = 0; k < nCols; k++) norm += result[i * nCols + k] * result[i * nCols + k];
    norm = Math.sqrt(norm);
    if (norm > 1e-12) {
      const inv = 1.0 / norm;
      for (let k = 0; k < nCols; k++) result[i * nCols + k] *= inv;
    }
  }
  return result;
}

function normalizeRows(matrix, nRows, nCols) {
  const result = new Float64Array(matrix);
  for (let i = 0; i < nRows; i++) {
    let norm = 0;
    for (let k = 0; k < nCols; k++) norm += result[i * nCols + k] * result[i * nCols + k];
    norm = Math.sqrt(norm);
    if (norm > 1e-12) {
      const inv = 1.0 / norm;
      for (let k = 0; k < nCols; k++) result[i * nCols + k] *= inv;
    }
  }
  return result;
}

function computePrincipalVectors(Ps, Pt, nPV, nCommon) {
  const mRows = [];
  for (let i = 0; i < nPV; i++) {
    const row = new Array(nPV);
    for (let j = 0; j < nPV; j++) {
      let dot = 0;
      for (let k = 0; k < nCommon; k++) dot += Ps[i * nCommon + k] * Pt[j * nCommon + k];
      row[j] = dot;
    }
    mRows.push(row);
  }
  const svd = new SVD(new Matrix(mRows), { autoTranspose: true });
  const U = svd.U;
  const V = svd.V;

  const srcRaw = new Float64Array(nPV * nCommon);
  for (let k = 0; k < nPV; k++) {
    for (let g = 0; g < nCommon; g++) {
      let val = 0;
      for (let i = 0; i < nPV; i++) val += U.get(i, k) * Ps[i * nCommon + g];
      srcRaw[k * nCommon + g] = val;
    }
  }

  const tgtRaw = new Float64Array(nPV * nCommon);
  for (let k = 0; k < nPV; k++) {
    for (let g = 0; g < nCommon; g++) {
      let val = 0;
      for (let i = 0; i < nPV; i++) val += V.get(i, k) * Pt[i * nCommon + g];
      tgtRaw[k * nCommon + g] = val;
    }
  }

  const sourceNorm = normalizeRows(srcRaw, nPV, nCommon);
  const targetNorm = normalizeRows(tgtRaw, nPV, nCommon);

  const cosSimDiag = new Float64Array(nPV);
  for (let k = 0; k < nPV; k++) {
    let dot = 0;
    for (let g = 0; g < nCommon; g++) dot += sourceNorm[k * nCommon + g] * targetNorm[k * nCommon + g];
    cosSimDiag[k] = dot;
  }

  return { sourceNorm, targetNorm, cosSimDiag };
}

function extractColumns(data, nRows, colIndices) {
  const nOut = colIndices.length;
  const result = new Float64Array(nRows * nOut);
  for (let r = 0; r < nRows; r++) {
    const base = r * colIndices.length;
    const srcBase = r * (data.length / nRows);
    for (let j = 0; j < nOut; j++) {
      result[base + j] = data[srcBase + colIndices[j]];
    }
  }
  return result;
}

function matmul(A, m, p, B, n) {
  const C = new Float64Array(m * n);
  for (let i = 0; i < m; i++) {
    const aOff = i * p;
    const cOff = i * n;
    for (let k = 0; k < p; k++) {
      const aik = A[aOff + k];
      if (aik === 0) continue;
      const bOff = k * n;
      for (let j = 0; j < n; j++) C[cOff + j] += aik * B[bOff + j];
    }
  }
  return C;
}

export function runSpaGE({
  spatialMatrix,
  spatialGenes,
  rnaMatrix,
  rnaGenes,
  genesToPredict,
  nPV = 20,
  onProgress = null,
}) {
  const post = (msg) => { if (onProgress) onProgress(msg); };
  const nSpatial = spatialMatrix.length / spatialGenes.length;
  const nRNA     = rnaMatrix.length / rnaGenes.length;
  const nSpatialGenes = spatialGenes.length;
  const nRnaGenes = rnaGenes.length;

  post(`SpaGE: ${nSpatial} spatial cells × ${nSpatialGenes} genes, ${nRNA} RNA cells × ${nRnaGenes} genes`);
  console.log(`[SpaGE] input: ${nSpatial} spatial × ${nSpatialGenes} sp-genes, ${nRNA} RNA × ${nRnaGenes} rna-genes`);
  console.log(`[SpaGE] spatial sample values (cell0, first 5 genes):`, Array.from(spatialMatrix.subarray(0, Math.min(5, nSpatialGenes))));
  console.log(`[SpaGE] RNA sample values (cell0, first 5 genes):`, Array.from(rnaMatrix.subarray(0, Math.min(5, nRnaGenes))));
  console.log(`[SpaGE] genesToPredict:`, genesToPredict);
  console.log(`[SpaGE] spatialGenes[:5]:`, spatialGenes.slice(0, 5));
  console.log(`[SpaGE] rnaGenes[:5]:`, rnaGenes.slice(0, 5));

  const spatialGeneSet = new Map(spatialGenes.map((g, i) => [g.toLowerCase(), i]));
  const rnaGeneSet     = new Map(rnaGenes.map((g, i) => [g.toLowerCase(), i]));

  const commonSpatialIdx = [];
  const commonRnaIdx     = [];
  for (const [norm, rnaIdx] of rnaGeneSet) {
    const spatIdx = spatialGeneSet.get(norm);
    if (spatIdx !== undefined) {
      commonSpatialIdx.push(spatIdx);
      commonRnaIdx.push(rnaIdx);
    }
  }

  const nCommon = commonSpatialIdx.length;
  if (nCommon < 5) {
    throw new Error(
      `SpaGE: only ${nCommon} common genes found between spatial data and scRNA reference. ` +
      'At least 5 are required. Make sure the scRNA reference uses matching gene names.'
    );
  }
  post(`SpaGE: ${nCommon} common genes found`);
  console.log(`[SpaGE] common genes (${nCommon}):`, commonSpatialIdx.length > 0 ? rnaGenes[commonRnaIdx[0]] : 'none');

  const effectiveNPV = Math.min(nPV, nCommon);

  const SpatialCommonRaw = extractColumns(spatialMatrix, nSpatial, commonSpatialIdx);
  const RnaCommonRaw     = extractColumns(rnaMatrix,     nRNA,     commonRnaIdx);

  const predictSet = new Set(genesToPredict.map(g => g.toLowerCase()));
  const predictRnaIdx = [];
  const actualPredictGenes = [];
  for (let i = 0; i < rnaGenes.length; i++) {
    if (predictSet.has(rnaGenes[i].toLowerCase())) {
      predictRnaIdx.push(i);
      actualPredictGenes.push(rnaGenes[i]);
    }
  }
  console.log(`[SpaGE] predictRnaIdx:`, predictRnaIdx, 'actualPredictGenes:', actualPredictGenes);
  if (predictRnaIdx.length === 0) {
    throw new Error(
      `SpaGE: none of the requested genes (${genesToPredict.join(', ')}) ` +
      'were found in the scRNA reference. Please check gene names.'
    );
  }

  const RnaPredict = extractColumns(rnaMatrix, nRNA, predictRnaIdx);

  post('SpaGE: Z-score normalizing...');
  const SpatialCommonZ = zscoreColumns(SpatialCommonRaw, nSpatial, nCommon);
  const RnaCommonZ     = zscoreColumns(RnaCommonRaw,     nRNA,     nCommon);
  console.log(`[SpaGE] SpatialCommonZ sample (cell0, first 3):`, Array.from(SpatialCommonZ.subarray(0, Math.min(3, nCommon))));
  console.log(`[SpaGE] RnaCommonZ sample (cell0, first 3):`, Array.from(RnaCommonZ.subarray(0, Math.min(3, nCommon))));
  let spatZeroCount = 0, rnaZeroCount = 0;
  for (let i = 0; i < Math.min(nSpatial * nCommon, 1000); i++) if (SpatialCommonZ[i] === 0 || !isFinite(SpatialCommonZ[i])) spatZeroCount++;
  for (let i = 0; i < Math.min(nRNA * nCommon, 1000); i++) if (RnaCommonZ[i] === 0 || !isFinite(RnaCommonZ[i])) rnaZeroCount++;
  console.log(`[SpaGE] spatialZ zero/NaN count (first 1000):`, spatZeroCount, '| rnaZ zero/NaN count:', rnaZeroCount);

  post('SpaGE: Computing PCA...');
  const PsRaw = computePCA(RnaCommonZ,     nRNA,     nCommon, effectiveNPV);
  const PtRaw = computePCA(SpatialCommonZ, nSpatial, nCommon, effectiveNPV);
  const nPVActual = Math.min(effectiveNPV, PsRaw.length / nCommon, PtRaw.length / nCommon);

  console.log(`[SpaGE] PsRaw row0[:3]:`, Array.from(PsRaw.subarray(0, Math.min(3, nCommon))));
  console.log(`[SpaGE] PtRaw row0[:3]:`, Array.from(PtRaw.subarray(0, Math.min(3, nCommon))));

  const Ps = orthRows(PsRaw, nPVActual, nCommon);
  const Pt = orthRows(PtRaw, nPVActual, nCommon);

  post('SpaGE: Computing principal vectors...');
  const { sourceNorm, cosSimDiag } = computePrincipalVectors(Ps, Pt, nPVActual, nCommon);

  let effectivePVCount = 0;
  for (let k = 0; k < nPVActual; k++) {
    if (cosSimDiag[k] > 0.3) effectivePVCount++;
  }
  if (effectivePVCount === 0) effectivePVCount = 1;
  console.log(`[SpaGE] cosSimDiag:`, Array.from(cosSimDiag));
  post(`SpaGE: ${effectivePVCount} effective principal vectors (cos sim > 0.3)`);

  const S_source = new Float64Array(nCommon * effectivePVCount);
  for (let k = 0; k < effectivePVCount; k++) {
    for (let g = 0; g < nCommon; g++) {
      S_source[g * effectivePVCount + k] = sourceNorm[k * nCommon + g];
    }
  }

  post('SpaGE: Projecting data...');
  const RnaProj     = matmul(RnaCommonZ,     nRNA,     nCommon, S_source, effectivePVCount);
  const SpatialProj = matmul(SpatialCommonZ, nSpatial, nCommon, S_source, effectivePVCount);

  const RnaProjNorm     = normalizeRows(RnaProj,     nRNA,     effectivePVCount);
  const SpatialProjNorm = normalizeRows(SpatialProj, nSpatial, effectivePVCount);

  const MAX_RNA_FOR_KNN = 5000;
  let knnRnaProj   = RnaProjNorm;
  let knnRnaPredict = RnaPredict;
  let knnNRNA = nRNA;
  if (nRNA > MAX_RNA_FOR_KNN) {
    post(`SpaGE: Subsampling RNA reference to ${MAX_RNA_FOR_KNN} cells for KNN...`);
    knnNRNA = MAX_RNA_FOR_KNN;
    knnRnaProj    = new Float64Array(knnNRNA * effectivePVCount);
    knnRnaPredict = new Float64Array(knnNRNA * predictRnaIdx.length);
    const step = nRNA / knnNRNA;
    for (let i = 0; i < knnNRNA; i++) {
      const src = Math.min(nRNA - 1, Math.floor(i * step));
      knnRnaProj.set(RnaProjNorm.subarray(src * effectivePVCount, (src + 1) * effectivePVCount), i * effectivePVCount);
      knnRnaPredict.set(RnaPredict.subarray(src * predictRnaIdx.length, (src + 1) * predictRnaIdx.length), i * predictRnaIdx.length);
    }
  }

  const nPredict = predictRnaIdx.length;
  const k = Math.min(50, knnNRNA - 1);

  let rnaPredictNonzero = 0;
  for (let i = 0; i < knnRnaPredict.length; i++) if (knnRnaPredict[i] > 0) rnaPredictNonzero++;
  console.log(`[SpaGE] knnRnaPredict nonzero: ${rnaPredictNonzero} / ${knnRnaPredict.length}`,
    'sample:', Array.from(knnRnaPredict.subarray(0, Math.min(10, knnRnaPredict.length))));
  console.log(`[SpaGE] RnaProjNorm cell0:`, Array.from(RnaProjNorm.subarray(0, Math.min(5, effectivePVCount))));
  console.log(`[SpaGE] SpatialProjNorm cell0:`, Array.from(SpatialProjNorm.subarray(0, Math.min(5, effectivePVCount))));

  post(`SpaGE: Running KNN (k=${k}) and imputing ${actualPredictGenes.length} gene(s)...`);

  const imputed = new Float32Array(nSpatial * nPredict);

  const distBuf = new Float64Array(knnNRNA);
  const idxBuf  = new Int32Array(knnNRNA);

  for (let j = 0; j < nSpatial; j++) {
    const spOff = j * effectivePVCount;

    for (let r = 0; r < knnNRNA; r++) {
      const rOff = r * effectivePVCount;
      let dot = 0;
      for (let p = 0; p < effectivePVCount; p++) dot += SpatialProjNorm[spOff + p] * knnRnaProj[rOff + p];
      distBuf[r] = Math.max(0, 1.0 - dot);
      idxBuf[r]  = r;
    }

    for (let ki = 0; ki < k; ki++) {
      let minD = distBuf[ki];
      let minI = ki;
      for (let r = ki + 1; r < knnNRNA; r++) {
        if (distBuf[r] < minD) { minD = distBuf[r]; minI = r; }
      }
      if (minI !== ki) {
        const tmpD = distBuf[ki]; distBuf[ki] = distBuf[minI]; distBuf[minI] = tmpD;
        const tmpI = idxBuf[ki];  idxBuf[ki]  = idxBuf[minI];  idxBuf[minI]  = tmpI;
      }
    }

    let sumDist = 0;
    let nValid  = 0;
    for (let ki = 0; ki < k; ki++) {
      if (distBuf[ki] < 1.0) { sumDist += distBuf[ki]; nValid++; }
    }
    if (j < 3) {
      console.log(`[SpaGE] cell${j}: top-5 dists`, Array.from(distBuf.subarray(0, 5)), 'nValid:', nValid, 'sumDist:', sumDist);
    }

    if (nValid === 0) {
      const w = 1.0 / k;
      for (let ki = 0; ki < k; ki++) {
        const rna = idxBuf[ki];
        const rnaOff = rna * nPredict;
        const outOff = j * nPredict;
        for (let g = 0; g < nPredict; g++) imputed[outOff + g] += w * knnRnaPredict[rnaOff + g];
      }
      continue;
    }

    if (nValid === 1) {
      for (let ki = 0; ki < k; ki++) {
        if (distBuf[ki] >= 1.0) continue;
        const rna = idxBuf[ki];
        const rnaOff = rna * nPredict;
        const outOff = j * nPredict;
        for (let g = 0; g < nPredict; g++) imputed[outOff + g] = knnRnaPredict[rnaOff + g];
        break;
      }
      continue;
    }

    for (let ki = 0; ki < k; ki++) {
      if (distBuf[ki] >= 1.0) continue;
      const w = sumDist < 1e-12
        ? 1.0 / nValid
        : (1.0 - distBuf[ki] / sumDist) / (nValid - 1);
      const rna = idxBuf[ki];
      const rnaOff = rna * nPredict;
      const outOff = j * nPredict;
      for (let g = 0; g < nPredict; g++) imputed[outOff + g] += w * knnRnaPredict[rnaOff + g];
    }
  }

  const result = new Map();
  for (let g = 0; g < nPredict; g++) {
    const expr = new Float32Array(nSpatial);
    for (let j = 0; j < nSpatial; j++) expr[j] = imputed[j * nPredict + g];
    result.set(actualPredictGenes[g], expr);
  }

  post('SpaGE: Imputation complete.');
  return result;
}
