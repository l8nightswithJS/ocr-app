// scripts/verify-dist.cjs
// Verifies the packaged renderer was built from the current hybrid workflow source.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const requiredMarkers = [
  'GNM-HYBRID-2026-06-24.5',
  'Sequence QR + LRM pairing',
  'passing unit cartridge OCR',
];

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walkFiles(p, out);
    else if (/\.(html|js|css)$/i.test(entry.name)) out.push(p);
  }
  return out;
}

if (!fs.existsSync(dist)) {
  console.error('verify:dist failed: dist folder does not exist.');
  process.exit(1);
}

const files = walkFiles(dist);
const combined = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const missing = requiredMarkers.filter((marker) => !combined.includes(marker));

if (missing.length) {
  console.error('verify:dist failed. Missing build markers:');
  for (const marker of missing) console.error(`- ${marker}`);
  process.exit(1);
}

console.log(`verify:dist passed. Checked ${files.length} built files.`);
