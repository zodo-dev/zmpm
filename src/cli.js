// zmpm CLI — command parsing + install orchestration.

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { parseSpec, ghDepSpec } from './spec.js';
import { loadRc, resolveGithubToken } from './auth.js';
import { fetchGithubTarball, fetchRepoAliases } from './resolvers/github.js';
import { fetchHttpTarball } from './resolvers/http.js';
import { fetchFileTarball } from './resolvers/file.js';
import { packPackage } from './pack.js';
import {
  extractTarball,
  readPackageMeta,
  readSameOrgDeps,
  placePackage,
} from './install.js';
import { lockPath, readLock, writeLock, recordInstall } from './lock.js';
import { syncGitignore } from './gitignore.js';

const require = createRequire(import.meta.url);
const VERSION = require('../package.json').version;

const HELP = `zmpm ${VERSION} — Zodo Meteor Package Manager

Vendor Meteor packages into an app's packages/ dir from GitHub Releases or any
tarball URL, with auth and transitive-dependency resolution.

USAGE
  zmpm add <spec>...        install package(s) into <dest>/ and update zmpm.json
  zmpm update [<name>...]    re-fetch installed packages (all, or the named ones)
  zmpm install              install everything recorded in zmpm.json (like npm ci)
  zmpm remove <name>...      remove package folder(s) + lockfile entries
  zmpm pack <dir>            build a correctly-structured release tarball from a
                             package dir (single top-level folder, no build output)
  zmpm list                  show installed packages from zmpm.json
  zmpm help                  this help

SPECS
  gh:<owner>/<repo>:<pkg>[@<version>]   GitHub Release asset (default @latest)
  https://host/path/pkg-x.y.z.tgz       any tarball over HTTP(S)
  file:<path> | ./path.tgz              a local tarball (e.g. from zmpm pack)

OPTIONS
  --dest <dir>       target packages dir (default: packages, or zmpm.json's dest)
  --token <token>    GitHub token (else ZMPM_GITHUB_TOKEN/GITHUB_TOKEN/GH_TOKEN,
                     or a .zmpmrc host entry)
  --header "K: v"    extra HTTP header for http(s) specs (repeatable)
  --config <file>    path to a .zmpmrc credentials file (else ~/.zmpmrc, ./.zmpmrc)
  --credential-helper <cmd>  external command that returns auth for a request URL
  --out <file>       (pack) output tarball path (default: zodo-<pkg>-<ver>.tgz)
  --no-deps          do not resolve same-org transitive dependencies
  --no-gitignore     do not manage .gitignore (default: ignore vendored dirs)
  --gitignore        (re-)enable .gitignore management (persisted in zmpm.json)
  --force            re-download even if the installed version already matches
  --cwd <dir>        run as if in <dir> (where zmpm.json + packages/ live)
  -h, --help         help      -v, --version   version

EXAMPLES
  npx zmpm add gh:zodo-dev/meteor-packages:ai-kit@0.2.0
  npx zmpm add https://pkgs.example.com/zodo-seo-ssr-0.1.0.tgz --header "Authorization: Bearer $T"
  GITHUB_TOKEN=*** npx zmpm update
`;

function parseArgs(argv) {
  const opts = { headers: [], positionals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--dest': opts.dest = argv[++i]; break;
      case '--token': opts.token = argv[++i]; break;
      case '--header': opts.headers.push(argv[++i]); break;
      case '--config': opts.config = argv[++i]; break;
      case '--credential-helper': opts.credentialHelper = argv[++i]; break;
      case '--out': opts.out = argv[++i]; break;
      case '--cwd': opts.cwd = argv[++i]; break;
      case '--no-deps': opts.noDeps = true; break;
      case '--gitignore': opts.gitignore = true; break;
      case '--no-gitignore': opts.gitignore = false; break;
      case '--force': opts.force = true; break;
      case '-h': case '--help': opts.help = true; break;
      case '-v': case '--version': opts.version = true; break;
      default:
        if (a && a.startsWith('--')) throw new Error(`unknown option '${a}'`);
        opts.positionals.push(a);
    }
  }
  return opts;
}

