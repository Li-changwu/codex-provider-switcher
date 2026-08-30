# Development

Install dependencies with `npm ci` and build with `npm run build`.

## Official Profile Login

Switching to an official Profile runs native `codex login` in the current
Extension Host terminal, then validates it with `codex login status`. A failed
login, cancellation, or failed status validation is reported only after the
transaction has completed its rollback. OAuth credentials remain managed by
Codex and must not be read, copied, or written by the extension to Profiles,
logs, backups, or SecretStorage.

This behavior uses the native Extension Host on Windows or Linux, including
VS Code Remote SSH when the Extension Host is Linux. macOS, WSL, cross-device
switching, and cloud Profile or session synchronization remain unsupported.
Session synchronization remains local to the current Extension Host and Codex
Home.

## Native Continuation

After a Profile switch has committed, the extension may offer a choice of local
source session IDs. Continuation uses native Codex fork or reuse through the
Codex app-server; it does not display, extract, replay, or use readable
transcript content as a fallback. The local mapping store keeps at most three
active branches for each source session and target Profile, applying native
archive and unarchive retention locally when necessary. The manual
**Codex: Continue Session** command remains native resume.

Native continuation requires a native Codex installation with app-server
support. Run these focused checks while developing it:

```text
npx tsx --test test/unit/app-server-fork.test.ts
npx tsx --test test/unit/native-continuation-terminal.test.ts
npx tsx --test test/integration/continuation.test.ts
```

`sqlite3` 6.0.1 requires Node 20.17 or later. The extension therefore requires
VS Code `^1.98.0`, whose Extension Host meets that runtime baseline. Do not use
`--ignore-scripts` in the normal setup path: it can skip installation work
needed for the native binding and leave the extension unable to load SQLite at
runtime.

Local validation uses a real `npm ci`, `npm run build`, and the binding
preflight:

```text
npm run verify:binding
```

Packaging is platform-specific because each VSIX contains the native SQLite
binding for its own target. Do not publish a single cross-platform VSIX with the
host binary. Run the package command only on its matching target host. The
generic Linux artifact additionally requires an x64 glibc host; a musl runtime
is rejected because it cannot safely publish the generic `linux-x64` artifact:

```text
npm run package:win32-x64
npm run package:linux-x64
```

Each package command runs the native binding preflight and production
`npm audit --omit=dev --json` gate before `vsce`. The release-gate child uses
an isolated temporary npm cache, the explicit HTTPS registry
`https://registry.npmjs.org/`, `--strict-ssl true`, and the same TLS-verified
OS/proxy environment whitelist as the Linux prebuild. It drops inherited npm
configuration and Node loader variables, forces
`NODE_TLS_REJECT_UNAUTHORIZED=1`, and removes the cache on every outcome. A
cache setup, audit, or cache cleanup failure aborts packaging before VSCE. It
then extracts its
target-suffixed VSIX to a fresh temporary directory and loads
`require("sqlite3")` from the extracted extension root in a clean child Node
process. The child receives an explicit minimal OS environment and never
inherits `NODE_OPTIONS`, `NODE_PATH`, `NODE_COMPILE_CACHE`, or
`NODE_V8_COVERAGE`; each native load has a 10 second timeout. Both checks
require an actual `.node` file under the `sqlite3` package and reject source
maps. The verifier does not assume a particular `sqlite3` loader layout,
because prebuilt and source-built installs can place the binary differently.

Before the Linux binding preflight, `package:linux-x64` invokes the lockfile-
pinned local `prebuild-install` tool from the sqlite3 package directory with
`--runtime napi --platform linux --arch x64 --libc glibc`. It derives and
passes the exact official GitHub asset URL from the installed sqlite3 version
and highest compatible declared N-API version. For sqlite3 6.0.1 on current
Node, that is
`https://github.com/TryGhost/node-sqlite3/releases/download/v6.0.1/sqlite3-v6.0.1-napi-v6-linux-x64.tar.gz`.
The command disables package-local prebuild overrides and requires a resulting
native binding. Its failure stops packaging; it never invokes `node-gyp` or
uses sqlite3's `prebuild-install || node-gyp rebuild` install script. This
prebuild-only tool and its download/cache content remain excluded from the
VSIX.

The prebuild subprocess has its own fresh temporary npm cache, passed as its
only `npm_config_cache` value and removed after either success or failure. It
first removes sqlite3's existing `build` directory so an installed source or
`node-gyp` binding cannot satisfy the later binding discovery. Its environment
is a narrow OS/proxy whitelist with `NODE_TLS_REJECT_UNAUTHORIZED=1`; it drops
`NODE_OPTIONS`, `NODE_PATH`, Node cache/coverage/preload variables, and all
inherited npm configuration overrides. A cache or stale-build cleanup failure,
download failure, extraction failure, or missing binding fails the package
before the normal SQLite preflight. The actual generic Linux load runs on the
planned Task 8 Ubuntu glibc CI job, not from a Windows host.

The VSIX verifier rejects unsafe archive paths and bounds extraction at 5,000
entries, 16 MiB per entry, and 64 MiB total uncompressed content. These limits
leave headroom over the current package while preventing oversized archives.
Stream failures settle once, destroy active streams, and preserve the original
verification error if temporary-directory cleanup also fails.

Packaging removes only the exact legacy, target, VSCE-default, and hidden
temporary artifact names resolved within the project root. VSCE writes to a
nonpublishable `.vsix.verify` file; only a successfully extracted and loaded
artifact is renamed to the publishable `@<target>.vsix` name. A failed package
or verifier run removes both temporary and target artifacts.

The VSIX uses an explicit runtime allowlist: `sqlite3` package metadata, its
JavaScript `lib` loader files, the installed `.node` binding, and the
`bindings` and `file-uri-to-path` loader dependencies. The direct
`@iarna/toml` runtime dependency remains included. Build and installation
trees such as `node-gyp`, `prebuild-install`, `tar`, sqlite source files, and
source archives are excluded and the VSIX verifier rejects them.

Run `npm audit --omit=dev --json` for an operator-visible view of the full
installed production dependency tree. The package lifecycle is the release
gate and must report zero vulnerabilities through its controlled child
environment. A direct command still inherits local environment settings, such
as this host's `NODE_TLS_REJECT_UNAUTHORIZED=0`; do not use it as evidence that
the release-gate child disabled TLS verification. Do not suppress or scope away
a nonzero audit result, even when generated-VSIX verification proves that
installation-only paths are excluded from the shipped artifact.

The CI workflow runs Windows x64 and Linux x64 jobs with Node 22. Each job
runs `npm ci`, type checking, unit tests, integration tests, and its matching
target package command. The Windows job builds the file-operations addon
before tests; the package workflow uploads distinct `@win32-x64` and
`@linux-x64` VSIX artifacts only after CI succeeds. The local commands above
still generate and verify target-specific artifacts only on their matching
target host.
