export function createBlankTileSource(width = 1000, height = 1000, tileSize = 256) {
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
    maxLevel: 20,

    getTileUrl: function(level, x, y) {
      return blankTileDataUrl;
    },

    downloadTileStart: function(imageJob) {
      const img = new Image();
      img.width = tileSize;
      img.height = tileSize;

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

export function createBlankTileSourceFromBounds(bounds, padding = 50) {
  if (!bounds || typeof bounds.xMin !== 'number') {
    return createBlankTileSource(1000, 1000);
  }

  const width = Math.ceil(bounds.xMax - bounds.xMin + 2 * padding);
  const height = Math.ceil(bounds.yMax - bounds.yMin + 2 * padding);

  return createBlankTileSource(width, height);
}
