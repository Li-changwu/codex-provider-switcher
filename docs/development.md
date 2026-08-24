# Development

Install dependencies with `npm ci` and build with `npm run build`.

`@vscode/sqlite3` is a native binding. On Windows, a local `npm ci` may require
the Visual Studio Desktop development with C++ workload so the binding can be
built. Do not use `--ignore-scripts` in the normal setup path: it skips the
native build and can leave the extension unable to load SQLite at runtime.

CI must run a real `npm ci`, `npm run build`, and a binding-load check such as:

```text
node -e "require('@vscode/sqlite3'); console.log('sqlite binding loaded')"
```

After packaging, run `npm run verify:package` to verify that the VSIX contains
the extension manifest, bundled entry point, and the `@vscode/sqlite3` runtime
package directory.
