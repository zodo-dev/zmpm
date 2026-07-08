// Direct HTTP(S) tarball resolver. Downloads any URL to a temp file, applying
// authentication (.zmpmrc host creds, credential helper, --header flags). A
// credential helper may also rewrite the URL (e.g. return a pre-signed URL).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { authorizeRequest } from '../auth.js';

export async function fetchHttpTarball(spec, opts = {}) {
  const auth = await authorizeRequest({
    url: spec.url, // scheme is respected (internal registries may be http-only)
    method: 'GET',
    opts,
    rc: opts.rc,
  });
  const headers = { 'User-Agent': 'zmpm', ...auth.headers };

  const res = await fetch(auth.url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${auth.url}`);

  const base = path.basename(new URL(auth.url).pathname) || 'package.tgz';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zmpm-'));
  const tarballPath = path.join(tmpDir, base);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tarballPath));

  return { tarballPath, version: null, tmpDir };
}
