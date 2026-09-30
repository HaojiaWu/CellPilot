export function runHarmony(embeddings, nCells, nDims, batchLabels, options = {}) {
  const {
    theta = 2,
    sigma = 0.1,
    nclust = null,
    tau = 0,
    blockSize = 0.05,
    maxIterHarmony = 20,
    maxIterKmeans = 20,
    epsilonCluster = 1e-5,
    epsilonHarmony = 1e-6,
    verbose = true,
    seed = 0,
  } = options;

  const tTotal = Date.now();

  const batchSet = new Set(batchLabels);
  const batchIds = Array.from(batchSet).sort((a, b) => a - b);
  const B = batchIds.length;
  const batchMap = new Map();
  batchIds.forEach((id, idx) => batchMap.set(id, idx));

  const batchOfCell = new Int32Array(nCells);
  for (let i = 0; i < nCells; i++) {
    batchOfCell[i] = batchMap.get(batchLabels[i]);
  }

  const K = nclust || Math.min(Math.round(nCells / 30), 100);

  if (verbose) {
    console.log('Running Harmony integration:');
    console.log(`  ${nCells} cells, ${nDims} dims, ${B} batches, ${K} clusters`);
    console.log(`  theta=${theta}, sigma=${sigma}, maxIterHarmony=${maxIterHarmony}`);
  }

  const N_b = new Float64Array(B);
  for (let i = 0; i < nCells; i++) N_b[batchOfCell[i]]++;
  const Pr_b = new Float64Array(B);
  for (let b = 0; b < B; b++) Pr_b[b] = N_b[b] / nCells;

  const thetaArr = new Float64Array(B);
  for (let b = 0; b < B; b++) {
    thetaArr[b] = typeof theta === 'number' ? theta : theta[b];
    if (tau > 0) {
      thetaArr[b] *= (1 - Math.exp(-Math.pow(N_b[b] / (K * tau), 2)));
    }
  }

  const sigmaArr = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    sigmaArr[k] = typeof sigma === 'number' ? sigma : sigma[k];
  }

  const lamb = new Float64Array(B + 1);
  for (let b = 0; b < B; b++) lamb[b + 1] = 1;

  const Bp1 = B + 1;
  const Phi_moe = new Float64Array(Bp1 * nCells);
  for (let i = 0; i < nCells; i++) Phi_moe[i] = 1;
  for (let i = 0; i < nCells; i++) {
    Phi_moe[(batchOfCell[i] + 1) * nCells + i] = 1;
  }

  const batchIndex = [];
  for (let b = 0; b < B; b++) {
    const idx = [];
    for (let i = 0; i < nCells; i++) {
      if (batchOfCell[i] === b) idx.push(i);
    }
    batchIndex.push(idx);
  }

  const Z_orig = new Float64Array(nDims * nCells);
  for (let i = 0; i < nCells; i++) {
    for (let d = 0; d < nDims; d++) {
      Z_orig[d * nCells + i] = embeddings[i * nDims + d];
    }
  }

  const Z_corr = new Float64Array(Z_orig);
  const Z_cos = new Float64Array(nDims * nCells);
  l2Normalize(Z_orig, nDims, nCells, Z_cos);

  if (verbose) console.log('  Initializing clusters with KMeans++...');
  const tKmeans = Date.now();
  const centroids = kmeanspp(Z_cos, nDims, nCells, K, 25, seed);

  const Y = new Float64Array(nDims * K);
  for (let k = 0; k < K; k++) {
    let norm = 0;
    for (let d = 0; d < nDims; d++) {
      norm += centroids[k * nDims + d] * centroids[k * nDims + d];
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < nDims; d++) {
      Y[d * K + k] = centroids[k * nDims + d] / norm;
    }
  }
  if (verbose) console.log(`  KMeans++ initialized in ${((Date.now() - tKmeans) / 1000).toFixed(1)}s`);

  const R = new Float64Array(K * nCells);
  const dist_mat = new Float64Array(K * nCells);
  const O = new Float64Array(K * B);
  const E = new Float64Array(K * B);

  computeDistances(Y, Z_cos, nDims, nCells, K, dist_mat);
  computeSoftAssignments(dist_mat, sigmaArr, K, nCells, R);
  computeOE(R, batchOfCell, Pr_b, K, B, nCells, O, E);

  const objectiveHarmony = [];
  const objectiveKmeans = [];
  const windowSize = 3;
  let obj0 = computeObjective(R, dist_mat, sigmaArr, O, E, thetaArr, K, B, nCells);
  objectiveKmeans.push(obj0);
  objectiveHarmony.push(obj0);

  let converged = false;
  for (let iter = 1; iter <= maxIterHarmony; iter++) {
    if (verbose) console.log(`  Harmony iteration ${iter}/${maxIterHarmony}...`);
    const tIter = Date.now();

    let kmeansRounds = 0;
    for (let ki = 0; ki < maxIterKmeans; ki++) {
      updateCentroids(Z_cos, R, nDims, nCells, K, Y);
      computeDistances(Y, Z_cos, nDims, nCells, K, dist_mat);
      updateR(dist_mat, sigmaArr, thetaArr, R, O, E, Pr_b,
              batchOfCell, K, B, nCells, blockSize, seed + iter * 1000 + ki);

      const obj = computeObjective(R, dist_mat, sigmaArr, O, E, thetaArr, K, B, nCells);
      objectiveKmeans.push(obj);
      kmeansRounds = ki + 1;

      if (ki > windowSize && objectiveKmeans.length > windowSize + 1) {
        let objOld = 0, objNew = 0;
        for (let w = 0; w < windowSize; w++) {
          objOld += objectiveKmeans[objectiveKmeans.length - windowSize - 1 + w];
          objNew += objectiveKmeans[objectiveKmeans.length - windowSize + w];
        }
        if (Math.abs(objOld - objNew) / Math.abs(objOld) < epsilonCluster) {
          break;
        }
      }
    }

    objectiveHarmony.push(objectiveKmeans[objectiveKmeans.length - 1]);
    if (verbose) console.log(`    Clustering: ${kmeansRounds} rounds`);

    moeCorrectRidge(Z_orig, Z_corr, Z_cos, R, Phi_moe, batchIndex,
                    lamb, nDims, nCells, K, B);

    if (verbose) {
      console.log(`    Iteration completed in ${((Date.now() - tIter) / 1000).toFixed(1)}s`);
    }

    if (objectiveHarmony.length >= 2) {
      const objOld = objectiveHarmony[objectiveHarmony.length - 2];
      const objNew = objectiveHarmony[objectiveHarmony.length - 1];
      const relChange = Math.abs(objOld) > 1e-300 ? (objOld - objNew) / Math.abs(objOld) : 0;
      if (verbose) {
        console.log(`    Objective: prev=${objOld.toFixed(4)} curr=${objNew.toFixed(4)} relChange=${(relChange * 100).toFixed(6)}% (epsilon=${epsilonHarmony})`);
      }
      if (relChange >= 0 && relChange < epsilonHarmony) {
        if (verbose) console.log(`  Converged after ${iter} iteration${iter > 1 ? 's' : ''}`);
        converged = true;
        break;
      }
    }
  }

  if (verbose && !converged) {
    console.log('  Stopped before convergence (max iterations reached)');
  }

  const result = new Float64Array(nCells * nDims);
  for (let i = 0; i < nCells; i++) {
    for (let d = 0; d < nDims; d++) {
      result[i * nDims + d] = Z_corr[d * nCells + i];
    }
  }

  if (verbose) {
    console.log(`  Harmony completed in ${((Date.now() - tTotal) / 1000).toFixed(1)}s`);
  }

  return result;
}

