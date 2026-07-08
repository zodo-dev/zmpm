// Manage a .gitignore block so vendored packages are not versioned.
//
// zmpm owns a single delimited block; user content outside the markers is never
// touched. The block is regenerated from the current package set on every
// mutation, so add/remove keep it in sync. Disabling removes the block.

import fs from 'fs';
import path from 'path';

const BEGIN = '# --- zmpm managed (vendored Meteor packages; do not edit) ---';
const END = '# --- end zmpm managed ---';

// Remove the managed block (and its surrounding blank lines) from a gitignore
// body, returning the remaining user content.
function stripBlock(body) {
  const lines = body.split('\n');
  const start = lines.indexOf(BEGIN);
  const end = lines.indexOf(END);
  if (start === -1 || end === -1 || end < start) return body;
  const before = lines.slice(0, start);
  const after = lines.slice(end + 1);
  // Trim a trailing blank line left before the block and a leading one after it.
  while (before.length && before[before.length - 1] === '') before.pop();
  while (after.length && after[0] === '') after.shift();
  return [...before, ...after].join('\n');
}

// Update <cwd>/.gitignore. `enabled=false` removes the block; otherwise the
// block ignores each `<dest>/<folder>/`. Returns { changed, path }.
export function syncGitignore({ cwd, dest, folders, enabled }) {
  const file = path.join(cwd, '.gitignore');
  const existed = fs.existsSync(file);
  const original = existed ? fs.readFileSync(file, 'utf8') : '';
  let body = stripBlock(original);

  if (enabled && folders.length) {
    const entries = folders
      .map((f) => `/${path.posix.join(dest, f)}/`)
      .sort();
    const block = [BEGIN, ...entries, END].join('\n');
    const base = body.replace(/\s*$/, '');
    body = base ? `${base}\n\n${block}\n` : `${block}\n`;
  } else {
    // Disabled or nothing to ignore: keep just the user content.
    body = body.replace(/\s*$/, '');
    if (body) body += '\n';
  }

  // Do not create an empty .gitignore that never existed.
  if (!existed && !body.trim()) return { changed: false, path: file };
  if (body === original) return { changed: false, path: file };
  fs.writeFileSync(file, body);
  return { changed: true, path: file };
}
