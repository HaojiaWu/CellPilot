function partialSort(idxs, vals, lo, hi, k, random = Math.random) {
  while (lo < hi) {
    const pivotIdx = lo + Math.floor(random() * (hi - lo + 1));
    const pivotVal = vals[idxs[pivotIdx]];
    swap(idxs, pivotIdx, hi);
    let storeIdx = lo;
    for (let i = lo; i < hi; i++) {
      if (vals[idxs[i]] < pivotVal) {
        swap(idxs, i, storeIdx);
        storeIdx++;
      }
    }
    swap(idxs, storeIdx, hi);
    if (storeIdx === k) return;
    if (storeIdx < k) lo = storeIdx + 1;
    else hi = storeIdx - 1;
  }
}

function swap(arr, i, j) {
  const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
}

/**
 * Build KNN graph using brute-force cosine distance (matching Seurat's default for LSI).
 * @param {() => number} [random=Math.random]: optional PRNG for reproducible KNN (same dataset → same graph)
 */
export function buildKNN(embeddings, nCells, nDims, k = 20, statusCallback = null, random = Math.random) {
  if (statusCallback) statusCallback(`Building KNN graph (k=${k})...`);

  const knnIndices = new Int32Array(nCells * k);
  const knnDistances = new Float64Array(nCells * k);

  const norms = new Float64Array(nCells);
  for (let i = 0; i < nCells; i++) {
    let s = 0;
    const base = i * nDims;
    for (let d = 0; d < nDims; d++) s += embeddings[base + d] * embeddings[base + d];
    norms[i] = Math.sqrt(s);
  }

  for (let i = 0; i < nCells; i++) {
    const dists = new Float64Array(nCells);
    const iBase = i * nDims;
    const ni = norms[i];

    for (let j = 0; j < nCells; j++) {
      if (i === j) { dists[j] = Infinity; continue; }
      let dot = 0;
      const jBase = j * nDims;
      for (let dim = 0; dim < nDims; dim++) {
        dot += embeddings[iBase + dim] * embeddings[jBase + dim];
      }
      const denom = ni * norms[j];
      dists[j] = denom > 0 ? 1 - dot / denom : 1;
    }

    const idxs = new Int32Array(nCells);
    for (let j = 0; j < nCells; j++) idxs[j] = j;
    partialSort(idxs, dists, 0, nCells - 1, k, random);

    const topK = Array.from(idxs.subarray(0, k));
    topK.sort((a, b) => dists[a] - dists[b]);

    for (let ki = 0; ki < k; ki++) {
      knnIndices[i * k + ki] = topK[ki];
      knnDistances[i * k + ki] = dists[topK[ki]];
    }
  }

  return { indices: knnIndices, distances: knnDistances };
}

/**
 * Build SNN graph from KNN using Jaccard similarity of neighbor sets.
 */
export function buildSNN(knnIndices, nCells, k, pruneSNN = 0, statusCallback = null) {
  if (statusCallback) statusCallback('Building SNN graph...');

  const neighborSets = [];
  for (let i = 0; i < nCells; i++) {
    const set = new Set();
    for (let ki = 0; ki < k; ki++) {
      set.add(knnIndices[i * k + ki]);
    }
    neighborSets.push(set);
  }

  const adjList = Array.from({ length: nCells }, () => []);
  const processed = new Set();

  for (let i = 0; i < nCells; i++) {
    for (let ki = 0; ki < k; ki++) {
      const j = knnIndices[i * k + ki];
      if (j === i) continue;
      const edgeKey = i < j ? i * nCells + j : j * nCells + i;
      if (processed.has(edgeKey)) continue;
      processed.add(edgeKey);

      const setI = neighborSets[i];
      const setJ = neighborSets[j];
      let shared = 0;
      for (const elem of setI) {
        if (setJ.has(elem)) shared++;
      }

      const jaccard = shared / (setI.size + setJ.size - shared);

      if (jaccard > pruneSNN) {
        adjList[i].push({ node: j, weight: jaccard });
        adjList[j].push({ node: i, weight: jaccard });
      }
    }
  }

  return adjList;
}

