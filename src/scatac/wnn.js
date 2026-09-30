function seededRandom(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WNN_SEED = 123;

function buildWeightedCombinedKNN(knnA, knnB, nCells, kSource, wA, wB, targetK) {
  const knnIndices   = new Array(nCells);
  const knnDistances = new Array(nCells);

  for (let i = 0; i < nCells; i++) {
    const nFromA = Math.round(targetK * wA[i]);
    const nFromB = targetK - nFromA;

    const aMap = new Map();
    for (let ki = 0; ki < Math.min(nFromA, kSource); ki++) {
      const j = knnA.indices[i * kSource + ki];
      if (j !== i) aMap.set(j, knnA.distances[i * kSource + ki]);
    }
    const bMap = new Map();
    for (let ki = 0; ki < Math.min(nFromB, kSource); ki++) {
      const j = knnB.indices[i * kSource + ki];
      if (j !== i) bMap.set(j, knnB.distances[i * kSource + ki]);
    }

    const merged = new Map();
    for (const [j, dA] of aMap) {
      merged.set(j, bMap.has(j) ? (dA + bMap.get(j)) / 2 : dA);
    }
    for (const [j, dB] of bMap) {
      if (!merged.has(j)) merged.set(j, dB);
    }

    const pairs = Array.from(merged.entries()).sort((a, b) => a[1] - b[1]);
    const top = pairs.slice(0, targetK);

    while (top.length < targetK) top.push([i, 1.0]);

    knnIndices[i]   = top.map(p => p[0]);
    knnDistances[i] = top.map(p => p[1]);
  }

  return { knnIndices, knnDistances };
}

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

  const kBuild = Math.max(k, numNeighbors);

  post(`WNN: Building RNA k-NN (k=${kBuild}, ${nCells} cells × ${nRNADims} dims)...`);
  const rnaKNN = buildKNN(rnaPCAEmbeddings, nCells, nRNADims, kBuild, null, random);

  post(`WNN: Building ATAC k-NN (k=${kBuild}, ${nCells} cells × ${nATACDims} dims)...`);
  const atacKNN = buildKNN(atacLSIEmbeddings, nCells, nATACDims, kBuild, null, random);

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

  post('WNN: Building weighted combined k-NN graph for UMAP...');
  const { knnIndices: umapKNNIdx, knnDistances: umapKNNDist } =
    buildWeightedCombinedKNN(rnaKNN, atacKNN, nCells, kBuild, wRNA, wATAC, numNeighbors);

  post('WNN: Running UMAP on weighted k-NN graph...');
  const { UMAP } = await import('umap-js');

  const umap = new UMAP({
    nNeighbors: numNeighbors,
    minDist,
    nComponents: 2,
    random,
    initializationMethod: 'random',
  });

  umap.setPrecomputedKNN(umapKNNIdx, umapKNNDist);

  const dummyX = Array.from({ length: nCells }, (_, i) => [i / nCells]);
  const umapEmbedding = umap.fit(dummyX);

  post('WNN: Building combined k-NN for clustering...');
  const { knnIndices: clusterKNNIdx } =
    buildWeightedCombinedKNN(rnaKNN, atacKNN, nCells, kBuild, wRNA, wATAC, k);

  const flatClusterKNN = new Int32Array(nCells * k);
  for (let i = 0; i < nCells; i++) {
    for (let ki = 0; ki < k; ki++) {
      flatClusterKNN[i * k + ki] = clusterKNNIdx[i][ki];
    }
  }

  const snnGraph = buildSNN(flatClusterKNN, nCells, k, 0, null);

  post(`WNN: Running Louvain clustering (resolution=${resolution})...`);
  const clusters = louvain(snnGraph, nCells, resolution, null, random);

  return {
    umapEmbedding,
    clusters: Array.from(clusters),
  };
}
