import { build } from "esbuild";

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  external: ["vscode"],
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/extension.js",
  sourcemap: true,
});
