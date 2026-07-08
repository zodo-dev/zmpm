// Extract a downloaded tarball into the destination packages/ dir and read the
// package's metadata (Meteor name, version, same-org dependencies).

import fs from 'fs';
import os from 'os';
import path from 'path';
import * as tar from 'tar';

// Extract a .tgz into a fresh temp dir and return its single top-level entry
// (the package folder). Tarballs produced by the release workflow contain one
// top-level directory named after the package folder.
export async function extractTarball(tarballPath) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zmpm-x-'));
  await tar.x({ file: tarballPath, cwd: outDir });
  const entries = fs.readdirSync(outDir).filter((e) => !e.startsWith('.'));
  const dirs = entries.filter((e) => fs.statSync(path.join(outDir, e)).isDirectory());
  if (dirs.length !== 1) {
    throw new Error(
      `expected a single top-level folder in the tarball, found: ${entries.join(', ') || '(none)'}`
    );
  }
  return { extractedRoot: outDir, folder: dirs[0], pkgDir: path.join(outDir, dirs[0]) };
}

// Read `name` and `version` from a package.js source string.
export function readPackageMeta(pkgJsSource) {
  const name = (/name:\s*'([^']+)'/.exec(pkgJsSource) || [])[1] || null;
  const version = (/version:\s*'([^']+)'/.exec(pkgJsSource) || [])[1] || null;
  return { name, version };
}

// Find same-org dependencies declared via api.use in a package.js.
// Given the owning package's prefix (e.g. `zodo:`), return the namespaced deps
// that share it, as { name, prefix, suffix, version }. A dep with no pinned
// version (e.g. `api.use('zodo:secrets')`) resolves to `latest`. The package's
// own name is excluded.
export function readSameOrgDeps(pkgJsSource, prefix, selfName) {
  const deps = new Map();
  // Namespaced name with an optional exact-semver constraint.
  const re = /['"]([a-z0-9_-]+:[a-z0-9_-]+)(?:@([0-9]+\.[0-9]+\.[0-9]+))?['"]/gi;
  let m;
  while ((m = re.exec(pkgJsSource))) {
    const [, name, version] = m;
    if (!name.startsWith(prefix)) continue;
    if (selfName && name === selfName) continue;
    const suffix = name.slice(prefix.length);
    if (!deps.has(name)) deps.set(name, { name, prefix, suffix, version: version || 'latest' });
  }
  return [...deps.values()];
}

// Move an extracted package folder into <destRoot>/<folder>, replacing any
// existing copy. Returns the final path.
export function placePackage(pkgDir, folder, destRoot) {
  fs.mkdirSync(destRoot, { recursive: true });
  const finalPath = path.join(destRoot, folder);
  fs.rmSync(finalPath, { recursive: true, force: true });
  // Copy then remove the source (rename can fail across filesystems/tmp).
  fs.cpSync(pkgDir, finalPath, { recursive: true });
  return finalPath;
}
