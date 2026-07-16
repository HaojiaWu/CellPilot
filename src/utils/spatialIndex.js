/**
 * Spatial tiling utilities for progressive rendering of large point clouds.
 *
 * The index stores the full coordinate arrays plus a pyramid of sampled tiles.
 * Each level doubles the number of tiles on each axis, similar to a quadtree.
 * Tiles retain their true counts so callers can decide when to switch to
 * density rendering.
 */

const DEFAULT_OPTIONS = {
  maxLevels: 8,
  baseSamplesPerTile: 600,
  levelSampleMultiplier: 2,
  hardSampleCap: 20000,
  seed: 1337,
};

const EPS = 1e-9;

const randomMulberry32 = (seed) => {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

const createTile = (level, tileX, tileY, capacity, bounds) => ({
  level,
  tileX,
  tileY,
  bounds,
  capacity,
  totalCount: 0,
  sample: [],
  sumX: 0,
  sumY: 0,
});

const pushSample = (tile, index, rng) => {
  tile.totalCount += 1;
  if (tile.sample.length < tile.capacity) {
    tile.sample.push(index);
  } else if (tile.capacity > 0) {
    const replaceIdx = Math.floor(rng() * tile.totalCount);
    if (replaceIdx < tile.capacity) {
      tile.sample[replaceIdx] = index;
    }
  }
};

const finalizeTile = (tile) => {
  const { sample, totalCount, sumX, sumY } = tile;
  return {
    level: tile.level,
    tileX: tile.tileX,
    tileY: tile.tileY,
    bounds: tile.bounds,
    totalCount,
    sampleCount: sample.length,
    centroid: totalCount ? [sumX / totalCount, sumY / totalCount] : [0, 0],
    indices: Uint32Array.from(sample),
  };
};

export const buildSpatialIndex = (points, options = {}) => {
  if (!Array.isArray(points) || points.length === 0) {
    return null;
  }

  const cfg = { ...DEFAULT_OPTIONS, ...options };
  const rng = randomMulberry32(cfg.seed);

  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  const count = points.length;
  const xs = new Float32Array(count);
  const ys = new Float32Array(count);

  points.forEach((point, idx) => {
    // Handle null/undefined points gracefully
    if (point == null) {
      xs[idx] = 0;
      ys[idx] = 0;
      return;
    }
    const x = Array.isArray(point) ? point[0] : point.x;
    const y = Array.isArray(point) ? point[1] : point.y;
    const xVal = Number.isFinite(x) ? x : 0;
    const yVal = Number.isFinite(y) ? y : 0;
    xs[idx] = xVal;
    ys[idx] = yVal;
    if (xVal !== 0 || yVal !== 0) {
      xMin = Math.min(xMin, xVal);
      xMax = Math.max(xMax, xVal);
      yMin = Math.min(yMin, yVal);
      yMax = Math.max(yMax, yVal);
    }
  });

  // When all points are null/zero (e.g. CosMX 0 matches), use default bounds so we still return a valid index
  // and the spatial view can render (points stacked at origin) instead of showing nothing
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    xMin = 0;
    xMax = 1;
    yMin = 0;
    yMax = 1;
  }

  const width = Math.max(xMax - xMin, EPS);
  const height = Math.max(yMax - yMin, EPS);

  const levels = [];

  for (let level = 0; level < cfg.maxLevels; level += 1) {
    const tiles = new Map();
    const tileCount = 1 << level;
    const tileWidth = width / tileCount;
    const tileHeight = height / tileCount;
    const capacity = Math.min(
      Math.round(cfg.baseSamplesPerTile * Math.pow(cfg.levelSampleMultiplier, level)),
      cfg.hardSampleCap
    );

    for (let idx = 0; idx < count; idx += 1) {
      const x = xs[idx];
      const y = ys[idx];

      const tx = Math.min(tileCount - 1, Math.max(0, Math.floor((x - xMin) / tileWidth)));
      const ty = Math.min(tileCount - 1, Math.max(0, Math.floor((y - yMin) / tileHeight)));
      const key = `${tx}/${ty}`;

      let tile = tiles.get(key);
      if (!tile) {
        const bounds = {
          xMin: xMin + tx * tileWidth,
          xMax: xMin + (tx + 1) * tileWidth,
          yMin: yMin + ty * tileHeight,
          yMax: yMin + (ty + 1) * tileHeight,
        };
        tile = createTile(level, tx, ty, capacity, bounds);
        tiles.set(key, tile);
      }

      tile.sumX += x;
      tile.sumY += y;
      pushSample(tile, idx, rng);
    }

    const finalizedTiles = new Map();
    for (const [key, tile] of tiles.entries()) {
      finalizedTiles.set(key, finalizeTile(tile));
    }

    levels.push({
      level,
      tileCount,
      tileWidth,
      tileHeight,
      tiles: finalizedTiles,
    });
  }

  return {
    type: 'spatial-index',
    pointCount: count,
    bounds: { xMin, xMax, yMin, yMax, width, height },
    xs,
    ys,
    levels,
    options: cfg,
  };
};

