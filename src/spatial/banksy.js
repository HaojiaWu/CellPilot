export function buildSpatialKNN(coords, k) {
  const nCells = coords.length;
  if (nCells === 0) throw new Error('Empty coordinate array');
  const kActual = Math.min(k, nCells - 1);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < nCells; i++) {
    const [x, y] = coords[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

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

    const heap = [];
    let radius = 1;

    while (heap.length < kActual + 1) {
      const gxMin = Math.max(0, gx - radius);
      const gxMax = Math.min(gridRes - 1, gx + radius);
      const gyMin = Math.max(0, gy - radius);
      const gyMax = Math.min(gridRes - 1, gy + radius);

      for (let gy2 = gyMin; gy2 <= gyMax; gy2++) {
        for (let gx2 = gxMin; gx2 <= gxMax; gx2++) {
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

export function computeRowNormalizedWeights(indices, distances, nCells, k) {
  const rowPtr = new Int32Array(nCells + 1);
  const weightIndices = new Int32Array(nCells * k);
  const weightValues = new Float32Array(nCells * k);

  for (let i = 0; i < nCells; i++) {
    const base = i * k;

    const dists = new Float64Array(k);
    for (let ki = 0; ki < k; ki++) dists[ki] = distances[base + ki];
    dists.sort();
    const medDist2 = dists[Math.floor(k / 2)] || 1e-10;

    let sumW = 0;
    for (let ki = 0; ki < k; ki++) {
      const d2 = distances[base + ki];
      const w = Math.exp(-d2 / medDist2);
      weightValues[base + ki] = w;
      sumW += w;
    }

    const invSum = sumW > 1e-12 ? 1 / sumW : 0;
    for (let ki = 0; ki < k; ki++) {
      weightIndices[base + ki] = indices[base + ki];
      weightValues[base + ki] *= invSum;
    }

    rowPtr[i + 1] = rowPtr[i] + k;
  }

  return { weightIndices, weightValues, rowPtr };
}

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

export function colZScore(M, nCells, nGenes) {
  const out = new Float32Array(nCells * nGenes);

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
    if (std[g] < 1e-10) std[g] = 1;
  }

  for (let i = 0; i < nCells; i++) {
    const base = i * nGenes;
    for (let g = 0; g < nGenes; g++) {
      out[base + g] = (M[base + g] - mean[g]) / std[g];
    }
  }

  return out;
}

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

export function randomizedPCA(matrix, nCells, nFeatures, nComponents, nIter = 3, randomFn = Math.random) {
  const k = Math.min(nComponents, nCells - 1, nFeatures - 1);
  const l = Math.min(k + 10, Math.min(nCells, nFeatures));

  const featureMeans = new Float64Array(nFeatures);
  for (let i = 0; i < nCells; i++) {
    const base = i * nFeatures;
    for (let f = 0; f < nFeatures; f++) featureMeans[f] += matrix[base + f];
  }
  for (let f = 0; f < nFeatures; f++) featureMeans[f] /= nCells;

  function randn() {
    const u1 = Math.max(1e-15, randomFn());
    const u2 = randomFn();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  const Omega = new Float64Array(nFeatures * l);
  for (let i = 0; i < nFeatures * l; i++) Omega[i] = randn();

  function computeY(Omg) {
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

  function computeAtQ(Q) {
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
    for (let f = 0; f < nFeatures; f++) {
      const m = featureMeans[f];
      if (m === 0) continue;
      for (let j = 0; j < l; j++) AtQ[f * l + j] -= m * colSums[j];
    }
    return AtQ;
  }

  function qrDecomp(A, nRows) {
    const Q = new Float64Array(A);
    for (let j = 0; j < l; j++) {
      for (let p = 0; p < j; p++) {
        let dot = 0;
        for (let i = 0; i < nRows; i++) dot += Q[i * l + p] * Q[i * l + j];
        for (let i = 0; i < nRows; i++) Q[i * l + j] -= dot * Q[i * l + p];
      }
      let norm = 0;
      for (let i = 0; i < nRows; i++) norm += Q[i * l + j] * Q[i * l + j];
      norm = Math.sqrt(norm);
      const inv = norm > 1e-14 ? 1 / norm : 0;
      for (let i = 0; i < nRows; i++) Q[i * l + j] *= inv;
    }
    return Q;
  }

  let Q = qrDecomp(computeY(Omega), nCells);
  for (let iter = 0; iter < nIter; iter++) {
    const Z = computeAtQ(Q);
    const Zq = qrDecomp(Z, nFeatures);
    Q = qrDecomp(computeY(Zq), nCells);
  }

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

  const BBt = new Float64Array(l * l);
  for (let p = 0; p < l; p++) {
    for (let q = p; q < l; q++) {
      let dot = 0;
      for (let f = 0; f < nFeatures; f++) dot += B[p * nFeatures + f] * B[q * nFeatures + f];
      BBt[p * l + q] = dot;
      BBt[q * l + p] = dot;
    }
  }

  const eigvecs = new Float64Array(l * k);
  const eigvals = new Float64Array(k);

  const BBtCopy = BBt.slice();
  for (let c = 0; c < k; c++) {
    let v = new Float64Array(l);
    v[c % l] = 1;
    for (let iter = 0; iter < 100; iter++) {
      const u = new Float64Array(l);
      for (let p = 0; p < l; p++) {
        for (let q = 0; q < l; q++) u[p] += BBtCopy[p * l + q] * v[q];
      }
      for (let prev = 0; prev < c; prev++) {
        let dot = 0;
        for (let p = 0; p < l; p++) dot += eigvecs[p * k + prev] * u[p];
        for (let p = 0; p < l; p++) u[p] -= dot * eigvecs[p * k + prev];
      }
      let norm = 0;
      for (let p = 0; p < l; p++) norm += u[p] * u[p];
      norm = Math.sqrt(norm);
      if (norm < 1e-14) break;
      const inv = 1 / norm;
      v = u;
      for (let p = 0; p < l; p++) v[p] *= inv;
    }
    let eig = 0;
    for (let p = 0; p < l; p++) {
      let Bv = 0;
      for (let q = 0; q < l; q++) Bv += BBtCopy[p * l + q] * v[q];
      eig += v[p] * Bv;
    }
    eigvals[c] = eig;
    for (let p = 0; p < l; p++) eigvecs[p * k + c] = v[p];

    for (let p = 0; p < l; p++) {
      for (let q = 0; q < l; q++) BBtCopy[p * l + q] -= eig * v[p] * v[q];
    }
  }

  const cellEmbeddings = new Float64Array(nCells * k);
  for (let i = 0; i < nCells; i++) {
    const qBase = i * l;
    const eBase = i * k;
    for (let c = 0; c < k; c++) {
      let val = 0;
      for (let j = 0; j < l; j++) val += Q[qBase + j] * eigvecs[j * k + c];
      const sv = Math.sqrt(Math.max(0, eigvals[c]));
      cellEmbeddings[eBase + c] = val * sv;
    }
  }

  return { cellEmbeddings, nCells, nComponents: k };
}

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
