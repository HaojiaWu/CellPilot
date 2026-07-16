const path = require('path');
const fs = require('fs').promises;

/**
 * Convert a TIFF file to Deep Zoom Image (DZI) format
 * @param {string} inputPath: Path to the input TIFF file
 * @param {string} outDir: Output directory for DZI tiles
 * @param {Array<Array<number>>} transformMatrix: Optional 3x3 transformation matrix
 * @returns {Promise<{dziPath: string, tilesDir: string, width: number, height: number, offset: {tx:number, ty:number}, scale:number, angle:number}>}
 */
async function tiffToDzi(inputPath, outDir, transformMatrix = null) {
  const sharp = require('sharp');
  const fsSync = require('fs');
  const base = path.parse(inputPath).name;
  const dstBase = path.join(outDir, base);

  // Create output directory
  await fs.mkdir(outDir, { recursive: true });

  const dziFile = `${dstBase}.dzi`;
  const tilesDir = `${dstBase}_files`;

  // Skip conversion if DZI already exists and no transform matrix is requested
  // (transform matrices are applied on the frontend anyway, so we can always cache)
  if (!transformMatrix && fsSync.existsSync(dziFile) && fsSync.existsSync(tilesDir)) {
    // Parse dimensions from existing DZI XML
    const dziXml = fsSync.readFileSync(dziFile, 'utf8');
    const wMatch = dziXml.match(/Width="(\d+)"/);
    const hMatch = dziXml.match(/Height="(\d+)"/);
    const cachedWidth = wMatch ? parseInt(wMatch[1]) : null;
    const cachedHeight = hMatch ? parseInt(hMatch[1]) : null;
    if (cachedWidth && cachedHeight) {
      return {
        dziPath: dziFile,
        tilesDir,
        width: cachedWidth,
        height: cachedHeight,
        offset: { tx: 0, ty: 0 },
        scale: 1,
        angle: 0,
        matrix: null,
      };
    }
  }

  if (transformMatrix) {
  }

  try {
    let pipeline = sharp(inputPath, {
      limitInputPixels: false  // Disable pixel limit for very large histology images
    });

    // Get original image metadata
    const metadata = await pipeline.metadata();
    const { width: origWidth, height: origHeight } = metadata;
    
    // Apply transformation if provided
    // IMPORTANT: For now, we DON'T apply the transformation during DZI generation
    // Instead, we just store the matrix and return the original image dimensions
    // The transformation will be handled in the coordinate mapping on the frontend
    let exportInfo = { offset: { tx: 0, ty: 0 }, scale: 1, angle: 0 };
    let finalWidth = origWidth;
    let finalHeight = origHeight;

    if (transformMatrix && Array.isArray(transformMatrix) && transformMatrix.length >= 2) {
      // Extract transformation matrix values for logging
      // Matrix format: [[a, b, tx], [c, d, ty], [0, 0, 1]]
      const a = Number(transformMatrix[0][0]);
      const b = Number(transformMatrix[0][1]);
      const tx = Number(transformMatrix[0][2] || 0);
      const c = Number(transformMatrix[1][0]);
      const d = Number(transformMatrix[1][1]);
      const ty = Number(transformMatrix[1][2] || 0);

      // Store transformation parameters for frontend use
      const s = Math.sqrt(a * a + c * c);
      const theta = Math.atan2(c, a);
      const angleDeg = (theta * 180 / Math.PI);

      exportInfo = {
        offset: { tx, ty },
        scale: s,
        angle: angleDeg,
        matrix: transformMatrix  // Pass the full matrix to frontend
      };

    }

    // Generate DZI tiles
    // Note: sharp's .tile() with layout 'dz' automatically adds .dzi extension
    const info = await pipeline
      .jpeg({ quality: 85, progressive: true })
      .tile({
        size: 512,        // tile size: 512 performs well for large images
        overlap: 1,       // small overlap helps avoid hairline seams
        layout: 'dz',     // Deep Zoom layout producing .dzi + _files/
      })
      .toFile(dstBase);  // Don't add .dzi here: sharp adds it automatically

    // Verify the files were created
    const dziExists = require('fs').existsSync(`${dstBase}.dzi`);
    const tilesExist = require('fs').existsSync(`${dstBase}_files`);
    return {
      dziPath: `${dstBase}.dzi`,
      tilesDir: `${dstBase}_files`,
      width: finalWidth,
      height: finalHeight,
      offset: exportInfo.offset,
      scale: exportInfo.scale,
      angle: exportInfo.angle,
      matrix: exportInfo.matrix,  // Pass through the transformation matrix
    };
  } catch (error) {
    console.error('Error converting TIFF to DZI:', error);
    throw error;
  }
}

module.exports = { tiffToDzi };

