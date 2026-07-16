/**
 * Sketch-based clustering for large spatial datasets (VisiumHD).
 *
 * Mirrors the Seurat v5 SketchData + ProjectData workflow described in:
 *   Hao et al. Nature Biotechnology 2023  https://doi.org/10.1038/s41587-023-01767-y
 *
 * Algorithm:
 *  1. Compute leverage scores from PCA embeddings (||PC[i,:]||²).
 *     Cells in rare or spatially-restricted groups score higher.
 *  2. Weighted-without-replacement sampling of nSketch cells proportional to
 *     leverage scores  → the "sketch" preserves rare populations.
 *  3. Fit UMAP on the sketch; reuse umap-js's internal k-NN for SNN + Louvain
 *     clustering, avoids a second O(n²) k-NN computation.
 *  4. Project all cells into the sketch UMAP using umap.transform(), which uses
 *     the pre-built random-projection forest for efficiency.
 *  5. Transfer cluster labels from sketch to all cells: find the nearest sketch
 *     cell in 2-D UMAP space (grid-accelerated) and inherit its label.
 */

import { buildSNN, louvain } from '../scatac/clustering.js';

/** Cells above this count trigger sketch clustering (same as Seurat default). */
export const SKETCH_MIN_CELLS = 50000;

/** Default sketch size (50 k matches Seurat's Visium HD vignette). */
const DEFAULT_N_SKETCH = 50000;
const DEFAULT_N_NEIGHBORS = 30;
const DEFAULT_MIN_DIST = 0.1;
const DEFAULT_RESOLUTION = 1.8;
const DEFAULT_SEED = 42;

// ---------------------------------------------------------------------------
// Seeded PRNG (Mulberry32), same generator used throughout CellPilot
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Step 1: Leverage scores
// ---------------------------------------------------------------------------

/**
 * Compute per-cell leverage scores from row-major PCA embeddings.
 * score[i] = Σ_k  PC[i,k]²
 *
 * @param {Float64Array} embeddings  Row-major: embeddings[i*nPCs + k]
 * @param {number} nCells
 * @param {number} nPCs
 * @returns {Float64Array}
 */
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

// ---------------------------------------------------------------------------
// Step 2: Proportional sampling without replacement
// ---------------------------------------------------------------------------

/**
 * Two-phase sampling that guarantees rare cell representation in the sketch.
 *
 * Phase 1, deterministic rare-cell guarantee:
 *   Take the top RARE_FRACTION × nSketch cells by leverage score unconditionally.
 *   These are the cells furthest from the centroid in PCA space (podocytes,
 *   rare glomerular/immune populations). Pure weighted sampling can drop them
 *   by chance, which causes their cluster to merge with the dominant neighbours.
 *
 * Phase 2, weighted random sampling:
 *   Fill the remaining slots by proportional sampling from all non-guaranteed
 *   cells using the original leverage scores.
 *
 * @param {Float64Array} scores
 * @param {number} nSketch
 * @param {number} [seed=42]
 * @returns {number[]}  Sorted array of selected indices
 */
