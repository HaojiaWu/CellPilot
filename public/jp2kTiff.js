const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const JP2K_COMPRESSION = new Set([34712, 33005]);
const APERIO_JP2K_YCBCR = 33003;

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };

function readFirstIfd(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const readAt = (pos, len) => {
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, pos);
      return b;
    };
    const hdr = readAt(0, 16);
    const order = hdr.toString('latin1', 0, 2);
    if (order !== 'II' && order !== 'MM') return null;
    const le = order === 'II';
    const u16 = (b, o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
    const u32 = (b, o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
    const u64 = (b, o) => Number(le ? b.readBigUInt64LE(o) : b.readBigUInt64BE(o));
    const magic = u16(hdr, 2);
    if (magic !== 42 && magic !== 43) return null;
    const big = magic === 43;
    const ifdOffset = big ? u64(hdr, 8) : u32(hdr, 4);

    const countBuf = readAt(ifdOffset, big ? 8 : 2);
    const n = big ? u64(countBuf, 0) : u16(countBuf, 0);
    const entrySize = big ? 20 : 12;
    const inlineSize = big ? 8 : 4;
    const entries = readAt(ifdOffset + (big ? 8 : 2), n * entrySize);
    const readValue = (b, o, type) => {
      switch (type) {
        case 3: case 8: return u16(b, o);
        case 4: case 9: case 13: return u32(b, o);
        case 16: case 17: case 18: return u64(b, o);
        default: return b[o];
      }
    };
    const tags = {};
    for (let i = 0; i < n; i++) {
      const e = i * entrySize;
      const tag = u16(entries, e);
      const type = u16(entries, e + 2);
      const count = big ? u64(entries, e + 4) : u32(entries, e + 4);
      const size = (TYPE_SIZE[type] || 1) * count;
      const valuePos = e + (big ? 12 : 8);
      if (type === 2 || type === 5 || type === 10 || type === 11 || type === 12) continue;
      const values = size <= inlineSize
        ? entries.subarray(valuePos, valuePos + inlineSize)
        : readAt(big ? u64(entries, valuePos) : u32(entries, valuePos), size);
      const step = TYPE_SIZE[type] || 1;
      const list = new Array(count);
      for (let k = 0; k < count; k++) list[k] = readValue(values, k * step, type);
      tags[tag] = list;
    }
    return tags;
  } finally {
    fs.closeSync(fd);
  }
}

function getJp2kTiffInfo(filePath) {
  let tags;
  try {
    tags = readFirstIfd(filePath);
  } catch (error) {
    console.warn('Could not read TIFF header:', error.message);
    return null;
  }
  const compression = tags?.[259]?.[0];
  if (compression === APERIO_JP2K_YCBCR) {
    throw new Error('This TIFF uses Aperio JPEG 2000 (YCbCr) compression, which is not supported yet. Please export it as a regular TIFF or OME-TIFF.');
  }
  if (!JP2K_COMPRESSION.has(compression)) return null;

  const width = tags[256]?.[0];
  const height = tags[257]?.[0];
  const samplesPerPixel = tags[277]?.[0] ?? 1;
  const bitsPerSample = tags[258]?.[0] ?? 8;
  const planar = tags[284]?.[0] ?? 1;
  const tileWidth = tags[322]?.[0];
  const tileHeight = tags[323]?.[0];
  const tileOffsets = tags[324];
  const tileByteCounts = tags[325];
  if (!tileWidth || !tileHeight || !tileOffsets || !tileByteCounts) {
    throw new Error('This JPEG 2000 TIFF is stored in strips, not tiles, which is not supported yet. Please export it as a tiled OME-TIFF.');
  }
  if (planar !== 1) {
    throw new Error('This JPEG 2000 TIFF stores each colour channel separately (planar), which is not supported yet.');
  }
  if (bitsPerSample !== 8 && bitsPerSample !== 16) {
    throw new Error(`This JPEG 2000 TIFF has ${bitsPerSample}-bit pixels; only 8- and 16-bit images are supported.`);
  }
  if (![1, 3, 4].includes(samplesPerPixel)) {
    throw new Error(`This JPEG 2000 TIFF has ${samplesPerPixel} channels; only grayscale, RGB and RGBA images are supported.`);
  }
  const tilesAcross = Math.ceil(width / tileWidth);
  const tilesDown = Math.ceil(height / tileHeight);
  if (tileOffsets.length < tilesAcross * tilesDown) {
    throw new Error('This JPEG 2000 TIFF has fewer tiles than its size needs; the file may be damaged.');
  }
  return {
    compression, width, height, samplesPerPixel, bitsPerSample, tileWidth, tileHeight,
    tileCount: tilesAcross * tilesDown, tileOffsets, tileByteCounts,
  };
}

