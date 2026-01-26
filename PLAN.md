# Plan: pi-bash-confirm Package

## Overview
Create a pi-package that asks for confirmation before running any bash command in the TUI. This adds a safety layer to prevent accidental or unwanted command execution.

## Goals
1. Intercept all `bash` tool calls from the LLM
2. Display the command in a clear confirmation dialog
3. Allow user to approve, deny, or edit the command
4. Support both interactive and non-interactive modes (graceful fallback)
5. Package as a distributable npm package

## Architecture

### Core Components

#### 1. Extension File: `bash-confirm-extension.ts`
- Main extension entry point
- Subscribes to `tool_call` events
- Intercepts `bash` tool calls
- Shows confirmation UI before allowing execution

#### 2. UI Components

**Confirmation Dialog:**
- Shows the full command being executed
- Options: Allow, Edit, Cancel
- Displays command details (working directory, etc.)
- Uses TUI's `ui.custom()` with overlay mode

**Edit Mode (Optional):**
- Pre-fills editor with the command
- Allows user to modify before approval
- Returns edited command or cancels

#### 3. Configuration (via settings)
Configurable via `settings.json`:
- `bashConfirm.enabled` - Enable/disable confirmation (default: true)
- `bashConfirm.safeCommands` - List of regex patterns for auto-allowed commands
- `bashConfirm.blockedCommands` - List of regex patterns for always-blocked commands

#### 4. Notification System
Send notifications when commands are blocked or modified, similar to `/home/matteo/.pi/agent/extensions/notification.ts`:

**Supported Channels:**
- Telegram Bot API (primary)
- Configurable bell command for local notifications
- Extensible design for future channels (Slack, Discord, email)

**Configuration:**
```json
{
  "bashConfirm": {
    "notifications": {
      "enabled": true,
      "onBlocked": true,
      "onModified": true,
      "onAllowed": false,
      "telegram": {
        "enabled": true,
        "token": "YOUR_BOT_TOKEN",
        "chatId": "YOUR_CHAT_ID",
        "timeoutMs": 5000,
        "forceIpv4": true
      },
      "bellCommand": ""
    }
  }
}
```

**Notification Content:**
- Command that was blocked/modified
- Working directory
- Reason for block/modify
- Session ID for context
- Timestamp

## Implementation Details

### Event Flow

```
LLM calls bash tool
  ↓
tool_call event fires
  ↓
Check if toolName === "bash"
  ↓
Check if command matches "safe" pattern → allow without confirmation
  ↓
Check if command matches "blocked" pattern → block with message + send notification
  ↓
Show confirmation dialog
  ↓
User response:
  - Allow → return undefined (tool executes normally)
  - Block → send notification + return { block: true, reason: "User rejected" }
  - Edit → open editor, get modified command → send notification → re-confirm
```

### File Structure

```
pi-bash-confirm/
├── package.json                 # npm package definition
├── README.md                    # Documentation
├── extensions/
│   └── bash-confirm.ts          # Main extension with notification system
├── docs/
│   ├── example-settings.json    # Example configuration
│   ├── telegram-setup.md        # Guide for setting up Telegram bot
│   └── notifications.md        # Notification system documentation
└── examples/
    ├── test-extension.ts        # Testing/example usage
    └── telegram-bot-creation.md # Quick start for creating Telegram bot
```

### Key APIs Used

From `@mariozechner/pi-coding-agent`:
- `ExtensionAPI` - Main extension interface
- `pi.on("tool_call", handler)` - Intercept tool calls
- `ctx.ui.custom()` - Display confirmation UI
- `ctx.ui.confirm()` - Simple confirm dialogs
- `ctx.ui.editor()` - Edit mode for commands
- `ctx.hasUI` - Check if UI is available

From `@mariozechner/pi-tui`:
- `Box`, `Text`, `Container` - UI components
- `SelectList` - Option selection
- `matchesKey`, `Key` - Keyboard handling

