import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { completeSimple } from "@mariozechner/pi-ai";
import { wrapTextWithAnsi } from "@mariozechner/pi-tui";
import https from "node:https";
import { splitCommand } from "./command-splitter.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

type WhitelistEntryType = "exact" | "pattern";
type WhitelistEntrySource = "user" | "ai";

type WhitelistEntry = {
  type: WhitelistEntryType;
  value: string;
  addedAt: string;
  note?: string;
  source?: WhitelistEntrySource;
};

type LegacyWhitelistEntry = {
  command?: string;
  addedAt?: string;
  note?: string;
};

type WhitelistData = {
  entries: WhitelistEntry[];
  version: number;
};

type GeneratedPattern = {
  pattern: string;
  dynamicCount: number;
  examples: string[];
  warnings: string[];
};

type TelegramResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error_code?: number; description?: string };

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: JsonObject, overrides: JsonObject): JsonObject {
  const result: JsonObject = { ...base };

  for (const [key, overrideValue] of Object.entries(overrides)) {
    if (overrideValue === undefined) continue;

    const baseValue = base[key];

    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      result[key] = deepMerge(baseValue, overrideValue);
    } else {
      result[key] = overrideValue;
    }
  }

  return result;
}

function loadJsonFile(path: string, ctx?: ExtensionContext): JsonObject {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return isPlainObject(parsed) ? parsed : {};
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    ctx?.ui.notify(`Failed to read settings: ${path} (${message})`, "warning");
    return {};
  }
}

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function loadMergedSettings(cwd: string, ctx?: ExtensionContext): {
  settings: JsonObject;
  globalSettingsPath: string;
  projectSettingsPath: string;
} {
  const globalSettingsPath = join(getAgentDir(), "settings.json");
  const projectSettingsPath = join(cwd, ".pi", "settings.json");

  const globalSettings = loadJsonFile(globalSettingsPath, ctx);
  const projectSettings = loadJsonFile(projectSettingsPath, ctx);

  return {
    settings: deepMerge(globalSettings, projectSettings),
    globalSettingsPath,
    projectSettingsPath,
  };
}

function getSetting<T>(settings: JsonObject, path: string, fallback: T): T {
  const parts = path.split(".").filter(Boolean);
  let current: unknown = settings;

  for (const part of parts) {
    if (!isPlainObject(current)) return fallback;
    current = current[part];
  }

  return (current as T) ?? fallback;
}

function debugNotify(ctx: ExtensionContext, settings: JsonObject, message: string): void {
  const debugEnabled = getSetting(settings, "bashConfirm.debug", false);
  if (!debugEnabled) return;
  ctx.ui.notify(`[bash-confirm debug] ${message}`, "info");
}

function maskToken(token: string): string {
  if (!token) return "(missing)";
  if (token.length <= 10) return "(present)";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function coerceChatId(chatId: unknown): string | number | undefined {
  if (typeof chatId === "number") return chatId;
  if (typeof chatId === "string") {
    const trimmed = chatId.trim();
    if (!trimmed) return undefined;
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum) && String(asNum) === trimmed) return asNum;
    return trimmed;
  }
  return undefined;
}

function formatNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const anyErr = error as any;
  const code = anyErr.code || anyErr.cause?.code;
  return code ? `${error.message} (${String(code)})` : error.message;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenizeCommand(command: string): string[] {
  const matches = command.match(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|\S+/g);
  return matches ?? [];
}

function classifyDynamicValue(value: string): { regex: string; example: string } | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return { regex: "\\d+", example: "42" };
  if (/^[a-f0-9]{7,40}$/i.test(value)) return { regex: "[a-f0-9]{7,40}", example: "deadbeef" };
  if (/^(~\/|\/|\.\/|\.\.\/)/.test(value) || value.includes("/")) {
    return { regex: "[\\w./~-]+", example: "path/to/value" };
  }
  if (/^[\w.-]+$/.test(value) && (/[0-9]/.test(value) || value.includes("-") || value.includes("_"))) {
    return { regex: "[\\w.-]+", example: "value-123" };
  }
  return null;
}

function shouldGeneralizeQuotedLiteral(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;

  // Keep very simple quoted literals exact.
  if (/^[\w./~-]+$/.test(trimmed)) return false;

  // Scripts and free-form text are likely variable and should be generalized.
  return /[\s()[\]{}'";,:!+=*?]/.test(trimmed);
}

function tokenizeWithExamples(command: string): GeneratedPattern {
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      pattern: "^$",
      dynamicCount: 0,
      examples: [],
      warnings: ["Command is empty"],
    };
  }

  const tokens = tokenizeCommand(trimmed);
  if (tokens.length === 0) {
    return {
      pattern: `^${escapeRegex(trimmed)}$`,
      dynamicCount: 0,
      examples: [trimmed],
      warnings: ["Could not parse command tokens"],
    };
  }

  const patternParts: string[] = [];
  const exampleTokens = [...tokens];
  let dynamicCount = 0;
  let generalizedQuotedLiterals = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (i === 0) {
      patternParts.push(escapeRegex(token));
      continue;
    }

    const eqIndex = token.indexOf("=");
    if (/^--?[\w-]+=/.test(token) && eqIndex > 0) {
      const key = token.slice(0, eqIndex);
      const value = token.slice(eqIndex + 1);
      const dynamic = classifyDynamicValue(value);
      if (dynamic) {
        patternParts.push(`${escapeRegex(key)}=${dynamic.regex}`);
        exampleTokens[i] = `${key}=${dynamic.example}`;
        dynamicCount++;
        continue;
      }
      patternParts.push(escapeRegex(token));
      continue;
    }

    if (/^--?[\w-]+$/.test(token)) {
      patternParts.push(escapeRegex(token));
      continue;
    }

    const quoted = (token.startsWith("\"") && token.endsWith("\"")) || (token.startsWith("'") && token.endsWith("'"));
    if (quoted && token.length >= 2) {
      const quote = token[0];
      const inner = token.slice(1, -1);
      const dynamic = classifyDynamicValue(inner);
      const shouldGeneralize = dynamic !== null || shouldGeneralizeQuotedLiteral(inner);
      if (shouldGeneralize) {
        if (quote === "\"") {
          patternParts.push(`\"[^\"]+\"`);
          exampleTokens[i] = `"${dynamic?.example ?? "value"}"`;
        } else {
          patternParts.push(`'[^']+'`);
          exampleTokens[i] = `'${dynamic?.example ?? "value"}'`;
        }
        dynamicCount++;
        if (dynamic === null) generalizedQuotedLiterals++;
        continue;
      }
      patternParts.push(escapeRegex(token));
      continue;
    }

    const dynamic = classifyDynamicValue(token);
    if (dynamic) {
      patternParts.push(dynamic.regex);
      exampleTokens[i] = dynamic.example;
      dynamicCount++;
      continue;
    }

    patternParts.push(escapeRegex(token));
  }

  const pattern = `^${patternParts.join("\\s+")}$`;
  const examples = [trimmed];
  const generatedExample = exampleTokens.join(" ");
  if (generatedExample !== trimmed) examples.push(generatedExample);

  const warnings: string[] = [];
  if (dynamicCount === 0) warnings.push("No dynamic tokens detected. Pattern is effectively exact.");
  if (generalizedQuotedLiterals > 0) warnings.push("Generalized quoted literal values; review before saving.");
  if (pattern.includes(".*")) warnings.push("Pattern contains broad wildcard (.*). Consider tightening it.");

  return { pattern, dynamicCount, examples, warnings };
}

function validateWhitelistPattern(pattern: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = pattern.trim();
  if (!trimmed) return { ok: false, reason: "Pattern is empty" };
  if (!trimmed.startsWith("^") || !trimmed.endsWith("$")) {
    return { ok: false, reason: "Pattern must be anchored with ^ and $" };
  }
  if (trimmed === "^.*$" || trimmed === "^.+$") {
    return { ok: false, reason: "Pattern is too broad" };
  }
  if (trimmed.includes(".*")) {
    return { ok: false, reason: "Pattern contains broad wildcard (.*), which is not allowed" };
  }

  try {
    new RegExp(trimmed);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `Invalid regex: ${message}` };
  }

  return { ok: true };
}

function normalizeWhitelistEntry(raw: unknown): WhitelistEntry | null {
  if (!isPlainObject(raw)) return null;

  const maybeLegacy = raw as LegacyWhitelistEntry;
  if (typeof maybeLegacy.command === "string") {
    const value = maybeLegacy.command.trim();
    if (!value) return null;
    return {
      type: "exact",
      value,
      addedAt: maybeLegacy.addedAt || new Date().toISOString(),
      note: maybeLegacy.note,
      source: "user",
    };
  }

  const type = raw.type;
  const value = raw.value;
  const addedAt = raw.addedAt;
  const note = raw.note;
  const source = raw.source;

  if ((type !== "exact" && type !== "pattern") || typeof value !== "string") return null;
  const trimmedValue = value.trim();
  if (!trimmedValue) return null;

  if (type === "pattern") {
    const validation = validateWhitelistPattern(trimmedValue);
    if (!validation.ok) return null;
  }

  return {
    type,
    value: trimmedValue,
    addedAt: typeof addedAt === "string" ? addedAt : new Date().toISOString(),
    note: typeof note === "string" && note.trim() ? note.trim() : undefined,
    source: source === "ai" || source === "user" ? source : undefined,
  };
}

