/**
 * Utility functions for loading and transforming histology images
 */

/**
 * Apply a 3×3 transformation matrix to a point in homogeneous coordinates
 * @param {number[][]} matrix: 3×3 transformation matrix
 * @param {number} x: X coordinate
 * @param {number} y: Y coordinate
 * @returns {[number, number]}: Transformed [x, y] coordinates
 */
export function transformPoint(matrix, x, y) {
  // Apply matrix multiplication in homogeneous coordinates
  // [x', y', 1]^T = matrix * [x, y, 1]^T
  const xPrime = matrix[0][0] * x + matrix[0][1] * y + matrix[0][2];
  const yPrime = matrix[1][0] * x + matrix[1][1] * y + matrix[1][2];
  // The w component (matrix[2][0] * x + matrix[2][1] * y + matrix[2][2]) should be 1 for affine transforms
  return [xPrime, yPrime];
}

/**
 * Apply transformation matrix to image bounds
 * @param {number[][]} matrix: 3×3 transformation matrix
 * @param {number} imageWidth: Original image width in pixels
 * @param {number} imageHeight: Original image height in pixels
 * @returns {Object}: Transformed bounds {xMin, yMin, xMax, yMax}
 */
export function transformImageBounds(matrix, imageWidth, imageHeight) {
  // Transform the four corners of the image
  const corners = [
    [0, 0],                    // top-left
    [imageWidth, 0],           // top-right
    [imageWidth, imageHeight], // bottom-right
    [0, imageHeight],          // bottom-left
  ];

  const transformedCorners = corners.map(([x, y]) => transformPoint(matrix, x, y));

  // Find the bounding box of transformed corners
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

/**
 * Create a tile-based representation of an image for efficient rendering
 * For very large images, we create logical tiles that can be loaded on demand
 * @param {number} imageWidth: Image width in pixels
 * @param {number} imageHeight: Image height in pixels
 * @param {number[][]} matrix: 3×3 transformation matrix
 * @param {number} tileSize: Size of each tile in pixels (default: 512)
 * @returns {Object}: Tile information including transformed bounds
 */
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

      // Transform the four corners of the tile
      const corners = [
        [tileX, tileY],
        [tileX + tileWidth, tileY],
        [tileX + tileWidth, tileY + tileHeight],
        [tileX, tileY + tileHeight],
      ];

      const transformedCorners = corners.map(([x, y]) => transformPoint(matrix, x, y));

      // Calculate bounding box for this tile
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

  // Calculate overall bounds
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

/**
 * Check if a tile is visible in the viewport
 * @param {Object} tile: Tile object with bounds
 * @param {Object} viewport: Viewport bounds {xMin, yMin, xMax, yMax}
 * @returns {boolean}: Whether the tile is visible
 */
export function isTileVisible(tile, viewport) {
  return !(
    tile.bounds.xMax < viewport.xMin ||
    tile.bounds.xMin > viewport.xMax ||
    tile.bounds.yMax < viewport.yMin ||
    tile.bounds.yMin > viewport.yMax
  );
}

