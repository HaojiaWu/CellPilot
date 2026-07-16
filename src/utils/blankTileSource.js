/**
 * Creates a blank transparent tile source for OpenSeadragon
 * This allows using OSD for zoom/pan controls without requiring an actual image
 */

/**
 * Create a custom tile source that returns transparent tiles
 * @param {number} width: Width of the virtual canvas in pixels
 * @param {number} height: Height of the virtual canvas in pixels
 * @param {number} tileSize: Size of each tile (default 256)
 * @returns {Object} OpenSeadragon custom tile source configuration
 */
export function createBlankTileSource(width = 1000, height = 1000, tileSize = 256) {
  // Create a single transparent tile canvas
  const tileCanvas = document.createElement('canvas');
  tileCanvas.width = tileSize;
  tileCanvas.height = tileSize;
  const ctx = tileCanvas.getContext('2d');
  ctx.clearRect(0, 0, tileSize, tileSize);
  const blankTileDataUrl = tileCanvas.toDataURL();

  return {
    width: width,
    height: height,
    tileSize: tileSize,
    tileOverlap: 0,
    minLevel: 0,
    maxLevel: 20, // Allow deep zoom

    getTileUrl: function(level, x, y) {
      // Return the same blank tile for all requests
      return blankTileDataUrl;
    },

    // Optional: implement custom tile loading for better performance
    downloadTileStart: function(imageJob) {
      // Create a blank tile immediately without actual download
      const img = new Image();
      img.width = tileSize;
      img.height = tileSize;

      // Use the blank tile data URL
      img.onload = function() {
        imageJob.finish(img);
      };
      img.onerror = function() {
        imageJob.finish(null, null, 'Failed to load blank tile');
      };

      img.src = blankTileDataUrl;
    },
  };
}

/**
 * Create a custom tile source based on data bounds
 * Automatically calculates appropriate dimensions from spatial data bounds
 * @param {Object} bounds: {xMin, xMax, yMin, yMax}
 * @param {number} padding: Padding around bounds (default 50)
 * @returns {Object} OpenSeadragon custom tile source configuration
 */
export function createBlankTileSourceFromBounds(bounds, padding = 50) {
  if (!bounds || typeof bounds.xMin !== 'number') {
    // Default to reasonable size if bounds not available
    return createBlankTileSource(1000, 1000);
  }

  const width = Math.ceil(bounds.xMax - bounds.xMin + 2 * padding);
  const height = Math.ceil(bounds.yMax - bounds.yMin + 2 * padding);

  return createBlankTileSource(width, height);
}