function loadWhitelist(cwd: string): WhitelistData {
  const whitelistPath = join(cwd, ".pi", "bash-confirm-whitelist.json");

  if (!existsSync(whitelistPath)) {
    return { entries: [], version: 2 };
  }

  try {
    const data = JSON.parse(readFileSync(whitelistPath, "utf-8")) as unknown;
    if (isPlainObject(data)) {
      const obj = data as Record<string, unknown>;
      const rawEntries = Array.isArray(obj.entries) ? obj.entries : [];
      const entries = rawEntries
        .map(entry => normalizeWhitelistEntry(entry))
        .filter((entry): entry is WhitelistEntry => entry !== null);
      const version = typeof obj.version === "number" ? obj.version : 1;
      const normalized: WhitelistData = { entries, version: 2 };

      // Migrate old shape (v1 command entries) or clean invalid entries.
      if (version < 2 || entries.length !== rawEntries.length) {
        saveWhitelist(cwd, normalized);
      }

      return normalized;
    }
  } catch {
    // Ignore errors and return default
  }

  return { entries: [], version: 2 };
}

function saveWhitelist(cwd: string, whitelist: WhitelistData): void {
  const dir = join(cwd, ".pi");
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return; // Failed to create directory
    }
  }

  try {
    writeFileSync(
      join(cwd, ".pi", "bash-confirm-whitelist.json"),
      JSON.stringify({ ...whitelist, version: 2 }, null, 2),
      "utf-8",
    );
  } catch {
    // Silent fail - can't write whitelist file
  }
}

function addWhitelistEntry(
  cwd: string,
  entry: { type: WhitelistEntryType; value: string; note?: string; source?: WhitelistEntrySource }
): boolean {
  const value = entry.value.trim();
  if (!value) return false;

  if (entry.type === "pattern") {
    const validation = validateWhitelistPattern(value);
    if (!validation.ok) return false;
  }

  const whitelist = loadWhitelist(cwd);
  if (whitelist.entries.some(existing => existing.type === entry.type && existing.value === value)) {
    return false;
  }

  whitelist.entries.push({
    type: entry.type,
    value,
    addedAt: new Date().toISOString(),
    note: entry.note,
    source: entry.source,
  });

  saveWhitelist(cwd, whitelist);
  return true;
}

function addExactToWhitelist(cwd: string, command: string, note?: string, source: WhitelistEntrySource = "user"): boolean {
  return addWhitelistEntry(cwd, { type: "exact", value: command, note, source });
}

function addPatternToWhitelist(cwd: string, pattern: string, note?: string, source: WhitelistEntrySource = "ai"): boolean {
  return addWhitelistEntry(cwd, { type: "pattern", value: pattern, note, source });
}

function removeFromWhitelist(cwd: string, value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;

  const whitelist = loadWhitelist(cwd);
  const nextEntries = whitelist.entries.filter(entry => entry.value !== trimmed);
  if (nextEntries.length === whitelist.entries.length) {
    return false;
  }

  whitelist.entries = nextEntries;
  saveWhitelist(cwd, whitelist);
  return true;
}

function formatWhitelistEntry(entry: WhitelistEntry, index: number): string {
  const date = new Date(entry.addedAt).toLocaleString();
  const note = entry.note ? ` (${entry.note})` : "";
  const source = entry.source ? ` [source: ${entry.source}]` : "";
  return `${index + 1}. [${entry.type}] ${escapeHtml(entry.value)}${escapeHtml(note)}${escapeHtml(source)}\n   Added: ${date}`;
}

function matchesRegexList(input: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern).test(input)) return true;
    } catch {
      // Ignore invalid config regexes
    }
  }
  return false;
}

function compileWhitelistPatterns(entries: WhitelistEntry[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const entry of entries) {
    if (entry.type !== "pattern") continue;
    const validation = validateWhitelistPattern(entry.value);
    if (!validation.ok) continue;
    try {
      compiled.push(new RegExp(entry.value));
    } catch {
      // Ignore invalid regex entries
    }
  }
  return compiled;
}

function parseValueAndNote(input: string): { value: string; note?: string } {
  const marker = " --note ";
  const markerIndex = input.indexOf(marker);
  if (markerIndex === -1) {
    return { value: input.trim() };
  }

  const value = input.slice(0, markerIndex).trim();
  const note = input.slice(markerIndex + marker.length).trim() || undefined;
  return { value, note };
}

type WhitelistAnalysisSnapshot = {
  exactEntries: string[];
  patternEntries: string[];
  exactCoveredByPattern: Array<{ command: string; matchingPatterns: string[] }>;
  prefixGroups: Array<{ prefix: string; commands: string[] }>;
};

type PendingGeneralizationRequest = {
  cwd: string;
  whitelistFingerprint: string;
};

type AiGeneralizationPlan = {
  addPatterns: Array<{ pattern: string; note?: string }>;
  removeExact: string[];
};

type AppliedGeneralizationResult = {
  addedPatterns: string[];
  removedExact: string[];
  skipped: string[];
};

type AutoAcceptDecision = "allow" | "review";
type AutoAcceptStrictness = "strict" | "permissive";

type AutoAcceptResult = {
  decision: AutoAcceptDecision;
  reason: string;
  modelRef: string;
};

const GENERALIZE_MARKER = "[BASH_CONFIRM_GENERALIZE_V1]";
const AUTO_ACCEPT_MARKER = "[BASH_CONFIRM_AUTO_ACCEPT_V1]";
let pendingGeneralizationRequest: PendingGeneralizationRequest | undefined;

type AutoAcceptSessionOverride = "on" | "off";
const autoAcceptSessionOverrides = new Map<string, AutoAcceptSessionOverride>();
const autoAcceptStrictnessSessionOverrides = new Map<string, AutoAcceptStrictness>();

function getSessionOverrideKey(ctx: ExtensionContext): string {
  const sessionId = typeof ctx.sessionId === "string" && ctx.sessionId.trim()
    ? ctx.sessionId.trim()
    : "(no-session)";
  return `${ctx.cwd}::${sessionId}`;
}

function getAutoAcceptSessionOverride(ctx: ExtensionContext): AutoAcceptSessionOverride | undefined {
  return autoAcceptSessionOverrides.get(getSessionOverrideKey(ctx));
}

function setAutoAcceptSessionOverride(ctx: ExtensionContext, mode: AutoAcceptSessionOverride): void {
  autoAcceptSessionOverrides.set(getSessionOverrideKey(ctx), mode);
}

function clearAutoAcceptSessionOverride(ctx: ExtensionContext): void {
  autoAcceptSessionOverrides.delete(getSessionOverrideKey(ctx));
}

function getAutoAcceptStrictnessSessionOverride(ctx: ExtensionContext): AutoAcceptStrictness | undefined {
  return autoAcceptStrictnessSessionOverrides.get(getSessionOverrideKey(ctx));
}

function setAutoAcceptStrictnessSessionOverride(ctx: ExtensionContext, strictness: AutoAcceptStrictness): void {
  autoAcceptStrictnessSessionOverrides.set(getSessionOverrideKey(ctx), strictness);
}

function clearAutoAcceptStrictnessSessionOverride(ctx: ExtensionContext): void {
  autoAcceptStrictnessSessionOverrides.delete(getSessionOverrideKey(ctx));
}

function buildWhitelistAnalysisSnapshot(entries: WhitelistEntry[]): WhitelistAnalysisSnapshot {
  const exactEntries = entries
    .filter(entry => entry.type === "exact")
    .map(entry => entry.value)
    .filter(Boolean);

  const patternEntries = entries
    .filter(entry => entry.type === "pattern")
    .map(entry => entry.value)
    .filter(Boolean);

  const exactCoveredByPattern = exactEntries
    .map(command => {
      const matchingPatterns = patternEntries.filter(pattern => {
        try {
          return new RegExp(pattern).test(command);
        } catch {
          return false;
        }
      });
      return { command, matchingPatterns };
    })
    .filter(item => item.matchingPatterns.length > 0)
    .slice(0, 40);

  const byPrefix = new Map<string, string[]>();
  for (const command of exactEntries) {
    const tokens = tokenizeCommand(command);
    const key = tokens.slice(0, 2).join(" ").trim() || tokens[0] || command;
    const group = byPrefix.get(key);
    if (group) {
      group.push(command);
    } else {
      byPrefix.set(key, [command]);
    }
  }

  const prefixGroups = [...byPrefix.entries()]
    .map(([prefix, commands]) => ({ prefix, commands }))
    .filter(group => group.commands.length >= 2)
    .sort((a, b) => b.commands.length - a.commands.length)
    .slice(0, 30);

  // Keep response bounded for AI context.
  return {
    exactEntries: exactEntries.slice(0, 200),
    patternEntries: patternEntries.slice(0, 200),
    exactCoveredByPattern,
    prefixGroups,
  };
}