const intersects = (a, b) => !(
  a.xMax < b.xMin ||
  a.xMin > b.xMax ||
  a.yMax < b.yMin ||
  a.yMin > b.yMax
);

const gatherForLevel = (index, level, viewBounds, options = {}) => {
  const { merge = true } = options;
  const levelInfo = index.levels[Math.max(0, Math.min(index.levels.length - 1, level))];
  let totalCount = 0;
  let sampleCount = 0;
  const chunks = merge ? [] : null;
  const tiles = [];

  for (const tile of levelInfo.tiles.values()) {
    if (!intersects(tile.bounds, viewBounds)) {
      continue;
    }
    totalCount += tile.totalCount;
    sampleCount += tile.sampleCount;
    if (tile.sampleCount > 0) {
      if (merge) {
        chunks.push(tile.indices);
      }
      tiles.push(tile);
    }
  }

  if (!sampleCount) {
    return {
      level: levelInfo.level,
      totalCount: 0,
      sampleCount: 0,
      indices: merge ? new Uint32Array(0) : null,
      tiles: [],
    };
  }

  let merged = null;
  if (merge && chunks.length) {
    merged = new Uint32Array(sampleCount);
    let offset = 0;
    for (const arr of chunks) {
      merged.set(arr, offset);
      offset += arr.length;
    }
  }

  return {
    level: levelInfo.level,
    totalCount,
    sampleCount,
    indices: merged,
    tiles,
  };
};

/**
 * Gather a sample suitable for point rendering. The function tries progressively
 * finer levels until the requested sample budget is exceeded, at which point it
 * falls back to the last acceptable level.
 */
export const gatherSamplesForViewport = (index, viewBounds, options = {}) => {
  if (!index) {
    return null;
  }
  const {
    maxSamples = 1_200_000,
    preferredLevel = null,
    merge = true,
  } = options;

  if (preferredLevel != null) {
    return gatherForLevel(index, preferredLevel, viewBounds, { merge });
  }

  let chosen = gatherForLevel(index, index.levels.length - 1, viewBounds, { merge });
  if (chosen.sampleCount <= maxSamples) {
    return chosen;
  }

  for (let level = index.levels.length - 2; level >= 0; level -= 1) {
    const candidate = gatherForLevel(index, level, viewBounds, { merge });
    if (candidate.sampleCount <= maxSamples) {
      return candidate;
    }
    chosen = candidate;
  }

  return chosen;
};

/**
 * Prepare a weight-scaled sample for density rendering. Each returned datum
 * contains the point index and a weight factor corresponding to the ratio
 * between the tile population and its sampled subset.
 */
export const gatherDensitySample = (index, viewBounds, options = {}) => {
  if (!index) {
    return null;
  }

  const { level = index.levels.length - 1 } = options;
  const levelInfo = index.levels[Math.max(0, Math.min(index.levels.length - 1, level))];

  const data = [];
  for (const tile of levelInfo.tiles.values()) {
    if (!intersects(tile.bounds, viewBounds) || tile.sampleCount === 0) {
      continue;
    }
    const weight = tile.totalCount / tile.sampleCount;
    for (const idx of tile.indices) {
      data.push({ index: idx, weight });
    }
  }

  return {
    level: levelInfo.level,
    totalCount: data.reduce((acc, d) => acc + d.weight, 0),
    data,
  };
};

export const defaultViewBounds = (index) => index?.bounds || null;


