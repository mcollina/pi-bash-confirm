# pi-bash-confirm

A [pi](https://github.com/earendil-works/pi) package that adds a confirmation dialog before executing bash commands in the TUI, with Telegram notification support for blocked and modified commands.

## Features

- **Confirmation Dialog**: Interactively approve, edit, always accept (exact/generic), or block bash commands before execution
- **Interactive Settings**: Use `/bash-confirm` to configure confirmation and auto-accept from one compact panel
- **Command Patterns**: Configure safe commands (auto-allow) and blocked commands (auto-block) using regex
- **Per-Project Whitelist**: Commands added as exact or regex-pattern entries won't prompt again in that project
- **Edit Mode**: Modify commands before approval using pi's built-in editor
- **Telegram Notifications**: Get notified when commands are blocked or modified
- **Optional auto-accept Mode**: Let a configurable fast model auto-allow or route to manual review
- **Non-Interactive Safety**: Blocks commands when UI is unavailable unless they match safe patterns (or auto-accept explicitly allows)
- **Easy Configuration**: All settings configurable via `settings.json` or environment variables

## Installation

Requires pi / `@earendil-works/pi-coding-agent` `0.80.x`.

```bash
pi install npm:pi-bash-confirm
```

## Quick Start

After installation, the extension automatically loads and will ask for confirmation before any bash command execution.

### Basic Configuration

Create or edit `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project):

```json
{
  "bashConfirm": {
    "enabled": true,
    "safeCommands": [
      "^ls"
    ],
    "blockedCommands": [
      "rm -rf",
      "sudo .* rm",
      ":>.*",
      "^dd "
    ],
    "autoAccept": {
      "enabled": false,
      "model": "openrouter/google/gemini-2.0-flash-001",
      "timeoutMs": 5000,
      "strictness": "permissive"
    }
  }
}
```

### Telegram Notifications

To enable Telegram notifications for blocked and modified commands:

```json
{
  "bashConfirm": {
    "notifications": {
      "enabled": true,
      "onShown": false,
      "onBlocked": true,
      "onModified": true,
      "onAllowed": false,
      "telegram": {
        "enabled": true,
        "token": "YOUR_BOT_TOKEN",
        "chatId": "YOUR_CHAT_ID",
        "timeoutMs": 5000,
        "forceIpv4": true
      }
    }
  }
}
```

Alternatively, use environment variables:

```bash
export TELEGRAM_BOT_TOKEN="your_bot_token"
export TELEGRAM_CHAT_ID="your_chat_id"
# or
export PI_TELEGRAM_TOKEN="your_bot_token"
export PI_TELEGRAM_CHAT_ID="your_chat_id"
```

### Interactive Settings

Run one command—without arguments or subcommands:

```text
/bash-confirm
```

The panel controls bash confirmation, auto-accept, and auto-accept policy for the current session. Persistent defaults remain in `settings.json`. Disabling bash confirmation also bypasses configured blocked-command checks for that session.

To show debug notifications explaining why commands were allowed or blocked, set `bashConfirm.debug` to `true` in `settings.json`.

## Configuration

### Global Options

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the extension |
| `debug` | boolean | `false` | Show debug notifications explaining why a command was allowed/blocked |
| `safeCommands` | string[] | `[]` | Regex patterns for auto-allowed commands |
| `blockedCommands` | string[] | `[]` | Regex patterns for always-blocked commands |
| `autoAccept.enabled` | boolean | `false` | Enable optional model-based auto-accept decision flow |
| `autoAccept.model` | string | `""` | Model reference (`provider/modelId`) used for auto-accept; falls back to current model when empty |
| `autoAccept.timeoutMs` | number | `5000` | Grace period before showing manual review (clamped to 1000-20000 ms); a late `allow` can dismiss the open dialog |
| `autoAccept.strictness` | string | `"permissive"` | Auto-accept policy mode: `strict` (narrow) or `permissive` (broader local dev writes allowed) |
| `autoAccept.neverAllowPatterns` | string[] | `[]` | Regex patterns that must always require manual confirmation (auto-accept is skipped) |

### Notification Options

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `notifications.enabled` | boolean | `false` | Enable notification system |
| `notifications.onShown` | boolean | `false` | Send notifications when confirmation dialog is displayed |
| `notifications.onBlocked` | boolean | `true` | Send notifications for blocked commands |
| `notifications.onModified` | boolean | `true` | Send notifications for modified commands |
| `notifications.onAllowed` | boolean | `false` | Send notifications for allowed commands |

### Telegram Options

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `notifications.telegram.enabled` | boolean | `false` | Enable Telegram notifications |
| `notifications.telegram.token` | string | - | Telegram bot token (or use env var) |
| `notifications.telegram.chatId` | string | - | Telegram chat ID (or use env var) |
| `notifications.telegram.timeoutMs` | number | `5000` | Request timeout in milliseconds |
| `notifications.telegram.forceIpv4` | boolean | `true` | Force IPv4 for Telegram API |

## Telegram Bot Setup

### 1. Create a Bot

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the bot token (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 2. Get Your Chat ID

**Method 1: Using curl**

```bash
curl https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```

Send a message to your bot first, then run the command. Look for `"chat":{"id":123456789}` in the response.

**Method 2: Direct message**

1. Send `/start` to your bot
2. Use the curl method above to get your chat ID

### 3. Configure

Add to your `settings.json`:

```json
{
  "bashConfirm": {
    "notifications": {
      "enabled": true,
      "telegram": {
        "enabled": true,
        "token": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
        "chatId": "123456789"
      }
    }
  }
}
```

See [docs/telegram-setup.md](docs/telegram-setup.md) for detailed instructions.

## Usage Examples

### Safe Commands

Configure safe commands to bypass confirmation:

```json
{
  "bashConfirm": {
    "enabled": true,
    "debug": false,
    "safeCommands": [
      "^ls",
      "^pwd",
      "^cd",
      "^rg",
      "^grep",
      "^find(?!.*-(exec|ok|delete|execdir))",
      "^cat",
      "^echo",
      "^head",
      "^tail",
      "^wc",
      "^sort",
      "^uniq",
      "^cut",
      "^tr",
      "^awk",
      "^file",
      "^stat",
      "^diff",
      "^cmp",
      "^basename",
      "^dirname",
      "^realpath",
      "^readlink",
      "^which",
      "^whereis",
      "^whatis",
      "^type",
      "^id",
      "^whoami",
      "^who",
      "^uname",
      "^hostname",
      "^date",
      "^cal",
      "^env",
      "^ps",
      "^pgrep",
      "^top",
      "^htop",
      "^df",
      "^du",
      "^free",
      "^uptime",
      "^lscpu",
      "^lsmem",
      "^lsusb",
      "^lspci",
      "^lsblk",
      "^mount$",
      "^ifconfig",
      "^ip addr",
      "^ip link",
      "^ip route",
      "^netstat",
      "^ss",
      "^ping",
      "^curl(?!.*-[Oo])",
      "^git (status|log|diff|show|branch|remote|config|stash list)",
      "^cat .+\\.md$",
      "^gh issue view .*$",
      "^gh pr view .*$",
      "^gh pr diff .*$",
      "^gh run .*$",
      "^gh repo view .*$"
    ]
  }
}
```

### Blocked Commands

Block dangerous patterns:

```json
{
  "bashConfirm": {
    "blockedCommands": [
      "rm -rf /",              # Prevent root deletion
      "rm -rf .*\\.git",       # Protect .git directories
      "sudo .* rm",            # Block sudo + rm
      ":>",                    # Prevent file truncation
      "^dd if=",               # Block dd commands
      "mkfs\\.",               # Block filesystem creation
      "> /dev/sda"             # Block disk writes
    ]
  }
}
```

### Project-Specific Settings

Create `.pi/settings.json` in your project directory:

```json
{
  "bashConfirm": {
    "safeCommands": [
      "^npm (install|test|run)",
      "^node .+\\.js$"
    ],
    "blockedCommands": [
      "rm -rf node_modules"
    ]
  }
}
```

## Confirmation Dialog

When a bash command is intercepted, you'll see:

```
⚠️  Bash Command Confirmation

Command:
  git push origin main

Working directory: /home/user/project

> 1. Allow
    Execute the command as-is
  2. Always Accept (Exact)
    Whitelist this exact command and execute
  3. Always Accept (Generic)
    Generate a regex pattern whitelist entry
  4. Edit
    Modify the command before execution
  5. Block
    Cancel this command

↑↓ navigate • enter select • 1-5 quick pick • esc cancel
```

**Options:**
- **Allow** (1): Execute the command as-is
- **Always Accept (Exact)** (2): Add an exact-match command whitelist entry
- **Always Accept (Generic)** (3): The dialog always shows the generated regex preview; selecting this lets you review/edit and whitelist it
- **Edit** (4): Open an editor to modify the command before approval
- **Block** (5): Cancel the command execution
- **Cancel** (ESC): Dismiss the dialog and cancel the command execution

You can quickly select an option by pressing its number (1-5) on your keyboard, or use arrow keys and Enter.

## Always Accept & Whitelist

The dialog supports two whitelist modes:

- **Always Accept (Exact)**: stores the exact command string
- **Always Accept (Generic)**: generates a regex pattern, lets you edit it, then stores it

### How It Works

- **Entry types**: whitelist entries are either `exact` or `pattern`
- **Per-project storage**: the whitelist is stored in `.pi/bash-confirm-whitelist.json` relative to your project root
- **Match order**: `blockedCommands` → exact whitelist → pattern whitelist → `safeCommands`
- **Survives restarts**: the whitelist persists across pi sessions

### Example Flow

```
1. User runs: git push origin feature/my-branch
2. Confirmation dialog appears
3. User selects: "Always Accept (Generic)" (option 3)
4. Extension proposes a pattern like: ^git\s+push\s+origin\s+[\w./-]+$
5. User confirms/edits the pattern and command executes
6. Future matching push commands execute without prompt
```

### Managing the Whitelist

Add entries directly from the confirmation dialog with **Always Accept (Exact)** or **Always Accept (Generic)**. To inspect, remove, or share entries, edit `.pi/bash-confirm-whitelist.json`.

### Whitelist File Format

```json
{
  "entries": [
    {
      "type": "exact",
      "value": "git push origin main",
      "addedAt": "2026-01-26T16:51:49.123Z",
      "note": "Always accept exact",
      "source": "user"
    },
    {
      "type": "pattern",
      "value": "^git\\s+push\\s+origin\\s+[\\w./-]+$",
      "addedAt": "2026-01-26T16:52:12.000Z",
      "note": "Always accept generic",
      "source": "ai"
    }
  ],
  "version": 2
}
```

The whitelist file can be committed to version control if you want to share whitelisted commands with your team.

## Optional `auto-accept` Mode (Fast Model)

When `bashConfirm.autoAccept.enabled` is `true`, commands that would normally open the confirmation dialog are first reviewed by a fast model.

The model must return one of:
- `allow` → command executes immediately
- `review` → fallback to the normal confirmation dialog (or block in non-interactive mode)

If the model returns `block`, the extension downgrades that to `review` and asks a human.

Example:

```json
{
  "bashConfirm": {
    "autoAccept": {
      "enabled": true,
      "model": "openrouter/google/gemini-2.0-flash-001",
      "timeoutMs": 4000,
      "strictness": "permissive",
      "neverAllowPatterns": [
        "^git\\s+push(?:\\s|$)",
        "^npm\\s+publish(?:\\s|$)"
      ]
    }
  }
}
```

Notes:
- This mode is **optional** and off by default.
- Use `autoAccept.strictness` to tune policy: `strict` favors check-only commands, while `permissive` can allow bounded local dev write workflows (for example `git commit`, `eslint --fix`, or `prettier --write`).
- `cd` is treated as shell-local navigation, not a mutation. For auto-accept policy scope, operations in a command chain are evaluated against the initial working directory; directory changes made by `cd` are ignored.
- The model receives an explicit allowed-directory list containing the initial working directory, the operating system's temp directory, and directories added for the current session with `/bash-confirm-allow-directory` (including their descendants).
- Inline interpreter code such as `python -c '...'` and `node -e '...'` is evaluated from its visible source and libraries rather than rejected for using an interpreter. Strict mode requires clear evidence of local, non-destructive behavior; permissive mode may make an educated evidence-based inference.
- High-risk operations (for example rebase/reset/push, publish/deploy, destructive deletes, privilege escalation) should fall back to manual review.
- Use `autoAccept.neverAllowPatterns` to force manual review for command families you never want auto-approved.
- Use `/bash-confirm` to override auto-accept and strictness for the current session.
- Use a low-latency model to keep shell flow responsive.
- `timeoutMs` limits how long the hook waits before showing manual review; if the model later returns `allow` while the dialog is open, the dialog is dismissed automatically.
- The command text is sent to the configured model for evaluation.

## Notification Examples

### Dialog Shown Notification

```
⏳ Command Confirmation Requested

Session: abc12345
Directory: /home/user/project

Command
ls -la /home/user/project

2026-01-26T16:51:49.123Z
```

### Blocked Command Notification

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

### Modified Command Notification

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

## Command

| Command | Description |
|---------|-------------|
| `/bash-confirm` | Open the interactive session settings panel |
| `/bash-confirm-allow-directory [path]` | Allow an existing directory for auto-accept in the current session; omit `path` to enter it interactively |

## Configuration Priority

Settings are loaded in this order (later overrides earlier):

1. Extension defaults
2. Global settings (`~/.pi/agent/settings.json`)
3. Project settings (`.pi/settings.json`)
4. Environment variables (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`)

