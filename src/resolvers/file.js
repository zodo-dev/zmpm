// Local file resolver: install a tarball already on disk (e.g. built by
// `zmpm pack`). Useful for offline installs and for testing a package before
// releasing it. The file is copied into a temp dir so the caller's cleanup and
// extraction path stay identical to the remote resolvers.

import fs from 'fs';
import os from 'os';
import path from 'path';

export async function fetchFileTarball(spec, opts = {}) {
  const src = path.resolve(opts.cwd || process.cwd(), spec.path);
  if (!fs.existsSync(src)) throw new Error(`file not found: ${src}`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zmpm-f-'));
  const dest = path.join(tmpDir, path.basename(src));
  fs.copyFileSync(src, dest);
  return { tarballPath: dest, version: null, tmpDir };
}
