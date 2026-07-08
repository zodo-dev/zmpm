// Self-contained test suite for zmpm. No network: builds tarballs from the
// fixtures in test/fixtures/ and serves them over a local HTTP server.
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { parseSpec } from '../src/spec.js';
import { extractTarball, readPackageMeta, readSameOrgDeps } from '../src/install.js';
import { authorizeRequest } from '../src/auth.js';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'zmpm.js');
const FIX = path.join(HERE, 'fixtures');

let pass = 0;
let fail = 0;
const ok = (c, m) => { c ? (pass += 1) : (fail += 1); console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const run = (args, cwd) => execFileP('node', [BIN, ...args], { cwd: cwd || ROOT });

// --- spec parsing ---
ok(parseSpec('gh:o/r:widget@0.2.0').kind === 'gh', 'parse gh spec');
ok(parseSpec('gh:o/r:widget').version === 'latest', 'gh defaults to @latest');
ok(parseSpec('https://x/y.tgz').kind === 'http', 'parse http spec');
ok(parseSpec('file:/tmp/x.tgz').kind === 'file', 'parse file: spec');
ok(parseSpec('./a.tgz').kind === 'file', 'parse bare local .tgz');
let threw = false; try { parseSpec('nope'); } catch { threw = true; }
ok(threw, 'reject bad spec');

// --- auth ---
const rc = { hosts: { 'pkgs.example.com': { token: 'RC' } } };
ok((await authorizeRequest({ url: 'https://pkgs.example.com/x', rc })).headers.Authorization === 'Bearer RC',
  'rc host token → Bearer');
ok((await authorizeRequest({ url: 'https://pkgs.example.com/x', rc, opts: { headers: ['Authorization: Bearer CLI'] } })).headers.Authorization === 'Bearer CLI',
  '--header overrides rc');
const hw = fs.mkdtempSync(path.join(os.tmpdir(), 'zmpm-h-'));
fs.writeFileSync(path.join(hw, 'h.js'),
  'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const r=JSON.parse(s);' +
  'process.stdout.write(JSON.stringify({url:r.url+"?sig=1",headers:{"X-Sig":"ok"}}));});');
const a3 = await authorizeRequest({ url: 'https://store/o.tgz', opts: { credentialHelper: `node ${path.join(hw, 'h.js')}` } });
ok(a3.url === 'https://store/o.tgz?sig=1' && a3.headers['X-Sig'] === 'ok', 'credential helper rewrites url + header');
fs.rmSync(hw, { recursive: true, force: true });

// --- pack (build tarballs from fixtures) ---
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zmpm-t-'));
for (const f of ['widget', 'core']) {
  // eslint-disable-next-line no-await-in-loop
  await run(['pack', path.join(FIX, f), '--out', path.join(work, `${f}.tgz`), '--cwd', work]);
}
const listing = (await import('child_process')).execFileSync('tar', ['-tzf', path.join(work, 'widget.tgz')], { encoding: 'utf8' })
  .split('\n').filter(Boolean);
const tops = new Set(listing.map((p) => p.split('/')[0]));
ok(tops.size === 1 && tops.has('widget'), 'pack: single top-level folder');
ok(!listing.some((p) => /\/(\.npm|node_modules)\//.test(p)), 'pack: excludes build output');

// --- extract + dep-scan ---
const ex = await extractTarball(path.join(work, 'widget.tgz'));
const src = fs.readFileSync(path.join(ex.pkgDir, 'package.js'), 'utf8');
const meta = readPackageMeta(src);
ok(meta.name === 'acme:widget', 'read package name');
const deps = readSameOrgDeps(src, 'acme:', meta.name);
ok(deps.some((d) => d.name === 'acme:core' && d.version === 'latest'), 'dep-scan finds acme:core@latest');
ok(!deps.some((d) => d.name === 'acme:widget'), 'dep-scan excludes self');
fs.rmSync(ex.extractedRoot, { recursive: true, force: true });

// --- serve tarballs; exercise the CLI end-to-end ---
const port = 39099;
const server = http.createServer((req, res) => {
  const f = path.join(work, path.basename(req.url));
  if (fs.existsSync(f)) { res.writeHead(200); fs.createReadStream(f).pipe(res); } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(port, r));

const app = fs.mkdtempSync(path.join(os.tmpdir(), 'zmpm-app-'));
try {
  await run(['add', `http://localhost:${port}/core.tgz`, '--cwd', app, '--no-deps']);
  ok(fs.existsSync(path.join(app, 'packages', 'core', 'package.js')), 'add placed packages/core');
  const lock = JSON.parse(fs.readFileSync(path.join(app, 'zmpm.json'), 'utf8'));
  ok(lock.packages['acme:core'] && lock.packages['acme:core'].direct === true, 'lockfile records acme:core');
  const gi = fs.readFileSync(path.join(app, '.gitignore'), 'utf8');
  ok(/zmpm managed/.test(gi) && /\/packages\/core\//.test(gi), 'default .gitignore ignores vendored dir');
  await run(['remove', 'acme:core', '--cwd', app]);
  ok(!fs.existsSync(path.join(app, 'packages', 'core')), 'remove deleted folder');
  const gi2 = fs.existsSync(path.join(app, '.gitignore')) ? fs.readFileSync(path.join(app, '.gitignore'), 'utf8') : '';
  ok(!/\/packages\/core\//.test(gi2), 'remove cleared gitignore entry');

  // file: install
  const fapp = fs.mkdtempSync(path.join(os.tmpdir(), 'zmpm-f-'));
  await run(['add', `file:${path.join(work, 'core.tgz')}`, '--cwd', fapp, '--no-deps']);
  ok(fs.existsSync(path.join(fapp, 'packages', 'core', 'package.js')), 'file: install placed the package');
  fs.rmSync(fapp, { recursive: true, force: true });

  // --no-gitignore opt-out
  const app2 = fs.mkdtempSync(path.join(os.tmpdir(), 'zmpm-a2-'));
  fs.writeFileSync(path.join(app2, '.gitignore'), 'node_modules/\n');
  await run(['add', `http://localhost:${port}/core.tgz`, '--cwd', app2, '--no-deps', '--no-gitignore']);
  const gi3 = fs.readFileSync(path.join(app2, '.gitignore'), 'utf8');
  ok(!/zmpm managed/.test(gi3) && /node_modules\//.test(gi3), '--no-gitignore leaves .gitignore untouched');
  ok(JSON.parse(fs.readFileSync(path.join(app2, 'zmpm.json'), 'utf8')).gitignore === false, '--no-gitignore persisted');
  fs.rmSync(app2, { recursive: true, force: true });
} finally {
  server.close();
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(app, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