function l2Normalize(Z, d, N, out) {
  for (let i = 0; i < N; i++) {
    let norm = 0;
    for (let dim = 0; dim < d; dim++) {
      norm += Z[dim * N + i] * Z[dim * N + i];
    }
    norm = Math.sqrt(norm) || 1;
    const invNorm = 1 / norm;
    for (let dim = 0; dim < d; dim++) {
      out[dim * N + i] = Z[dim * N + i] * invNorm;
    }
  }
}

function computeDistances(Y, Z_cos, d, N, K, dist_mat) {
  for (let k = 0; k < K; k++) {
    for (let i = 0; i < N; i++) {
      let dot = 0;
      for (let dim = 0; dim < d; dim++) {
        dot += Y[dim * K + k] * Z_cos[dim * N + i];
      }
      dist_mat[k * N + i] = 2 * (1 - dot);
    }
  }
}

function computeSoftAssignments(dist_mat, sigma, K, N, R) {
  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (let k = 0; k < K; k++) {
      const val = Math.exp(-dist_mat[k * N + i] / sigma[k]);
      R[k * N + i] = val;
      sum += val;
    }
    if (sum > 1e-300) {
      const invSum = 1 / sum;
      for (let k = 0; k < K; k++) {
        R[k * N + i] *= invSum;
      }
    }
  }
}

