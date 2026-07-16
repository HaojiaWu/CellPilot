/**
 * Weighted Nearest Neighbor (WNN) integration for multiome data.
 *
 * Analogous to Seurat's FindMultiModalNeighbors + RunUMAP(nn.name="weighted.nn").
 *
 * Algorithm:
 * 1. Build k-NN in RNA PCA space and ATAC LSI space separately (cosine distance).
 *    NO z-score normalization: Seurat does not z-score before FindMultiModalNeighbors.
 *    With cosine distance the absolute scale of each PC/LSI dim doesn't matter, but
 *    the relative magnitude across dims DOES, PC1's larger values correctly give it
 *    more weight. Z-scoring would equalize all dims and amplify high-PC noise.
 * 2. Compute per-cell modality weights from neighborhood compactness.
 * 3. For each cell, proportionally select neighbors from each modality:
 *      n_rna = round(k * w_rna[i]) from RNA k-NN
 *      n_atac = k: n_rna         from ATAC k-NN
 *    Merge; shared neighbors (in both lists) get combined (averaged) distance.
 *    This avoids the "1.0 penalty" problem where unilateral neighbors get
 *    artificially inflated distances, distorting the UMAP graph.
 * 4. Run UMAP on the precomputed weighted k-NN graph (setPrecomputedKNN).
 *    Uses random initialization to avoid issues with spectral layout on dummy data.
 * 5. Run Louvain on the weighted combined SNN graph.
 */

