import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflowDirectory = resolve(repositoryRoot, ".github/workflows");

const actionPins = new Map([
  ["actions/checkout", "d23441a48e516b6c34aea4fa41551a30e30af803"],
  ["actions/setup-node", "249970729cb0ef3589644e2896645e5dc5ba9c38"],
  ["actions/upload-artifact", "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"],
  ["actions/download-artifact", "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"],
]);

test("pins every official workflow action to its Node 24 runtime commit", async () => {
  const workflowFiles = (await readdir(workflowDirectory)).filter((file) =>
    /\.ya?ml$/u.test(file),
  );

  for (const workflowFile of workflowFiles) {
    const workflow = await readFile(resolve(workflowDirectory, workflowFile), "utf8");

    for (const [action, expectedPin] of actionPins) {
      const references = workflow.matchAll(
        new RegExp(`uses:\\s*${action.replace("/", "\\/")}@([^\\s#]+)`, "gu"),
      );

      for (const reference of references) {
        assert.equal(
          reference[1],
          expectedPin,
          `${workflowFile} must pin ${action} to ${expectedPin}`,
        );
      }
    }
  }
});