## Non-Interactive Mode

When pi is running in non-interactive mode (print, JSON, RPC), the extension will:

- Block all bash commands unless they match a `safeCommands` pattern
- If `auto-accept` is enabled, run model review first (`allow`/`review`)
- Block when manual confirmation is required but no UI is available
- Send blocked command notifications (if configured)

To allow commands in non-interactive mode, add them to `safeCommands` or enable `auto-accept` with a conservative fast model.

## Troubleshooting

### Notifications Not Working

1. Verify bot token and chat ID are correct
2. Make sure notifications are enabled: `bashConfirm.notifications.enabled: true`
3. Set `bashConfirm.debug` to `true` and retry a command
4. Check Telegram bot is running (send it a message)
5. Verify bot token hasn't expired

### All Commands Blocked

If commands are being blocked unexpectedly:

1. Open `/bash-confirm` and check that bash confirmation is enabled
2. Verify commands don't match `blockedCommands` patterns
3. Set `bashConfirm.debug` to `true` for decision notifications
4. Add safe patterns to `safeCommands` if needed

### Invalid Regex Patterns

If a regex pattern is invalid, it will be silently skipped. Test your patterns:

```javascript
new RegExp("your-pattern").test("test-string")
```

## License

MIT

## Contributing

Contributions welcome! Please open an issue or submit a pull request.