// Resolve a downloaded+extracted package from a spec, place it, record it, and
// recurse into same-org dependencies. `ctx` carries run-wide state.
async function installSpec(specStr, ctx, { direct = false } = {}) {
  const spec = parseSpec(specStr);
  const fetchOpts = {
    token: ctx.token,
    headers: ctx.headerFlags, // raw --header list; resolvers parse as needed
    rc: ctx.rc,
    credentialHelper: ctx.credentialHelper,
  };

  const resolver = {
    gh: fetchGithubTarball,
    http: fetchHttpTarball,
    file: fetchFileTarball,
  }[spec.kind];
  const dl = await resolver(spec, { ...fetchOpts, cwd: ctx.cwd });

  try {
    const { extractedRoot, folder, pkgDir } = await extractTarball(dl.tarballPath);
    try {
      const pkgJsPath = path.join(pkgDir, 'package.js');
      if (!fs.existsSync(pkgJsPath)) {
        throw new Error(`tarball for '${folder}' has no package.js — not a Meteor package`);
      }
      const src = fs.readFileSync(pkgJsPath, 'utf8');
      const meta = readPackageMeta(src);
      const name = meta.name || `${folder}`;
      const version = dl.version || meta.version || null;

      const key = `${name}@${version}`;
      if (ctx.seen.has(key) && !ctx.force) {
        return; // already handled in this run
      }

      // Skip re-download when the same version is already vendored (unless --force).
      const existing = ctx.lock.packages[name];
      const destPath = path.join(ctx.destRoot, folder);
      if (
        !direct &&
        !ctx.force &&
        existing &&
        existing.version === version &&
        fs.existsSync(destPath)
      ) {
        ctx.seen.add(key);
        return;
      }

      placePackage(pkgDir, folder, ctx.destRoot);
      recordInstall(ctx.lock, {
        name,
        folder,
        version,
        source: spec.raw,
        direct,
      });
      ctx.seen.add(key);
      ctx.installed.push({ name, folder, version });
      console.log(`  ✓ ${name}@${version || '?'} → ${path.relative(ctx.cwd, destPath)}/`);

      // Transitive same-org deps (gh specs only — needs a repo to resolve from).
      if (!ctx.noDeps && spec.kind === 'gh' && meta.name) {
        const prefix = meta.name.slice(0, meta.name.indexOf(':') + 1);
        const deps = readSameOrgDeps(src, prefix, meta.name);
        if (deps.length) {
          const aliases = await ctx.aliasesFor(spec);
          for (const dep of deps) {
            const depFolder = aliases[dep.name] || dep.suffix;
            // eslint-disable-next-line no-await-in-loop
            await installSpec(ghDepSpec(spec, depFolder, dep.version), ctx);
          }
        }
      }
    } finally {
      fs.rmSync(extractedRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dl.tmpDir, { recursive: true, force: true });
  }
}

function makeCtx(opts) {
  const cwd = path.resolve(opts.cwd || process.cwd());
  const lockFile = lockPath(cwd);
  const lock = readLock(lockFile);
  const destRoot = path.resolve(cwd, opts.dest || lock.dest || 'packages');
  lock.dest = path.relative(cwd, destRoot) || 'packages';
  // Persist a --gitignore/--no-gitignore choice; default stays whatever the lock has.
  if (typeof opts.gitignore === 'boolean') lock.gitignore = opts.gitignore;

  const rc = loadRc({ cwd, config: opts.config });
  const aliasCache = new Map();
  return {
    cwd,
    lockFile,
    lock,
    destRoot,
    rc,
    token: resolveGithubToken(opts, rc),
    headerFlags: opts.headers,
    credentialHelper: opts.credentialHelper,
    noDeps: opts.noDeps,
    force: opts.force,
    seen: new Set(),
    installed: [],
    // Cache repo alias maps per owner/repo.
    async aliasesFor(spec) {
      const k = `${spec.owner}/${spec.repo}`;
      if (!aliasCache.has(k)) {
        aliasCache.set(k, await fetchRepoAliases(spec, { token: this.token, rc }));
      }
      return aliasCache.get(k);
    },
  };
}

// Regenerate the managed .gitignore block from the current lock + settings.
function applyGitignore(ctx) {
  const folders = Object.values(ctx.lock.packages).map((e) => e.folder);
  const { changed, path: p } = syncGitignore({
    cwd: ctx.cwd,
    dest: ctx.lock.dest,
    folders,
    enabled: ctx.lock.gitignore !== false,
  });
  if (changed) {
    const verb = ctx.lock.gitignore !== false ? 'updated' : 'cleared';
    console.log(`  ${verb} ${path.relative(ctx.cwd, p)}`);
  }
}

async function cmdAdd(specs, opts) {
  if (!specs.length) throw new Error('add: at least one spec required');
  const ctx = makeCtx(opts);
  console.log(`Installing into ${path.relative(ctx.cwd, ctx.destRoot) || '.'}/`);
  for (const s of specs) {
    // eslint-disable-next-line no-await-in-loop
    await installSpec(s, ctx, { direct: true });
  }
  writeLock(ctx.lockFile, ctx.lock);
  applyGitignore(ctx);
  console.log(`Done. ${ctx.installed.length} package(s). Lockfile: ${path.relative(ctx.cwd, ctx.lockFile)}`);
}

async function cmdUpdate(names, opts) {
  const ctx = makeCtx(opts);
  const entries = Object.entries(ctx.lock.packages).filter(
    ([name, e]) => e.direct && (names.length === 0 || names.includes(name))
  );
  if (!entries.length) throw new Error('update: no matching direct packages in zmpm.json');
  ctx.force = true; // update always re-fetches
  console.log(`Updating ${entries.length} package(s)`);
  for (const [, e] of entries) {
    // eslint-disable-next-line no-await-in-loop
    await installSpec(e.source, ctx, { direct: true });
  }
  writeLock(ctx.lockFile, ctx.lock);
  applyGitignore(ctx);
  console.log(`Done. ${ctx.installed.length} package(s) refreshed.`);
}

async function cmdInstall(opts) {
  const ctx = makeCtx(opts);
  const entries = Object.entries(ctx.lock.packages).filter(([, e]) => e.direct);
  if (!entries.length) throw new Error('install: zmpm.json has no direct packages');
  console.log(`Installing ${entries.length} package(s) from zmpm.json`);
  for (const [, e] of entries) {
    // eslint-disable-next-line no-await-in-loop
    await installSpec(e.source, ctx, { direct: true });
  }
  writeLock(ctx.lockFile, ctx.lock);
  applyGitignore(ctx);
  console.log(`Done. ${ctx.installed.length} package(s).`);
}

function cmdRemove(names, opts) {
  if (!names.length) throw new Error('remove: at least one package name required');
  const ctx = makeCtx(opts);
  let removed = 0;
  for (const name of names) {
    const entry = ctx.lock.packages[name];
    if (!entry) {
      console.log(`  - ${name}: not in zmpm.json`);
      continue;
    }
    const p = path.join(ctx.destRoot, entry.folder);
    fs.rmSync(p, { recursive: true, force: true });
    delete ctx.lock.packages[name];
    removed += 1;
    console.log(`  ✓ removed ${name} (${path.relative(ctx.cwd, p)}/)`);
  }
  writeLock(ctx.lockFile, ctx.lock);
  applyGitignore(ctx);
  console.log(`Done. ${removed} removed.`);
}

async function cmdPack(args, opts) {
  const dir = args[0];
  if (!dir) throw new Error('pack: <package-dir> required');
  const cwd = path.resolve(opts.cwd || process.cwd());
  const { file, folder, version } = await packPackage({ dir, out: opts.out, cwd });
  console.log(`packed ${folder}@${version || '?'} → ${path.relative(cwd, file)}`);
}

function cmdList(opts) {
  const ctx = makeCtx(opts);
  const names = Object.keys(ctx.lock.packages);
  if (!names.length) {
    console.log('No packages recorded in zmpm.json');
    return;
  }
  console.log(`dest: ${ctx.lock.dest}`);
  for (const name of names.sort()) {
    const e = ctx.lock.packages[name];
    const tag = e.direct ? '' : ' (dep)';
    console.log(`  ${name}@${e.version || '?'}${tag}  ←  ${e.source}`);
  }
}

export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.version) { console.log(VERSION); return; }
  const [cmd, ...rest] = opts.positionals;
  if (opts.help || !cmd || cmd === 'help') { console.log(HELP); return; }

  switch (cmd) {
    case 'add': return cmdAdd(rest, opts);
    case 'update': return cmdUpdate(rest, opts);
    case 'install': case 'sync': return cmdInstall(opts);
    case 'remove': case 'rm': return cmdRemove(rest, opts);
    case 'pack': return cmdPack(rest, opts);
    case 'list': case 'ls': return cmdList(opts);
    default: throw new Error(`unknown command '${cmd}' (try: zmpm help)`);
  }
}
