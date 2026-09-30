const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'app-electron');
const ELECTRON_FILES = ['electron.js', 'preload.js', 'tiffToDzi.js', 'jp2kTiff.js', 'jp2kTileWorker.js'];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

async function main() {
  const buildDir = path.join(root, 'build');
  if (!fs.existsSync(buildDir)) throw new Error('build/ not found: run `npm run build` first');

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of ELECTRON_FILES) {
    const src = fs.readFileSync(path.join(root, 'public', name), 'utf8');
    const result = await minify(src, {
      compress: false,
      mangle: false,
      module: false,
      format: { comments: false, beautify: false },
    });
    if (!result.code) throw new Error(`terser returned no code for ${name}`);
    fs.writeFileSync(path.join(outDir, name), result.code);
    console.log(`app-electron/${name}: ${src.length} -> ${result.code.length} bytes`);
  }

  for (const name of ELECTRON_FILES) fs.rmSync(path.join(buildDir, name), { force: true });

  const maps = walk(buildDir).filter((p) => p.endsWith('.map'));
  for (const p of maps) fs.rmSync(p);
  let sourceMapRefs = 0;
  for (const p of walk(buildDir).filter((f) => /\.(js|css)$/.test(f))) {
    const text = fs.readFileSync(p, 'utf8');
    const stripped = text.replace(/\n?\/[/*]# sourceMappingURL=[^\n]*?(\*\/)?\s*$/, '');
    if (stripped !== text) {
      fs.writeFileSync(p, stripped);
      sourceMapRefs++;
    }
  }
  console.log(`Removed ${maps.length} source maps and ${sourceMapRefs} sourceMappingURL references from build/`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
