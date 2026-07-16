/**
 * SpaGE: Spatial Gene Enhancement using scRNA-seq
 * JavaScript reimplementation of Abdelaal et al. (2020)
 *
 * Reference: Abdelaal T., Mourragui S., Mahfouz A., Reiders M.J.T. (2020)
 * SpaGE: Spatial Gene Enhancement using scRNA-seq. Nucleic Acids Research.
 *
 * Algorithm:
 *  1. Z-score normalize both datasets by gene (column-wise)
 *  2. Find common genes between spatial and RNA data
 *  3. Independently compute PCA on each dataset (common genes only)
 *  4. Orthogonalize PCA components via Gram-Schmidt
 *  5. Compute principal vectors by SVD of the cross-covariance
 *  6. Filter by cosine similarity > 0.3 to get effective principal vectors
 *  7. Project both datasets onto the source principal vectors
 *  8. Build k-NN (k=50) in projected space using cosine distance
 *  9. Predict each spatial cell's missing genes via weighted neighbor average
 */

import { Matrix, SVD } from 'ml-matrix';

/**
 * Utility: Z-score normalize each column (axis=0 in numpy terms)
 * Input:  data Float32Array, row-major (nCells × nGenes)
 * Output: Float32Array, same shape, each gene (column) has mean=0, std=1
  */
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

/**
 * PCA via covariance matrix eigendecomposition
 *
 * For the gene-alignment step, nGenes (common genes) is typically small
 * (100–500), so (nGenes × nGenes) eigendecomposition is fast regardless of
 * how many cells are present.  We subsample up to maxCells rows before
 * building the covariance matrix to keep memory low on huge datasets.
 *
 * Returns Float64Array of shape (nComp × nGenes), row-major.
 * Each row is a principal component (gene loading vector).
  */
function computePCA(data, nCells, nGenes, nComp, maxCells = 10000) {
  // Optionally subsample rows for covariance estimation
  let X = data;       // Float64Array (nCells × nGenes)
  let n = nCells;

  if (nCells > maxCells) {
    // Random subsample without replacement
    const step = nCells / maxCells;
    n = maxCells;
    X = new Float64Array(n * nGenes);
    for (let i = 0; i < n; i++) {
      const src = Math.min(nCells - 1, Math.floor(i * step)) * nGenes;
      X.set(data.subarray(src, src + nGenes), i * nGenes);
    }
  }

  // Center each gene (column mean)
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

  // Covariance matrix C = Xc.T @ Xc  (nGenes × nGenes)
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
  // Fill lower triangle (symmetric)
  for (let i = 0; i < nGenes; i++) {
    for (let j = i + 1; j < nGenes; j++) {
      C[j * nGenes + i] = C[i * nGenes + j];
    }
  }

  // Use ml-matrix SVD on the covariance matrix to get eigenvectors
  // SVD(C) = U S V^T; for symmetric positive-semi-definite, U == V
  // Eigenvectors are columns of V (= rows of V^T)
  const rows = [];
  for (let i = 0; i < nGenes; i++) {
    rows.push(Array.from(C.subarray(i * nGenes, (i + 1) * nGenes)));
  }
  const svd = new SVD(new Matrix(rows), { autoTranspose: true });
  const V = svd.V; // nGenes × nGenes

  const actualComp = Math.min(nComp, V.columns, nGenes);
  const components = new Float64Array(actualComp * nGenes);
  for (let k = 0; k < actualComp; k++) {
    for (let g = 0; g < nGenes; g++) {
      components[k * nGenes + g] = V.get(g, k);
    }
  }
  return components; // (actualComp × nGenes)
}

/**
 * Gram-Schmidt orthogonalization on rows
 * Equivalent to: scipy.linalg.orth(M.T).T  (makes rows orthonormal)
 * In-place on a copy.
  */