export function proportionalSample(scores, nSketch, seed = DEFAULT_SEED) {
  const nCells = scores.length;
  if (nCells <= nSketch) {
    return Array.from({ length: nCells }, (_, i) => i);
  }

  // Phase 1: deterministically guarantee the top-leverage (rarest) cells.
  // 25% of the sketch is reserved for these cells so rare types like podocytes
  // always have enough representatives for UMAP/Louvain to separate them.
  const RARE_FRACTION = 0.25;
  const nGuaranteed = Math.ceil(nSketch * RARE_FRACTION);

  const order = Array.from({ length: nCells }, (_, i) => i);
  order.sort((a, b) => scores[b] - scores[a]);
  const guaranteed = new Set(order.slice(0, nGuaranteed));

  // Phase 2: proportional weighted sampling from the non-guaranteed pool.
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

  // Pad sequentially if weighted sampling couldn't fill remaining slots
  for (let i = 0; i < nCells && selected.size < nSketch; i++) {
    selected.add(i);
  }

  return Array.from(selected).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Step 5: Grid-based 2-D nearest-neighbor for label transfer
// ---------------------------------------------------------------------------
// Fix disconnected Louvain communities
// ---------------------------------------------------------------------------

/**
 * Louvain can assign the same label to graph-disconnected subgraphs.
 * This splits each cluster into its connected components so every label
 * corresponds to a single contiguous region in UMAP space.
 *
 * @param {Int32Array} labels   Louvain output (length nNodes)
 * @param {Array}      snnGraph Adjacency list from buildSNN
 * @param {number}     nNodes
 * @returns {Int32Array}  Relabelled array (same length, contiguous from 0)
 */
function splitDisconnectedClusters(labels, snnGraph, nNodes) {
  // Group node indices by their Louvain label
  const clusterMembers = new Map();
  for (let i = 0; i < nNodes; i++) {
    const c = labels[i];
    if (!clusterMembers.has(c)) clusterMembers.set(c, []);
    clusterMembers.get(c).push(i);
  }

  const newLabels = new Int32Array(nNodes).fill(-1);
  let nextLabel = 0;

  for (const members of clusterMembers.values()) {
    // Build a membership set for fast edge-crossing check
    const memberSet = new Set(members);

    // BFS over the induced subgraph
    const visited = new Set();
    for (const start of members) {
      if (visited.has(start)) continue;
      // New connected component within this cluster
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

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Sketch-based clustering and UMAP for VisiumHD / large spatial datasets.
 *
 * @param {Float64Array} pcaEmbeddings  Row-major (nCells × nPCs) from bakana
 * @param {number} nCells
 * @param {number} nPCs
 * @param {object} [opts]
 * @param {number}   [opts.nSketch=50000]
 * @param {number}   [opts.nNeighbors=30]   UMAP neighbor count
 * @param {number}   [opts.snnK=20]         SNN graph neighbor count (smaller = tighter rare-cell communities)
 * @param {number}   [opts.minDist=0.1]
 * @param {number}   [opts.resolution=2.5]
 * @param {number}   [opts.seed=42]
 * @param {Function} [opts.statusCallback]
 * @returns {Promise<{
 *   umapCoordinates: Array<[number,number]>,
 *   clusters: number[],
 *   nClusters: number,
 *   sketchIndices: number[]
 * }>}
 */
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

  // Each stage gets its own fresh seeded RNG so results are fully deterministic.
  const umapRng    = mulberry32(seed);
  const louvainRng = mulberry32(seed + 1);
  const noiseRng   = mulberry32(seed + 2);

  // Step 1: Leverage scores:
  post(`Sketch: Computing leverage scores for ${nCells.toLocaleString()} cells…`);
  const leverageScores = computeLeverageScores(pcaEmbeddings, nCells, nPCs);

  // Step 2: Two-phase sampling (rare-cell guarantee + weighted random):
  const actualSketch = Math.min(nSketch, nCells);
  post(`Sketch: Selecting ${actualSketch.toLocaleString()} representative cells (25% guaranteed rare)…`);
  const sketchIndices = proportionalSample(leverageScores, actualSketch, seed);
  const nSk = sketchIndices.length;

  // Step 3: Build sketch input for umap-js (array-of-arrays):
  //   umap-js expects Array<Array<number>>, not a flat TypedArray
  const sketchData = new Array(nSk);
  for (let si = 0; si < nSk; si++) {
    const base = sketchIndices[si] * nPCs;
    sketchData[si] = Array.from(pcaEmbeddings.subarray(base, base + nPCs));
  }

  // Step 4: Fit UMAP on the sketch:
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
  // sketchUmapRaw is Array<[x, y]>
  const sketchUmap = sketchUmapRaw.map(row => [row[0], row[1]]);

  // Step 5: Cluster sketch with a smaller SNN k for rare-cell sensitivity:
  //   We use snnK (default 15) rather than the UMAP k (default 30).
  //   Fewer SNN neighbours → each node connects only to its closest peers →
  //   rare populations (podocytes, immune cells) form tight, self-contained
  //   communities that Louvain resolves as distinct clusters rather than
  //   merging them into the dominant neighbouring cell type.
  //
  //   UMAP already computed k=nNeighbors neighbours for each cell. We truncate
  //   those to the nearest snnK entries (they are already distance-sorted) so
  //   no second k-NN pass is needed, O(0) extra cost.
  post(`Sketch: Building SNN graph (k=${snnK}) for clustering…`);

  const rawKnnIndices = umap.knnIndices; // Array<Array<number>>, k = kActualUmap
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
  // Split any Louvain community whose SNN subgraph is disconnected.
  const sketchLabels    = splitDisconnectedClusters(louvainLabels, snnGraph, nSk);
  const nSketchClusters = new Set(Array.from(sketchLabels)).size;
  post(`Sketch: Found ${nSketchClusters} clusters in the sketch (after disconnected-community splitting).`);

  // Steps 6-7: Fast projection + label assignment via PCA-space NN:
  //   Random-projection ANN index: project sketch cells onto N_RP random unit
  //   vectors, binary-search each sorted list per query cell, compute exact PCA
  //   distances over the candidate window, then majority-vote the top-K labels.
  //   Runtime: O(nSk × N_RP × nPCs) build + O(nNonSketch × candidates × nPCs) query.

  const K_VOTE   = 5;   // nearest sketch cells for majority-vote label transfer
  const N_RP     = 8;   // random projection directions
  const RP_WINDOW = 40; // window half-width on each projection axis

  const sketchSet = new Set(sketchIndices);

  const nonSketchIndices = [];
  for (let i = 0; i < nCells; i++) {
    if (!sketchSet.has(i)) nonSketchIndices.push(i);
  }
  const nNonSketch = nonSketchIndices.length;

  post(`Sketch: Building random-projection ANN index (${N_RP} projections)…`);

  // Build RP index over sketch cells:
  const rpRng = mulberry32(seed + 3); // separate seed, independent of UMAP/Louvain/noise
  const rpIndex = [];
  for (let p = 0; p < N_RP; p++) {
    // Gaussian random unit vector in nPCs-dimensional space (Box-Muller)
    const v = new Float64Array(nPCs);
    let norm = 0;
    for (let k = 0; k < nPCs; k++) {
      const u1 = Math.max(rpRng(), 1e-10), u2 = rpRng();
      const g  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v[k] = g; norm += g * g;
    }
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < nPCs; k++) v[k] /= norm;

    // Project every sketch cell
    const proj = new Float64Array(nSk);
    for (let si = 0; si < nSk; si++) {
      const b = sketchIndices[si] * nPCs;
      let dot = 0;
      for (let k = 0; k < nPCs; k++) dot += pcaEmbeddings[b + k] * v[k];
      proj[si] = dot;
    }

    // Sort sketch indices by projection value
    const order = Array.from({ length: nSk }, (_, i) => i);
    order.sort((a, b) => proj[a] - proj[b]);
    const sortedProj = new Float64Array(nSk);
    for (let i = 0; i < nSk; i++) sortedProj[i] = proj[order[i]];

    rpIndex.push({ v, order, sortedProj });
  }

  // Noise scale: 2.5% of avg UMAP std-dev
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

  // Sketch cells: exact coordinates and labels
  for (let si = 0; si < nSk; si++) {
    const ci = sketchIndices[si];
    fullUmap[ci]     = sketchUmap[si];
    fullClusters[ci] = sketchLabels[si];
  }

  post(`Sketch: Assigning ${nNonSketch.toLocaleString()} non-sketch cells (k=${K_VOTE} vote, RP ANN)…`);

  // Query RP index for each non-sketch cell:
  for (let j = 0; j < nNonSketch; j++) {
    const ci   = nonSketchIndices[j];
    const base = ci * nPCs;

    // Collect candidate sketch indices from all RP projections
    const candidateDist = new Map(); // si → exact squared PCA distance
    for (const { v, order, sortedProj } of rpIndex) {
      // Project query onto this direction
      let qProj = 0;
      for (let k = 0; k < nPCs; k++) qProj += pcaEmbeddings[base + k] * v[k];

      // Binary search for insertion position
      let lo = 0, hi = nSk - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedProj[mid] < qProj) lo = mid + 1; else hi = mid;
      }

      // Collect ±RP_WINDOW neighbours along this projection axis
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

    // Sort candidates by exact PCA distance and take top K_VOTE
    const sorted = Array.from(candidateDist.entries()).sort((a, b) => a[1] - b[1]);
    const topK   = sorted.slice(0, K_VOTE);

    // Majority vote on cluster label
    const votes = new Map();
    for (const [si] of topK) {
      const label = sketchLabels[si];
      votes.set(label, (votes.get(label) ?? 0) + 1);
    }
    let bestLabel = sketchLabels[topK[0][0]], bestVotes = 0;
    for (const [label, count] of votes) {
      if (count > bestVotes) { bestVotes = count; bestLabel = label; }
    }

    // UMAP position from closest sketch cell + jitter
    const nearestSi = topK[0][0];
    fullUmap[ci] = [
      sketchUmap[nearestSi][0] + (noiseRng() - 0.5) * noiseScale,
      sketchUmap[nearestSi][1] + (noiseRng() - 0.5) * noiseScale,
    ];
    fullClusters[ci] = bestLabel;
  }

  // Remap labels to contiguous integers starting from 0
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