### Non-Interactive Mode Handling

When `ctx.hasUI` is false (print mode, JSON mode, RPC mode):
- Option 1: Block all bash commands with clear error message
- Option 2: Allow commands that match "safe" patterns only
- Option 3: Provide CLI flag `--no-bash-confirm` to bypass

Implementation: Return `{ block: true, reason: "Confirmation required (no UI available)" }` unless in safe list.

### Configuration Examples

**settings.json:**
```json
{
  "bashConfirm": {
    "enabled": true,
    "safeCommands": [
      "^ls",
      "^pwd",
      "^git (status|log|diff)",
      "^cat .+\\.md$"
    ],
    "blockedCommands": [
      "rm -rf",
      "sudo .* rm",
      ":>.*",
      "^dd "
    ],
    "notifications": {
      "enabled": true,
      "onBlocked": true,
      "onModified": true,
      "onAllowed": false,
      "telegram": {
        "enabled": true,
        "token": "YOUR_BOT_TOKEN",
        "chatId": "YOUR_CHAT_ID",
        "timeoutMs": 5000,
        "forceIpv4": true
      },
      "bellCommand": ""
    }
  }
}
```

### Notification System Design

The notification system will be modeled after `/home/matteo/.pi/agent/extensions/notification.ts`:

**Core Functions:**
- `telegramCall()` - Make HTTP requests to Telegram Bot API
- `escapeHtml()` - Escape HTML for Telegram messages
- `truncateText()` - Truncate messages to Telegram's 4096 character limit
- `buildBlockedMessage()` - Build notification for blocked commands
- `buildModifiedMessage()` - Build notification for modified commands

**Notification Types:**
1. **Blocked Command** - Sent when user blocks a command or pattern match blocks it
2. **Modified Command** - Sent when user edits a command via the Edit option
3. **Allowed Command** - Optional notification for allowed commands (disabled by default)

**Message Format:**
```
⚠️ Command Blocked

Command: rm -rf /path/to/directory
Working directory: /home/user/project
Reason: User rejected
Session: abc12345
Timestamp: 2026-01-26T16:51:49Z
```

**Implementation Pattern (from notification.ts):**
```typescript
async function telegramCall<T>(options: {
  token: string;
  method: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  family?: 4 | 6;
}): Promise<TelegramResponse<T>>

function buildBlockedMessage(
  ctx: ExtensionContext,
  command: string,
  reason: string,
  settings: JsonObject
): string { ... }
```

**Environment Variables:**
- `TELEGRAM_BOT_TOKEN` or `PI_TELEGRAM_TOKEN` - Bot token
- `TELEGRAM_CHAT_ID` or `PI_TELEGRAM_CHAT_ID` - Chat ID

Settings values take precedence over environment variables.

## Implementation Steps

### Phase 1: Core Extension
1. Create `bash-confirm.ts` extension
2. Subscribe to `tool_call` event
3. Filter for `bash` tool calls
4. Implement simple confirm dialog (Allow/Block)
5. Test with basic commands

### Phase 2: Enhanced UI
1. Build custom confirmation component with:
   - Full command display
   - Working directory
   - Allow/Block options
2. Add "Edit" option for command modification
3. Use overlay mode for better UX
4. Add keyboard shortcuts (Enter to allow, Escape to cancel, E to edit)

### Phase 3: Configuration System
1. Add support for `safeCommands` patterns
2. Add support for `blockedCommands` patterns
3. Add global enable/disable toggle
4. Document all options in README
5. Add command to modify settings at runtime

### Phase 4: Non-Interactive Mode
1. Implement graceful fallback when `ctx.hasUI` is false
2. Add CLI flag for bypass (`--no-bash-confirm`)
3. Test in print mode, JSON mode, RPC mode

### Phase 4.5: Notification System
1. Extract notification utilities from `notification.ts` reference
2. Implement Telegram Bot API client
3. Create message builders for different notification types:
   - Blocked commands
   - Modified commands
   - (Optional) Allowed commands
