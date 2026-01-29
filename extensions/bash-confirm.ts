import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { wrapTextWithAnsi } from "@mariozechner/pi-tui";
import https from "node:https";
import { splitCommand } from "./command-splitter.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

type WhitelistEntry = {
  command: string;
  addedAt: string;
  note?: string;
};

type WhitelistData = {
  entries: WhitelistEntry[];
  version: number;
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

function loadWhitelist(cwd: string): WhitelistData {
  const whitelistPath = join(cwd, ".pi", "bash-confirm-whitelist.json");

  if (!existsSync(whitelistPath)) {
    return { entries: [], version: 1 };
  }

  try {
    const data = JSON.parse(readFileSync(whitelistPath, "utf-8")) as unknown;
    if (isPlainObject(data)) {
      const obj = data as Record<string, unknown>;
      const entries = Array.isArray(obj.entries) ? (obj.entries as WhitelistEntry[]) : [];
      const version = typeof obj.version === "number" ? obj.version : 1;
      return { entries, version };
    }
  } catch (error: unknown) {
    // Ignore errors and return default
  }

  return { entries: [], version: 1 };
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
      JSON.stringify(whitelist, null, 2),
      "utf-8",
    );
  } catch (error: unknown) {
    // Silent fail - can't write whitelist file
  }
}

function addToWhitelist(cwd: string, command: string, note?: string): void {
  const trimmed = command.trim();
  if (!trimmed) return;
  const whitelist = loadWhitelist(cwd);

  // Check if already whitelisted
  if (whitelist.entries.some(entry => entry.command.trim() === trimmed)) {
    return;
  }

  whitelist.entries.push({
    command: trimmed,
    addedAt: new Date().toISOString(),
    note,
  });

  saveWhitelist(cwd, whitelist);
}

function removeFromWhitelist(cwd: string, command: string): boolean {
  const trimmed = command.trim();
  const whitelist = loadWhitelist(cwd);
  const index = whitelist.entries.findIndex(entry => entry.command.trim() === trimmed);

  if (index === -1) {
    return false;
  }

  whitelist.entries.splice(index, 1);
  saveWhitelist(cwd, whitelist);
  return true;
}

