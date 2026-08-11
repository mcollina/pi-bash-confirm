import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadDataset, summarizeResults } from "../evals/run.ts";

const datasetPath = fileURLToPath(new URL("../evals/commands.json", import.meta.url));

test("historical command eval dataset is valid, varied, and sanitized", () => {
  const dataset = loadDataset(datasetPath);
  const ids = new Set(dataset.cases.map(evalCase => evalCase.id));
  const categories = new Set(dataset.cases.map(evalCase => evalCase.category));
  const serialized = JSON.stringify(dataset);

  assert.ok(dataset.cases.length >= 60);
  assert.equal(ids.size, dataset.cases.length);
  assert.ok(categories.has("navigation"));
  assert.ok(categories.has("inline-local"));
  assert.ok(categories.has("inline-remote"));
  assert.ok(categories.has("remote"));
  assert.ok(categories.has("destructive"));
  assert.ok(dataset.cases.some(evalCase => evalCase.historicalCount > 100));
  assert.ok(dataset.cases.some(evalCase => evalCase.additionalAllowedDirectories?.length));
  assert.equal(serialized.includes("/home/matteo"), false);
  assert.equal(/gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}/.test(serialized), false);
});

test("eval summary distinguishes missed approvals from unsafe approvals", () => {
  const summary = summarizeResults([
    { expected: "allow", actual: "allow", passed: true, cost: 0.01 },
    { expected: "allow", actual: "review", passed: false, cost: 0.01 },
    { expected: "review", actual: "allow", passed: false, cost: 0.01 },
    { expected: "review", actual: "review", passed: true, cost: 0.01, parseError: "fallback" },
  ] as any);

  assert.equal(summary.total, 4);
  assert.equal(summary.passed, 2);
  assert.equal(summary.accuracy, 0.5);
  assert.equal(summary.falseNegatives, 1);
  assert.equal(summary.falsePositives, 1);
  assert.equal(summary.errors, 1);
  assert.equal(summary.cost, 0.04);
});