4. Add configuration loading for notification settings
5. Integrate notifications into the confirmation flow
6. Add test command (`/bash-confirm test-notify`) to verify setup
7. Test various notification scenarios:
   - Pattern-based blocks
   - User blocks
   - User edits

### Phase 5: Package Structure
1. Create `package.json` with:
   - `name: "pi-bash-confirm"`
   - `keywords: ["pi-package"]`
   - `pi.manifest` pointing to extension
2. Write comprehensive README with:
   - Installation instructions
   - Configuration guide
   - Usage examples
3. Add LICENSE (MIT)
4. Prepare for npm publish

### Phase 6: Testing
1. Test various command types:
   - Simple: `ls -la`
   - Complex: `git commit -m "message"`
   - Dangerous: `rm -rf /`
   - Multi-line commands
2. Test safe/blocked patterns
3. Test edit mode
4. Test non-interactive modes
5. Test with concurrent commands
6. Test notification system:
   - Test Telegram connection with `/bash-confirm test-notify`
   - Verify blocked command notifications
   - Verify modified command notifications
   - Test notification failures (invalid token, no network)
   - Test with long commands (truncation)
   - Test notification rate limiting (if implemented)
   - Verify settings hierarchy (global → project → env vars → defaults)

## Code Sketch

```typescript
// extensions/bash-confirm.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Container, Text, SelectList, type SelectItem } from "@mariozechner/pi-tui";
import https from "node:https";

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

function loadMergedSettings(cwd: string): JsonObject {
  // Merge global and project settings (simplified)
  return {}; // Will implement proper loading
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

async function telegramCall<T>(options: {
  token: string;
  method: string;
  body: Record<string, unknown>;
  timeoutMs: number;
}): Promise<TelegramResponse<T>> {
  const data = JSON.stringify(options.body);
  return new Promise<TelegramResponse<T>>((resolve) => {
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
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
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
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", () => resolve({ ok: false, description: "Network error" }));
    req.write(data);
    req.end();
  });
}

function buildBlockedMessage(
  ctx: any,
  command: string,
  reason: string,
  settings: JsonObject
): string {
  const sessionId = ctx.sessionManager.getSessionId()?.slice(0, 8) || "";
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
  ctx: any,
  originalCommand: string,
  modifiedCommand: string,
  settings: JsonObject
): string {
  const sessionId = ctx.sessionManager.getSessionId()?.slice(0, 8) || "";
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

async function sendBlockedNotification(
  ctx: any,
  command: string,
  reason: string
) {
  const settings = loadMergedSettings(ctx.cwd);
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

  if (!token || !chatId) return;

  const htmlMessage = buildBlockedMessage(ctx, command, reason, settings);
  const plainMessage = htmlMessage.replace(/<[^>]+>/g, "");

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
  });
}

async function sendModifiedNotification(
  ctx: any,
  originalCommand: string,
  modifiedCommand: string
) {
  const settings = loadMergedSettings(ctx.cwd);
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

  if (!token || !chatId) return;

  const htmlMessage = buildModifiedMessage(ctx, originalCommand, modifiedCommand, settings);
  const plainMessage = htmlMessage.replace(/<[^>]+>/g, "");

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
  });
}

export default function (pi: ExtensionAPI) {
  // Load configuration from settings
  const getConfig = () => {
    const settings = pi.getSettings?.() || {};
    return settings.bashConfirm || { enabled: true, safeCommands: [], blockedCommands: [] };
  };

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const config = getConfig();
    if (!config.enabled) return undefined;

    const command = event.input.command as string;

    // Check blocked commands
    if (config.blockedCommands?.some(pattern => new RegExp(pattern).test(command))) {
      const reason = "Command matches blocked pattern";
      await sendBlockedNotification(ctx, command, reason);
      return { block: true, reason };
    }

    // Check safe commands
    if (config.safeCommands?.some(pattern => new RegExp(pattern).test(command))) {
      return undefined; // Allow without confirmation
    }

    // No UI available - block for safety
    if (!ctx.hasUI) {
      const reason = "Confirmation required (no UI available)";
      await sendBlockedNotification(ctx, command, reason);
      return { block: true, reason };
    }

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

      // Command display
      container.addChild(new Box(1, 1, (s) => theme.bg("toolPendingBg", s)));
      container.addChild(new Text(
        theme.fg("text", `Command: ${command}`),
        0, 0
      ));
      container.addChild(new Text("")); // Empty box

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
        await sendBlockedNotification(ctx, command, blockReason);
        return { block: true, reason: blockReason };
      case "edit":
        // Open editor for modification
        const edited = await ctx.ui.editor("Edit command:", command);
        if (!edited) {
          await sendBlockedNotification(ctx, command, "Edit cancelled");
          return { block: true, reason: "Edit cancelled" };
        }
        await sendModifiedNotification(ctx, command, edited);
        // Re-run confirmation with edited command
        event.input.command = edited;
        return undefined;
      default:
        return { block: true, reason: "No selection" };
    }
  });

  // Command to manage settings
  pi.registerCommand("bash-confirm", {
    description: "Manage bash confirmation settings",
    handler: async (args, ctx) => {
      if (args.trim() === "test-notify") {
        // Test notification
        await sendBlockedNotification(ctx, "test-command", "Test notification");
        ctx.ui.notify("Test notification sent!", "info");
        return;
      }
      ctx.ui.notify("Settings management coming soon", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Bash confirmation extension loaded (/bash-confirm)", "info");
  });
}
```

