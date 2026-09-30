export function transformPoint(matrix, x, y) {
  const xPrime = matrix[0][0] * x + matrix[0][1] * y + matrix[0][2];
  const yPrime = matrix[1][0] * x + matrix[1][1] * y + matrix[1][2];
  return [xPrime, yPrime];
}

export function transformImageBounds(matrix, imageWidth, imageHeight) {
  const corners = [
    [0, 0],
    [imageWidth, 0],
    [imageWidth, imageHeight],
    [0, imageHeight],
  ];

  const transformedCorners = corners.map(([x, y]) => transformPoint(matrix, x, y));

  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  for (const [x, y] of transformedCorners) {
    xMin = Math.min(xMin, x);
    xMax = Math.max(xMax, x);
    yMin = Math.min(yMin, y);
    yMax = Math.max(yMax, y);
  }

  return { xMin, yMin, xMax, yMax };
}

export function createImageTiles(imageWidth, imageHeight, matrix, tileSize = 512) {
  const tiles = [];
  const numTilesX = Math.ceil(imageWidth / tileSize);
  const numTilesY = Math.ceil(imageHeight / tileSize);

  for (let ty = 0; ty < numTilesY; ty++) {
    for (let tx = 0; tx < numTilesX; tx++) {
      const tileX = tx * tileSize;
      const tileY = ty * tileSize;
      const tileWidth = Math.min(tileSize, imageWidth - tileX);
      const tileHeight = Math.min(tileSize, imageHeight - tileY);

      const corners = [
        [tileX, tileY],
        [tileX + tileWidth, tileY],
        [tileX + tileWidth, tileY + tileHeight],
        [tileX, tileY + tileHeight],
      ];

      const transformedCorners = corners.map(([x, y]) => transformPoint(matrix, x, y));

      let xMin = Number.POSITIVE_INFINITY;
      let xMax = Number.NEGATIVE_INFINITY;
      let yMin = Number.POSITIVE_INFINITY;
      let yMax = Number.NEGATIVE_INFINITY;

      for (const [x, y] of transformedCorners) {
        xMin = Math.min(xMin, x);
        xMax = Math.max(xMax, x);
        yMin = Math.min(yMin, y);
        yMax = Math.max(yMax, y);
      }

      tiles.push({
        tileX: tx,
        tileY: ty,
        sourceX: tileX,
        sourceY: tileY,
        sourceWidth: tileWidth,
        sourceHeight: tileHeight,
        bounds: { xMin, yMin, xMax, yMax },
        transformedCorners,
      });
    }
  }

  let overallXMin = Number.POSITIVE_INFINITY;
  let overallXMax = Number.NEGATIVE_INFINITY;
  let overallYMin = Number.POSITIVE_INFINITY;
  let overallYMax = Number.NEGATIVE_INFINITY;

  for (const tile of tiles) {
    overallXMin = Math.min(overallXMin, tile.bounds.xMin);
    overallXMax = Math.max(overallXMax, tile.bounds.xMax);
    overallYMin = Math.min(overallYMin, tile.bounds.yMin);
    overallYMax = Math.max(overallYMax, tile.bounds.yMax);
  }

  return {
    tiles,
    bounds: {
      xMin: overallXMin,
      yMin: overallYMin,
      xMax: overallXMax,
      yMax: overallYMax,
    },
    numTilesX,
    numTilesY,
    tileSize,
  };
}

export function isTileVisible(tile, viewport) {
  return !(
    tile.bounds.xMax < viewport.xMin ||
    tile.bounds.xMin > viewport.xMax ||
    tile.bounds.yMax < viewport.yMin ||
    tile.bounds.yMin > viewport.yMax
  );
}

