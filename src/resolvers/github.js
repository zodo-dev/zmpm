// GitHub Release resolver: turn a `gh:` spec into a downloaded tarball path.
//
// Private-repo note: a Release asset cannot be fetched from its
// `browser_download_url` with an Authorization header — that path 404s. The
// asset must be fetched from the assets API endpoint
// (`/repos/:o/:r/releases/assets/:id`) with `Accept: application/octet-stream`.
// GitHub then 302-redirects to a pre-signed S3 URL; Node's fetch (undici) drops
// the Authorization header on the cross-origin redirect, so the signed URL — which
// carries its own auth — downloads correctly.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { resolveGithubToken } from '../auth.js';
import { compareSemver } from '../spec.js';

const API = process.env.ZMPM_GITHUB_API || 'https://api.github.com';

function apiHeaders(token) {
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'zmpm',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function ghJson(url, token) {
  const res = await fetch(url, { headers: apiHeaders(token) });
  if (res.status === 404) {
    throw new Error(`not found (404): ${url} — check the repo/tag and token scope`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`unauthorized (${res.status}) for ${url} — provide a token with contents:read`);
  }
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}`);
  return res.json();
}

// Resolve `latest` to the highest `<pkg>-v<semver>` tag in the repo.
async function resolveLatestVersion({ owner, repo, pkg }, token) {
  const releases = await ghJson(`${API}/repos/${owner}/${repo}/releases?per_page=100`, token);
  const prefix = `${pkg}-v`;
  const versions = releases
    .map((r) => r.tag_name)
    .filter((t) => typeof t === 'string' && t.startsWith(prefix))
    .map((t) => t.slice(prefix.length));
  if (!versions.length) {
    throw new Error(`no releases found for '${pkg}' in ${owner}/${repo} (tag prefix '${prefix}')`);
  }
  versions.sort(compareSemver);
  return versions[versions.length - 1];
}

// Best-effort fetch of an optional `zmpm.aliases.json` at the repo root, mapping
// a Meteor package name to its folder when they differ (e.g.
// {"zodo:email-mailersend": "mailersend"}). Returns {} when absent.
export async function fetchRepoAliases({ owner, repo }, opts = {}) {
  const token = resolveGithubToken(opts, opts.rc);
  try {
    const res = await fetch(`${API}/repos/${owner}/${repo}/contents/zmpm.aliases.json`, {
      headers: apiHeaders(token),
    });
    if (!res.ok) return {};
    const json = await res.json();
    if (!json || !json.content) return {};
    const decoded = Buffer.from(json.content, json.encoding || 'base64').toString('utf8');
    const map = JSON.parse(decoded);
    return map && typeof map === 'object' ? map : {};
  } catch (e) {
    return {};
  }
}

// Download `gh:` spec → { tarballPath, version, tmpDir }. Caller cleans tmpDir.
export async function fetchGithubTarball(spec, opts = {}) {
  const token = resolveGithubToken(opts, opts.rc);
  const { owner, repo, pkg } = spec;
  const version =
    spec.version === 'latest' ? await resolveLatestVersion(spec, token) : spec.version;

  const tag = `${pkg}-v${version}`;
  const release = await ghJson(`${API}/repos/${owner}/${repo}/releases/tags/${tag}`, token);
  const assets = release.assets || [];

  // Prefer the conventional asset name, else the sole .tgz/.tar.gz asset.
  const wanted = `zodo-${pkg}-${version}.tgz`;
  let asset =
    assets.find((a) => a.name === wanted) ||
    assets.find((a) => a.name === `${pkg}-${version}.tgz`);
  if (!asset) {
    const tarballs = assets.filter((a) => /\.(tgz|tar\.gz)$/i.test(a.name));
    if (tarballs.length === 1) [asset] = tarballs;
  }
  if (!asset) {
    throw new Error(
      `release ${tag} has no matching tarball asset (looked for ${wanted}); ` +
        `assets: ${assets.map((a) => a.name).join(', ') || '(none)'}`
    );
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zmpm-'));
  const tarballPath = path.join(tmpDir, asset.name);

  const res = await fetch(asset.url, {
    headers: { ...apiHeaders(token), Accept: 'application/octet-stream' },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`asset download failed (${res.status}) for ${asset.name}`);
  }
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tarballPath));

  return { tarballPath, version, tmpDir };
}