function unpackedPath(p) {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function writeBigTiffIfd(fd, position, info, offsets, byteCounts) {
  const { width, height, samplesPerPixel, bitsPerSample, tileWidth, tileHeight } = info;
  const tileCount = offsets.length;

  const arrays = Buffer.alloc(tileCount * 16);
  for (let i = 0; i < tileCount; i++) {
    arrays.writeBigUInt64LE(BigInt(offsets[i]), i * 8);
    arrays.writeBigUInt64LE(BigInt(byteCounts[i]), (tileCount + i) * 8);
  }
  fs.writeSync(fd, arrays, 0, arrays.length, position);
  const offsetsPos = position;
  const countsPos = position + tileCount * 8;
  const ifdPos = position + arrays.length;

  const photometric = samplesPerPixel >= 3 ? 2 : 1;
  const entries = [
    [256, 4, 1, [width]],
    [257, 4, 1, [height]],
    [258, 3, samplesPerPixel, new Array(samplesPerPixel).fill(bitsPerSample)],
    [259, 3, 1, [8]],
    [262, 3, 1, [photometric]],
    [277, 3, 1, [samplesPerPixel]],
    [284, 3, 1, [1]],
    [322, 4, 1, [tileWidth]],
    [323, 4, 1, [tileHeight]],
    [324, 16, tileCount, null, offsetsPos],
    [325, 16, tileCount, null, countsPos],
  ];
  if (samplesPerPixel === 4) entries.push([338, 3, 1, [2]]);
  entries.push([339, 3, samplesPerPixel, new Array(samplesPerPixel).fill(1)]);
  entries.sort((a, b) => a[0] - b[0]);

  const ifd = Buffer.alloc(8 + entries.length * 20 + 8);
  ifd.writeBigUInt64LE(BigInt(entries.length), 0);
  entries.forEach(([tag, type, count, values, externalPos], i) => {
    const e = 8 + i * 20;
    ifd.writeUInt16LE(tag, e);
    ifd.writeUInt16LE(type, e + 2);
    ifd.writeBigUInt64LE(BigInt(count), e + 4);
    if (externalPos !== undefined) {
      ifd.writeBigUInt64LE(BigInt(externalPos), e + 12);
    } else {
      values.forEach((v, k) => {
        if (type === 3) ifd.writeUInt16LE(v, e + 12 + k * 2);
        else ifd.writeUInt32LE(v, e + 12 + k * 4);
      });
    }
  });
  fs.writeSync(fd, ifd, 0, ifd.length, ifdPos);

  const header = Buffer.alloc(16);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(43, 2);
  header.writeUInt16LE(8, 4);
  header.writeUInt16LE(0, 6);
  header.writeBigUInt64LE(BigInt(ifdPos), 8);
  fs.writeSync(fd, header, 0, 16, 0);
}

async function transcodeJp2kTiff(inputPath, info, onProgress = null) {
  const tmpDir = path.join(os.tmpdir(), 'cellpilot-jp2k');
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `${path.basename(inputPath).replace(/\.[^.]+$/, '')}_${process.pid}_${Date.now()}.tif`);

  const decoderPath = unpackedPath(require.resolve('@cornerstonejs/codec-openjpeg/decodewasmjs'));
  const workerPath = unpackedPath(path.join(__dirname, 'jp2kTileWorker.js'));
  const nWorkers = Math.max(1, Math.min(6, os.cpus().length - 1, info.tileCount));
  const bytesPerSample = info.bitsPerSample / 8;

  const fd = fs.openSync(outPath, 'w');
  let position = 16;
  const offsets = new Array(info.tileCount);
  const byteCounts = new Array(info.tileCount);
  const workers = [];
  const started = Date.now();

  try {
    await new Promise((resolve, reject) => {
      let next = 0;
      let done = 0;
      let failed = false;
      const fail = (error) => {
        if (failed) return;
        failed = true;
        reject(error);
      };
      const sendNext = (worker) => {
        if (next >= info.tileCount) return;
        const index = next++;
        worker.postMessage({ index, offset: info.tileOffsets[index], length: info.tileByteCounts[index] });
      };
      for (let w = 0; w < nWorkers; w++) {
        const worker = new Worker(workerPath, {
          workerData: {
            inputPath,
            tileWidth: info.tileWidth,
            tileHeight: info.tileHeight,
            samplesPerPixel: info.samplesPerPixel,
            bytesPerSample,
            decoderPath,
          },
        });
        workers.push(worker);
        worker.on('error', fail);
        worker.on('message', (msg) => {
          if (failed) return;
          if (msg.error) {
            fail(new Error(`Could not decode JPEG 2000 tile ${msg.index}: ${msg.error}`));
            return;
          }
          const data = Buffer.from(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength);
          fs.writeSync(fd, data, 0, data.length, position);
          offsets[msg.index] = position;
          byteCounts[msg.index] = data.length;
          position += data.length;
          done++;
          if (onProgress && (done % 20 === 0 || done === info.tileCount)) onProgress(done, info.tileCount);
          if (done === info.tileCount) resolve();
          else sendNext(worker);
        });
        sendNext(worker);
      }
    });
    writeBigTiffIfd(fd, position, info, offsets, byteCounts);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(outPath, { force: true });
    throw error;
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
  fs.closeSync(fd);
  console.log(`JPEG 2000 TIFF transcoded (${info.tileCount} tiles, ${nWorkers} workers) in ${((Date.now() - started) / 1000).toFixed(1)}s: ${outPath}`);
  return outPath;
}

module.exports = { getJp2kTiffInfo, transcodeJp2kTiff };
