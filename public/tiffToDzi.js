const path = require('path');
const fs = require('fs').promises;
const { getJp2kTiffInfo, transcodeJp2kTiff } = require('./jp2kTiff');

async function tiffToDzi(inputPath, outDir, transformMatrix = null) {
  const sharp = require('sharp');
  const fsSync = require('fs');
  const base = path.parse(inputPath).name;
  const dstBase = path.join(outDir, base);

  await fs.mkdir(outDir, { recursive: true });

  const dziFile = `${dstBase}.dzi`;
  const tilesDir = `${dstBase}_files`;

  if (!transformMatrix && fsSync.existsSync(dziFile) && fsSync.existsSync(tilesDir)) {
    console.log(`DZI already exists, skipping conversion: ${dziFile}`);
    const dziXml = fsSync.readFileSync(dziFile, 'utf8');
    const wMatch = dziXml.match(/Width="(\d+)"/);
    const hMatch = dziXml.match(/Height="(\d+)"/);
    const cachedWidth = wMatch ? parseInt(wMatch[1]) : null;
    const cachedHeight = hMatch ? parseInt(hMatch[1]) : null;
    if (cachedWidth && cachedHeight) {
      console.log(`Cached DZI dimensions: ${cachedWidth} x ${cachedHeight}`);
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

  console.log(`Converting TIFF to DZI: ${inputPath}`);
  console.log(`Output directory: ${outDir}`);
  if (transformMatrix) {
    console.log(`Applying transformation matrix:`, transformMatrix);
  }

  let sharpInputPath = inputPath;
  let tempTiffPath = null;
  const jp2kInfo = getJp2kTiffInfo(inputPath);
  if (jp2kInfo) {
    console.log(`JPEG 2000 TIFF detected (compression ${jp2kInfo.compression}, ${jp2kInfo.width} x ${jp2kInfo.height}, ${jp2kInfo.tileCount} tiles); decoding tiles...`);
    tempTiffPath = await transcodeJp2kTiff(inputPath, jp2kInfo, (done, total) => {
      console.log(`JPEG 2000 tiles decoded: ${done}/${total}`);
    });
    sharpInputPath = tempTiffPath;
  }

  try {
    let pipeline = sharp(sharpInputPath, {
      limitInputPixels: false
    });

    const metadata = await pipeline.metadata();
    const { width: origWidth, height: origHeight } = metadata;
    
    console.log(`Original image dimensions: ${origWidth} x ${origHeight}`);
    console.log(`Total pixels: ${(origWidth * origHeight / 1000000).toFixed(1)} megapixels`);

    let exportInfo = { offset: { tx: 0, ty: 0 }, scale: 1, angle: 0 };
    let finalWidth = origWidth;
    let finalHeight = origHeight;

    if (transformMatrix && Array.isArray(transformMatrix) && transformMatrix.length >= 2) {
      const a = Number(transformMatrix[0][0]);
      const b = Number(transformMatrix[0][1]);
      const tx = Number(transformMatrix[0][2] || 0);
      const c = Number(transformMatrix[1][0]);
      const d = Number(transformMatrix[1][1]);
      const ty = Number(transformMatrix[1][2] || 0);

      console.log(`Transformation matrix: [[${a}, ${b}, ${tx}], [${c}, ${d}, ${ty}], [0,0,1]]`);

      const s = Math.sqrt(a * a + c * c);
      const theta = Math.atan2(c, a);
      const angleDeg = (theta * 180 / Math.PI);

      exportInfo = {
        offset: { tx, ty },
        scale: s,
        angle: angleDeg,
        matrix: transformMatrix
      };

      console.log(`Transformation will be applied on frontend`);
      console.log(`Scale: ${s.toFixed(6)}, Rotation: ${angleDeg.toFixed(2)}°, Translation: [${tx}, ${ty}]`);
    }

    const info = await pipeline
      .jpeg({ quality: 85, progressive: true })
      .tile({
        size: 512,
        overlap: 1,
        layout: 'dz',
      })
      .toFile(dstBase);

    console.log(`DZI conversion complete:`, info);
    console.log(`DZI file should be at: ${dstBase}.dzi`);
    console.log(`Tiles directory should be at: ${dstBase}_files`);

    const dziExists = require('fs').existsSync(`${dstBase}.dzi`);
    const tilesExist = require('fs').existsSync(`${dstBase}_files`);
    console.log(`DZI file exists: ${dziExists}`);
    console.log(`Tiles directory exists: ${tilesExist}`);

    return {
      dziPath: `${dstBase}.dzi`,
      tilesDir: `${dstBase}_files`,
      width: finalWidth,
      height: finalHeight,
      offset: exportInfo.offset,
      scale: exportInfo.scale,
      angle: exportInfo.angle,
      matrix: exportInfo.matrix,
    };
  } catch (error) {
    console.error('Error converting TIFF to DZI:', error);
    throw error;
  } finally {
    if (tempTiffPath) await fs.rm(tempTiffPath, { force: true }).catch(() => {});
  }
}

module.exports = { tiffToDzi };