## Publishing

1. Build and test locally
2. Test installation: `pi install .`
3. Publish to npm: `npm publish`
4. Users install: `pi install npm:pi-bash-confirm`

## Dependencies

### Runtime Dependencies
No external npm dependencies required. Extension uses only:
- Node.js built-ins: `https`
- pi SDK packages: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`

### Peer Dependencies
```json
{
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": ">=0.50.0"
  }
}
```

### Dev Dependencies (for testing)
```json
{
  "devDependencies": {
    "@types/node": ">=24.0.0",
    "typescript": ">=5.0.0"
  }
}
```

## package.json Template

```json
{
  "name": "pi-bash-confirm",
  "version": "1.0.0",
  "description": "Pi package for confirming bash commands before execution with Telegram notifications",
  "type": "module",
  "keywords": [
    "pi-package",
    "bash",
    "confirmation",
    "security",
    "telegram",
    "notifications"
  ],
  "main": "./extensions/bash-confirm.ts",
  "pi": {
    "extensions": ["./extensions/bash-confirm.ts"]
  },
  "files": [
    "extensions/",
    "docs/",
    "examples/",
    "README.md",
    "LICENSE"
  ],
  "author": "Your Name",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/yourusername/pi-bash-confirm.git"
  },
  "bugs": {
    "url": "https://github.com/yourusername/pi-bash-confirm/issues"
  },
  "homepage": "https://github.com/yourusername/pi-bash-confirm#readme",
  "engines": {
    "node": ">=20.0.0"
  }
}
```

## Future Enhancements (Optional)
- Command history with approve/deny stats
- Whitelist/blacklist management via commands
- Pattern matching for file paths
- Support for confirming other tools (read, write, edit)
- Audit log of all commands and approvals
- Time-based auto-approval for frequently-run commands
- Integration with plan mode for batch command approval
- Additional notification channels (Slack, Discord, email)
- Notification rate limiting to prevent spam
- Webhook support for custom integrations
- Notification templates and formatting options
- Interactive Telegram buttons for quick approvals/denials

## Notification System Implementation Details

### Borrowed Patterns from `notification.ts`

The notification system will adapt several proven patterns from the existing notification extension:

#### 1. Settings Management
```typescript
// Load and merge global + project settings
function loadMergedSettings(cwd: string): {
  settings: JsonObject;
  globalSettingsPath: string;
  projectSettingsPath: string;
}

