# zmpm — Zodo Meteor Package Manager

Vendor Meteor packages into an app's `packages/` directory from **GitHub
Releases** or **any tarball URL**, with authentication and transitive-dependency
resolution. A generic, registry-free alternative to Atmosphere for
private/self-hosted Meteor packages.

Meteor already treats anything in `packages/<dir>/` as a local package and
builds it itself — so `zmpm add` gives you `meteor add`-able packages without a
package server. What you give up vs Atmosphere is `meteor update` semantics;
`zmpm update` fills that gap.

## Usage

Run with `npx` (no install):

```bash
npx @zodo/zmpm add gh:zodo-dev/meteor-packages:ai-kit@0.2.0
```

That downloads the release tarball into `packages/ai-kit/` and, because
`ai-kit` declares `zodo:secrets`, also pulls `packages/secrets/`. Then in your
app:

```bash
meteor add zodo:ai-kit
```

### Commands

```
zmpm add <spec>...        install package(s) into <dest>/ and update zmpm.json
zmpm update [<name>...]    re-fetch installed packages (all, or the named ones)
zmpm install              install everything recorded in zmpm.json (like npm ci)
zmpm remove <name>...      remove package folder(s) + lockfile entries
zmpm pack <dir>            build a correctly-structured release tarball from a dir
zmpm list                  show installed packages from zmpm.json
```

### Source specs

| Spec | Meaning |
|---|---|
| `gh:<owner>/<repo>:<pkg>[@<version>]` | GitHub Release asset (default `@latest`). Resolves tag `<pkg>-v<version>`. |
| `https://host/path/pkg-x.y.z.tgz` | any tarball over HTTP(S) |
| `file:<path>` or `./path.tgz` | a local tarball (e.g. from `zmpm pack`) |

### Options

