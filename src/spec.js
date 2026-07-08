// Parse a source spec into a structured descriptor.
//
// Supported forms:
//   gh:<owner>/<repo>:<pkg>[@<version>]     GitHub Release asset (default: @latest)
//   https://host/path/to/pkg-x.y.z.tgz      any tarball over HTTP(S)
//   http://...                              (upgraded to https by the resolver if needed)
//
// A version may be an exact semver (0.2.0) or the keyword `latest`.

const GH_RE = /^gh:([^/\s]+)\/([^:\s]+):([^@\s]+)(?:@(.+))?$/;

export function parseSpec(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('empty package spec');

  if (raw.startsWith('gh:')) {
    const m = GH_RE.exec(raw);
    if (!m) {
      throw new Error(
        `invalid gh spec '${raw}' (expected gh:<owner>/<repo>:<pkg>[@<version>])`
      );
    }
    const [, owner, repo, pkg, version] = m;
    return {
      kind: 'gh',
      owner,
      repo,
      pkg,
      version: version || 'latest',
      raw,
    };
  }

  if (/^https?:\/\//i.test(raw)) {
    return { kind: 'http', url: raw, raw };
  }

  // A local tarball: explicit `file:<path>` or a path to an existing .tgz/.tar.gz.
  if (raw.startsWith('file:')) {
    return { kind: 'file', path: raw.slice('file:'.length), raw };
  }
  if (/\.(tgz|tar\.gz)$/i.test(raw) && /^(\.{0,2}\/|[a-zA-Z]:[\\/])/.test(raw)) {
    return { kind: 'file', path: raw, raw };
  }

  throw new Error(
    `unrecognized spec '${raw}' (use gh:<owner>/<repo>:<pkg>@<ver>, an http(s) tarball URL, or file:<path>)`
  );
}

// Build the gh spec string for a transitive dependency in the same repo.
export function ghDepSpec({ owner, repo }, folder, version) {
  return `gh:${owner}/${repo}:${folder}@${version}`;
}

// Compare two semver-ish strings (a > b -> 1). Missing parts count as 0.
export function compareSemver(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}
