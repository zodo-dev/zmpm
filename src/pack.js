// Build a release tarball for a package directory with the exact structure zmpm
// expects: a single top-level folder (the package folder), no build output. This
// is the one place tarballs are created, so local/manual releases can't get the
// layout wrong (nested dirs, missing top-level folder, bundled .npm/).

import fs from 'fs';
import path from 'path';
import * as tar from 'tar';
import { readPackageMeta } from './install.js';

const EXCLUDE = new Set(['.npm', 'node_modules', '.git']);

export async function packPackage({ dir, out, cwd = process.cwd() }) {
  const pkgDir = path.resolve(cwd, dir);
  const pkgJs = path.join(pkgDir, 'package.js');
  if (!fs.existsSync(pkgJs)) {
    throw new Error(`no package.js in '${dir}' — not a Meteor package`);
  }
  const folder = path.basename(pkgDir);
  const parent = path.dirname(pkgDir);
  const { version } = readPackageMeta(fs.readFileSync(pkgJs, 'utf8'));
  const file = out
    ? path.resolve(cwd, out)
    : path.resolve(cwd, `zodo-${folder}-${version || '0.0.0'}.tgz`);

  await tar.c(
    {
      gzip: true,
      file,
      cwd: parent, // entries are "folder/..." → single top-level dir
      portable: true, // reproducible: drop uid/gid/atime noise
      filter: (p) => !p.split('/').some((seg) => EXCLUDE.has(seg)),
    },
    [folder]
  );

  return { file, folder, version };
}