function formatWhitelistEntry(entry: WhitelistEntry, index: number): string {
  const date = new Date(entry.addedAt).toLocaleString();
  const note = entry.note ? ` (${entry.note})` : "";
  return `${index + 1}. ${escapeHtml(entry.command)} ${escapeHtml(note)}\n   Added: ${date}`;
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
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const { settings } = loadMergedSettings(ctx.cwd, ctx);
    const config = getSetting(settings, "bashConfirm", { enabled: true, safeCommands: [], blockedCommands: [] }) as {
      enabled?: boolean;
      safeCommands?: string[];
      blockedCommands?: string[];
    };

    if (!config.enabled) {
      debugNotify(ctx, settings, "Extension disabled (bashConfirm.enabled = false)");
      return undefined;
    }

    const command = event.input.command as string;

    const parsed = splitCommand(command);
    const segments = parsed.segments.map(segment => segment.trim()).filter(Boolean);
    const segmentsToCheck = segments.length > 0 ? segments : (command.trim() ? [command.trim()] : []);

    const whitelist = loadWhitelist(ctx.cwd);
    const whitelistSet = new Set(whitelist.entries.map(entry => entry.command.trim()).filter(Boolean));

    const isBlockedSegment = (segment: string): boolean =>
      config.blockedCommands?.some(pattern => new RegExp(pattern).test(segment)) ?? false;
    const isSafeSegment = (segment: string): boolean =>
      config.safeCommands?.some(pattern => new RegExp(pattern).test(segment)) ?? false;
    const isWhitelistedSegment = (segment: string): boolean => whitelistSet.has(segment);

    const blockedSegment = segmentsToCheck.find(segment => isBlockedSegment(segment));
    if (blockedSegment) {
      const reason = `Command segment matches blocked pattern: ${blockedSegment}`;
      debugNotify(ctx, settings, `Blocked: ${reason}`);
      return await blockAndStop(ctx, command, reason, pi);
    }

    if (parsed.requiresConfirmation) {
      debugNotify(ctx, settings, "Parsed command requires confirmation");
    }

    const allAllowed =
      !parsed.requiresConfirmation &&
      segmentsToCheck.length > 0 &&
      segmentsToCheck.every(segment => isWhitelistedSegment(segment) || isSafeSegment(segment));

    if (allAllowed) {
      debugNotify(ctx, settings, "Allowed: all segments match whitelist/safe patterns");
      return undefined; // Allow without confirmation
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

    // Show confirmation dialog
    const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      let selectedIndex = 0;
      const options = [
        { value: "allow", label: "Allow", description: "Execute the command as-is" },
        { value: "always-accept", label: "Always Accept", description: "Add to whitelist and execute" },
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
        }

        // Help text
        lines.push("");
        lines.push(theme.fg("dim", "↑↓ navigate • enter select • 1-4 quick pick • esc cancel"));

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
      case "always-accept":
        debugNotify(ctx, settings, "User allowed and whitelisted command");
        // Add to whitelist
        addToWhitelist(ctx.cwd, command, "Always accept");
        ctx.ui.notify("Added to whitelist: " + command, "success");
        return undefined; // Execute normally
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

        ctx.ui.notify(`bash-confirm: enabled=${enabled}, debug=${debugEnabled}`, "info");
        ctx.ui.notify(`notifications: enabled=${notifyEnabled}, onShown=${onShown}, onBlocked=${onBlocked}, onModified=${onModified}`, "info");
        ctx.ui.notify(`telegram: token=${maskToken(token)}, chatId=${chatId || "(missing)"}, timeoutMs=${timeoutMs}, forceIpv4=${forceIpv4}`, "info");
        ctx.ui.notify(`safeCommands: [${safeCommands.join(", ") || "(none)"}]`, "info");
        ctx.ui.notify(`blockedCommands: [${blockedCommands.join(", ") || "(none)"}]`, "info");
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
            if (me.ok) {
              ctx.ui.notify(`Telegram getMe ok: @${me.result.username ?? "(no username)"} (${me.result.id})`, "info");
            } else {
              ctx.ui.notify(
                `Telegram getMe failed: ${me.description ?? "Unknown error"}${me.error_code ? ` (code ${me.error_code})` : ""}`,
                "warning",
              );
            }
          } catch (error: unknown) {
            const err = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`Telegram connection failed: ${err}`, "warning");
          }
        }
        return;
      }

      // Whitelist commands
      const wlCmd = cmd.startsWith("whitelist ") ? cmd.slice("whitelist ".length).trim() : cmd;
      if (wlCmd) {
        const wlArgs = cmd.slice("whitelist ".length).trim();

        // List whitelist
        if (wlCmd === "list" || wlCmd === "ls") {
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

        // Add to whitelist
        if (wlCmd === "add" || wlCmd === "a") {
          const spaceIndex = wlArgs.indexOf(" ");
          let command = wlArgs;
          let note: string | undefined;
          if (spaceIndex > 0) {
            command = wlArgs.slice(0, spaceIndex);
            note = wlArgs.slice(spaceIndex + 1).trim() || undefined;
          }
          if (!command) {
            ctx.ui.notify("Usage: /bash-confirm whitelist add <command> [note]", "warning");
            return;
          }
          addToWhitelist(ctx.cwd, command, note);
          ctx.ui.notify(`Added to whitelist: ${command}`, "success");
          return;
        }

        // Remove from whitelist
        if (wlCmd === "remove" || wlCmd === "rm" || wlCmd === "delete" || wlCmd === "del") {
          if (!wlArgs) {
            ctx.ui.notify("Usage: /bash-confirm whitelist remove <command>", "warning");
            return;
          }
          const removed = removeFromWhitelist(ctx.cwd, wlArgs);
          if (removed) {
            ctx.ui.notify(`Removed from whitelist: ${wlArgs}`, "success");
          } else {
            ctx.ui.notify(`Command not in whitelist: ${wlArgs}`, "warning");
          }
          return;
        }

        // Clear whitelist
        if (wlCmd === "clear" || wlCmd === "delete-all") {
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

        // Show whitelist file location
        if (wlCmd === "path" || wlCmd === "where" || wlCmd === "file") {
          ctx.ui.notify(`Whitelist file: ${join(ctx.cwd, ".pi", "bash-confirm-whitelist.json")}`, "info");
          return;
        }

        ctx.ui.notify("Usage: /bash-confirm whitelist [list|add|remove|clear|path]", "info");
        return;
      }

      ctx.ui.notify("Usage: /bash-confirm [test-notify|debug|whitelist ...]", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const whitelist = loadWhitelist(ctx.cwd);
    ctx.ui.notify(`Bash confirmation extension loaded (/bash-confirm) - ${whitelist.entries.length} whitelisted command${whitelist.entries.length !== 1 ? "s" : ""}`, "info");
  });
}