| Option | Meaning |
|---|---|
| `--dest <dir>` | target packages dir (default `packages`, or the lockfile's `dest`) |
| `--token <token>` | GitHub token (else `ZMPM_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN`) |
| `--header "K: v"` | extra HTTP header for `http(s)` specs (repeatable) |
| `--config <file>` | path to a `.zmpmrc` (else `~/.zmpmrc`, `./.zmpmrc`) |
| `--credential-helper <cmd>` | external command that returns auth for a URL |
| `--no-deps` | do not resolve same-org transitive dependencies |
| `--gitignore` / `--no-gitignore` | manage / stop managing `.gitignore` (default: manage) |
| `--force` | re-download even if the installed version already matches |
| `--cwd <dir>` | run as if in `<dir>` (where `zmpm.json` + `packages/` live) |

## Authentication

Three mechanisms, applied in this precedence (later wins): **`.zmpmrc` host
entry → credential helper → `--header`**.

### 1. Inline / env (simplest)

```bash
# private GitHub repo — token with contents:read
ZMPM_GITHUB_TOKEN=ghp_xxx npx @zodo/zmpm add gh:zodo-dev/meteor-packages:ai-kit@0.2.0
# any authenticated URL
npx @zodo/zmpm add https://pkgs.example.com/zodo-seo-ssr-0.1.0.tgz --header "Authorization: Bearer $T"
```

Release assets on a private repo are fetched via the assets API (not the browser
URL); the redirect to signed storage drops the token, as it should.

### 2. `.zmpmrc` file (per-host, like `.npmrc`)

Put static credentials in `~/.zmpmrc` (global) or `<app>/.zmpmrc` (project).
**Gitignore it — it holds secrets.** See [`examples/.zmpmrc.example`](examples/.zmpmrc.example):

```json
{
  "hosts": {
    "api.github.com": { "token": "ghp_read_token" },
    "pkgs.example.com": { "headers": { "Authorization": "Bearer STATIC" } }
  },
  "credentialHelper": "node ./examples/credential-helper.example.js"
}
```

### 3. Credential helper (dynamic — for storage / pre-signing)

For auth that must be computed per request (e.g. pre-signing an S3/GCS/OCI URL,
minting a short-lived token), point zmpm at an external command. zmpm writes a
JSON request to its stdin and reads a JSON response from stdout:

```
request:  { "url": "<requested url>", "host": "<host>", "method": "GET" }
response: { "headers": { "<name>": "<value>" }, "url": "<optional rewritten url>" }
```

Returning `url` makes zmpm fetch a **different** URL — the storage case: hand back
a signed URL that carries its own auth. Runnable sample:
[`examples/credential-helper.example.js`](examples/credential-helper.example.js).

```bash
npx @zodo/zmpm add https://store.internal/secrets.tgz \
  --credential-helper "node ./scripts/sign-url.js"
```

## Transitive dependencies

For a `gh:` install, zmpm reads the fetched package's `package.js`, finds
`api.use('<same-prefix>:…')` dependencies (e.g. `zodo:*`), maps each to a folder
(an optional `zmpm.aliases.json` at the repo root overrides the default
name→folder mapping), and installs those from the **same repo** recursively. A
dependency in a different repo must be added explicitly. `http(s)` installs do
not auto-resolve dependencies (there is no repo to resolve them from).

## Config + lockfile (`zmpm.json`)

`zmpm.json` (next to the app) is both config and lockfile — it records the
target dir, the gitignore preference, and every installed package + its source:

```json
{
  "dest": "packages",
  "gitignore": true,
  "packages": {
    "zodo:ai-kit": { "folder": "ai-kit", "version": "0.2.0", "source": "gh:zodo-dev/meteor-packages:ai-kit@0.2.0", "direct": true },
    "zodo:secrets": { "folder": "secrets", "version": "0.1.0", "source": "gh:zodo-dev/meteor-packages:secrets@0.1.0", "direct": false }
  }
}
```

- **`dest`** — where packages are vendored. Set once with `--dest`; persisted
  here so later commands don't need it.
- **`packages`** — `direct: true` = you asked for it; `false` = pulled as a
  transitive dep. `zmpm update` follows the direct roots.
- Commit `zmpm.json` (it has no secrets). `zmpm install` reinstalls exactly this
  set — use it in CI. `zmpm update` re-fetches the direct entries.

## `.gitignore` management

By default zmpm keeps a managed block in `<app>/.gitignore` so vendored packages
are **not** versioned (Meteor rebuilds them from the tarball / next `zmpm
install`):

```
# --- zmpm managed (vendored Meteor packages; do not edit) ---
/packages/ai-kit/
/packages/secrets/
# --- end zmpm managed ---
```

The block is regenerated on every `add`/`remove`/`update`; your other
`.gitignore` content is never touched. Opt out with `--no-gitignore` (persisted
as `"gitignore": false`), which also removes the block. If you prefer to **commit**
the vendored packages, use `--no-gitignore`.

## Examples

```bash
# 1. Install a package (public repo) + its deps, then wire it into Meteor
npx @zodo/zmpm add gh:zodo-dev/meteor-packages:ai-kit@0.2.0
meteor add zodo:ai-kit

# 2. Private repo — token with contents:read
ZMPM_GITHUB_TOKEN=ghp_xxx npx @zodo/zmpm add gh:zodo-dev/meteor-packages:ai-kit@latest

# 3. Pin a version and a custom target dir (persisted to zmpm.json)
npx @zodo/zmpm add gh:zodo-dev/meteor-packages:seo-ssr@0.1.0 --dest app/packages

# 4. Direct tarball URL with a static header
npx @zodo/zmpm add https://pkgs.example.com/zodo-cookie-consent-0.1.0.tgz \
  --header "Authorization: Bearer $REGISTRY_TOKEN"

# 5. Object storage via a credential helper that returns a pre-signed URL
npx @zodo/zmpm add https://store.internal/zodo-secrets.tgz \
  --credential-helper "node ./scripts/presign.js"

# 6. Reproducible install in CI (reads zmpm.json, like npm ci)
GITHUB_TOKEN=$CI_TOKEN npx @zodo/zmpm install

# 7. Update all direct packages to their source spec (@latest re-resolves)
npx @zodo/zmpm update

# 8. Update just one; inspect; remove one
npx @zodo/zmpm update zodo:ai-kit
npx @zodo/zmpm list
npx @zodo/zmpm remove zodo:cookie-consent

# 9. Commit the vendored packages instead of gitignoring them
npx @zodo/zmpm add gh:zodo-dev/meteor-packages:ai-kit@0.2.0 --no-gitignore

# 10. Build a release tarball locally (correct structure), then test it
npx @zodo/zmpm pack ./ai-kit --out zodo-ai-kit-0.2.0.tgz
npx @zodo/zmpm add file:./zodo-ai-kit-0.2.0.tgz   # install the local tarball to verify
```

`zmpm pack` guarantees the layout the resolvers expect — a single top-level
folder, with `.npm/`, `node_modules/` and VCS excluded — so a hand-rolled `tar`
can't produce a broken (nested / missing-top-level) package.

A typical CI step for an app that vendors from a private repo:

```yaml
- name: Vendor Meteor packages
  env:
    GITHUB_TOKEN: ${{ secrets.PKG_READ_TOKEN }}
  run: npx @zodo/zmpm install       # installs exactly what zmpm.json pins
```

## Notes

- Downloaded tarballs are **source** packages; Meteor compiles them locally.
  Build output (`.npm/`, `node_modules/`) is regenerated by Meteor — the release
  tarballs exclude it.
- zmpm never runs Meteor for you — after `zmpm add`, run `meteor add <name>`.

## License

[Apache License 2.0](LICENSE) — Copyright 2026 Zodo.
