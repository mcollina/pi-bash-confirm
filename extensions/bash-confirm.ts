import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Box, Container, Text, SelectList, type SelectItem } from "@mariozechner/pi-tui";
import https from "node:https";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

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

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const { settings } = loadMergedSettings(ctx.cwd, ctx);
    const config = getSetting(settings, "bashConfirm", { enabled: true, safeCommands: [], blockedCommands: [] }) as {
      enabled?: boolean;
      safeCommands?: string[];
      blockedCommands?: string[];
    };

    if (!config.enabled) return undefined;

    const command = event.input.command as string;

    // Check blocked commands
    if (config.blockedCommands?.some(pattern => new RegExp(pattern).test(command))) {
      const reason = "Command matches blocked pattern";
      await sendBlockedNotification(ctx, command, reason, pi);
      return { block: true, reason };
    }

    // Check safe commands
    if (config.safeCommands?.some(pattern => new RegExp(pattern).test(command))) {
      return undefined; // Allow without confirmation
    }

    // No UI available - block for safety
    if (!ctx.hasUI) {
      const reason = "Confirmation required (no UI available)";
      await sendBlockedNotification(ctx, command, reason, pi);
      return { block: true, reason };
    }

    // Send notification that dialog is being shown
    await sendShownNotification(ctx, command, pi);

    // Show confirmation dialog
    const items: SelectItem[] = [
      { value: "allow", label: "Allow", description: "Execute the command as-is" },
      { value: "edit", label: "Edit", description: "Modify the command before execution" },
      { value: "block", label: "Block", description: "Cancel this command" },
    ];

    const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const container = new Container();

      // Header
      container.addChild(new Text(
        theme.fg("warning", theme.bold("⚠️  Bash Command Confirmation")),
        1, 1
      ));

      // Command display box
      container.addChild(new Box(1, 1, (s) => theme.bg("toolPendingBg", s)));
      container.addChild(new Text(
        theme.fg("text", `Command: ${command}`),
        0, 0
      ));
      container.addChild(new Text(""));

      // Working directory
      container.addChild(new Text(
        theme.fg("muted", `Working directory: ${ctx.cwd}`),
        1, 0
      ));

      // Selection list
      const selectList = new SelectList(items, 3, {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("dim", t),
      });
      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done("block");
      container.addChild(selectList);

      // Help text
      container.addChild(new Text(
        theme.fg("dim", "↑↓ navigate • enter select • esc cancel"),
        1, 0
      ));

      return {
        render: (w) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data) => { selectList.handleInput(data); tui.requestRender(); },
      };
    }, { overlay: true, overlayOptions: { anchor: "center", width: 60, minHeight: 10 } });

    // Handle user choice
    switch (result) {
      case "allow":
        return undefined; // Execute normally
      case "block":
        const blockReason = "Blocked by user";
        await sendBlockedNotification(ctx, command, blockReason, pi);
        return { block: true, reason: blockReason };
      case "edit":
        // Open editor for modification
        const edited = await ctx.ui.editor("Edit command:", command);
        if (!edited) {
          await sendBlockedNotification(ctx, command, "Edit cancelled", pi);
          return { block: true, reason: "Edit cancelled" };
        }
        await sendModifiedNotification(ctx, command, edited, pi);
        // Update command and allow execution
        event.input.command = edited;
        return undefined;
      default:
        return { block: true, reason: "No selection" };
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

        ctx.ui.notify(`bash-confirm: enabled=${enabled}`, "info");
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

      ctx.ui.notify("Usage: /bash-confirm test-notify | debug", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Bash confirmation extension loaded (/bash-confirm)", "info");
  });
}