## Local Development

For local development and testing, pi does not support installing packages from local directories via `pi install`. Instead, use one of these methods:

### Method 1: Copy Extension File (Recommended)

**Global installation** (applies to all projects):
```bash
cp extensions/bash-confirm.ts ~/.pi/agent/extensions/
```

**Project installation** (applies to current project only):
```bash
mkdir -p .pi/extensions
cp extensions/bash-confirm.ts .pi/extensions/
```

### Method 2: Add to Settings.json

**Global settings** (`~/.pi/agent/settings.json`):
```json
{
  "packages": [
    "/absolute/path/to/pi-permission"
  ]
}
```

**Project settings** (`.pi/settings.json`):
```json
{
  "packages": [
    "./extensions/bash-confirm.ts"
  ]
}
```

### Method 3: Use as Single Extension

You can also load the extension file directly:
```json
{
  "packages": [
    "/absolute/path/to/pi-permission/extensions/bash-confirm.ts"
  ]
}
```

### Testing

After installing locally:
1. Restart pi
2. Run `/bash-confirm` to verify the settings panel opens
3. Try running a bash command to see the confirmation dialog

### Prompt Evaluation

Run `npm run eval -- --dry-run` to validate the historical command dataset, or evaluate a configured model with `npm run eval -- --model <provider/model>`. See [`evals/README.md`](evals/README.md) for dataset provenance, metrics, and all options.

### Development Workflow

1. Make changes to `extensions/bash-confirm.ts`
2. For Method 1: Re-copy the file to the extensions directory
3. For Methods 2 & 3: Restart pi to reload changes
4. Test with `/bash-confirm` and bash commands

## Related

- [pi](https://github.com/earendil-works/pi) - AI coding agent
- [pi packages documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [pi extensions documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
