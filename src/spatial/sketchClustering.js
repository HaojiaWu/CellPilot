import { buildSNN, louvain } from '../scatac/clustering.js';

export const SKETCH_MIN_CELLS = 50000;

const DEFAULT_N_SKETCH = 50000;
const DEFAULT_N_NEIGHBORS = 30;
const DEFAULT_MIN_DIST = 0.1;
const DEFAULT_RESOLUTION = 1.8;
const DEFAULT_SEED = 42;

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function computeLeverageScores(embeddings, nCells, nPCs) {
  const scores = new Float64Array(nCells);
  for (let i = 0; i < nCells; i++) {
    let sum = 0;
    const base = i * nPCs;
    for (let k = 0; k < nPCs; k++) {
      const v = embeddings[base + k];
      sum += v * v;
    }
    scores[i] = sum;
  }
  return scores;
}

export function proportionalSample(scores, nSketch, seed = DEFAULT_SEED) {
  const nCells = scores.length;
  if (nCells <= nSketch) {
    return Array.from({ length: nCells }, (_, i) => i);
  }

  const RARE_FRACTION = 0.25;
  const nGuaranteed = Math.ceil(nSketch * RARE_FRACTION);

  const order = Array.from({ length: nCells }, (_, i) => i);
  order.sort((a, b) => scores[b] - scores[a]);
  const guaranteed = new Set(order.slice(0, nGuaranteed));

  const pool = [];
  const poolWeights = new Float64Array(nCells - nGuaranteed);
  let pi = 0;
  for (let i = 0; i < nCells; i++) {
    if (!guaranteed.has(i)) {
      pool.push(i);
      poolWeights[pi++] = Math.max(scores[i], 1e-12);
    }
  }

  const cumSum = new Float64Array(pool.length + 1);
  for (let i = 0; i < pool.length; i++) {
    cumSum[i + 1] = cumSum[i] + poolWeights[i];
  }
  const total = cumSum[pool.length];

  const selected = new Set(guaranteed);
  const nRandom = nSketch - nGuaranteed;
  const maxAttempts = nRandom * 6;
  const rng = mulberry32(seed);

  for (let attempt = 0; attempt < maxAttempts && selected.size < nSketch; attempt++) {
    const target = rng() * total;
    let lo = 0, hi = pool.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumSum[mid + 1] < target) lo = mid + 1;
      else hi = mid;
    }
    selected.add(pool[lo]);
  }

  for (let i = 0; i < nCells && selected.size < nSketch; i++) {
    selected.add(i);
  }

  return Array.from(selected).sort((a, b) => a - b);
}

function splitDisconnectedClusters(labels, snnGraph, nNodes) {
  const clusterMembers = new Map();
  for (let i = 0; i < nNodes; i++) {
    const c = labels[i];
    if (!clusterMembers.has(c)) clusterMembers.set(c, []);
    clusterMembers.get(c).push(i);
  }

  const newLabels = new Int32Array(nNodes).fill(-1);
  let nextLabel = 0;

  for (const members of clusterMembers.values()) {
    const memberSet = new Set(members);

    const visited = new Set();
    for (const start of members) {
      if (visited.has(start)) continue;
      const queue = [start];
      visited.add(start);
      while (queue.length > 0) {
        const node = queue.shift();
        newLabels[node] = nextLabel;
        for (const { node: nb } of snnGraph[node]) {
          if (memberSet.has(nb) && !visited.has(nb)) {
            visited.add(nb);
            queue.push(nb);
          }
        }
      }
      nextLabel++;
    }
  }

  return newLabels;
}