function buildWhitelistFingerprint(whitelist: WhitelistData): string {
  const normalized = whitelist.entries
    .map(entry => `${entry.type}:${entry.value}`)
    .sort()
    .join("\n");
  return `${whitelist.version}:${normalized}`;
}

function buildAiGeneralizationPrompt(cwd: string, whitelist: WhitelistData): string {
  const snapshot = buildWhitelistAnalysisSnapshot(whitelist.entries);

  return [
    GENERALIZE_MARKER,
    "You are reviewing a bash command permission whitelist for overlap and generalization opportunities.",
    "",
    "Goal:",
    "- Recommend safe regex pattern entries that can replace multiple exact entries.",
    "- Flag redundant exact entries already covered by existing patterns.",
    "- Be conservative: avoid broad patterns, avoid using .* unless strictly scoped.",
    "",
    "Safety constraints:",
    "- Anchor all patterns with ^ and $",
    "- Prefer explicit token classes like [\\w./-]+, \\d+, or fixed literals",
    "- Do not suggest patterns equivalent to ^.*$ or ^.+$",
    "",
    "Return ONLY valid JSON with this exact shape:",
    '{"summary":["..."],"addPatterns":[{"pattern":"^...$","note":"..."}],"removeExact":["exact command"]}',
    "",
    `Project directory: ${cwd}`,
    `Whitelist version: ${whitelist.version}`,
    `Total entries: ${whitelist.entries.length}`,
    `Exact entries: ${snapshot.exactEntries.length}`,
    `Pattern entries: ${snapshot.patternEntries.length}`,
    "",
    "Whitelist analysis snapshot (JSON):",
    "```json",
    JSON.stringify(snapshot, null, 2),
    "```",
  ].join("\n");
}

function extractFirstJsonObject(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const firstBrace = trimmed.indexOf("{");
  if (firstBrace === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = firstBrace; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return trimmed.slice(firstBrace, i + 1);
      }
    }
  }

  return undefined;
}

function parseAiGeneralizationPlan(text: string): { plan?: AiGeneralizationPlan; error?: string } {
  const jsonText = extractFirstJsonObject(text);
  if (!jsonText) {
    return { error: "No JSON object found in AI response" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Failed to parse AI JSON: ${message}` };
  }

  if (!isPlainObject(parsed)) {
    return { error: "AI response JSON must be an object" };
  }

  const addPatternsRaw = parsed.addPatterns;
  const removeExactRaw = parsed.removeExact;

  const addPatterns: Array<{ pattern: string; note?: string }> = [];
  if (Array.isArray(addPatternsRaw)) {
    for (const item of addPatternsRaw) {
      if (typeof item === "string") {
        const pattern = item.trim();
        if (pattern) addPatterns.push({ pattern });
        continue;
      }
      if (isPlainObject(item) && typeof item.pattern === "string") {
        const pattern = item.pattern.trim();
        if (!pattern) continue;
        const note = typeof item.note === "string" && item.note.trim() ? item.note.trim() : undefined;
        addPatterns.push({ pattern, note });
      }
    }
  }

  const removeExact = Array.isArray(removeExactRaw)
    ? removeExactRaw.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean)
    : [];

  if (addPatterns.length === 0 && removeExact.length === 0) {
    return { error: "AI plan contains no actionable changes" };
  }

  return { plan: { addPatterns, removeExact } };
}

function parseModelReference(ref: string): { provider: string; modelId: string } | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;

  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator >= trimmed.length - 1) return undefined;

  return {
    provider: trimmed.slice(0, separator),
    modelId: trimmed.slice(separator + 1),
  };
}

function normalizeAutoAcceptStrictness(value: unknown): AutoAcceptStrictness {
  if (typeof value !== "string") return "strict";
  const normalized = value.trim().toLowerCase();
  return normalized === "permissive" ? "permissive" : "strict";
}

function buildAutoAcceptPrompt(cwd: string, command: string, strictness: AutoAcceptStrictness): string {
  const strictPolicy = [
    "- allow when the command is clearly read-only/inspection/navigation and does not change files, git history, system state, or remote state.",
    "- allow common local verification commands when they are check-only (for example: eslint without --fix, tsc --noEmit, npm/pnpm/yarn/bun run lint|typecheck|test, prettier --check).",
    "- review for mutating operations: writes/edits, --fix/--write style flags, package install/update/remove, service/process control, permissions/ownership changes, git state changes (commit/rebase/reset/merge/push), publish/deploy/release, remote execution, or uncertainty.",
    "- for command chains, allow only if every segment is clearly check-only/read-only; otherwise choose review.",
  ];

  const permissivePolicy = [
    "- allow all strict-mode allow cases.",
    "- allow low-risk local developer write operations inside the working tree when intent is clear and bounded (for example: git commit/amend, eslint --fix, prettier --write, test snapshot updates, local build output generation).",
    "- review for high-risk operations: history rewrites beyond commit/amend (rebase/reset), remote or publishing actions (push/publish/deploy/release), destructive deletes, privilege escalation, broad permission/ownership changes, remote execution, or uncertainty.",
    "- for command chains, choose review if any segment is high-risk or unclear.",
  ];

  const policyLines = strictness === "permissive" ? permissivePolicy : strictPolicy;

  return [
    AUTO_ACCEPT_MARKER,
    "You are a security gate for bash command execution.",
    "Return ONLY JSON with shape:",
    '{"decision":"allow|review","reason":"short explanation"}',
    "",
    `Strictness mode: ${strictness}`,
    "Decision policy:",
    ...policyLines,
    "",
    "Be conservative. If uncertain, return review.",
    "",
    `Working directory: ${cwd}`,
    `Command: ${command}`,
  ].join("\n");
}

function extractAssistantTextFromContent(message: unknown): string {
  if (!isPlainObject(message)) return "";

  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const chunks: string[] = [];
  for (const item of content) {
    if (!isPlainObject(item)) continue;

    if (item.type === "text" && typeof item.text === "string") {
      chunks.push(item.text);
      continue;
    }

    // Fallback for providers that expose only thinking content.
    if (item.type === "thinking" && typeof item.thinking === "string") {
      chunks.push(item.thinking);
      continue;
    }

    // Some models may respond via tool-call style JSON arguments even without text chunks.
    if (item.type === "toolCall" && isPlainObject(item.arguments)) {
      chunks.push(JSON.stringify(item.arguments));
      continue;
    }

    if (item.type === "toolCall" && typeof item.arguments === "string") {
      chunks.push(item.arguments);
      continue;
    }

    if (typeof item.text === "string") {
      chunks.push(item.text);
    }
  }

  return chunks.join("").trim();
}

function parseAutoAcceptDecision(text: string): { result?: AutoAcceptResult; error?: string } {
  const jsonText = extractFirstJsonObject(text);
  if (!jsonText) {
    return { error: "No JSON object found in auto-accept response" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Failed to parse auto-accept JSON: ${message}` };
  }

  if (!isPlainObject(parsed)) {
    return { error: "Auto-accept JSON response must be an object" };
  }

  const decisionRaw = typeof parsed.decision === "string" ? parsed.decision.trim().toLowerCase() : "";
  if (decisionRaw !== "allow" && decisionRaw !== "review" && decisionRaw !== "block") {
    return { error: "Auto-accept decision must be one of allow|review" };
  }

  const reasonRaw = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
  const normalizedDecision: AutoAcceptDecision = decisionRaw === "allow" ? "allow" : "review";
  const normalizedReason =
    decisionRaw === "block"
      ? `Model requested block; falling back to manual review. ${reasonRaw || "No reason provided"}`
      : (reasonRaw || "No reason provided");

  return {
    result: {
      decision: normalizedDecision,
      reason: normalizedReason,
      modelRef: "",
    },
  };
}

