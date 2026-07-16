/**
 * BANKSY: Binning Area Neighborhood Kernel SpatiallY
 * JavaScript reimplementation for CellPilot spatial region segmentation.
 *
 * Reference: Singhal et al. 2024, Nature Genetics
 * https://www.nature.com/articles/s41588-024-01664-3
 *
 * Algorithm overview:
 *  1. Build spatial k-NN graph with Gaussian distance weights
 *  2. Compute neighbor mean expression matrix N = W @ X
 *  3. Z-score X and N independently per gene
 *  4. Build BANKSY matrix: [sqrt(1-lambda)*zscore(X) | sqrt(lambda)*zscore(N)]
 *  5. PCA on BANKSY matrix (randomized SVD)
 *  6. Return PCA embeddings for downstream SNN clustering
 *
 * Key parameter: lambda (default 0.3)
 * 0 = pure transcriptomic clustering (ignores spatial context)
 * 1 = pure spatial averaging (ignores individual cell identity)
 * 0.3 = balanced, recommended for region segmentation
 */

// ---------------------------------------------------------------------------
// Spatial k-NN
// ---------------------------------------------------------------------------

/**
 * Build a 2D spatial k-NN graph using a grid-accelerated search.
 * Returns for each cell: indices of k nearest neighbors + squared distances.
 *
 * @param {Array<[number,number]>} coords: Array of [x, y] coordinate pairs
 * @param {number} k: Number of nearest neighbors
 * @returns {{ indices: Int32Array, distances: Float64Array }}
 *   Flat arrays: indices[i*k .. i*k+k] are neighbor indices for cell i,
 *                distances[i*k .. i*k+k] are corresponding squared distances.
 */
