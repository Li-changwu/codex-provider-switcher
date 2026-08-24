import { build } from "esbuild";

const nodeMajorVersion = process.versions.node.split(".")[0];

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  external: ["vscode"],
  platform: "node",
  target: `node${nodeMajorVersion}`,
  format: "cjs",
  outfile: "dist/extension.js",
  sourcemap: true,
});