function computeOE(R, batchOfCell, Pr_b, K, B, N, O, E) {
  O.fill(0);
  E.fill(0);
  for (let k = 0; k < K; k++) {
    let rowSum = 0;
    const base = k * N;
    for (let i = 0; i < N; i++) {
      const r = R[base + i];
      rowSum += r;
      O[k * B + batchOfCell[i]] += r;
    }
    for (let b = 0; b < B; b++) {
      E[k * B + b] = rowSum * Pr_b[b];
    }
  }
}

function computeObjective(R, dist_mat, sigma, O, E, theta, K, B, N) {
  const normConst = 2000.0 / N;

  let kmeansErr = 0;
  const len = K * N;
  for (let idx = 0; idx < len; idx++) {
    kmeansErr += R[idx] * dist_mat[idx];
  }

  let entropy = 0;
  for (let k = 0; k < K; k++) {
    const sk = sigma[k];
    const base = k * N;
    for (let i = 0; i < N; i++) {
      const r = R[base + i];
      if (r > 1e-300) entropy += sk * r * Math.log(r);
    }
  }

  let crossEntropy = 0;
  for (let k = 0; k < K; k++) {
    for (let b = 0; b < B; b++) {
      const o = Math.max(O[k * B + b], 1e-8);
      const e = Math.max(E[k * B + b], 1e-8);
      crossEntropy += sigma[k] * theta[b] * O[k * B + b] * Math.log((o + e) / e);
    }
  }

  return (kmeansErr + entropy + crossEntropy) * normConst;
}

function updateCentroids(Z_cos, R, d, N, K, Y) {
  for (let k = 0; k < K; k++) {
    for (let dim = 0; dim < d; dim++) {
      let sum = 0;
      const rBase = k * N;
      for (let i = 0; i < N; i++) {
        sum += Z_cos[dim * N + i] * R[rBase + i];
      }
      Y[dim * K + k] = sum;
    }
  }
  for (let k = 0; k < K; k++) {
    let norm = 0;
    for (let dim = 0; dim < d; dim++) {
      norm += Y[dim * K + k] * Y[dim * K + k];
    }
    norm = Math.sqrt(norm);
    if (norm > 1e-14) {
      const invNorm = 1 / norm;
      for (let dim = 0; dim < d; dim++) {
        Y[dim * K + k] *= invNorm;
      }
    }
  }
}

