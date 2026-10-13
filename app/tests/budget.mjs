// First-load budget: every static file the visitor app needs before it is usable, compressed.
// Excludes satellite/street tiles (third-party, loaded on demand), the About render (lazy) and the
// operator console. Target: < 2 MB compressed.
import fs from 'node:fs';
import zlib from 'node:zlib';
const ROOT = new URL('..', import.meta.url).pathname;
const files = [
  'index.html', 'manifest.webmanifest', 'sw.js', 'icons/icon.svg', 'icons/icon-192.png',
  'css/app.css', 'vendor/leaflet/leaflet.css', 'vendor/leaflet/leaflet.js', 'data/campus.v1.json', 'data/pads.v1.json',
  ...fs.readdirSync(ROOT + 'fonts').filter(f => f.endsWith('.woff2')).map(f => 'fonts/' + f),
  ...['js', 'js/providers', 'js/sim'].flatMap(d => fs.readdirSync(ROOT + d).filter(f => f.endsWith('.js') && f !== 'operator.js').map(f => `${d}/${f}`))
];
let raw = 0, gz = 0, br = 0;
const rows = files.map(f => {
  const b = fs.readFileSync(ROOT + f);
  const g = zlib.gzipSync(b, { level: 9 }).length, r = zlib.brotliCompressSync(b).length;
  raw += b.length; gz += g; br += r;
  return [f, b.length, g, r];
});
const kb = n => (n / 1024).toFixed(1).padStart(7) + ' KB';
for (const [f, a, g, r] of rows) console.log(f.padEnd(44), kb(a), kb(g), kb(r));
console.log('-'.repeat(80));
console.log('TOTAL'.padEnd(44), kb(raw), kb(gz), kb(br), `  (${files.length} files; raw / gzip / brotli)`);
const ok = gz < 2 * 1024 * 1024;
console.log(ok ? `Within the 2 MB compressed first-load budget (${(gz / 1048576 * 100 / 2).toFixed(1)}% used, gzip).` : 'OVER BUDGET');
process.exit(ok ? 0 : 1);
