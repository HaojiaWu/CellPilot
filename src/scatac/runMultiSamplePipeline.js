/**
 * Seeded PRNG (Mulberry32) for reproducible multi-sample pipeline (same samples → same UMAP and clustering).
 */
function seededRandom(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fixed seed so the same samples always yield the same UMAP and clustering (match single-sample SCATAC_RANDOM_SEED). */
const ATAC_INTEGRATION_RANDOM_SEED = 42;

/**
 * Multi-sample scATAC-seq integration pipeline.
 *
 * Pipeline: unified peaks → TF-IDF → fast WASM SVD (LSI) → Harmony → UMAP → Louvain
 * Uses a fixed random seed so loading the same samples produces identical UMAP and clusters.
 *
 * @param {Array<{ countMatrix: import('./sparse.js').SparseMatrixCSC, peakNames: string[], barcodes: string[], name: string }>} samples
 * @param {Object} [options]
 * @param {(msg: string) => void} [options.statusCallback]
 * @param {number} [options.resolution]: Louvain resolution; default 0.6 for 2 samples, 0.3 for 3 (single-sample uses 0.8 in runSingleSamplePipeline)
 * @param {number} [options.minDist=0.3]
 * @param {number} [options.numNeighbors=30]
 * @returns {Promise<{
 *   umapEmbedding: number[][],
 *   clusters: number[],
 *   correctedEmbeddings: Float64Array,
 *   mergedMatrix: import('./sparse.js').SparseMatrixCSC,
 *   unifiedPeaks: Array<{chr:string,start:number,end:number}>,
 *   unifiedPeakNames: string[],
 *   allBarcodes: string[],
 *   integrationViews: Record<string, {indices: number[]}>,
 *   datasetNames: string[]
 * }>}
 */
export async function runMultiSamplePipeline(samples, options = {}) {
  const nSamples = samples.length;
  const defaultResolution = nSamples === 2 ? 0.6 : 0.3; // 2 samples → 0.6, 3 samples → 0.3 (1 sample uses runSingleSamplePipeline with 0.8)
  const {
    statusCallback = null,
    resolution = defaultResolution,
    minDist = 0.3,
    numNeighbors = 30,
  } = options;

  const post = (msg) => {
    if (statusCallback) statusCallback(msg);
  };

  const { parsePeakName, createUnifiedPeaks, mapPeaksToUnified, remapCountMatrix, hconcatMatrices, peaksToNames } = await import('./peaks.js');
  const { runTFIDF, findTopFeatures } = await import('./tfidf.js');
  const { randomizedSVD } = await import('./svd.js');
  const { runHarmony } = await import('./harmony.js');
  const { buildKNN, buildSNN, louvain } = await import('./clustering.js');
  const { UMAP } = await import('umap-js');

  // ---- Step 1: Parse peak names ----
  post('Parsing peak names...');
  const allPeakSets = samples.map((s) => s.peakNames.map(parsePeakName));

  // ---- Step 2: Create unified peak set ----
  post('Creating unified peak set...');
  const unifiedPeaks = createUnifiedPeaks(allPeakSets);
  const unifiedPeakNames = peaksToNames(unifiedPeaks);
  const nUnifiedPeaks = unifiedPeaks.length;
  post(`Unified peak set: ${nUnifiedPeaks} peaks`);

  // ---- Step 3: Remap each sample to unified peaks ----
  const remappedMatrices = [];
  const allBarcodes = [];
  const batchLabels = [];

  for (let s = 0; s < samples.length; s++) {
    const sample = samples[s];
    post(`Remapping ${sample.name} (${sample.peakNames.length} peaks → unified)...`);
    const mapping = mapPeaksToUnified(allPeakSets[s], unifiedPeaks);
    const remapped = remapCountMatrix(sample.countMatrix, mapping, nUnifiedPeaks);
    remappedMatrices.push(remapped);

    // Prefix barcodes with sample name to avoid collisions
    const prefixedBarcodes = sample.barcodes.map((bc) => `${sample.name}_${bc}`);
    allBarcodes.push(...prefixedBarcodes);

    for (let i = 0; i < remapped.ncols; i++) {
      batchLabels.push(s);
    }
  }

  // ---- Step 4: Merge matrices ----
  post('Merging matrices...');
  const mergedMatrix = hconcatMatrices(remappedMatrices);
  const nCells = allBarcodes.length;
  post(`Merged: ${nUnifiedPeaks} peaks × ${nCells} cells`);

  // ---- Step 5: Find top features and subset count matrix ----
  // Uses q5 cutoff (same as Signac's default) for all sample counts.
  // When the sparse matrix is too large for the WASM SVD module's heap, svd.js automatically
  // falls back to pure-JS matrix multiply (kana-inspired separation: WASM for small dense
  // kernels only, JS for large sparse×dense when WASM heap is insufficient).
  post('Finding top features...');
  const topFeatureIndices = findTopFeatures(mergedMatrix, 'q5', post);

  // Subset the COUNT matrix first (Int32/Float32 sparse), then run TF-IDF on the smaller matrix.
  // This avoids holding a full Float64/Float32 TF-IDF matrix for 180K+ peaks.
  post('Subsetting count matrix to top features...');
  const countSubset = mergedMatrix.subsetRows(topFeatureIndices);
  post(`Count subset: ${countSubset.nrows} × ${countSubset.ncols}, nnz = ${countSubset.nnz}`);

  // ---- Step 6: TF-IDF normalization on the smaller subset ----
  post('Running TF-IDF normalization...');
  const tfidfSubset = runTFIDF(countSubset, 1, 1e4, post);
  post(`TF-IDF subset: ${tfidfSubset.nrows} × ${tfidfSubset.ncols}`);

  // ---- Step 8: SVD (LSI) ----
  const nSVDComponents = 50;
  post('Running LSI (SVD)...');

  /** Single seeded RNG for SVD, Harmony, UMAP, and clustering so results are reproducible. */
  const random = seededRandom(ATAC_INTEGRATION_RANDOM_SEED);

  const svdResult = await randomizedSVD(tfidfSubset, nSVDComponents, 20, 5, true, post, random);

  // ---- Step 9: Harmony batch correction ----
  // Use LSI dims 2–50 (skip first, depth-correlated)
  post('Running Harmony batch correction...');
  const harmonyDims = svdResult.nComponents - 1; // 49
  const harmonyInput = new Float64Array(nCells * harmonyDims);
  for (let i = 0; i < nCells; i++) {
    for (let d = 0; d < harmonyDims; d++) {
      harmonyInput[i * harmonyDims + d] =
        svdResult.cellEmbeddings[i * svdResult.nComponents + d + 1];
    }
  }

  const batchLabelArr = new Int32Array(batchLabels);
  const correctedEmbeddings = runHarmony(harmonyInput, nCells, harmonyDims, batchLabelArr, {
    theta: 2,
    sigma: 0.1,
    maxIterHarmony: 20,
    maxIterKmeans: 20,
    verbose: true,
    seed: ATAC_INTEGRATION_RANDOM_SEED,
  });

  // ---- Step 10: UMAP on corrected embeddings ----
  post('Running UMAP...');
  const umapInput = [];
  for (let i = 0; i < nCells; i++) {
    const row = [];
    for (let d = 0; d < harmonyDims; d++) {
      row.push(correctedEmbeddings[i * harmonyDims + d]);
    }
    umapInput.push(row);
  }

  function cosineDistance(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? 1 - dot / denom : 1;
  }

  const umap = new UMAP({
    nNeighbors: numNeighbors,
    minDist,
    nComponents: 2,
    distanceFn: cosineDistance,
    random,
  });

  const umapEmbedding = umap.fit(umapInput);

  // ---- Step 11: Clustering on corrected embeddings ----
  post('Building KNN and clustering...');
  const k = 20;
  const knn = buildKNN(correctedEmbeddings, nCells, harmonyDims, k, post, random);
  const snnGraph = buildSNN(knn.indices, nCells, k, 0, post);
  const clusters = louvain(snnGraph, nCells, resolution, post, random);

  const nClusters = new Set(clusters).size;
  post(`Found ${nClusters} clusters`);

  // ---- Step 12: Build integration views (per-sample cell indices) ----
  const integrationViews = {};
  const datasetNames = samples.map((s) => s.name);
  let cellOffset = 0;
  for (let s = 0; s < samples.length; s++) {
    const nSampleCells = samples[s].barcodes.length;
    const indices = [];
    for (let i = 0; i < nSampleCells; i++) {
      indices.push(cellOffset + i);
    }
    integrationViews[samples[s].name] = { indices };
    cellOffset += nSampleCells;
  }

  return {
    umapEmbedding,
    clusters: Array.from(clusters),
    correctedEmbeddings,
    mergedMatrix,
    unifiedPeaks,
    unifiedPeakNames,
    allBarcodes,
    integrationViews,
    datasetNames,
  };
}
