import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  AUTO_ACCEPT_MAX_TOKENS,
  AUTO_ACCEPT_SYSTEM_PROMPT,
  buildAutoAcceptPrompt,
  parseAutoAcceptDecision,
  type AutoAcceptDecision,
  type AutoAcceptStrictness,
} from "../extensions/bash-confirm.ts";

type ExpectedDecisions = Record<AutoAcceptStrictness, AutoAcceptDecision>;

type EvalCase = {
  id: string;
  category: string;
  command: string;
  cwd?: string;
  additionalAllowedDirectories?: string[];
  expected: ExpectedDecisions;
  historicalCount: number;
  origin: "historical" | "historical-adapted" | "historical-sanitized";
  rationale?: string;
};

type EvalDataset = {
  version: number;
  description: string;
  source: Record<string, unknown>;
  defaults: {
    cwd: string;
    additionalAllowedDirectories: string[];
  };
  cases: EvalCase[];
};

type EvalResult = {
  caseId: string;
  category: string;
  strictness: AutoAcceptStrictness;
  run: number;
  expected: AutoAcceptDecision;
  actual: AutoAcceptDecision;
  passed: boolean;
  reason: string;
  rawResponse: string;
  parseError?: string;
  requestError?: string;
  latencyMs: number;
  cost: number;
};

type EvalSummary = {
  total: number;
  passed: number;
  accuracy: number;
  falseNegatives: number;
  falsePositives: number;
  errors: number;
  cost: number;
};

type CliOptions = {
  datasetPath: string;
  modelRef?: string;
  strictnesses: AutoAcceptStrictness[];
  runs: number;
  concurrency: number;
  timeoutMs: number;
  limit?: number;
  filter?: RegExp;
  outputPath?: string;
  dryRun: boolean;
};

const DEFAULT_DATASET_PATH = fileURLToPath(new URL("./commands.json", import.meta.url));

function usage(): string {
  return [
    "Usage: npm run eval -- [options]",
    "",
    "Options:",
    "  --model <provider/model>   Model to evaluate (or BASH_CONFIRM_EVAL_MODEL)",
    "  --mode <both|strict|permissive>  Policy mode(s), default: both",
    "  --dataset <path>           Dataset JSON, default: evals/commands.json",
    "  --runs <n>                 Repetitions per case and mode, default: 1",
    "  --concurrency <n>          Concurrent model requests, default: 4",
    "  --timeout-ms <n>           Per-request timeout, default: 20000",
    "  --filter <regex>           Match case id, category, or command",
    "  --limit <n>                Evaluate at most n matching cases",
    "  --output <path>            Write a detailed JSON report",
    "  --dry-run                  Validate and summarize without model calls",
    "  --help                     Show this help",
  ].join("\n");
}

