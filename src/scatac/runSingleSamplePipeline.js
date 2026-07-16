/**
 * Seeded PRNG (Mulberry32) for reproducible scATAC pipeline (same dataset → same UMAP and clustering).
 * @param {number} seed: integer seed
 * @returns {() => number}: function returning [0, 1)
 */
function seededRandom(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fixed seed so the same dataset always yields the same UMAP and clustering. */
const SCATAC_RANDOM_SEED = 42;

/**
 * Run the single-sample scATAC pipeline from an in-memory count matrix (SparseMatrixCSC).
 * Pipeline: FindTopFeatures -> TF-IDF -> subset to top features -> LSI (SVD) -> UMAP -> Louvain.
 * Uses a fixed random seed so loading the same dataset produces identical UMAP and clusters.
 *
 * @param {import('./sparse.js').SparseMatrixCSC} countMatrix: peaks x cells
 * @param {Object} [options]
 * @param {number} [options.scaleFactor=1e4]
 * @param {number} [options.minDist=0.3]: UMAP min_dist
 * @param {number} [options.numNeighbors=30]: UMAP n_neighbors
 * @param {number} [options.resolution=0.8]: Louvain resolution
 * @param {string} [options.topFeatureCutoff='q5']: FindTopFeatures cutoff
 * @param {(msg: string) => void} [options.statusCallback]: optional status callback (e.g. for worker STATUS_UPDATE)
 * @returns {Promise<{ umapEmbedding: number[][], clusters: number[], cellEmbeddings: Float64Array, singularValues: Float64Array, sdev: Float64Array, topPeakIndices: number[], nCells: number, nComponents: number }>}
 */
export async function runSingleSamplePipeline(countMatrix, options = {}) {
  const {
    scaleFactor = 1e4,
    minDist = 0.3,
    numNeighbors = 30,
    resolution = 0.8,
    topFeatureCutoff = 'q5',
    statusCallback = null
  } = options;

  const post = (msg) => { if (statusCallback) statusCallback(msg); };

  /** Single seeded RNG for SVD, UMAP, and clustering so results are reproducible. */
  const random = seededRandom(SCATAC_RANDOM_SEED);

  const { runTFIDF, findTopFeatures } = await import('./tfidf.js');
  const { randomizedSVD } = await import('./svd.js');
  const { buildKNN, buildSNN, louvain } = await import('./clustering.js');

  post('Selecting top features...');
  const topFeatureIndices = findTopFeatures(countMatrix, topFeatureCutoff, post);

  post('Running TF-IDF normalization...');
  const tfidfMatrix = runTFIDF(countMatrix, 1, scaleFactor, post);

  post('Subsetting to top features...');
  const tfidfSubset = tfidfMatrix.subsetRows(topFeatureIndices);

  const nSVDComponents = 50;
  const nOversamples = 20;
  const nIter = 5;
  post('Running LSI (SVD)...');
  const svdResult = await randomizedSVD(tfidfSubset, nSVDComponents, nOversamples, nIter, true, post, random);

  // UMAP on LSI components 2–50 (skip first, depth-correlated)
  const umapDims = svdResult.nComponents - 1;
  const umapInput = [];
  for (let i = 0; i < svdResult.nCells; i++) {
    const row = [];
    for (let d = 1; d < svdResult.nComponents; d++) {
      row.push(svdResult.cellEmbeddings[i * svdResult.nComponents + d]);
    }
    umapInput.push(row);
  }

  post('Running UMAP...');
  const { UMAP } = await import('umap-js');

  function cosineDistance(a, b) {
    let dot = 0; let normA = 0; let normB = 0;
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
    random
  });

  const umapEmbedding = umap.fit(umapInput);

  // Clustering on LSI 2–50: KNN -> SNN -> Louvain
  const clusterEmbeddings = new Float64Array(svdResult.nCells * umapDims);
  for (let i = 0; i < svdResult.nCells; i++) {
    for (let d = 0; d < umapDims; d++) {
      clusterEmbeddings[i * umapDims + d] = svdResult.cellEmbeddings[i * svdResult.nComponents + d + 1];
    }
  }

  const k = 20;
  post('Building KNN and clustering...');
  const knn = buildKNN(clusterEmbeddings, svdResult.nCells, umapDims, k, post, random);
  const snnGraph = buildSNN(knn.indices, svdResult.nCells, k, 0, post);
  const clusters = louvain(snnGraph, svdResult.nCells, resolution, post, random);

  return {
    umapEmbedding,
    clusters: Array.from(clusters),
    cellEmbeddings: svdResult.cellEmbeddings,
    singularValues: svdResult.singularValues,
    sdev: svdResult.sdev,
    topPeakIndices: topFeatureIndices,
    nCells: svdResult.nCells,
    nComponents: svdResult.nComponents
  };
}