export function buildSpatialKNN(coords, k) {
  const nCells = coords.length;
  if (nCells === 0) throw new Error('Empty coordinate array');
  const kActual = Math.min(k, nCells - 1);

  // Compute bounding box
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < nCells; i++) {
    const [x, y] = coords[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  // Build grid for fast neighbor lookup
  // Target ~5-10 cells per grid cell on average
  const gridRes = Math.max(1, Math.ceil(Math.sqrt(nCells / 8)));
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  const grid = new Array(gridRes * gridRes).fill(null).map(() => []);
  const cellGrid = new Int32Array(nCells);

  for (let i = 0; i < nCells; i++) {
    const gx = Math.min(gridRes - 1, Math.floor((coords[i][0] - minX) / rangeX * gridRes));
    const gy = Math.min(gridRes - 1, Math.floor((coords[i][1] - minY) / rangeY * gridRes));
    const gi = gy * gridRes + gx;
    cellGrid[i] = gi;
    grid[gi].push(i);
  }

  const indices = new Int32Array(nCells * kActual);
  const distances = new Float64Array(nCells * kActual);

  for (let i = 0; i < nCells; i++) {
    const [xi, yi] = coords[i];
    const gx = Math.min(gridRes - 1, Math.floor((xi - minX) / rangeX * gridRes));
    const gy = Math.min(gridRes - 1, Math.floor((yi - minY) / rangeY * gridRes));

    // Candidate neighbors, expand search radius until we have enough
    const heap = []; // max-heap of [dist2, idx]
    let radius = 1;

    while (heap.length < kActual + 1) {
      const gxMin = Math.max(0, gx - radius);
      const gxMax = Math.min(gridRes - 1, gx + radius);
      const gyMin = Math.max(0, gy - radius);
      const gyMax = Math.min(gridRes - 1, gy + radius);

      for (let gy2 = gyMin; gy2 <= gyMax; gy2++) {
        for (let gx2 = gxMin; gx2 <= gxMax; gx2++) {
          // Only process border cells on expansion to avoid re-visiting interior
          if (radius > 1 && gx2 > gxMin && gx2 < gxMax && gy2 > gyMin && gy2 < gyMax) continue;
          const candidates = grid[gy2 * gridRes + gx2];
          for (const j of candidates) {
            if (j === i) continue;
            const dx = xi - coords[j][0];
            const dy = yi - coords[j][1];
            const d2 = dx * dx + dy * dy;
            heap.push([d2, j]);
          }
        }
      }
      radius++;
      if (radius > gridRes) break;
    }

    // Sort and take top kActual
    heap.sort((a, b) => a[0] - b[0]);
    const base = i * kActual;
    for (let ki = 0; ki < kActual; ki++) {
      if (ki < heap.length) {
        indices[base + ki] = heap[ki][1];
        distances[base + ki] = heap[ki][0];
      } else {
        indices[base + ki] = 0;
        distances[base + ki] = 0;
      }
    }
  }

  return { indices, distances, k: kActual };
}

// ---------------------------------------------------------------------------
// Gaussian weights + row normalization
// ---------------------------------------------------------------------------

/**
 * Compute row-normalized Gaussian weights from kNN distances.
 * For each cell i: w_ij = exp(-(d_ij / median_di)^2), normalized so sum = 1.
 *
 * @param {Int32Array} indices: flat kNN indices (nCells × k)
 * @param {Float64Array} distances: flat squared kNN distances (nCells × k)
 * @param {number} nCells
 * @param {number} k
 * @returns {{ weightIndices: Int32Array, weightValues: Float32Array, rowPtr: Int32Array }}
 */
export function computeRowNormalizedWeights(indices, distances, nCells, k) {
  const rowPtr = new Int32Array(nCells + 1);
  const weightIndices = new Int32Array(nCells * k);
  const weightValues = new Float32Array(nCells * k);

  for (let i = 0; i < nCells; i++) {
    const base = i * k;

    // buildSpatialKNN stores squared distances. For BANKSY's kNN_median
    // kernel, exp(-distance^2 / median(distance)^2), median(distance)^2 is
    // equal to median(distance^2) for non-negative sorted distances.
    const dists = new Float64Array(k);
    for (let ki = 0; ki < k; ki++) dists[ki] = distances[base + ki];
    dists.sort();
    const medDist2 = dists[Math.floor(k / 2)] || 1e-10;

    // Gaussian weights
    let sumW = 0;
    for (let ki = 0; ki < k; ki++) {
      const d2 = distances[base + ki];
      const w = Math.exp(-d2 / medDist2);
      weightValues[base + ki] = w;
      sumW += w;
    }

    // Row-normalize
    const invSum = sumW > 1e-12 ? 1 / sumW : 0;
    for (let ki = 0; ki < k; ki++) {
      weightIndices[base + ki] = indices[base + ki];
      weightValues[base + ki] *= invSum;
    }

    rowPtr[i + 1] = rowPtr[i] + k;
  }

  return { weightIndices, weightValues, rowPtr };
}

// ---------------------------------------------------------------------------
// Neighbor mean matrix: N = W @ X
// ---------------------------------------------------------------------------

/**
 * Compute neighbor mean expression matrix N = W @ X.
 * X is stored row-major: X[cell * nGenes + gene].
 *
 * @param {Int32Array} weightIndices: sparse weight col indices (nCells × k)
 * @param {Float32Array} weightValues: sparse weight values (nCells × k)
 * @param {Float32Array} X: expression matrix (nCells × nGenes), row-major
 * @param {number} nCells
 * @param {number} nGenes
 * @param {number} k
 * @returns {Float32Array} N: neighbor mean matrix (nCells × nGenes), row-major
 */
export function computeNeighborMatrix(weightIndices, weightValues, X, nCells, nGenes, k) {
  const N = new Float32Array(nCells * nGenes);

  for (let i = 0; i < nCells; i++) {
    const base = i * k;
    const rowBase = i * nGenes;

    for (let ki = 0; ki < k; ki++) {
      const j = weightIndices[base + ki];
      const w = weightValues[base + ki];
      const jBase = j * nGenes;

      for (let g = 0; g < nGenes; g++) {
        N[rowBase + g] += w * X[jBase + g];
      }
    }
  }

  return N;
}

// ---------------------------------------------------------------------------
// Column-wise z-score
// ---------------------------------------------------------------------------

/**
 * Z-score matrix columns (per gene, across cells).
 * Modifies the matrix in place.
 * Returns a new Float32Array with z-scored values.
 *
 * @param {Float32Array} M: matrix (nCells × nGenes), row-major
 * @param {number} nCells
 * @param {number} nGenes
 * @returns {Float32Array} z-scored copy
 */
export function colZScore(M, nCells, nGenes) {
  const out = new Float32Array(nCells * nGenes);

  // Compute per-gene mean and std
  const mean = new Float64Array(nGenes);
  const std = new Float64Array(nGenes);

  for (let i = 0; i < nCells; i++) {
    const base = i * nGenes;
    for (let g = 0; g < nGenes; g++) mean[g] += M[base + g];
  }
  for (let g = 0; g < nGenes; g++) mean[g] /= nCells;

  for (let i = 0; i < nCells; i++) {
    const base = i * nGenes;
    for (let g = 0; g < nGenes; g++) {
      const d = M[base + g] - mean[g];
      std[g] += d * d;
    }
  }
  for (let g = 0; g < nGenes; g++) {
    std[g] = Math.sqrt(std[g] / Math.max(nCells - 1, 1));
    if (std[g] < 1e-10) std[g] = 1; // avoid div-by-zero for zero-variance genes
  }

  for (let i = 0; i < nCells; i++) {
    const base = i * nGenes;
    for (let g = 0; g < nGenes; g++) {
      out[base + g] = (M[base + g] - mean[g]) / std[g];
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// BANKSY matrix assembly
// ---------------------------------------------------------------------------

/**
 * Assemble BANKSY matrix from own expression and neighbor mean.
 *
 * banksyMatrix = [sqrt(1-lambda) * zscore(X) | sqrt(lambda) * zscore(N)]
 * Shape: nCells × (2 * nGenes), row-major
 *
 * @param {Float32Array} X: own expression (nCells × nGenes), row-major
 * @param {Float32Array} N: neighbor mean (nCells × nGenes), row-major
 * @param {number} lambda: neighborhood contribution weight (default 0.3)
 * @param {number} nCells
 * @param {number} nGenes
 * @returns {Float32Array} BANKSY matrix (nCells × 2*nGenes), row-major
 */
export function buildBanksyMatrix(X, N, lambda, nCells, nGenes) {
  const zX = colZScore(X, nCells, nGenes);
  const zN = colZScore(N, nCells, nGenes);

  const scaleX = Math.sqrt(1 - lambda);
  const scaleN = Math.sqrt(lambda);

  const nFeatures = 2 * nGenes;
  const out = new Float32Array(nCells * nFeatures);

  for (let i = 0; i < nCells; i++) {
    const inBase = i * nGenes;
    const outBase = i * nFeatures;
    for (let g = 0; g < nGenes; g++) {
      out[outBase + g] = scaleX * zX[inBase + g];
      out[outBase + nGenes + g] = scaleN * zN[inBase + g];
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Randomized SVD / PCA (dense, row-major)
// ---------------------------------------------------------------------------

/**
 * Randomized truncated PCA on a dense matrix (nCells × nFeatures, row-major).
 * Uses power iteration for accuracy.
 *
 * Returns cell embeddings in PCA space: Float64Array of shape nCells × nComponents.
 *
 * @param {Float32Array} matrix: input matrix (nCells × nFeatures), row-major
 * @param {number} nCells
 * @param {number} nFeatures
 * @param {number} nComponents: number of PCA components to compute
 * @param {number} nIter: power iteration steps (3 is usually enough)
 * @param {Function} [randomFn]: seeded PRNG (defaults to Math.random)
 * @returns {Float64Array} cellEmbeddings (nCells × nComponents, row-major)
 */
export function randomizedPCA(matrix, nCells, nFeatures, nComponents, nIter = 3, randomFn = Math.random) {
  const k = Math.min(nComponents, nCells - 1, nFeatures - 1);
  const l = Math.min(k + 10, Math.min(nCells, nFeatures)); // oversampling

  // 1. Column-center the matrix (subtract per-feature mean)
  const featureMeans = new Float64Array(nFeatures);
  for (let i = 0; i < nCells; i++) {
    const base = i * nFeatures;
    for (let f = 0; f < nFeatures; f++) featureMeans[f] += matrix[base + f];
  }
  for (let f = 0; f < nFeatures; f++) featureMeans[f] /= nCells;

  // 2. Random projection: Omega is (nFeatures × l), Gaussian
  // Box-Muller transform for normal distribution
  function randn() {
    const u1 = Math.max(1e-15, randomFn());
    const u2 = randomFn();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  const Omega = new Float64Array(nFeatures * l);
  for (let i = 0; i < nFeatures * l; i++) Omega[i] = randn();

  // Y = (A: mu) @ Omega: (nCells × l)
  // = A @ Omega: mu @ Omega (mu is broadcast as 1 × nFeatures)
  function computeY(Omg) {
    // mu_Omg = mu (1 × nFeatures) @ Omega (nFeatures × l) → 1 × l
    const muOmg = new Float64Array(l);
    for (let f = 0; f < nFeatures; f++) {
      const m = featureMeans[f];
      if (m === 0) continue;
      for (let j = 0; j < l; j++) muOmg[j] += m * Omg[f * l + j];
    }
    const Y = new Float64Array(nCells * l);
    for (let i = 0; i < nCells; i++) {
      const base = i * nFeatures;
      const outBase = i * l;
      for (let f = 0; f < nFeatures; f++) {
        const v = matrix[base + f];
        for (let j = 0; j < l; j++) Y[outBase + j] += v * Omg[f * l + j];
      }
      for (let j = 0; j < l; j++) Y[outBase + j] -= muOmg[j];
    }
    return Y;
  }

  // A^T @ Q: mu^T @ (1^T @ Q)
  function computeAtQ(Q) {
    // 1^T @ Q: col sums of Q (l × 1 → nCells-sum per col)
    const colSums = new Float64Array(l);
    for (let i = 0; i < nCells; i++) {
      const base = i * l;
      for (let j = 0; j < l; j++) colSums[j] += Q[base + j];
    }
    const AtQ = new Float64Array(nFeatures * l);
    for (let i = 0; i < nCells; i++) {
      const base = i * nFeatures;
      const qBase = i * l;
      for (let f = 0; f < nFeatures; f++) {
        const v = matrix[base + f];
        for (let j = 0; j < l; j++) AtQ[f * l + j] += v * Q[qBase + j];
      }
    }
    // Subtract centering: AtQ[f,j] -= mu[f] * colSums[j]
    for (let f = 0; f < nFeatures; f++) {
      const m = featureMeans[f];
      if (m === 0) continue;
      for (let j = 0; j < l; j++) AtQ[f * l + j] -= m * colSums[j];
    }
    return AtQ;
  }

  // 3. QR decomposition (modified Gram-Schmidt)
  // In-place on A (nRows × l, row-major)
  function qrDecomp(A, nRows) {
    const Q = new Float64Array(A);
    for (let j = 0; j < l; j++) {
      // Orthogonalize column j against all previous columns
      for (let p = 0; p < j; p++) {
        let dot = 0;
        for (let i = 0; i < nRows; i++) dot += Q[i * l + p] * Q[i * l + j];
        for (let i = 0; i < nRows; i++) Q[i * l + j] -= dot * Q[i * l + p];
      }
      // Normalize
      let norm = 0;
      for (let i = 0; i < nRows; i++) norm += Q[i * l + j] * Q[i * l + j];
      norm = Math.sqrt(norm);
      const inv = norm > 1e-14 ? 1 / norm : 0;
      for (let i = 0; i < nRows; i++) Q[i * l + j] *= inv;
    }
    return Q;
  }

  // 4. Power iteration: Q ← orth(A (A^T Q))
  let Q = qrDecomp(computeY(Omega), nCells);
  for (let iter = 0; iter < nIter; iter++) {
    const Z = computeAtQ(Q); // nFeatures × l
    const Zq = qrDecomp(Z, nFeatures);
    Q = qrDecomp(computeY(Zq), nCells);
  }

  // 5. Project: B = Q^T A (l × nFeatures)
  // B[j,f] = sum_i Q[i,j] * (A[i,f]: mu[f])
  const colSumsQ = new Float64Array(l);
  for (let i = 0; i < nCells; i++) {
    const base = i * l;
    for (let j = 0; j < l; j++) colSumsQ[j] += Q[base + j];
  }
  const B = new Float64Array(l * nFeatures);
  for (let i = 0; i < nCells; i++) {
    const base = i * nFeatures;
    const qBase = i * l;
    for (let j = 0; j < l; j++) {
      const qij = Q[qBase + j];
      for (let f = 0; f < nFeatures; f++) B[j * nFeatures + f] += qij * matrix[base + f];
    }
  }
  for (let j = 0; j < l; j++) {
    for (let f = 0; f < nFeatures; f++) B[j * nFeatures + f] -= colSumsQ[j] * featureMeans[f];
  }

  // 6. SVD of small matrix B (l × nFeatures)
  // Compute B @ B^T (l × l), then eigendecompose
  const BBt = new Float64Array(l * l);
  for (let p = 0; p < l; p++) {
    for (let q = p; q < l; q++) {
      let dot = 0;
      for (let f = 0; f < nFeatures; f++) dot += B[p * nFeatures + f] * B[q * nFeatures + f];
      BBt[p * l + q] = dot;
      BBt[q * l + p] = dot;
    }
  }

  // Power iteration eigendecomposition for the top k eigenvectors of BBt
  // Simple Lanczos-style: deflation approach
  const eigvecs = new Float64Array(l * k); // l × k, row-major (each col is an eigenvec)
  const eigvals = new Float64Array(k);

  // Use QR iteration via Gram-Schmidt deflation for small l
  // For small l (≤40), this is fast enough
  const BBtCopy = BBt.slice();
  for (let c = 0; c < k; c++) {
    // Power iteration for dominant eigenvector
    let v = new Float64Array(l);
    v[c % l] = 1; // initial vector
    for (let iter = 0; iter < 100; iter++) {
      // u = BBt @ v
      const u = new Float64Array(l);
      for (let p = 0; p < l; p++) {
        for (let q = 0; q < l; q++) u[p] += BBtCopy[p * l + q] * v[q];
      }
      // Deflate previously found components
      for (let prev = 0; prev < c; prev++) {
        let dot = 0;
        for (let p = 0; p < l; p++) dot += eigvecs[p * k + prev] * u[p];
        for (let p = 0; p < l; p++) u[p] -= dot * eigvecs[p * k + prev];
      }
      // Normalize
      let norm = 0;
      for (let p = 0; p < l; p++) norm += u[p] * u[p];
      norm = Math.sqrt(norm);
      if (norm < 1e-14) break;
      const inv = 1 / norm;
      v = u;
      for (let p = 0; p < l; p++) v[p] *= inv;
    }
    // Rayleigh quotient for eigenvalue
    let eig = 0;
    for (let p = 0; p < l; p++) {
      let Bv = 0;
      for (let q = 0; q < l; q++) Bv += BBtCopy[p * l + q] * v[q];
      eig += v[p] * Bv;
    }
    eigvals[c] = eig;
    for (let p = 0; p < l; p++) eigvecs[p * k + c] = v[p];

    // Deflate BBtCopy by eig * v @ v^T
    for (let p = 0; p < l; p++) {
      for (let q = 0; q < l; q++) BBtCopy[p * l + q] -= eig * v[p] * v[q];
    }
  }

  // 7. Cell embeddings = Q @ U_k where U_k = eigvecs (l × k)
  // cellEmbeddings[i, c] = sum_j Q[i,j] * eigvecs[j,c]
  const cellEmbeddings = new Float64Array(nCells * k);
  for (let i = 0; i < nCells; i++) {
    const qBase = i * l;
    const eBase = i * k;
    for (let c = 0; c < k; c++) {
      let val = 0;
      for (let j = 0; j < l; j++) val += Q[qBase + j] * eigvecs[j * k + c];
      // Scale by singular value (sqrt of eigenvalue) to get proper PCA scores
      const sv = Math.sqrt(Math.max(0, eigvals[c]));
      cellEmbeddings[eBase + c] = val * sv;
    }
  }

  return { cellEmbeddings, nCells, nComponents: k };
}

// ---------------------------------------------------------------------------
// Main BANKSY entry point
// ---------------------------------------------------------------------------

/**
 * Run BANKSY region segmentation.
 *
 * @param {Object} params
 * @param {Array<[number,number]>} params.coords: Spatial coordinates [[x,y], ...]
 * @param {Float32Array} params.expressionMatrix: Dense expression matrix (nCells × nGenes), row-major
 *   Values should be log-normalized counts.
 * @param {number} params.nCells: Number of cells
 * @param {number} params.nGenes: Number of genes (features)
 * @param {number} [params.lambda=0.3]: Neighborhood contribution (0=transcriptomic, 1=spatial)
 * @param {number} [params.numNeighbors=15]: Number of spatial nearest neighbors
 * @param {number} [params.numPcaDims=20]: PCA dimensions for downstream clustering
 * @param {number} [params.pcaIter=3]: Randomized SVD power iteration steps
 * @param {Function} [params.statusCallback]: Progress callback fn(message)
 * @param {Function} [params.randomFn]: Seeded PRNG for reproducibility
 * @returns {{ cellEmbeddings: Float64Array, nCells: number, nComponents: number, kUsed: number }}
 */
export async function runBanksy(params) {
  const {
    coords,
    expressionMatrix,
    nCells,
    nGenes,
    lambda = 0.3,
    numNeighbors = 15,
    numPcaDims = 20,
    pcaIter = 3,
    statusCallback = null,
    randomFn = Math.random,
  } = params;

  const post = (msg) => { if (statusCallback) statusCallback(msg); };

  post(`BANKSY: Building spatial k-NN graph (k=${numNeighbors})...`);
  const { indices: knnIdx, distances: knnDist, k } = buildSpatialKNN(coords, numNeighbors);

  post(`BANKSY: Computing Gaussian neighborhood weights...`);
  const { weightIndices, weightValues } = computeRowNormalizedWeights(knnIdx, knnDist, nCells, k);

  post(`BANKSY: Computing neighbor mean expression matrix...`);
  const N = computeNeighborMatrix(weightIndices, weightValues, expressionMatrix, nCells, nGenes, k);

  post(`BANKSY: Building BANKSY matrix (lambda=${lambda})...`);
  const banksyMatrix = buildBanksyMatrix(expressionMatrix, N, lambda, nCells, nGenes);
  const nFeatures = 2 * nGenes;

  post(`BANKSY: Running PCA (${numPcaDims} components)...`);
  const { cellEmbeddings, nComponents } = randomizedPCA(
    banksyMatrix,
    nCells,
    nFeatures,
    numPcaDims,
    pcaIter,
    randomFn,
  );

  return { cellEmbeddings, nCells, nComponents, kUsed: k };
}