function parsePositiveInteger(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return number;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    datasetPath: DEFAULT_DATASET_PATH,
    modelRef: process.env.BASH_CONFIRM_EVAL_MODEL,
    strictnesses: ["strict", "permissive"],
    runs: 1,
    concurrency: 4,
    timeoutMs: 20000,
    dryRun: false,
  };

  const takeValue = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--model") {
      options.modelRef = takeValue(index, arg);
      index++;
      continue;
    }
    if (arg === "--dataset") {
      options.datasetPath = resolve(takeValue(index, arg));
      index++;
      continue;
    }
    if (arg === "--mode") {
      const mode = takeValue(index, arg);
      if (mode !== "both" && mode !== "strict" && mode !== "permissive") {
        throw new Error("--mode must be both, strict, or permissive");
      }
      options.strictnesses = mode === "both" ? ["strict", "permissive"] : [mode];
      index++;
      continue;
    }
    if (arg === "--runs") {
      options.runs = parsePositiveInteger(takeValue(index, arg), arg);
      index++;
      continue;
    }
    if (arg === "--concurrency") {
      options.concurrency = parsePositiveInteger(takeValue(index, arg), arg);
      index++;
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInteger(takeValue(index, arg), arg);
      index++;
      continue;
    }
    if (arg === "--limit") {
      options.limit = parsePositiveInteger(takeValue(index, arg), arg);
      index++;
      continue;
    }
    if (arg === "--filter") {
      options.filter = new RegExp(takeValue(index, arg), "i");
      index++;
      continue;
    }
    if (arg === "--output") {
      options.outputPath = resolve(takeValue(index, arg));
      index++;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function isDecision(value: unknown): value is AutoAcceptDecision {
  return value === "allow" || value === "review";
}

export function loadDataset(path: string): EvalDataset {
  const dataset = JSON.parse(readFileSync(path, "utf8")) as EvalDataset;
  if (dataset.version !== 1 || !dataset.defaults || !Array.isArray(dataset.cases)) {
    throw new Error(`Unsupported or malformed eval dataset: ${path}`);
  }
  if (typeof dataset.defaults.cwd !== "string" || !Array.isArray(dataset.defaults.additionalAllowedDirectories)) {
    throw new Error("Dataset defaults must define cwd and additionalAllowedDirectories");
  }

  const ids = new Set<string>();
  for (const [index, evalCase] of dataset.cases.entries()) {
    if (!evalCase || typeof evalCase.id !== "string" || !evalCase.id.trim()) {
      throw new Error(`Case ${index} has no id`);
    }
    if (ids.has(evalCase.id)) throw new Error(`Duplicate case id: ${evalCase.id}`);
    ids.add(evalCase.id);
    if (typeof evalCase.command !== "string" || !evalCase.command.trim()) {
      throw new Error(`Case ${evalCase.id} has no command`);
    }
    if (!isDecision(evalCase.expected?.strict) || !isDecision(evalCase.expected?.permissive)) {
      throw new Error(`Case ${evalCase.id} has invalid expected decisions`);
    }
    if (!Number.isInteger(evalCase.historicalCount) || evalCase.historicalCount < 1) {
      throw new Error(`Case ${evalCase.id} has invalid historicalCount`);
    }
  }
  return dataset;
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content.map(item => {
    if (!item || typeof item !== "object") return "";
    const block = item as Record<string, unknown>;
    if (typeof block.text === "string") return block.text;
    if (typeof block.thinking === "string") return block.thinking;
    if (block.arguments !== undefined) {
      return typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments);
    }
    return "";
  }).join("").trim();
}