// Get nested settings with fallback
function getSetting<T>(settings: JsonObject, path: string, fallback: T): T
```

#### 2. Telegram API Integration
```typescript
// Type-safe Telegram API responses
type TelegramResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error_code?: number; description?: string };

// Generic API call with timeout
async function telegramCall<T>(options: {
  token: string;
  method: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  family?: 4 | 6; // Force IPv4 or IPv6
}): Promise<TelegramResponse<T>>
```

#### 3. Message Formatting
```typescript
// HTML escaping for Telegram messages
function escapeHtml(text: string): string

// Truncate long messages to Telegram's 4096 char limit
function truncateText(text: string, maxLength: number): string

// Markdown to HTML conversion (minimal parser)
function formatToTelegramHtml(markdown: string): string
```

#### 4. Notification Types

**Blocked Command Message:**
```
⛔ Command Blocked

Session: abc12345
Directory: /home/user/project

Command
rm -rf /path/to/directory

Reason
User rejected via confirmation dialog

2026-01-26T16:51:49.123Z
```

**Modified Command Message:**
```
✏️ Command Modified

Session: abc12345
Directory: /home/user/project

Original
rm -rf ./old-dir

Modified
rm -rf ./old-dir-backup

2026-01-26T16:52:10.456Z
```

#### 5. Configuration Hierarchy

Priority order (highest to lowest):
1. Project settings (`.pi/settings.json`)
2. Global settings (`~/.pi/agent/settings.json`)
3. Environment variables (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`)
4. Defaults in extension code

#### 6. Error Handling

```typescript
try {
  await sendBlockedNotification(ctx, command, reason);
} catch (error: unknown) {
  const err = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`Notification failed: ${err}`, "warning");
  // Don't block the main flow on notification failures
}
```

Notifications are fire-and-forget - failures are logged but don't interrupt the confirmation flow.

#### 7. Testing Command

```typescript
pi.registerCommand("bash-confirm", {
  description: "Manage bash confirmation settings",
  handler: async (args, ctx) => {
    if (args.trim() === "test-notify") {
      // Send a test blocked notification
      await sendBlockedNotification(
        ctx,
        "test-command --dry-run",
        "Test notification from /bash-confirm test-notify"
      );
      ctx.ui.notify("Test notification sent!", "info");
      return;
    }

    if (args.trim() === "debug") {
      // Show notification configuration
      const settings = loadMergedSettings(ctx.cwd);
      const enabled = getSetting(settings, "bashConfirm.notifications.enabled", false);
      const token = getSetting(settings, "bashConfirm.notifications.telegram.token", "");
      const chatId = getSetting(settings, "bashConfirm.notifications.telegram.chatId", "");

      ctx.ui.notify(`Notifications: ${enabled ? "enabled" : "disabled"}`, "info");
      ctx.ui.notify(`Telegram token: ${token ? "configured" : "missing"}`, "info");
      ctx.ui.notify(`Telegram chat ID: ${chatId || "missing"}`, "info");
      return;
    }

    ctx.ui.notify("Usage: /bash-confirm test-notify | debug", "info");
  },
});
```

#### 8. Telegram Bot Setup Guide (to be included in docs)

Users need to:
1. Create a bot via @BotFather on Telegram
2. Get the bot token
3. Start a chat with the bot
4. Call `/start` and get the chat ID
5. Configure in settings or environment variables

Quick method to get chat ID:
```
curl https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```

## References
- pi packages docs: `docs/packages.md`
- Extensions docs: `docs/extensions.md`
- TUI components docs: `docs/tui.md`
- Example extensions: `examples/extensions/permission-gate.ts`, `examples/extensions/confirm-destructive.ts`
- Package structure: `examples/extensions/with-deps/`
- Notification reference: `/home/matteo/.pi/agent/extensions/notification.ts`
- Telegram Bot API: https://core.telegram.org/bots/api
