const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const zlib = require('zlib');

const { inputPath, tileWidth, tileHeight, samplesPerPixel, bytesPerSample, decoderPath } = workerData;
const fd = fs.openSync(inputPath, 'r');
const tileBytes = tileWidth * tileHeight * samplesPerPixel * bytesPerSample;

const decoderReady = require(decoderPath)({ print: () => {}, printErr: () => {} });

parentPort.on('message', async ({ index, offset, length }) => {
  try {
    const openjpeg = await decoderReady;
    let raw;
    if (length === 0) {
      raw = Buffer.alloc(tileBytes);
    } else {
      const encoded = Buffer.alloc(length);
      fs.readSync(fd, encoded, 0, length, offset);
      const decoder = new openjpeg.J2KDecoder();
      try {
        decoder.getEncodedBuffer(length).set(encoded);
        decoder.decode();
        const info = decoder.getFrameInfo();
        const decoded = decoder.getDecodedBuffer();
        if (info.componentCount !== samplesPerPixel) {
          throw new Error(`tile ${index} has ${info.componentCount} channels, expected ${samplesPerPixel}`);
        }
        if (info.width === tileWidth && info.height === tileHeight) {
          raw = Buffer.from(decoded);
        } else {
          raw = Buffer.alloc(tileBytes);
          const srcRow = info.width * samplesPerPixel * bytesPerSample;
          const dstRow = tileWidth * samplesPerPixel * bytesPerSample;
          const rows = Math.min(info.height, tileHeight);
          const copy = Math.min(srcRow, dstRow);
          for (let y = 0; y < rows; y++) {
            raw.set(decoded.subarray(y * srcRow, y * srcRow + copy), y * dstRow);
          }
        }
      } finally {
        decoder.delete();
      }
    }
    const compressed = zlib.deflateSync(raw, { level: 1 });
    parentPort.postMessage({ index, data: compressed });
  } catch (error) {
    parentPort.postMessage({ index, error: error.message });
  }
});