function splitModelReference(modelRef: string): { provider: string; modelId: string } {
  const separator = modelRef.indexOf("/");
  if (separator <= 0 || separator === modelRef.length - 1) {
    throw new Error("Model must use <provider>/<modelId> format");
  }
  return { provider: modelRef.slice(0, separator), modelId: modelRef.slice(separator + 1) };
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export function summarizeResults(results: EvalResult[]): EvalSummary {
  const passed = results.filter(result => result.passed).length;
  const falseNegatives = results.filter(result => result.expected === "allow" && result.actual === "review").length;
  const falsePositives = results.filter(result => result.expected === "review" && result.actual === "allow").length;
  const errors = results.filter(result => result.parseError || result.requestError).length;
  const cost = results.reduce((total, result) => total + result.cost, 0);
  return {
    total: results.length,
    passed,
    accuracy: results.length === 0 ? 0 : passed / results.length,
    falseNegatives,
    falsePositives,
    errors,
    cost,
  };
}

function printDatasetSummary(dataset: EvalDataset, cases: EvalCase[]): void {
  const categories = new Map<string, number>();
  let strictAllows = 0;
  let permissiveAllows = 0;
  for (const evalCase of cases) {
    categories.set(evalCase.category, (categories.get(evalCase.category) ?? 0) + 1);
    if (evalCase.expected.strict === "allow") strictAllows++;
    if (evalCase.expected.permissive === "allow") permissiveAllows++;
  }

  console.log(`Dataset v${dataset.version}: ${cases.length} cases`);
  console.log(`Expected approvals: strict=${strictAllows}, permissive=${permissiveAllows}`);
  console.log(`Categories: ${[...categories.entries()].sort().map(([name, count]) => `${name}=${count}`).join(", ")}`);
}

function printResultSummary(results: EvalResult[]): void {
  for (const strictness of ["strict", "permissive"] as const) {
    const modeResults = results.filter(result => result.strictness === strictness);
    if (modeResults.length === 0) continue;
    const summary = summarizeResults(modeResults);
    console.log(
      `${strictness}: ${summary.passed}/${summary.total} (${(summary.accuracy * 100).toFixed(1)}%)` +
      ` false-negatives=${summary.falseNegatives} false-positives=${summary.falsePositives}` +
      ` errors=${summary.errors} cost=$${summary.cost.toFixed(4)}`,
    );
  }

  const failures = results.filter(result => !result.passed);
  if (failures.length === 0) return;
  console.log("\nFailures:");
  for (const result of failures) {
    const diagnostic = result.requestError ?? result.parseError ?? result.reason;
    console.log(`- ${result.caseId} [${result.strictness}]: expected=${result.expected} actual=${result.actual} — ${diagnostic}`);
  }
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const dataset = loadDataset(options.datasetPath);
  let cases = dataset.cases.filter(evalCase => {
    if (!options.filter) return true;
    return options.filter.test(`${evalCase.id}\n${evalCase.category}\n${evalCase.command}`);
  });
  if (options.limit !== undefined) cases = cases.slice(0, options.limit);
  printDatasetSummary(dataset, cases);

  if (options.dryRun) return;
  if (!options.modelRef) {
    throw new Error("--model is required unless --dry-run is used (or set BASH_CONFIRM_EVAL_MODEL)");
  }

  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  const { provider, modelId } = splitModelReference(options.modelRef);
  const model = registry.find(provider, modelId);
  if (!model) throw new Error(`Model not found: ${options.modelRef}`);
  const auth = await registry.getApiKeyAndHeaders(model);
  if (auth.ok === false) throw new Error(auth.error);

  const jobs = cases.flatMap(evalCase => options.strictnesses.flatMap(strictness =>
    Array.from({ length: options.runs }, (_, index) => ({ evalCase, strictness, run: index + 1 })),
  ));
  console.log(`Running ${jobs.length} evaluations with ${options.modelRef} (concurrency=${options.concurrency})...`);

  const results = await mapConcurrent(jobs, options.concurrency, async ({ evalCase, strictness, run }): Promise<EvalResult> => {
    const started = performance.now();
    let rawResponse = "";
    let reason = "";
    let parseError: string | undefined;
    let requestError: string | undefined;
    let actual: AutoAcceptDecision = "review";
    let cost = 0;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const assistant = await completeSimple(
        model,
        {
          systemPrompt: AUTO_ACCEPT_SYSTEM_PROMPT,
          messages: [{
            role: "user",
            content: buildAutoAcceptPrompt(
              evalCase.cwd ?? dataset.defaults.cwd,
              evalCase.command,
              strictness,
              evalCase.additionalAllowedDirectories ?? dataset.defaults.additionalAllowedDirectories,
            ),
            timestamp: Date.now(),
          }],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          reasoning: "minimal",
          maxTokens: AUTO_ACCEPT_MAX_TOKENS,
          signal: controller.signal,
        },
      );
      rawResponse = extractAssistantText(assistant);
      cost = assistant.usage?.cost?.total ?? 0;
      const parsed = parseAutoAcceptDecision(rawResponse);
      if (parsed.result) {
        actual = parsed.result.decision;
        reason = parsed.result.reason;
      } else {
        parseError = parsed.error ?? "Could not parse model decision";
        reason = "Invalid response; production fallback is manual review";
      }
    } catch (error: unknown) {
      requestError = error instanceof Error ? error.message : String(error);
      reason = "Request failed; production fallback is manual review";
    } finally {
      clearTimeout(timeout);
    }

    const expected = evalCase.expected[strictness];
    return {
      caseId: evalCase.id,
      category: evalCase.category,
      strictness,
      run,
      expected,
      actual,
      passed: actual === expected,
      reason,
      rawResponse,
      parseError,
      requestError,
      latencyMs: Math.round(performance.now() - started),
      cost,
    };
  });

  printResultSummary(results);
  if (options.outputPath) {
    const report = {
      generatedAt: new Date().toISOString(),
      model: options.modelRef,
      dataset: options.datasetPath,
      options: {
        strictnesses: options.strictnesses,
        runs: options.runs,
        concurrency: options.concurrency,
        timeoutMs: options.timeoutMs,
        filter: options.filter?.source,
        limit: options.limit,
      },
      summary: summarizeResults(results),
      results,
    };
    writeFileSync(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`Detailed report: ${options.outputPath}`);
  }
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