function orthRows(matrix, nRows, nCols) {
  const result = new Float64Array(matrix);
  for (let i = 0; i < nRows; i++) {
    // Subtract projections onto all previous orthonormal rows
    for (let j = 0; j < i; j++) {
      let dot = 0;
      for (let k = 0; k < nCols; k++) dot += result[i * nCols + k] * result[j * nCols + k];
      for (let k = 0; k < nCols; k++) result[i * nCols + k] -= dot * result[j * nCols + k];
    }
    // Normalize
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

/**
 * L2-normalize each row to unit length
  */
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

/**
 * Principal vector computation between source (RNA) and target (spatial) PCA
 *
 * In Python (SpaGE/principal_vectors.py):
 *   u, sigma, v = np.linalg.svd(Ps @ Pt.T)
 *   source_components = normalize(u.T @ Ps)   # (nPV × nCommon)
 *   target_components = normalize(v  @ Pt)     # (nPV × nCommon)
 *
 * numpy.linalg.svd returns v with ROWS = right singular vectors.
 * ml-matrix SVD returns V with COLUMNS = right singular vectors.
 * So numpy v = ml-matrix V.T, and numpy v[k,:] = ml-matrix V[:,k].
  */
function computePrincipalVectors(Ps, Pt, nPV, nCommon) {
  // M = Ps @ Pt.T  (nPV × nPV)
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
  const U = svd.U; // (nPV × nPV)
  const V = svd.V; // (nPV × nPV)

  // source_components[k,g] = sum_i U[i,k] * Ps[i,g]   (U.T @ Ps)
  const srcRaw = new Float64Array(nPV * nCommon);
  for (let k = 0; k < nPV; k++) {
    for (let g = 0; g < nCommon; g++) {
      let val = 0;
      for (let i = 0; i < nPV; i++) val += U.get(i, k) * Ps[i * nCommon + g];
      srcRaw[k * nCommon + g] = val;
    }
  }

  // target_components[k,g] = sum_i V_ml[i,k] * Pt[i,g]   (numpy v @ Pt = V_ml.T @ Pt)
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

  // Cosine similarity on diagonal: sim[k] = sourceNorm[k,:] · targetNorm[k,:]
  const cosSimDiag = new Float64Array(nPV);
  for (let k = 0; k < nPV; k++) {
    let dot = 0;
    for (let g = 0; g < nCommon; g++) dot += sourceNorm[k * nCommon + g] * targetNorm[k * nCommon + g];
    cosSimDiag[k] = dot;
  }

  return { sourceNorm, targetNorm, cosSimDiag };
}

/**
 * Extract a subset of columns from a row-major matrix
 * data: Float32Array or Float64Array (nRows × nTotalCols)
 * colIndices: number[] – which columns to keep
 * Returns Float64Array (nRows × colIndices.length)
  */
function extractColumns(data, nRows, colIndices) {
  const nOut = colIndices.length;
  const result = new Float64Array(nRows * nOut);
  for (let r = 0; r < nRows; r++) {
    const base = r * colIndices.length;
    const srcBase = r * (data.length / nRows); // infer nTotalCols from array length
    for (let j = 0; j < nOut; j++) {
      result[base + j] = data[srcBase + colIndices[j]];
    }
  }
  return result;
}

/**
 * Matrix-multiply A @ B where A is (m × p) and B is (p × n)
 * Both are Float64Arrays, row-major.  Returns Float64Array (m × n).
  */
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

/**
 * runSpaGE – main exported function
 *
 * @param {object} opts
 * @param {Float32Array} opts.spatialMatrix  row-major (nSpatial × nSpatialGenes), log-normalized
 * @param {string[]}     opts.spatialGenes   gene names matching spatialMatrix columns
 * @param {Float32Array} opts.rnaMatrix      row-major (nRNA × nRnaGenes), log-normalized
 * @param {string[]}     opts.rnaGenes       gene names matching rnaMatrix columns
 * @param {string[]}     opts.genesToPredict gene names to impute (must be in rnaGenes)
 * @param {number}       [opts.nPV=20]       number of principal vectors
 * @param {Function}     [opts.onProgress]   optional progress callback(message)
 *
 * @returns {Map<string, Float32Array>}  gene → expression array (nSpatial cells)
  */
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

  // 1. Find common genes:
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

  const effectiveNPV = Math.min(nPV, nCommon);

  // 2. Extract common-gene sub-matrices:
  const SpatialCommonRaw = extractColumns(spatialMatrix, nSpatial, commonSpatialIdx);
  const RnaCommonRaw     = extractColumns(rnaMatrix,     nRNA,     commonRnaIdx);

  // Genes to predict: indices in rnaGenes
  const predictSet = new Set(genesToPredict.map(g => g.toLowerCase()));
  const predictRnaIdx = [];
  const actualPredictGenes = [];
  for (let i = 0; i < rnaGenes.length; i++) {
    if (predictSet.has(rnaGenes[i].toLowerCase())) {
      predictRnaIdx.push(i);
      actualPredictGenes.push(rnaGenes[i]);
    }
  }
  if (predictRnaIdx.length === 0) {
    throw new Error(
      `SpaGE: none of the requested genes (${genesToPredict.join(', ')}) ` +
      'were found in the scRNA reference. Please check gene names.'
    );
  }

  // RNA predict sub-matrix: (nRNA × nPredict)
  const RnaPredict = extractColumns(rnaMatrix, nRNA, predictRnaIdx);

  // 3. Z-score normalize:
  post('SpaGE: Z-score normalizing...');
  const SpatialCommonZ = zscoreColumns(SpatialCommonRaw, nSpatial, nCommon);
  const RnaCommonZ     = zscoreColumns(RnaCommonRaw,     nRNA,     nCommon);
  // Check for NaN/all-zero after zscore
  let spatZeroCount = 0, rnaZeroCount = 0;
  for (let i = 0; i < Math.min(nSpatial * nCommon, 1000); i++) if (SpatialCommonZ[i] === 0 || !isFinite(SpatialCommonZ[i])) spatZeroCount++;
  for (let i = 0; i < Math.min(nRNA * nCommon, 1000); i++) if (RnaCommonZ[i] === 0 || !isFinite(RnaCommonZ[i])) rnaZeroCount++;

  // 4. PCA on each dataset (common genes only):
  post('SpaGE: Computing PCA...');
  const PsRaw = computePCA(RnaCommonZ,     nRNA,     nCommon, effectiveNPV);
  const PtRaw = computePCA(SpatialCommonZ, nSpatial, nCommon, effectiveNPV);
  const nPVActual = Math.min(effectiveNPV, PsRaw.length / nCommon, PtRaw.length / nCommon);


  // 5. Orthogonalize PCA components:
  const Ps = orthRows(PsRaw, nPVActual, nCommon);
  const Pt = orthRows(PtRaw, nPVActual, nCommon);

  // 6. Compute principal vectors:
  post('SpaGE: Computing principal vectors...');
  const { sourceNorm, cosSimDiag } = computePrincipalVectors(Ps, Pt, nPVActual, nCommon);

  // Filter by cosine similarity > 0.3
  let effectivePVCount = 0;
  for (let k = 0; k < nPVActual; k++) {
    if (cosSimDiag[k] > 0.3) effectivePVCount++;
  }
  if (effectivePVCount === 0) effectivePVCount = 1; // keep at least one
  post(`SpaGE: ${effectivePVCount} effective principal vectors (cos sim > 0.3)`);

  // S_source = sourceNorm[:effectivePVCount, :].T  (nCommon × effectivePVCount)
  // Both RNA and Spatial are projected onto SOURCE (RNA) principal vectors.
  // This matches Python SpaGE main.py where both use source_components_.T:
  //   Common_data_projected  = Common_data.dot(S)
  //   Spatial_data_projected = Spatial_data.dot(S)
  const S_source = new Float64Array(nCommon * effectivePVCount);
  for (let k = 0; k < effectivePVCount; k++) {
    for (let g = 0; g < nCommon; g++) {
      S_source[g * effectivePVCount + k] = sourceNorm[k * nCommon + g];
    }
  }

  // 7. Project BOTH datasets onto SOURCE (RNA) principal vectors:
  post('SpaGE: Projecting data...');
  const RnaProj     = matmul(RnaCommonZ,     nRNA,     nCommon, S_source, effectivePVCount);
  const SpatialProj = matmul(SpatialCommonZ, nSpatial, nCommon, S_source, effectivePVCount);

  // 8. Normalize projected vectors for cosine distance:
  const RnaProjNorm     = normalizeRows(RnaProj,     nRNA,     effectivePVCount);
  const SpatialProjNorm = normalizeRows(SpatialProj, nSpatial, effectivePVCount);

  // Subsample RNA for KNN if very large (keep computation tractable)
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

  // Check RnaPredict has nonzero values
  let rnaPredictNonzero = 0;
  for (let i = 0; i < knnRnaPredict.length; i++) if (knnRnaPredict[i] > 0) rnaPredictNonzero++;
  // Sample projected values

  // 9. KNN and weighted average:
  post(`SpaGE: Running KNN (k=${k}) and imputing ${actualPredictGenes.length} gene(s)...`);

  const imputed = new Float32Array(nSpatial * nPredict);

  // Reusable buffers for per-cell KNN
  const distBuf = new Float64Array(knnNRNA);
  const idxBuf  = new Int32Array(knnNRNA);

  for (let j = 0; j < nSpatial; j++) {
    const spOff = j * effectivePVCount;

    // Compute cosine distances to all RNA cells
    for (let r = 0; r < knnNRNA; r++) {
      const rOff = r * effectivePVCount;
      let dot = 0;
      for (let p = 0; p < effectivePVCount; p++) dot += SpatialProjNorm[spOff + p] * knnRnaProj[rOff + p];
      // cosine distance = 1: similarity; clamp to [0, 2]
      distBuf[r] = Math.max(0, 1.0 - dot);
      idxBuf[r]  = r;
    }

    // Partial sort: find top-k by ascending distance (selection sort on k elements)
    for (let ki = 0; ki < k; ki++) {
      let minD = distBuf[ki];
      let minI = ki;
      for (let r = ki + 1; r < knnNRNA; r++) {
        if (distBuf[r] < minD) { minD = distBuf[r]; minI = r; }
      }
      if (minI !== ki) {
        // Swap
        const tmpD = distBuf[ki]; distBuf[ki] = distBuf[minI]; distBuf[minI] = tmpD;
        const tmpI = idxBuf[ki];  idxBuf[ki]  = idxBuf[minI];  idxBuf[minI]  = tmpI;
      }
    }

    // Compute weights from top-k neighbors where distance < 1
    // weights[i] = 1: dist[i] / sum(dist[valid])
    let sumDist = 0;
    let nValid  = 0;
    for (let ki = 0; ki < k; ki++) {
      if (distBuf[ki] < 1.0) { sumDist += distBuf[ki]; nValid++; }
    }
    if (j < 3) {
    }

    if (nValid === 0) {
      // No neighbors within cosine distance 1.0, use uniform weights over all k neighbors
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
      // Single valid neighbor, use it with full weight
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

    // nValid >= 2: weighted average of valid neighbors
    // Weight formula: w_i = (1: dist_i/sumDist) / (nValid-1)
    // When sumDist == 0 (all neighbors at identical distance 0), fall back to uniform
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

  // 10. Pack results into a Map:
  const result = new Map();
  for (let g = 0; g < nPredict; g++) {
    const expr = new Float32Array(nSpatial);
    for (let j = 0; j < nSpatial; j++) expr[j] = imputed[j * nPredict + g];
    result.set(actualPredictGenes[g], expr);
  }

  post('SpaGE: Imputation complete.');
  return result;
}