function localOptimize(adjList, nNodes, resolution, random = null) {
  const degree = new Float64Array(nNodes);
  let totalWeight = 0;

  for (let i = 0; i < nNodes; i++) {
    for (const { weight } of adjList[i]) {
      degree[i] += weight;
    }
    totalWeight += degree[i];
  }
  totalWeight /= 2;

  if (totalWeight === 0) {
    const result = new Int32Array(nNodes);
    for (let i = 0; i < nNodes; i++) result[i] = i;
    return result;
  }

  const community = new Int32Array(nNodes);
  for (let i = 0; i < nNodes; i++) community[i] = i;

  const commDegree = new Float64Array(nNodes);
  for (let i = 0; i < nNodes; i++) commDegree[i] = degree[i];

  let improved = true;
  let iteration = 0;

  while (improved && iteration < 100) {
    improved = false;
    iteration++;

    const order = Array.from({ length: nNodes }, (_, i) => i);
    const rng = random ?? Math.random;
    for (let i = nNodes - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    for (const idx of order) {
      const currentComm = community[idx];
      const ki = degree[idx];
      if (ki === 0) continue;

      const commWeights = new Map();
      for (const { node: j, weight } of adjList[idx]) {
        if (j === idx) continue;
        const c = community[j];
        commWeights.set(c, (commWeights.get(c) || 0) + weight);
      }

      const wCurrent = commWeights.get(currentComm) || 0;

      let bestComm = currentComm;
      let bestDeltaQ = 0;

      for (const [c, wc] of commWeights) {
        if (c === currentComm) continue;

        const deltaQ = (wc - wCurrent) / totalWeight
          + resolution * ki * (commDegree[currentComm] - ki - commDegree[c])
            / (2 * totalWeight * totalWeight);

        if (deltaQ > bestDeltaQ) {
          bestDeltaQ = deltaQ;
          bestComm = c;
        }
      }

      if (bestComm !== currentComm) {
        community[idx] = bestComm;
        commDegree[currentComm] -= ki;
        commDegree[bestComm] += ki;
        improved = true;
      }
    }
  }

  return community;
}

function buildCoarsenedGraph(adjList, community, nNodes, nComms) {
  const edgeWeights = new Map();

  for (let i = 0; i < nNodes; i++) {
    const ci = community[i];
    for (const { node: j, weight } of adjList[i]) {
      if (j === i) {
        const key = ci * nComms + ci;
        edgeWeights.set(key, (edgeWeights.get(key) || 0) + weight);
        continue;
      }
      if (j < i) continue;
      const cj = community[j];

      const key = ci <= cj ? ci * nComms + cj : cj * nComms + ci;
      edgeWeights.set(key, (edgeWeights.get(key) || 0) + weight);
    }
  }

  const coarseAdj = Array.from({ length: nComms }, () => []);
  for (const [key, weight] of edgeWeights) {
    const ci = Math.floor(key / nComms);
    const cj = key % nComms;
    if (ci === cj) {
      coarseAdj[ci].push({ node: ci, weight: weight * 2 });
    } else {
      coarseAdj[ci].push({ node: cj, weight });
      coarseAdj[cj].push({ node: ci, weight });
    }
  }

  return coarseAdj;
}

/**
 * Full multi-level Louvain community detection.
 * @param {() => number} [random=Math.random]: optional PRNG for reproducible clustering (same graph → same communities)
 */
export function louvain(adjList, nNodes, resolution = 1.0, statusCallback = null, random = null) {
  if (statusCallback) statusCallback(`Running Louvain clustering (resolution=${resolution})...`);

  let membership = new Int32Array(nNodes);
  for (let i = 0; i < nNodes; i++) membership[i] = i;

  let currentAdj = adjList;
  let currentN = nNodes;

  const rng = random ?? Math.random;
  while (true) {
    const localComm = localOptimize(currentAdj, currentN, resolution, rng);

    const uniqueComms = [...new Set(localComm)];
    uniqueComms.sort((a, b) => a - b);
    const commMap = new Map();
    uniqueComms.forEach((c, idx) => commMap.set(c, idx));
    const nComms = uniqueComms.length;
    for (let i = 0; i < currentN; i++) {
      localComm[i] = commMap.get(localComm[i]);
    }

    const newMembership = new Int32Array(nNodes);
    for (let i = 0; i < nNodes; i++) {
      newMembership[i] = localComm[membership[i]];
    }
    membership = newMembership;

    if (nComms >= currentN) break;

    currentAdj = buildCoarsenedGraph(currentAdj, localComm, currentN, nComms);
    currentN = nComms;
  }

  const finalComms = [...new Set(membership)];
  finalComms.sort((a, b) => a - b);
  const finalMap = new Map();
  finalComms.forEach((c, idx) => finalMap.set(c, idx));
  for (let i = 0; i < nNodes; i++) {
    membership[i] = finalMap.get(membership[i]);
  }

  return membership;
}