async function evaluateAutoAcceptCommand(
  command: string,
  ctx: ExtensionContext,
  settings: JsonObject,
  strictnessOverride?: AutoAcceptStrictness,
): Promise<{ result?: AutoAcceptResult; error?: string }> {
  const configuredModel = (getSetting(settings, "bashConfirm.autoAccept.model", "") as string).trim();
  const strictness = strictnessOverride ?? normalizeAutoAcceptStrictness(getSetting(settings, "bashConfirm.autoAccept.strictness", "strict"));

  let model = ctx.model;
  if (configuredModel) {
    const parsedRef = parseModelReference(configuredModel);
    if (!parsedRef) {
      return { error: "bashConfirm.autoAccept.model must be in format <provider>/<modelId>" };
    }

    model = ctx.modelRegistry.find(parsedRef.provider, parsedRef.modelId);
    if (!model) {
      return { error: `Configured auto-accept model not found: ${configuredModel}` };
    }
  }

  if (!model) {
    return { error: "No active model available for auto-accept" };
  }

  const modelRef = `${model.provider}/${model.id}`;
  const apiKey = await ctx.modelRegistry.getApiKey(model);
  const timeoutMsRaw = getSetting(settings, "bashConfirm.autoAccept.timeoutMs", 5000);
  const timeoutMsNumber = Number(timeoutMsRaw);
  const timeoutMs = Number.isFinite(timeoutMsNumber)
    ? Math.min(20000, Math.max(1000, timeoutMsNumber))
    : 5000;

  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);

  try {
    const assistant = await completeSimple(
      model,
      {
        systemPrompt: "You are a strict bash security reviewer. Output JSON only.",
        messages: [{ role: "user", content: buildAutoAcceptPrompt(ctx.cwd, command, strictness), timestamp: Date.now() }],
      },
      {
        apiKey,
        reasoning: "minimal",
        maxTokens: 120,
        signal: timeoutController.signal,
      },
    );

    const responseText = extractAssistantTextFromContent(assistant);
    if (!responseText) {
      const modelError = isPlainObject(assistant) && typeof assistant.errorMessage === "string"
        ? assistant.errorMessage.trim()
        : "";
      const stopReason = isPlainObject(assistant) && typeof assistant.stopReason === "string"
        ? assistant.stopReason
        : "";
      const diagnostic = modelError || (stopReason ? `No text output (stopReason=${stopReason})` : "Model returned no text");

      return {
        result: {
          decision: "review",
          reason: `${diagnostic}; falling back to manual review.`,
          modelRef,
        },
      };
    }

    const parsedDecision = parseAutoAcceptDecision(responseText);
    if (!parsedDecision.result) {
      return {
        result: {
          decision: "review",
          reason: `${parsedDecision.error || "Failed to parse auto-accept response"}; falling back to manual review.`,
          modelRef,
        },
      };
    }

    parsedDecision.result.modelRef = modelRef;
    return { result: parsedDecision.result };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Auto-accept model request failed: ${message}` };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function extractLastAssistantText(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as any;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;

    const text = message.content
      .filter((content: any) => content?.type === "text" && typeof content.text === "string")
      .map((content: any) => content.text)
      .join("")
      .trim();

    if (text) return text;
  }
  return undefined;
}

function applyAiGeneralizationPlan(cwd: string, plan: AiGeneralizationPlan): AppliedGeneralizationResult {
  const whitelist = loadWhitelist(cwd);

  const existingPatternSet = new Set(
    whitelist.entries
      .filter(entry => entry.type === "pattern")
      .map(entry => entry.value)
  );
  const existingExactSet = new Set(
    whitelist.entries
      .filter(entry => entry.type === "exact")
      .map(entry => entry.value)
  );

  const addedPatterns: string[] = [];
  const skipped: string[] = [];

  for (const candidate of plan.addPatterns) {
    const pattern = candidate.pattern.trim();
    if (!pattern) continue;

    const validation = validateWhitelistPattern(pattern);
    if (validation.ok === false) {
      skipped.push(`Skipped invalid pattern ${pattern}: ${validation.reason}`);
      continue;
    }

    if (existingPatternSet.has(pattern)) {
      skipped.push(`Pattern already exists: ${pattern}`);
      continue;
    }

    existingPatternSet.add(pattern);
    addedPatterns.push(pattern);
  }

  const coverageRegexes: RegExp[] = [];
  for (const pattern of existingPatternSet) {
    try {
      coverageRegexes.push(new RegExp(pattern));
    } catch {
      // Ignore invalid regexes
    }
  }

  const removeSet = new Set<string>();
  for (const command of plan.removeExact) {
    const trimmed = command.trim();
    if (!trimmed) continue;

    if (!existingExactSet.has(trimmed)) {
      skipped.push(`Exact entry not found: ${trimmed}`);
      continue;
    }

    const isCovered = coverageRegexes.some(regex => regex.test(trimmed));
    if (!isCovered) {
      skipped.push(`Not removed (not covered by a pattern): ${trimmed}`);
      continue;
    }

    removeSet.add(trimmed);
  }

  const removedExact: string[] = [];
  const nextEntries = whitelist.entries.filter(entry => {
    if (entry.type === "exact" && removeSet.has(entry.value)) {
      removedExact.push(entry.value);
      return false;
    }
    return true;
  });

  for (const pattern of addedPatterns) {
    nextEntries.push({
      type: "pattern",
      value: pattern,
      note: "AI suggest-generalize",
      source: "ai",
      addedAt: new Date().toISOString(),
    });
  }

  if (addedPatterns.length > 0 || removedExact.length > 0) {
    saveWhitelist(cwd, { version: 2, entries: nextEntries });
  }

  return { addedPatterns, removedExact, skipped };
}

function queueAiGeneralizationReview(pi: ExtensionAPI, ctx: ExtensionContext, whitelist: WhitelistData): void {
  const prompt = buildAiGeneralizationPrompt(ctx.cwd, whitelist);

  if (ctx.isIdle() === true) {
    pi.sendUserMessage(prompt);
  } else {
    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  }
}

async function telegramCall<T>(options: {
  token: string;
  method: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  family?: 4 | 6;
}): Promise<TelegramResponse<T>> {
  const data = JSON.stringify(options.body);

  return await new Promise<TelegramResponse<T>>((resolve) => {
    const req = https.request(
      {
        protocol: "https:",
        hostname: "api.telegram.org",
        method: "POST",
        path: `/bot${options.token}/${options.method}`,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: options.timeoutMs,
        family: options.family,
      },
      (res) => {
        const chunks: Buffer[] = [];

        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          try {
            const parsed = JSON.parse(text) as unknown;
            if (isPlainObject(parsed) && typeof parsed.ok === "boolean") {
              resolve(parsed as TelegramResponse<T>);
              return;
            }
            resolve({ ok: false, description: text.slice(0, 500) });
          } catch {
            resolve({ ok: false, description: text.slice(0, 500) });
          }
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error("Request timed out"));
    });

    req.on("error", (error) => {
      resolve({ ok: false, description: `Network error: ${formatNetworkError(error)}` });
    });

    req.write(data);
    req.end();
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, Math.max(0, maxLength - 40));
  const breakPoint = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "));
  const cut = breakPoint > slice.length * 0.6 ? slice.slice(0, breakPoint).trim() : slice.trim();
  return `${cut}\n\n...(truncated)`;
}

function ringTerminalBell(): void {
  if (!process.stdout.isTTY) return;
  try {
    process.stdout.write("\x07");
  } catch {
    // Non-fatal: bell support depends on terminal settings.
  }
}

function buildShownMessage(
  ctx: ExtensionContext,
  command: string,
  settings: JsonObject
): string {
  const sessionId = ctx.sessionId?.slice(0, 8) || "";
  const lines: string[] = [];
  lines.push("<b>⏳ Command Confirmation Requested</b>");
  if (sessionId) lines.push(`Session: <code>${escapeHtml(sessionId)}</code>`);
  lines.push(`Directory: <code>${escapeHtml(ctx.cwd)}</code>`);
  lines.push("");
  lines.push("<b>Command</b>");
  lines.push(`<code>${escapeHtml(truncateText(command, 1000))}</code>`);
  lines.push("");
  lines.push(`<i>${new Date().toISOString()}</i>`);
  return truncateText(lines.join("\n"), 3900);
}

function buildBlockedMessage(
  ctx: ExtensionContext,
  command: string,
  reason: string,
  settings: JsonObject
): string {
  const sessionId = ctx.sessionId?.slice(0, 8) || "";
  const lines: string[] = [];
  lines.push("<b>⛔ Command Blocked</b>");
  if (sessionId) lines.push(`Session: <code>${escapeHtml(sessionId)}</code>`);
  lines.push(`Directory: <code>${escapeHtml(ctx.cwd)}</code>`);
  lines.push("");
  lines.push("<b>Command</b>");
  lines.push(`<code>${escapeHtml(truncateText(command, 1000))}</code>`);
  lines.push("");
  lines.push("<b>Reason</b>");
  lines.push(escapeHtml(reason));
  lines.push("");
  lines.push(`<i>${new Date().toISOString()}</i>`);
  return truncateText(lines.join("\n"), 3900);
}

function buildModifiedMessage(
  ctx: ExtensionContext,
  originalCommand: string,
  modifiedCommand: string,
  settings: JsonObject
): string {
  const sessionId = ctx.sessionId?.slice(0, 8) || "";
  const lines: string[] = [];
  lines.push("<b>✏️ Command Modified</b>");
  if (sessionId) lines.push(`Session: <code>${escapeHtml(sessionId)}</code>`);
  lines.push(`Directory: <code>${escapeHtml(ctx.cwd)}</code>`);
  lines.push("");
  lines.push("<b>Original</b>");
  lines.push(`<code>${escapeHtml(truncateText(originalCommand, 500))}</code>`);
  lines.push("");
  lines.push("<b>Modified</b>");
  lines.push(`<code>${escapeHtml(truncateText(modifiedCommand, 500))}</code>`);
  lines.push("");
  lines.push(`<i>${new Date().toISOString()}</i>`);
  return truncateText(lines.join("\n"), 3900);
}

async function sendShownNotification(
  ctx: ExtensionContext,
  command: string,
  pi: ExtensionAPI
) {
  const { settings } = loadMergedSettings(ctx.cwd, ctx);
  const notifyEnabled = getSetting(settings, "bashConfirm.notifications.enabled", false);
  if (!notifyEnabled) return;

  const onShown = getSetting(settings, "bashConfirm.notifications.onShown", false);
  if (!onShown) return;

  const telegramEnabled = getSetting(settings, "bashConfirm.notifications.telegram.enabled", false);
  if (!telegramEnabled) return;

  const token = getSetting(settings, "bashConfirm.notifications.telegram.token", "") ||
               process.env.TELEGRAM_BOT_TOKEN ||
               process.env.PI_TELEGRAM_TOKEN;
  const chatId = getSetting(settings, "bashConfirm.notifications.telegram.chatId", "") ||
                  process.env.TELEGRAM_CHAT_ID ||
                  process.env.PI_TELEGRAM_CHAT_ID;
  const timeoutMs = getSetting(settings, "bashConfirm.notifications.telegram.timeoutMs", 5000);
  const forceIpv4 = getSetting(settings, "bashConfirm.notifications.telegram.forceIpv4", true);

  if (!token || !chatId) return;

  const htmlMessage = buildShownMessage(ctx, command, settings);

  try {
    await telegramCall({
      token,
      method: "sendMessage",
      body: {
        chat_id: chatId,
        text: htmlMessage,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      },
      timeoutMs,
      family: forceIpv4 ? 4 : undefined,
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Notification failed: ${err}`, "warning");
  }
}

