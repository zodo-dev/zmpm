// Authentication: static per-host credentials (a .zmpmrc file, like .npmrc) plus
// an optional external credential-helper command for dynamic cases (e.g. signing
// a storage URL at request time).
//
// Precedence for a request's headers (later wins):
//   1. .zmpmrc host entry (token → Bearer, or explicit headers)
//   2. credential-helper output (may also REWRITE the url — e.g. a pre-signed URL)
//   3. --header flags on the command line
//
// .zmpmrc (JSON) shape:
//   {
//     "hosts": {
//       "api.github.com": { "token": "ghp_..." },
//       "pkgs.example.com": { "headers": { "Authorization": "Bearer ..." } }
//     },
//     "credentialHelper": "node ./scripts/zmpm-cred.js"
//   }

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

// Turn repeated `--header "Name: value"` flags into a headers object.
export function parseHeaderFlags(headerList = []) {
  const headers = {};
  for (const h of headerList) {
    const idx = String(h).indexOf(':');
    if (idx === -1) throw new Error(`invalid --header '${h}' (expected "Name: value")`);
    const name = h.slice(0, idx).trim();
    const value = h.slice(idx + 1).trim();
    if (name) headers[name] = value;
  }
  return headers;
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

// Load and merge .zmpmrc from (base→override): ~/.zmpmrc, <cwd>/.zmpmrc, then an
// explicit --config / $ZMPMRC path. Later sources win; `hosts` are deep-merged.
export function loadRc(opts = {}) {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const candidates = [
    path.join(os.homedir(), '.zmpmrc'),
    path.join(cwd, '.zmpmrc'),
    opts.config || process.env.ZMPMRC,
  ].filter(Boolean);

  const rc = { hosts: {}, credentialHelper: undefined };
  for (const file of candidates) {
    const data = readJsonIfExists(file);
    if (!data) continue;
    if (data.hosts) Object.assign(rc.hosts, data.hosts);
    if (data.credentialHelper) rc.credentialHelper = data.credentialHelper;
  }
  return rc;
}

// Resolve a GitHub token from (in order): --token, ZMPM_GITHUB_TOKEN,
// GITHUB_TOKEN, GH_TOKEN, then a .zmpmrc host entry (api.github.com/github.com).
export function resolveGithubToken(opts = {}, rc = { hosts: {} }) {
  const fromRc =
    (rc.hosts['api.github.com'] && rc.hosts['api.github.com'].token) ||
    (rc.hosts['github.com'] && rc.hosts['github.com'].token);
  return (
    opts.token ||
    process.env.ZMPM_GITHUB_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    fromRc ||
    undefined
  );
}

// Run an external credential helper: the request JSON goes in on stdin, and the
// helper prints a JSON response on stdout: { headers?: {...}, url?: "..." }.
// `url` lets a helper return a pre-signed/rewritten URL to fetch instead.
function runCredentialHelper(command, request, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`credential helper timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`credential helper exited with code ${code}`));
      const trimmed = out.trim();
      if (!trimmed) return resolve({});
      try {
        return resolve(JSON.parse(trimmed));
      } catch (e) {
        return reject(new Error('credential helper did not return valid JSON'));
      }
    });
    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
  });
}

// Build the effective { url, headers } for a request, applying rc host creds,
// the credential helper, and --header flags in that precedence.
export async function authorizeRequest({ url, method = 'GET', opts = {}, rc = { hosts: {} } }) {
  const host = new URL(url).host;
  let outUrl = url;
  const headers = {};

  const hostCfg = rc.hosts[host];
  if (hostCfg) {
    if (hostCfg.headers) Object.assign(headers, hostCfg.headers);
    if (hostCfg.token) headers.Authorization = `Bearer ${hostCfg.token}`;
  }

  const helper = opts.credentialHelper || rc.credentialHelper || process.env.ZMPM_CREDENTIAL_HELPER;
  if (helper) {
    const res = await runCredentialHelper(helper, { url, host, method });
    if (res && res.url) outUrl = res.url;
    if (res && res.headers) Object.assign(headers, res.headers);
  }

  Object.assign(headers, parseHeaderFlags(opts.headers || []));
  return { url: outUrl, headers };
}