function seededRandom(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WNN_SEED = 123;

/**
 * Build a proportionally-selected weighted combined k-NN graph.
 *
 * For each cell i:
 * Take top nFromA = round(targetK * wA[i]) neighbors from modality A (by ascending cosine dist)
 * Take top nFromB = targetK: nFromA neighbors from modality B
 * Merge the two lists; cells appearing in BOTH get distance = (d_A + d_B) / 2 (rewarded)
 * Cells appearing in only one modality keep their actual modality distance (no penalty)
 * Sort merged list by distance, keep top targetK
 *
 * Returns parallel arrays for umap-js setPrecomputedKNN:
 *   knnIndices[i]   = Array of targetK neighbor indices
 *   knnDistances[i] = Array of targetK distances
 */
function buildWeightedCombinedKNN(knnA, knnB, nCells, kSource, wA, wB, targetK) {
  const knnIndices   = new Array(nCells);
  const knnDistances = new Array(nCells);

  for (let i = 0; i < nCells; i++) {
    const nFromA = Math.round(targetK * wA[i]);
    const nFromB = targetK - nFromA;

    // Collect top nFromA from modality A
    const aMap = new Map();
    for (let ki = 0; ki < Math.min(nFromA, kSource); ki++) {
      const j = knnA.indices[i * kSource + ki];
      if (j !== i) aMap.set(j, knnA.distances[i * kSource + ki]);
    }
    // Collect top nFromB from modality B
    const bMap = new Map();
    for (let ki = 0; ki < Math.min(nFromB, kSource); ki++) {
      const j = knnB.indices[i * kSource + ki];
      if (j !== i) bMap.set(j, knnB.distances[i * kSource + ki]);
    }

    // Merge: shared neighbors get averaged distance (bonus); unique keep own distance
    const merged = new Map();
    for (const [j, dA] of aMap) {
      merged.set(j, bMap.has(j) ? (dA + bMap.get(j)) / 2 : dA);
    }
    for (const [j, dB] of bMap) {
      if (!merged.has(j)) merged.set(j, dB);
    }

    // Sort ascending by distance, keep top targetK
    const pairs = Array.from(merged.entries()).sort((a, b) => a[1] - b[1]);
    const top = pairs.slice(0, targetK);

    // Pad with self if fewer than targetK unique neighbors
    while (top.length < targetK) top.push([i, 1.0]);

    knnIndices[i]   = top.map(p => p[0]);
    knnDistances[i] = top.map(p => p[1]);
  }

  return { knnIndices, knnDistances };
}

/**
 * Run the WNN integration pipeline.
 *
 * @param {Float64Array} rnaPCAEmbeddings : row-major (nCells × nRNADims)
 * @param {Float64Array} atacLSIEmbeddings: row-major (nCells × nATACDims), dim 0 already excluded
 * @param {number} nCells
 * @param {number} nRNADims
 * @param {number} nATACDims
 * @param {object} [options]
 * @param {number} [options.k=20]           : neighbors for weight estimation and clustering
 * @param {number} [options.minDist=0.3]    : UMAP min_dist
 * @param {number} [options.numNeighbors=20]: UMAP n_neighbors (also used for combined k-NN)
 * @param {number} [options.resolution=0.3] : Louvain resolution
 * @param {Function} [options.statusCallback]
 * @returns {Promise<{ umapEmbedding: number[][], clusters: number[] }>}
 */
export async function runWNNPipeline(rnaPCAEmbeddings, atacLSIEmbeddings, nCells, nRNADims, nATACDims, options = {}) {
  const {
    k = 20,
    minDist = 0.3,
    numNeighbors = 20,
    resolution = 0.3,
    statusCallback = null,
  } = options;

  const post = (msg) => { if (statusCallback) statusCallback(msg); };
  const random = seededRandom(WNN_SEED);

  const { buildKNN, buildSNN, louvain } = await import('./clustering.js');

  // Step 1: Build k-NN in each modality (cosine, raw embeddings, no z-score)
  // Seurat does not z-score before FindMultiModalNeighbors. Raw cosine distance
  // correctly weights high-variance PCs/dims more (they have larger values).
  const kBuild = Math.max(k, numNeighbors);

  post(`WNN: Building RNA k-NN (k=${kBuild}, ${nCells} cells × ${nRNADims} dims)...`);
  const rnaKNN = buildKNN(rnaPCAEmbeddings, nCells, nRNADims, kBuild, null, random);

  post(`WNN: Building ATAC k-NN (k=${kBuild}, ${nCells} cells × ${nATACDims} dims)...`);
  const atacKNN = buildKNN(atacLSIEmbeddings, nCells, nATACDims, kBuild, null, random);

  // Step 2: Per-cell modality weights
  // Cells with tight (low-distance) k neighborhoods get higher weight for that modality.
  post('WNN: Computing per-cell modality weights...');
  const wRNA  = new Float64Array(nCells);
  const wATAC = new Float64Array(nCells);

  for (let i = 0; i < nCells; i++) {
    let rnaSum = 0, atacSum = 0;
    for (let ki = 0; ki < k; ki++) {
      rnaSum  += rnaKNN.distances[i * kBuild + ki];
      atacSum += atacKNN.distances[i * kBuild + ki];
    }
    const rnaAvg  = rnaSum  / k;
    const atacAvg = atacSum / k;
    const invRNA  = rnaAvg  > 1e-12 ? 1.0 / rnaAvg  : 1e12;
    const invATAC = atacAvg > 1e-12 ? 1.0 / atacAvg : 1e12;
    const total   = invRNA + invATAC;
    wRNA[i]  = invRNA  / total;
    wATAC[i] = invATAC / total;
  }

  // Step 3: Proportional combined k-NN for UMAP
  post('WNN: Building weighted combined k-NN graph for UMAP...');
  const { knnIndices: umapKNNIdx, knnDistances: umapKNNDist } =
    buildWeightedCombinedKNN(rnaKNN, atacKNN, nCells, kBuild, wRNA, wATAC, numNeighbors);

  // Step 4: UMAP on precomputed weighted k-NN graph
  // Random initialization avoids spectral-layout artifacts from dummy X data.
  post('WNN: Running UMAP on weighted k-NN graph...');
  const { UMAP } = await import('umap-js');

  const umap = new UMAP({
    nNeighbors: numNeighbors,
    minDist,
    nComponents: 2,
    random,
    initializationMethod: 'random', // avoid spectral-layout artifacts with dummy X
  });

  umap.setPrecomputedKNN(umapKNNIdx, umapKNNDist);

  // umap.fit() still needs an X array of length nCells for graph sizing;
  // actual values are ignored because k-NN is precomputed.
  const dummyX = Array.from({ length: nCells }, (_, i) => [i / nCells]);
  const umapEmbedding = umap.fit(dummyX);

  // Step 5: Louvain clustering on weighted combined SNN
  post('WNN: Building combined k-NN for clustering...');
  const { knnIndices: clusterKNNIdx } =
    buildWeightedCombinedKNN(rnaKNN, atacKNN, nCells, kBuild, wRNA, wATAC, k);

  const flatClusterKNN = new Int32Array(nCells * k);
  for (let i = 0; i < nCells; i++) {
    for (let ki = 0; ki < k; ki++) {
      flatClusterKNN[i * k + ki] = clusterKNNIdx[i][ki];
    }
  }

  // No SNN pruning (pruneSNN=0): the combined k-NN already has fewer shared neighbors
  // than modality-specific k-NN; pruning at 1/15 would remove too many valid edges.
  const snnGraph = buildSNN(flatClusterKNN, nCells, k, 0, null);

  post(`WNN: Running Louvain clustering (resolution=${resolution})...`);
  const clusters = louvain(snnGraph, nCells, resolution, null, random);

  return {
    umapEmbedding,
    clusters: Array.from(clusters),
  };
}