async function sendBlockedNotification(
  ctx: ExtensionContext,
  command: string,
  reason: string,
  pi: ExtensionAPI
) {
  const { settings } = loadMergedSettings(ctx.cwd, ctx);
  const notifyEnabled = getSetting(settings, "bashConfirm.notifications.enabled", false);
  if (!notifyEnabled) return;

  const onBlocked = getSetting(settings, "bashConfirm.notifications.onBlocked", false);
  if (!onBlocked) return;

  const telegramEnabled = getSetting(settings, "bashConfirm.notifications.telegram.enabled", false);
  if (!telegramEnabled) return;

  const token = getSetting(settings, "bashConfirm.notifications.telegram.token", "") ||
               process.env.TELEGRAM_BOT_TOKEN ||
               process.env.PI_TELEGRAM_TOKEN;
  const chatId = getSetting(settings, "bashConfirm.notifications.telegram.chatId", "") ||
                  process.env.TELEGRAM_CHAT_ID ||
                  process.env.PI_TELEGRAM_CHAT_ID;
  const timeoutMs = getSetting(settings, "bashConfirm.notifications.telegram.timeoutMs", 5000);
  const forceIpv4 = getSetting(settings, "bashConfirm.notifications.telegram.forceIpv4", true);

  if (!token || !chatId) return;

  const htmlMessage = buildBlockedMessage(ctx, command, reason, settings);

  try {
    await telegramCall({
      token,
      method: "sendMessage",
      body: {
        chat_id: chatId,
        text: htmlMessage,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      },
      timeoutMs,
      family: forceIpv4 ? 4 : undefined,
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Notification failed: ${err}`, "warning");
  }
}

async function sendModifiedNotification(
  ctx: ExtensionContext,
  originalCommand: string,
  modifiedCommand: string,
  pi: ExtensionAPI
) {
  const { settings } = loadMergedSettings(ctx.cwd, ctx);
  const notifyEnabled = getSetting(settings, "bashConfirm.notifications.enabled", false);
  if (!notifyEnabled) return;

  const onModified = getSetting(settings, "bashConfirm.notifications.onModified", false);
  if (!onModified) return;

  const telegramEnabled = getSetting(settings, "bashConfirm.notifications.telegram.enabled", false);
  if (!telegramEnabled) return;

  const token = getSetting(settings, "bashConfirm.notifications.telegram.token", "") ||
               process.env.TELEGRAM_BOT_TOKEN ||
               process.env.PI_TELEGRAM_TOKEN;
  const chatId = getSetting(settings, "bashConfirm.notifications.telegram.chatId", "") ||
                  process.env.TELEGRAM_CHAT_ID ||
                  process.env.PI_TELEGRAM_CHAT_ID;
  const timeoutMs = getSetting(settings, "bashConfirm.notifications.telegram.timeoutMs", 5000);
  const forceIpv4 = getSetting(settings, "bashConfirm.notifications.telegram.forceIpv4", true);

  if (!token || !chatId) return;

  const htmlMessage = buildModifiedMessage(ctx, originalCommand, modifiedCommand, settings);

  try {
    await telegramCall({
      token,
      method: "sendMessage",
      body: {
        chat_id: chatId,
        text: htmlMessage,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      },
      timeoutMs,
      family: forceIpv4 ? 4 : undefined,
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Notification failed: ${err}`, "warning");
  }
}

async function blockAndStop(
  ctx: ExtensionContext,
  command: string,
  reason: string,
  pi: ExtensionAPI
): Promise<{ block: true; reason: string }> {
  await sendBlockedNotification(ctx, command, reason, pi);
  ctx.abort();
  return { block: true, reason };
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (event, ctx) => {
    const pending = pendingGeneralizationRequest;
    if (!pending) return;

    if (pending.cwd !== ctx.cwd) return;

    pendingGeneralizationRequest = undefined;

    const currentWhitelist = loadWhitelist(ctx.cwd);
    const currentFingerprint = buildWhitelistFingerprint(currentWhitelist);
    if (currentFingerprint !== pending.whitelistFingerprint) {
      ctx.ui.notify("Whitelist changed while AI was analyzing; not auto-applying recommendations.", "warning");
      return;
    }

    const assistantText = extractLastAssistantText(event.messages as unknown[]);
    if (!assistantText) {
      ctx.ui.notify("AI generalization response had no text output.", "warning");
      return;
    }

    const parsed = parseAiGeneralizationPlan(assistantText);
    if (!parsed.plan) {
      ctx.ui.notify(`Could not apply AI recommendations: ${parsed.error}`, "warning");
      return;
    }

    if (ctx.hasUI === true) {
      const shouldApply = await ctx.ui.confirm(
        "Apply AI whitelist recommendations?",
        `Add patterns: ${parsed.plan.addPatterns.length}\nRemove exact entries: ${parsed.plan.removeExact.length}`,
      );
      if (shouldApply !== true) {
        ctx.ui.notify("Skipped applying AI recommendations.", "info");
        return;
      }
    }

    const applied = applyAiGeneralizationPlan(ctx.cwd, parsed.plan);
    if (applied.addedPatterns.length === 0 && applied.removedExact.length === 0) {
      ctx.ui.notify("AI recommendations produced no safe whitelist changes.", "warning");
      if (applied.skipped.length > 0) {
        ctx.ui.notify(applied.skipped.slice(0, 3).join(" | "), "info");
      }
      return;
    }

    ctx.ui.notify(
      `Applied AI recommendations: +${applied.addedPatterns.length} pattern(s), -${applied.removedExact.length} exact entry(ies).`,
      "success",
    );

    if (applied.skipped.length > 0) {
      ctx.ui.notify(`Skipped ${applied.skipped.length} recommendation(s).`, "info");
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const { settings } = loadMergedSettings(ctx.cwd, ctx);
    const config = getSetting(settings, "bashConfirm", { enabled: true, safeCommands: [], blockedCommands: [] }) as {
      enabled?: boolean;
      safeCommands?: string[];
      blockedCommands?: string[];
      autoAccept?: {
        enabled?: boolean;
        model?: string;
        timeoutMs?: number;
        strictness?: AutoAcceptStrictness;
        neverAllowPatterns?: string[];
      };
    };

    if (!config.enabled) {
      debugNotify(ctx, settings, "Extension disabled (bashConfirm.enabled = false)");
      return undefined;
    }

    const command = event.input.command as string;

    const parsed = splitCommand(command);
    const trimmedCommand = command.trim();
    const segments = parsed.segments.map(segment => segment.trim()).filter(Boolean);
    const segmentsToCheck = segments.length > 0 ? segments : (trimmedCommand ? [trimmedCommand] : []);

    const whitelist = loadWhitelist(ctx.cwd);
    const exactWhitelistSet = new Set(
      whitelist.entries
        .filter(entry => entry.type === "exact")
        .map(entry => entry.value.trim())
        .filter(Boolean)
    );
    const whitelistPatterns = compileWhitelistPatterns(whitelist.entries);

    const isBlockedSegment = (segment: string): boolean =>
      matchesRegexList(segment, config.blockedCommands);
    const isSafeSegment = (segment: string): boolean =>
      matchesRegexList(segment, config.safeCommands);
    const isExactWhitelistedSegment = (segment: string): boolean => exactWhitelistSet.has(segment);
    const isPatternWhitelistedSegment = (segment: string): boolean =>
      whitelistPatterns.some(pattern => pattern.test(segment));
    const isExactWhitelistedCommand = (fullCommand: string): boolean => exactWhitelistSet.has(fullCommand);
    const isPatternWhitelistedCommand = (fullCommand: string): boolean =>
      whitelistPatterns.some(pattern => pattern.test(fullCommand));

    const blockedSegment = segmentsToCheck.find(segment => isBlockedSegment(segment));
    if (blockedSegment) {
      const reason = `Command segment matches blocked pattern: ${blockedSegment}`;
      debugNotify(ctx, settings, `Blocked: ${reason}`);
      return await blockAndStop(ctx, command, reason, pi);
    }

    if (parsed.requiresConfirmation) {
      debugNotify(ctx, settings, "Parsed command requires confirmation");
    }

    const commandWhitelisted =
      trimmedCommand.length > 0 &&
      (isExactWhitelistedCommand(trimmedCommand) || isPatternWhitelistedCommand(trimmedCommand));

    const allSegmentsAllowed =
      segmentsToCheck.length > 0 &&
      segmentsToCheck.every(segment => {
        if (isExactWhitelistedSegment(segment)) return true;
        if (isPatternWhitelistedSegment(segment)) return true;
        return isSafeSegment(segment);
      });

    if (commandWhitelisted) {
      debugNotify(ctx, settings, "Allowed: full command matched exact/pattern whitelist");
      return undefined; // Allow without confirmation
    }

    const allAllowed = !parsed.requiresConfirmation && allSegmentsAllowed;
    if (allAllowed) {
      debugNotify(ctx, settings, "Allowed: all segments matched exact/pattern whitelist or safeCommands");
      return undefined; // Allow without confirmation
    }

    const autoAcceptNeverAllowPatterns = config.autoAccept?.neverAllowPatterns;
    const matchesNeverAllowPattern =
      matchesRegexList(trimmedCommand, autoAcceptNeverAllowPatterns) ||
      segmentsToCheck.some(segment => matchesRegexList(segment, autoAcceptNeverAllowPatterns));

    if (matchesNeverAllowPattern) {
      debugNotify(ctx, settings, "auto-accept bypassed: command matched autoAccept.neverAllowPatterns");
    }

    const autoAcceptEnabledByConfig = config.autoAccept?.enabled === true;
    const autoAcceptSessionOverride = getAutoAcceptSessionOverride(ctx);
    const autoAcceptEnabled = autoAcceptSessionOverride
      ? autoAcceptSessionOverride === "on"
      : autoAcceptEnabledByConfig;
    const autoAcceptStrictnessByConfig = normalizeAutoAcceptStrictness(config.autoAccept?.strictness);
    const autoAcceptStrictnessSessionOverride = getAutoAcceptStrictnessSessionOverride(ctx);
    const autoAcceptStrictness = autoAcceptStrictnessSessionOverride ?? autoAcceptStrictnessByConfig;

    if (autoAcceptSessionOverride) {
      debugNotify(ctx, settings, `auto-accept session override active: ${autoAcceptSessionOverride}`);
    }
    if (autoAcceptStrictnessSessionOverride) {
      debugNotify(ctx, settings, `auto-accept strictness session override active: ${autoAcceptStrictnessSessionOverride}`);
    }

    if (autoAcceptEnabled && !matchesNeverAllowPattern) {
      const autoAccept = await evaluateAutoAcceptCommand(command, ctx, settings, autoAcceptStrictness);
      if (autoAccept.result) {
        if (autoAccept.result.decision === "allow") {
          debugNotify(
            ctx,
            settings,
            `auto-accept allowed command via ${autoAccept.result.modelRef}: ${autoAccept.result.reason}`,
          );
          ctx.ui.notify(`auto-accept allowed command: ${autoAccept.result.reason}`, "info");
          return undefined;
        }

        debugNotify(
          ctx,
          settings,
          `auto-accept requested manual review via ${autoAccept.result.modelRef}: ${autoAccept.result.reason}`,
        );
      } else if (autoAccept.error) {
        ctx.ui.notify(`auto-accept unavailable: ${autoAccept.error}`, "warning");
      }
    }

    // No UI available - block for safety
    if (!ctx.hasUI) {
      const reason = "Confirmation required (no UI available)";
      debugNotify(ctx, settings, `Blocked: ${reason}`);
      return await blockAndStop(ctx, command, reason, pi);
    }

    // Send notification that dialog is being shown
    debugNotify(ctx, settings, "Showing confirmation dialog");
    await sendShownNotification(ctx, command, pi);

    // Ring terminal bell to draw attention while waiting for user confirmation.
    ringTerminalBell();

    // Show confirmation dialog
    const genericPreview = tokenizeWithExamples(command);

    const result = await ctx.ui.custom((tui, theme, _kb, done) => {
      let selectedIndex = 0;
      const options = [
        { value: "allow", label: "Allow", description: "Execute the command as-is" },
        { value: "always-accept", label: "Always Accept (Exact)", description: "Whitelist this exact command and execute" },
        { value: "always-accept-generic", label: "Always Accept (Generic)", description: "Generate a regex pattern whitelist entry" },
        { value: "edit", label: "Edit", description: "Modify the command before execution" },
        { value: "block", label: "Block", description: "Cancel this command" },
      ];

      function handleInput(data: string) {
        if (data === "\u001B[B" || data === "\u0019") { // Down arrow or Ctrl+N
          selectedIndex = Math.min(selectedIndex + 1, options.length - 1);
          tui.requestRender();
          return;
        }
        if (data === "\u001B[A" || data === "\u0018") { // Up arrow or Ctrl+P
          selectedIndex = Math.max(selectedIndex - 1, 0);
          tui.requestRender();
          return;
        }
        if (/^[1-9]$/.test(data)) {
          const numericIndex = Number(data) - 1;
          if (numericIndex >= 0 && numericIndex < options.length) {
            selectedIndex = numericIndex;
            tui.requestRender();
            done(options[selectedIndex].value);
          }
          return;
        }
        if (data === "\r" || data === "\n") { // Enter
          done(options[selectedIndex].value);
          return;
        }
        if (data === "\u001B") { // Escape
          done("block");
        }
      }

      function render(width: number): string[] {
        const lines: string[] = [];

        // Header
        lines.push(theme.fg("warning", theme.bold("⚠️  Bash Command Confirmation")));

        // Command display (wrapped to full width)
        lines.push("");
        lines.push("Command:");
        const commandWidth = Math.max(10, width - 4);
        const commandLines = wrapTextWithAnsi(command, commandWidth);
        for (const line of commandLines) {
          lines.push(`  ${line}`);
        }
        lines.push("");

        // Working directory
        lines.push(`Working directory: ${ctx.cwd}`);

        // Options
        lines.push("");
        for (let i = 0; i < options.length; i++) {
          const opt = options[i];
          const isSelected = i === selectedIndex;
          const prefix = isSelected ? "> " : "  ";
          const numberedLabel = `${i + 1}. ${opt.label}`;
          const label = isSelected ? theme.fg("accent", numberedLabel) : theme.fg("text", numberedLabel);
          lines.push(`${prefix}${label}`);

          if (opt.description) {
            lines.push(`    ${theme.fg("muted", opt.description)}`);
          }

          if (opt.value === "always-accept-generic") {
            const previewWidth = Math.max(10, width - 8);
            const previewLines = wrapTextWithAnsi(`Pattern: ${genericPreview.pattern}`, previewWidth);
            for (const line of previewLines) {
              lines.push(`    ${theme.fg("dim", line)}`);
            }

            if (genericPreview.examples[1]) {
              const exampleLines = wrapTextWithAnsi(`Example: ${genericPreview.examples[1]}`, previewWidth);
              for (const line of exampleLines) {
                lines.push(`    ${theme.fg("muted", line)}`);
              }
            }
          }
        }

        // Help text
        lines.push("");
        lines.push(theme.fg("dim", "↑↓ navigate • enter select • 1-5 quick pick • esc cancel"));

        return lines;
      }

      return {
        render,
        invalidate: () => {},
        handleInput,
      };
    }, { overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "90%", margin: 1 } });

    // Handle user choice
    switch (result) {
      case "allow":
        debugNotify(ctx, settings, "User allowed command");
        return undefined; // Execute normally
      case "always-accept": {
        debugNotify(ctx, settings, "User allowed and exactly whitelisted command");
        const added = addExactToWhitelist(ctx.cwd, command, "Always accept exact", "user");
        ctx.ui.notify(
          added ? `Added exact whitelist entry: ${command}` : `Exact whitelist entry already exists: ${command}`,
          added ? "success" : "info",
        );
        return undefined; // Execute normally
      }
      case "always-accept-generic": {
        debugNotify(ctx, settings, "User chose generic whitelist pattern");
        const generated = genericPreview;

        ctx.ui.notify(`Generated pattern: ${generated.pattern}`, "info");
        if (generated.examples[1]) {
          ctx.ui.notify(`Example allowed command: ${generated.examples[1]}`, "info");
        }
        for (const warning of generated.warnings) {
          ctx.ui.notify(`Pattern warning: ${warning}`, "warning");
        }

        const editedPattern = await ctx.ui.editor("Edit generic whitelist regex (^...$):", generated.pattern);
        if (!editedPattern) {
          debugNotify(ctx, settings, "User cancelled generic pattern edit");
          return await blockAndStop(ctx, command, "Generic pattern edit cancelled", pi);
        }

        const validation = validateWhitelistPattern(editedPattern);
        if (validation.ok === false) {
          const reason = validation.reason;
          ctx.ui.notify(`Invalid generic pattern: ${reason}`, "warning");
          return await blockAndStop(ctx, command, `Invalid generic pattern: ${reason}`, pi);
        }

        const added = addPatternToWhitelist(ctx.cwd, editedPattern, "Always accept generic", "ai");
        ctx.ui.notify(
          added
            ? `Added generic whitelist pattern: ${editedPattern}`
            : `Generic whitelist pattern already exists: ${editedPattern}`,
          added ? "success" : "info",
        );

        return undefined; // Execute normally
      }
      case "block":
        debugNotify(ctx, settings, "User blocked command");
        return await blockAndStop(ctx, command, "Blocked by user", pi);
      case "edit":
        debugNotify(ctx, settings, "User chose to edit command");
        // Open editor for modification
        const edited = await ctx.ui.editor("Edit command:", command);
        if (!edited) {
          debugNotify(ctx, settings, "User cancelled edit");
          return await blockAndStop(ctx, command, "Edit cancelled", pi);
        }
        await sendModifiedNotification(ctx, command, edited, pi);
        // Update command and allow execution
        event.input.command = edited;
        return undefined;
      default:
        debugNotify(ctx, settings, "No selection - blocking");
        return await blockAndStop(ctx, command, "No selection", pi);
    }
  });

  // Command to manage settings and test notifications
  pi.registerCommand("bash-confirm", {
    description: "Manage bash confirmation settings and test notifications",
    handler: async (args, ctx) => {
      const { settings, globalSettingsPath, projectSettingsPath } = loadMergedSettings(ctx.cwd, ctx);

      const cmd = args.trim();

      if (cmd === "test-notify") {
        await sendBlockedNotification(ctx, "test-command --dry-run", "Test notification from /bash-confirm test-notify", pi);
        ctx.ui.notify("Test notification sent!", "info");
        return;
      }

      if (cmd === "debug") {
        const enabled = getSetting(settings, "bashConfirm.enabled", true);
        const debugEnabled = getSetting(settings, "bashConfirm.debug", false);
        const notifyEnabled = getSetting(settings, "bashConfirm.notifications.enabled", false);
        const onShown = getSetting(settings, "bashConfirm.notifications.onShown", false);
        const onBlocked = getSetting(settings, "bashConfirm.notifications.onBlocked", false);
        const onModified = getSetting(settings, "bashConfirm.notifications.onModified", false);
        const token = getSetting(settings, "bashConfirm.notifications.telegram.token", "");
        const chatId = getSetting(settings, "bashConfirm.notifications.telegram.chatId", "");
        const timeoutMs = getSetting(settings, "bashConfirm.notifications.telegram.timeoutMs", 5000);
        const forceIpv4 = getSetting(settings, "bashConfirm.notifications.telegram.forceIpv4", true);
        const safeCommands = getSetting(settings, "bashConfirm.safeCommands", []) as string[];
        const blockedCommands = getSetting(settings, "bashConfirm.blockedCommands", []) as string[];
        const autoAcceptEnabledByConfig = getSetting(settings, "bashConfirm.autoAccept.enabled", false);
        const autoAcceptModel = getSetting(settings, "bashConfirm.autoAccept.model", "");
        const autoAcceptTimeoutMs = getSetting(settings, "bashConfirm.autoAccept.timeoutMs", 5000);
        const autoAcceptStrictnessByConfig = normalizeAutoAcceptStrictness(getSetting(settings, "bashConfirm.autoAccept.strictness", "strict"));
        const autoAcceptNeverAllowPatterns = getSetting(settings, "bashConfirm.autoAccept.neverAllowPatterns", []) as string[];
        const autoAcceptSessionOverride = getAutoAcceptSessionOverride(ctx);
        const autoAcceptStrictnessSessionOverride = getAutoAcceptStrictnessSessionOverride(ctx);
        const autoAcceptStrictnessEffective = autoAcceptStrictnessSessionOverride ?? autoAcceptStrictnessByConfig;
        const autoAcceptEffective = autoAcceptSessionOverride
          ? autoAcceptSessionOverride === "on"
          : autoAcceptEnabledByConfig;

        ctx.ui.notify(`bash-confirm: enabled=${enabled}, debug=${debugEnabled}`, "info");
        ctx.ui.notify(`notifications: enabled=${notifyEnabled}, onShown=${onShown}, onBlocked=${onBlocked}, onModified=${onModified}`, "info");
        ctx.ui.notify(`telegram: token=${maskToken(token)}, chatId=${chatId || "(missing)"}, timeoutMs=${timeoutMs}, forceIpv4=${forceIpv4}`, "info");
        ctx.ui.notify(`safeCommands: [${safeCommands.join(", ") || "(none)"}]`, "info");
        ctx.ui.notify(`blockedCommands: [${blockedCommands.join(", ") || "(none)"}]`, "info");
        ctx.ui.notify(
          `autoAccept: configEnabled=${autoAcceptEnabledByConfig}, effectiveEnabled=${autoAcceptEffective}, strictness(config=${autoAcceptStrictnessByConfig}, effective=${autoAcceptStrictnessEffective}), model=${autoAcceptModel || "(current model)"}, timeoutMs=${autoAcceptTimeoutMs}`,
          "info",
        );
        ctx.ui.notify(
          `autoAccept.sessionOverride: ${autoAcceptSessionOverride || "(none)"}`,
          "info",
        );
        ctx.ui.notify(
          `autoAccept.strictnessSessionOverride: ${autoAcceptStrictnessSessionOverride || "(none)"}`,
          "info",
        );
        ctx.ui.notify(
          `autoAccept.neverAllowPatterns: [${autoAcceptNeverAllowPatterns.join(", ") || "(none)"}]`,
          "info",
        );
        ctx.ui.notify(`settings: global=${globalSettingsPath}`, "info");
        ctx.ui.notify(`settings: project=${projectSettingsPath}`, "info");

        // Test Telegram connection if configured
        const telegramEnabled = getSetting(settings, "bashConfirm.notifications.telegram.enabled", false);
        if (telegramEnabled && token) {
          try {
            const me = await telegramCall<{ username?: string; id: number }>({
              token,
              method: "getMe",
              body: {},
              timeoutMs: 3000,
              family: forceIpv4 ? 4 : undefined,
            });
            if (me.ok === true) {
              ctx.ui.notify(`Telegram getMe ok: @${me.result.username ?? "(no username)"} (${me.result.id})`, "info");
            } else {
              const description = me.description ?? "Unknown error";
              const code = me.error_code ? ` (code ${me.error_code})` : "";
              ctx.ui.notify(`Telegram getMe failed: ${description}${code}`, "warning");
            }
          } catch (error: unknown) {
            const err = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`Telegram connection failed: ${err}`, "warning");
          }
        }
        return;
      }

      if (cmd === "auto-accept" || cmd.startsWith("auto-accept ")) {
        const autoArgs = cmd.slice("auto-accept".length).trim();
        const autoEnabledByConfig = getSetting(settings, "bashConfirm.autoAccept.enabled", false);
        const autoModel = getSetting(settings, "bashConfirm.autoAccept.model", "");
        const autoTimeoutMs = getSetting(settings, "bashConfirm.autoAccept.timeoutMs", 5000);
        const autoStrictnessByConfig = normalizeAutoAcceptStrictness(getSetting(settings, "bashConfirm.autoAccept.strictness", "strict"));
        const autoNeverAllowPatterns = getSetting(settings, "bashConfirm.autoAccept.neverAllowPatterns", []) as string[];
        const autoSessionOverride = getAutoAcceptSessionOverride(ctx);
        const autoStrictnessSessionOverride = getAutoAcceptStrictnessSessionOverride(ctx);
        const autoEffectiveEnabled = autoSessionOverride ? autoSessionOverride === "on" : autoEnabledByConfig;
        const autoEffectiveStrictness = autoStrictnessSessionOverride ?? autoStrictnessByConfig;

        if (!autoArgs || autoArgs === "status") {
          ctx.ui.notify(`auto-accept config enabled: ${autoEnabledByConfig}`, "info");
          ctx.ui.notify(`auto-accept effective enabled: ${autoEffectiveEnabled}`, "info");
          ctx.ui.notify(`auto-accept session override: ${autoSessionOverride || "(none)"}`, "info");
          ctx.ui.notify(`auto-accept model: ${autoModel || "(current model)"}`, "info");
          ctx.ui.notify(`auto-accept strictness config: ${autoStrictnessByConfig}`, "info");
          ctx.ui.notify(`auto-accept strictness effective: ${autoEffectiveStrictness}`, "info");
          ctx.ui.notify(`auto-accept strictness session override: ${autoStrictnessSessionOverride || "(none)"}`, "info");
          ctx.ui.notify(`auto-accept timeoutMs: ${autoTimeoutMs}`, "info");
          ctx.ui.notify(
            `auto-accept neverAllowPatterns: [${autoNeverAllowPatterns.join(", ") || "(none)"}]`,
            "info",
          );
          return;
        }

        if (autoArgs === "strictness" || autoArgs.startsWith("strictness ")) {
          const strictnessArgs = autoArgs.slice("strictness".length).trim().toLowerCase();

          if (!strictnessArgs || strictnessArgs === "status") {
            const override = getAutoAcceptStrictnessSessionOverride(ctx);
            const effective = override ?? autoStrictnessByConfig;
            ctx.ui.notify(`auto-accept strictness config: ${autoStrictnessByConfig}`, "info");
            ctx.ui.notify(`auto-accept strictness effective: ${effective}`, "info");
            ctx.ui.notify(`auto-accept strictness session override: ${override || "(none)"}`, "info");
            return;
          }

          if (strictnessArgs === "strict" || strictnessArgs === "permissive") {
            setAutoAcceptStrictnessSessionOverride(ctx, strictnessArgs);
            ctx.ui.notify(`Set auto-accept strictness session override: ${strictnessArgs}`, "success");
            return;
          }

          if (strictnessArgs === "clear" || strictnessArgs === "reset" || strictnessArgs === "default") {
            clearAutoAcceptStrictnessSessionOverride(ctx);
            ctx.ui.notify("Cleared auto-accept strictness session override", "success");
            ctx.ui.notify(`auto-accept strictness effective: ${autoStrictnessByConfig}`, "info");
            return;
          }

          ctx.ui.notify("Usage: /bash-confirm auto-accept strictness [status|strict|permissive|clear]", "info");
          return;
        }

        if (autoArgs === "session" || autoArgs.startsWith("session ")) {
          const sessionArgs = autoArgs.slice("session".length).trim().toLowerCase();

          if (!sessionArgs || sessionArgs === "status") {
            const override = getAutoAcceptSessionOverride(ctx);
            const effective = override ? override === "on" : autoEnabledByConfig;
            ctx.ui.notify(`auto-accept session override: ${override || "(none)"}`, "info");
            ctx.ui.notify(`auto-accept effective enabled: ${effective}`, "info");
            return;
          }

          if (sessionArgs === "on") {
            setAutoAcceptSessionOverride(ctx, "on");
            ctx.ui.notify("Set auto-accept session override: on", "success");
            return;
          }

          if (sessionArgs === "off") {
            setAutoAcceptSessionOverride(ctx, "off");
            ctx.ui.notify("Set auto-accept session override: off", "success");
            return;
          }

          if (sessionArgs === "clear" || sessionArgs === "reset" || sessionArgs === "default") {
            clearAutoAcceptSessionOverride(ctx);
            const effective = autoEnabledByConfig;
            ctx.ui.notify("Cleared auto-accept session override", "success");
            ctx.ui.notify(`auto-accept effective enabled: ${effective}`, "info");
            return;
          }

          ctx.ui.notify("Usage: /bash-confirm auto-accept session [status|on|off|clear]", "info");
          return;
        }

        if (autoArgs.startsWith("test ")) {
          const testCommand = autoArgs.slice("test ".length).trim();
          if (!testCommand) {
            ctx.ui.notify("Usage: /bash-confirm auto-accept test <command>", "warning");
            return;
          }

          const evaluated = await evaluateAutoAcceptCommand(testCommand, ctx, settings, autoEffectiveStrictness);
          if (evaluated.result) {
            ctx.ui.notify(
              `auto-accept (${evaluated.result.modelRef}): ${evaluated.result.decision} — ${evaluated.result.reason}`,
              "info",
            );
          } else {
            ctx.ui.notify(`auto-accept test failed: ${evaluated.error}`, "warning");
          }
          return;
        }

        ctx.ui.notify("Usage: /bash-confirm auto-accept [status|strictness [status|strict|permissive|clear]|session [status|on|off|clear]|test <command>]", "info");
        return;
      }

      if (cmd === "suggest-generalize" || cmd === "sg") {
        const whitelist = loadWhitelist(ctx.cwd);
        if (whitelist.entries.length === 0) {
          ctx.ui.notify("Whitelist is empty. Add entries first.", "warning");
          return;
        }

        pendingGeneralizationRequest = {
          cwd: ctx.cwd,
          whitelistFingerprint: buildWhitelistFingerprint(whitelist),
        };

        queueAiGeneralizationReview(pi, ctx, whitelist);
        ctx.ui.notify("Queued AI whitelist generalization review. Recommendations will be applied after confirmation.", "info");
        return;
      }

      // Whitelist commands
      if (cmd === "whitelist" || cmd.startsWith("whitelist ")) {
        const wlInput = cmd.slice("whitelist".length).trim();
        const subcommandRaw = wlInput.split(/\s+/, 1)[0] || "list";
        const subcommand = subcommandRaw.toLowerCase();
        const wlArgs = wlInput.slice(subcommandRaw.length).trim();

        if (subcommand === "list" || subcommand === "ls") {
          const whitelist = loadWhitelist(ctx.cwd);
          ctx.ui.notify(`Whitelist (${whitelist.entries.length} entries):`, "info");
          if (whitelist.entries.length === 0) {
            ctx.ui.notify("  (empty)", "info");
          } else {
            whitelist.entries.forEach((entry, i) => {
              ctx.ui.notify(formatWhitelistEntry(entry, i), "info");
            });
          }
          return;
        }

        if (subcommand === "suggest-generalize" || subcommand === "sg") {
          const whitelist = loadWhitelist(ctx.cwd);
          if (whitelist.entries.length === 0) {
            ctx.ui.notify("Whitelist is empty. Add entries first.", "warning");
            return;
          }

          pendingGeneralizationRequest = {
            cwd: ctx.cwd,
            whitelistFingerprint: buildWhitelistFingerprint(whitelist),
          };

          queueAiGeneralizationReview(pi, ctx, whitelist);
          ctx.ui.notify("Queued AI whitelist generalization review. Recommendations will be applied after confirmation.", "info");
          return;
        }

        if (subcommand === "add" || subcommand === "a" || subcommand === "add-exact") {
          const parsed = parseValueAndNote(wlArgs);
          if (!parsed.value) {
            ctx.ui.notify("Usage: /bash-confirm whitelist add <command> [--note <note>]", "warning");
            return;
          }

          const added = addExactToWhitelist(ctx.cwd, parsed.value, parsed.note, "user");
          ctx.ui.notify(
            added ? `Added exact whitelist entry: ${parsed.value}` : `Exact whitelist entry already exists: ${parsed.value}`,
            added ? "success" : "info",
          );
          return;
        }

        if (subcommand === "add-pattern" || subcommand === "ap") {
          const parsed = parseValueAndNote(wlArgs);
          if (!parsed.value) {
            ctx.ui.notify("Usage: /bash-confirm whitelist add-pattern <regex> [--note <note>]", "warning");
            return;
          }

          const validation = validateWhitelistPattern(parsed.value);
          if (validation.ok === false) {
            ctx.ui.notify(`Invalid pattern: ${validation.reason}`, "warning");
            return;
          }

          const added = addPatternToWhitelist(ctx.cwd, parsed.value, parsed.note, "user");
          ctx.ui.notify(
            added ? `Added pattern whitelist entry: ${parsed.value}` : `Pattern whitelist entry already exists: ${parsed.value}`,
            added ? "success" : "info",
          );
          return;
        }

        if (subcommand === "remove" || subcommand === "rm" || subcommand === "delete" || subcommand === "del") {
          if (!wlArgs) {
            ctx.ui.notify("Usage: /bash-confirm whitelist remove <value>", "warning");
            return;
          }
          const removed = removeFromWhitelist(ctx.cwd, wlArgs);
          if (removed) {
            ctx.ui.notify(`Removed whitelist entry: ${wlArgs}`, "success");
          } else {
            ctx.ui.notify(`Whitelist entry not found: ${wlArgs}`, "warning");
          }
          return;
        }

        if (subcommand === "clear" || subcommand === "delete-all") {
          const whitelist = loadWhitelist(ctx.cwd);
          if (whitelist.entries.length === 0) {
            ctx.ui.notify("Whitelist is already empty", "info");
            return;
          }
          whitelist.entries = [];
          saveWhitelist(ctx.cwd, whitelist);
          ctx.ui.notify("Cleared whitelist", "success");
          return;
        }

        if (subcommand === "path" || subcommand === "where" || subcommand === "file") {
          ctx.ui.notify(`Whitelist file: ${join(ctx.cwd, ".pi", "bash-confirm-whitelist.json")}`, "info");
          return;
        }

        ctx.ui.notify("Usage: /bash-confirm whitelist [list|add|add-pattern|suggest-generalize|remove|clear|path]", "info");
        return;
      }

      ctx.ui.notify("Usage: /bash-confirm [test-notify|debug|auto-accept ...|suggest-generalize|whitelist ...]", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const whitelist = loadWhitelist(ctx.cwd);
    ctx.ui.notify(`Bash confirmation extension loaded (/bash-confirm) - ${whitelist.entries.length} whitelist entr${whitelist.entries.length === 1 ? "y" : "ies"}`, "info");
  });
}
