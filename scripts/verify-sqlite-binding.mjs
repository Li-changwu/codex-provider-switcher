import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findNativeBinding, runSqliteRequire } from "./sqlite-binding-utils.mjs";

export const sqlitePackagePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../node_modules/sqlite3",
);

export async function verifySqliteBinding() {
  let nativeBindingPath;
  try {
    nativeBindingPath = await findNativeBinding(sqlitePackagePath);
  } catch {
    nativeBindingPath = undefined;
  }
  if (!nativeBindingPath) {
    throw new Error(`Missing native SQLite binding under: ${sqlitePackagePath}`);
  }

  const result = await runSqliteRequire(resolve(sqlitePackagePath, "../.."));
  if (result.timedOut) {
    throw new Error(`Native SQLite binding load timed out after ${result.timeoutMs}ms.`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      [
        `Native SQLite binding failed to load: ${nativeBindingPath}`,
        result.output,
      ].join("\n"),
    );
  }

  return nativeBindingPath;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const nativeBindingPath = await verifySqliteBinding();
  console.log(`Verified native SQLite binding: ${nativeBindingPath}`);
}