function updateR(dist_mat, sigma, theta, R, O, E, Pr_b,
                 batchOfCell, K, B, N, blockSize, seed) {
  const scale_dist = new Float64Array(K * N);
  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (let k = 0; k < K; k++) {
      const val = Math.exp(-dist_mat[k * N + i] / sigma[k]);
      scale_dist[k * N + i] = val;
      sum += val;
    }
    if (sum > 1e-300) {
      const invSum = 1 / sum;
      for (let k = 0; k < K; k++) {
        scale_dist[k * N + i] *= invSum;
      }
    }
  }

  const order = new Int32Array(N);
  for (let i = 0; i < N; i++) order[i] = i;
  const rng = seedRandom(seed);
  for (let i = N - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }

  const cellsPerBlock = Math.max(1, Math.floor(N * blockSize));
  const nBlocks = Math.ceil(N / cellsPerBlock);
  const divFactor = new Float64Array(K * B);

  for (let blk = 0; blk < nBlocks; blk++) {
    const idxMin = blk * cellsPerBlock;
    const idxMax = Math.min((blk + 1) * cellsPerBlock, N);

    for (let k = 0; k < K; k++) {
      let rSum = 0;
      for (let ci = idxMin; ci < idxMax; ci++) {
        const cell = order[ci];
        const r = R[k * N + cell];
        rSum += r;
        O[k * B + batchOfCell[cell]] -= r;
      }
      for (let b = 0; b < B; b++) {
        E[k * B + b] -= rSum * Pr_b[b];
      }
    }

    for (let k = 0; k < K; k++) {
      for (let b = 0; b < B; b++) {
        const e = Math.max(E[k * B + b], 1e-8);
        const o = Math.max(O[k * B + b], 1e-8);
        const ratio = Math.max(e / (o + e), 1e-8);
        divFactor[k * B + b] = Math.pow(ratio, theta[b]);
      }
    }

    for (let ci = idxMin; ci < idxMax; ci++) {
      const cell = order[ci];
      const b = batchOfCell[cell];
      let colSum = 0;
      for (let k = 0; k < K; k++) {
        R[k * N + cell] = scale_dist[k * N + cell] * divFactor[k * B + b];
        colSum += R[k * N + cell];
      }
      colSum = Math.max(colSum, 1e-300);
      const invSum = 1 / colSum;
      for (let k = 0; k < K; k++) {
        R[k * N + cell] *= invSum;
      }
    }

    for (let k = 0; k < K; k++) {
      let rSum = 0;
      for (let ci = idxMin; ci < idxMax; ci++) {
        const cell = order[ci];
        const r = R[k * N + cell];
        rSum += r;
        O[k * B + batchOfCell[cell]] += r;
      }
      for (let b = 0; b < B; b++) {
        E[k * B + b] += rSum * Pr_b[b];
      }
    }
  }
}

function moeCorrectRidge(Z_orig, Z_corr, Z_cos, R, Phi_moe, batchIndex,
                         lamb, d, N, K, B) {
  const Bp1 = B + 1;
  Z_corr.set(Z_orig);

  for (let k = 0; k < K; k++) {
    const cov = new Float64Array(Bp1 * Bp1);
    for (let r = 0; r < Bp1; r++) {
      for (let c = r; c < Bp1; c++) {
        let sum = 0;
        for (let i = 0; i < N; i++) {
          sum += Phi_moe[r * N + i] * R[k * N + i] * Phi_moe[c * N + i];
        }
        cov[r * Bp1 + c] = sum;
        cov[c * Bp1 + r] = sum;
      }
    }
    for (let r = 0; r < Bp1; r++) {
      cov[r * Bp1 + r] += lamb[r];
    }

    const invCov = invertSmallMatrix(cov, Bp1);

    const z_sums = new Float64Array(Bp1 * d);

    for (let i = 0; i < N; i++) {
      const rk = R[k * N + i];
      for (let dim = 0; dim < d; dim++) {
        z_sums[dim] += Z_orig[dim * N + i] * rk;
      }
    }
    for (let b = 0; b < B; b++) {
      const cells = batchIndex[b];
      for (let ci = 0; ci < cells.length; ci++) {
        const i = cells[ci];
        const rk = R[k * N + i];
        for (let dim = 0; dim < d; dim++) {
          z_sums[(b + 1) * d + dim] += Z_orig[dim * N + i] * rk;
        }
      }
    }

    const W = new Float64Array(Bp1 * d);
    for (let r = 0; r < Bp1; r++) {
      for (let dim = 0; dim < d; dim++) {
        let sum = 0;
        for (let c = 0; c < Bp1; c++) {
          sum += invCov[r * Bp1 + c] * z_sums[c * d + dim];
        }
        W[r * d + dim] = sum;
      }
    }

    for (let dim = 0; dim < d; dim++) {
      W[dim] = 0;
    }

    for (let i = 0; i < N; i++) {
      const rk = R[k * N + i];
      if (rk < 1e-15) continue;
      for (let dim = 0; dim < d; dim++) {
        let correction = 0;
        for (let r = 0; r < Bp1; r++) {
          correction += W[r * d + dim] * Phi_moe[r * N + i];
        }
        Z_corr[dim * N + i] -= correction * rk;
      }
    }
  }

  l2Normalize(Z_corr, d, N, Z_cos);
}