export async function runSketchClustering(pcaEmbeddings, nCells, nPCs, opts = {}) {
  const {
    nSketch    = DEFAULT_N_SKETCH,
    nNeighbors = DEFAULT_N_NEIGHBORS,
    snnK       = 20,
    minDist    = DEFAULT_MIN_DIST,
    resolution = DEFAULT_RESOLUTION,
    seed       = DEFAULT_SEED,
    statusCallback = null,
  } = opts;

  const post = (msg) => { if (statusCallback) statusCallback(msg); };

  const umapRng    = mulberry32(seed);
  const louvainRng = mulberry32(seed + 1);
  const noiseRng   = mulberry32(seed + 2);

  post(`Sketch: Computing leverage scores for ${nCells.toLocaleString()} cells…`);
  const leverageScores = computeLeverageScores(pcaEmbeddings, nCells, nPCs);

  const actualSketch = Math.min(nSketch, nCells);
  post(`Sketch: Selecting ${actualSketch.toLocaleString()} representative cells (25% guaranteed rare)…`);
  const sketchIndices = proportionalSample(leverageScores, actualSketch, seed);
  const nSk = sketchIndices.length;

  const sketchData = new Array(nSk);
  for (let si = 0; si < nSk; si++) {
    const base = sketchIndices[si] * nPCs;
    sketchData[si] = Array.from(pcaEmbeddings.subarray(base, base + nPCs));
  }

  post(`Sketch: Fitting UMAP on ${nSk.toLocaleString()} sketch cells…`);
  const { UMAP } = await import('umap-js');
  const kActualUmap = Math.min(nNeighbors, nSk - 1);
  const umap = new UMAP({
    nNeighbors: kActualUmap,
    minDist,
    nComponents: 2,
    random: umapRng,
  });
  const sketchUmapRaw = umap.fit(sketchData);
  const sketchUmap = sketchUmapRaw.map(row => [row[0], row[1]]);

  post(`Sketch: Building SNN graph (k=${snnK}) for clustering…`);

  const rawKnnIndices = umap.knnIndices;
  const kKnn = Math.min(snnK, kActualUmap, nSk - 1);
  const flatKnn = new Int32Array(nSk * kKnn);
  if (rawKnnIndices) {
    for (let i = 0; i < nSk; i++) {
      const row = rawKnnIndices[i];
      for (let ki = 0; ki < kKnn; ki++) flatKnn[i * kKnn + ki] = row[ki] ?? 0;
    }
  }

  post(`Sketch: Clustering ${nSk.toLocaleString()} sketch cells (SNN + Louvain, resolution=${resolution})…`);
  const snnGraph      = buildSNN(flatKnn, nSk, kKnn, 0, post);
  const louvainLabels = louvain(snnGraph, nSk, resolution, post, louvainRng);
  const sketchLabels    = splitDisconnectedClusters(louvainLabels, snnGraph, nSk);
  const nSketchClusters = new Set(Array.from(sketchLabels)).size;
  post(`Sketch: Found ${nSketchClusters} clusters in the sketch (after disconnected-community splitting).`);

  const K_VOTE   = 5;
  const N_RP     = 8;
  const RP_WINDOW = 40;

  const sketchSet = new Set(sketchIndices);

  const nonSketchIndices = [];
  for (let i = 0; i < nCells; i++) {
    if (!sketchSet.has(i)) nonSketchIndices.push(i);
  }
  const nNonSketch = nonSketchIndices.length;

  post(`Sketch: Building random-projection ANN index (${N_RP} projections)…`);

  const rpRng = mulberry32(seed + 3);
  const rpIndex = [];
  for (let p = 0; p < N_RP; p++) {
    const v = new Float64Array(nPCs);
    let norm = 0;
    for (let k = 0; k < nPCs; k++) {
      const u1 = Math.max(rpRng(), 1e-10), u2 = rpRng();
      const g  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v[k] = g; norm += g * g;
    }
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < nPCs; k++) v[k] /= norm;

    const proj = new Float64Array(nSk);
    for (let si = 0; si < nSk; si++) {
      const b = sketchIndices[si] * nPCs;
      let dot = 0;
      for (let k = 0; k < nPCs; k++) dot += pcaEmbeddings[b + k] * v[k];
      proj[si] = dot;
    }

    const order = Array.from({ length: nSk }, (_, i) => i);
    order.sort((a, b) => proj[a] - proj[b]);
    const sortedProj = new Float64Array(nSk);
    for (let i = 0; i < nSk; i++) sortedProj[i] = proj[order[i]];

    rpIndex.push({ v, order, sortedProj });
  }

  let meanX = 0, meanY = 0;
  for (let si = 0; si < nSk; si++) { meanX += sketchUmap[si][0]; meanY += sketchUmap[si][1]; }
  meanX /= nSk; meanY /= nSk;
  let varX = 0, varY = 0;
  for (let si = 0; si < nSk; si++) {
    varX += (sketchUmap[si][0] - meanX) ** 2;
    varY += (sketchUmap[si][1] - meanY) ** 2;
  }
  const noiseScale = (Math.sqrt(varX / nSk) + Math.sqrt(varY / nSk)) * 0.025;

  const fullUmap     = new Array(nCells);
  const fullClusters = new Int32Array(nCells);

  for (let si = 0; si < nSk; si++) {
    const ci = sketchIndices[si];
    fullUmap[ci]     = sketchUmap[si];
    fullClusters[ci] = sketchLabels[si];
  }

  post(`Sketch: Assigning ${nNonSketch.toLocaleString()} non-sketch cells (k=${K_VOTE} vote, RP ANN)…`);

  for (let j = 0; j < nNonSketch; j++) {
    const ci   = nonSketchIndices[j];
    const base = ci * nPCs;

    const candidateDist = new Map();
    for (const { v, order, sortedProj } of rpIndex) {
      let qProj = 0;
      for (let k = 0; k < nPCs; k++) qProj += pcaEmbeddings[base + k] * v[k];

      let lo = 0, hi = nSk - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedProj[mid] < qProj) lo = mid + 1; else hi = mid;
      }

      const start = Math.max(0, lo - RP_WINDOW);
      const end   = Math.min(nSk - 1, lo + RP_WINDOW);
      for (let i = start; i <= end; i++) {
        const si = order[i];
        if (!candidateDist.has(si)) {
          const sBase = sketchIndices[si] * nPCs;
          let dist = 0;
          for (let k = 0; k < nPCs; k++) {
            const d = pcaEmbeddings[base + k] - pcaEmbeddings[sBase + k];
            dist += d * d;
          }
          candidateDist.set(si, dist);
        }
      }
    }

    if (candidateDist.size === 0) {
      fullUmap[ci] = [0, 0]; fullClusters[ci] = 0; continue;
    }

    const sorted = Array.from(candidateDist.entries()).sort((a, b) => a[1] - b[1]);
    const topK   = sorted.slice(0, K_VOTE);

    const votes = new Map();
    for (const [si] of topK) {
      const label = sketchLabels[si];
      votes.set(label, (votes.get(label) ?? 0) + 1);
    }
    let bestLabel = sketchLabels[topK[0][0]], bestVotes = 0;
    for (const [label, count] of votes) {
      if (count > bestVotes) { bestVotes = count; bestLabel = label; }
    }

    const nearestSi = topK[0][0];
    fullUmap[ci] = [
      sketchUmap[nearestSi][0] + (noiseRng() - 0.5) * noiseScale,
      sketchUmap[nearestSi][1] + (noiseRng() - 0.5) * noiseScale,
    ];
    fullClusters[ci] = bestLabel;
  }

  const labelMap  = new Map();
  let nextLabel   = 0;
  for (let ci = 0; ci < nCells; ci++) {
    if (!labelMap.has(fullClusters[ci])) labelMap.set(fullClusters[ci], nextLabel++);
  }
  const remappedClusters = Array.from(fullClusters, c => labelMap.get(c));
  const nClusters = labelMap.size;

  post(`Sketch complete: ${nClusters} clusters across ${nCells.toLocaleString()} cells.`);

  return {
    umapCoordinates: fullUmap,
    clusters:        remappedClusters,
    nClusters,
    sketchIndices,
  };
}
