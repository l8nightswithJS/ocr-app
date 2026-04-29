// cleanup-duplicate-js.mjs
// Safely remove .js files under src/ that have a matching .ts file

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'src');
const APPLY = process.argv.includes('--apply');

if (!fs.existsSync(SRC_DIR)) {
  console.error(`❌ src/ directory not found at: ${SRC_DIR}`);
  process.exit(1);
}

const tsBases = new Set();
const jsCandidates = [];

/**
 * Recursively walk dir and collect:
 *  - all .ts files (record basename+dir)
 *  - all .js files (as candidates to maybe delete)
 */
function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      const base = path.basename(entry.name, ext);

      if (ext === '.ts') {
        // ignore .d.ts
        if (!entry.name.endsWith('.d.ts')) {
          tsBases.add(path.join(dir, base));
        }
      } else if (ext === '.js') {
        jsCandidates.push({ full, dir, base });
      }
    }
  }
}

// 1) Scan src/ and build lists
walk(SRC_DIR);

// 2) Find .js files that have matching .ts siblings
const toDelete = jsCandidates.filter((f) => tsBases.has(path.join(f.dir, f.base)));

if (toDelete.length === 0) {
  console.log('✅ No duplicate .js files found that have matching .ts siblings under src/.');
  process.exit(0);
}

console.log('Found duplicate .js files (with matching .ts in same folder):\n');
toDelete.forEach((f) => {
  console.log('  ' + path.relative(ROOT, f.full));
});

if (!APPLY) {
  console.log('\nDry run only. To actually delete these files, run:');
  console.log('  node cleanup-duplicate-js.mjs --apply');
  process.exit(0);
}

// 3) Delete them (when --apply is provided)
console.log('\n🗑 Deleting files...\n');

for (const f of toDelete) {
  try {
    fs.unlinkSync(f.full);
    console.log('  deleted:', path.relative(ROOT, f.full));
  } catch (err) {
    console.error('  FAILED to delete:', path.relative(ROOT, f.full), '-', err.message);
  }
}

console.log('\n✅ Cleanup complete.');