function invertSmallMatrix(A, n) {
  const aug = new Float64Array(n * 2 * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      aug[i * 2 * n + j] = A[i * n + j];
    }
    aug[i * 2 * n + n + i] = 1;
  }

  for (let col = 0; col < n; col++) {
    let maxVal = Math.abs(aug[col * 2 * n + col]);
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      const val = Math.abs(aug[row * 2 * n + col]);
      if (val > maxVal) { maxVal = val; maxRow = row; }
    }
    if (maxRow !== col) {
      for (let j = 0; j < 2 * n; j++) {
        const t = aug[col * 2 * n + j];
        aug[col * 2 * n + j] = aug[maxRow * 2 * n + j];
        aug[maxRow * 2 * n + j] = t;
      }
    }

    const pivot = aug[col * 2 * n + col];
    if (Math.abs(pivot) < 1e-14) continue;
    const invPivot = 1 / pivot;
    for (let j = 0; j < 2 * n; j++) aug[col * 2 * n + j] *= invPivot;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row * 2 * n + col];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) {
        aug[row * 2 * n + j] -= factor * aug[col * 2 * n + j];
      }
    }
  }

  const inv = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      inv[i * n + j] = aug[i * 2 * n + n + j];
    }
  }
  return inv;
}

function kmeanspp(Z_cos, d, N, K, maxIter, seed) {
  const rng = seedRandom(seed);
  const centroids = new Float64Array(K * d);
  const assignments = new Int32Array(N);

  const first = Math.floor(rng() * N);
  for (let dim = 0; dim < d; dim++) {
    centroids[dim] = Z_cos[dim * N + first];
  }

  const minDist = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let dist = 0;
    for (let dim = 0; dim < d; dim++) {
      const diff = Z_cos[dim * N + i] - centroids[dim];
      dist += diff * diff;
    }
    minDist[i] = dist;
  }

  for (let k = 1; k < K; k++) {
    let totalDist = 0;
    for (let i = 0; i < N; i++) totalDist += minDist[i];

    let target = rng() * totalDist;
    let chosen = N - 1;
    for (let i = 0; i < N; i++) {
      target -= minDist[i];
      if (target <= 0) { chosen = i; break; }
    }

    for (let dim = 0; dim < d; dim++) {
      centroids[k * d + dim] = Z_cos[dim * N + chosen];
    }

    for (let i = 0; i < N; i++) {
      let dist = 0;
      for (let dim = 0; dim < d; dim++) {
        const diff = Z_cos[dim * N + i] - centroids[k * d + dim];
        dist += diff * diff;
      }
      if (dist < minDist[i]) minDist[i] = dist;
    }
  }

  const counts = new Float64Array(K);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = 0;
    for (let i = 0; i < N; i++) {
      let bestK = 0;
      let bestDist = Infinity;
      for (let k = 0; k < K; k++) {
        let dist = 0;
        for (let dim = 0; dim < d; dim++) {
          const diff = Z_cos[dim * N + i] - centroids[k * d + dim];
          dist += diff * diff;
        }
        if (dist < bestDist) { bestDist = dist; bestK = k; }
      }
      if (assignments[i] !== bestK) changed++;
      assignments[i] = bestK;
    }

    if (changed === 0) break;

    centroids.fill(0);
    counts.fill(0);
    for (let i = 0; i < N; i++) {
      const k = assignments[i];
      counts[k]++;
      for (let dim = 0; dim < d; dim++) {
        centroids[k * d + dim] += Z_cos[dim * N + i];
      }
    }
    for (let k = 0; k < K; k++) {
      if (counts[k] > 0) {
        const inv = 1 / counts[k];
        for (let dim = 0; dim < d; dim++) {
          centroids[k * d + dim] *= inv;
        }
      }
    }
  }

  return centroids;
}

function seedRandom(seed) {
  let state = seed | 0;
  return function () {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
