// The zmpm lockfile (zmpm.json) records what was installed and from where, so
// `zmpm update` can re-fetch and `zmpm remove` can clean up. It lives next to
// the app (default: ./zmpm.json).

import fs from 'fs';
import path from 'path';

const DEFAULT_FILE = 'zmpm.json';

export function lockPath(cwd = process.cwd(), file = DEFAULT_FILE) {
  return path.resolve(cwd, file);
}

export function readLock(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data.packages || typeof data.packages !== 'object') data.packages = {};
    if (!data.dest) data.dest = 'packages';
    // Auto-manage .gitignore by default (opt-out via `gitignore: false`).
    if (typeof data.gitignore !== 'boolean') data.gitignore = true;
    return data;
  } catch (e) {
    return { dest: 'packages', gitignore: true, packages: {} };
  }
}

export function writeLock(file, lock) {
  const ordered = {
    dest: lock.dest || 'packages',
    gitignore: lock.gitignore !== false,
    packages: Object.fromEntries(
      Object.keys(lock.packages)
        .sort()
        .map((k) => [k, lock.packages[k]])
    ),
  };
  fs.writeFileSync(file, `${JSON.stringify(ordered, null, 2)}\n`);
}

// Record an installed package. Keyed by Meteor name so re-installs dedupe.
export function recordInstall(lock, { name, folder, version, source, direct }) {
  const prev = lock.packages[name] || {};
  lock.packages[name] = {
    folder,
    version: version || prev.version || null,
    source,
    // A package is "direct" if the user asked for it explicitly at least once;
    // transitive-only installs stay direct:false so update follows the roots.
    direct: Boolean(direct || prev.direct),
  };
}
