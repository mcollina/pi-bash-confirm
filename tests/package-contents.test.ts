import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));

test("npm package includes only runtime sources", () => {
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));

  assert.deepEqual(packageJson.files, [
    "extensions/bash-confirm.ts",
    "extensions/command-splitter.ts",
  ]);
});
