// Structural lockfile validator: every declared hard dependency of every entry
// in the lock must resolve to another entry in the SAME lock, following npm's
// node_modules walk-up rule. A lock that fails this is the exact shape that
// breaks `npm ci` on a platform whose optional binaries differ from the one
// that wrote the lock (the entry is present, its dependencies are not).
const fs = require('fs');

function validate(file) {
  const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pkgs = lock.packages;
  const paths = new Set(Object.keys(pkgs));

  // Resolve `name` as seen from the entry living at `fromPath`.
  function resolve(fromPath, name) {
    let cur = fromPath;
    let triedRoot = false;
    for (;;) {
      const cand = (cur ? cur + '/' : '') + 'node_modules/' + name;
      if (paths.has(cand)) return cand;
      if (cur === '') return null;
      const idx = cur.lastIndexOf('node_modules/');
      if (idx === -1) {
        // A workspace path like "packages/cli": only the root remains.
        if (triedRoot) return null;
        triedRoot = true;
        cur = '';
      } else {
        cur = idx === 0 ? '' : cur.slice(0, idx - 1);
      }
    }
  }

  const missing = [];
  for (const [p, meta] of Object.entries(pkgs)) {
    if (meta.link) continue; // workspace symlink; its target is its own entry
    for (const name of Object.keys(meta.dependencies || {})) {
      if (resolve(p, name)) continue;
      missing.push({ from: p || '<root>', needs: name, optionalParent: !!meta.optional });
    }
  }
  return { entries: paths.size, missing };
}

for (const file of process.argv.slice(2)) {
  const label = file.split(/[\\/]/).slice(-2).join('/');
  const { entries, missing } = validate(file);
  console.log(`=== ${label}  (${entries} entries) ===`);
  if (missing.length === 0) {
    console.log('  OK - every hard dependency resolves');
  } else {
    console.log(`  ${missing.length} UNRESOLVABLE hard dependencies:`);
    for (const m of missing.slice(0, 20)) {
      console.log(`    ${m.from}  needs  ${m.needs}${m.optionalParent ? '   [parent is an optional platform binary]' : ''}`);
    }
  }
}
