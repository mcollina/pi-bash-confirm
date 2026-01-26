# pi-bash-confirm

A [pi](https://github.com/mariozechner/pi) package that adds a confirmation dialog before executing bash commands in the TUI, with Telegram notification support for blocked and modified commands.

## Features

- **Confirmation Dialog**: Interactively approve, edit, or block bash commands before execution
- **Command Patterns**: Configure safe commands (auto-allow) and blocked commands (auto-block) using regex
- **Edit Mode**: Modify commands before approval using pi's built-in editor
- **Telegram Notifications**: Get notified when commands are blocked or modified
- **Non-Interactive Safety**: Blocks commands when UI is unavailable unless they match safe patterns
- **Easy Configuration**: All settings configurable via `settings.json` or environment variables

## Installation

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
    ]
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

### Test Notifications

Test your Telegram notification setup:

```
/bash-confirm test-notify
```

### Debug Configuration

View your current configuration:

```
/bash-confirm debug
```

## Configuration

### Global Options

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the extension |
| `safeCommands` | string[] | `[]` | Regex patterns for auto-allowed commands |
| `blockedCommands` | string[] | `[]` | Regex patterns for always-blocked commands |

### Notification Options

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `notifications.enabled` | boolean | `false` | Enable notification system |
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
    "safeCommands": [
      "^ls",                    # Simple ls
      "^ls -",                  # ls with any flags
      "^pwd$",                  # Exact pwd match
      "^git (status|log)",      # git status or git log
      "^cat .+\\.(md|txt|json)$" # cat files with extensions
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
┌────────────────────────────────────────────────────────────────────┐
│ ⚠️  Bash Command Confirmation                                      │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │Command: git push origin main                                    │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ Working directory: /home/user/project                              │
│                                                                     │
│ ● Allow   Execute the command as-is                                 │
│   Edit    Modify the command before execution                       │
│   Block   Cancel this command                                       │
│                                                                     │
│ ↑↓ navigate • enter select • esc cancel                             │
└────────────────────────────────────────────────────────────────────┘
```

**Options:**
- **Allow**: Execute the command as-is
- **Edit**: Open editor to modify the command before approval
- **Block** (or ESC): Cancel the command execution

## Notification Examples

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

## Commands

| Command | Description |
|---------|-------------|
| `/bash-confirm test-notify` | Send a test notification to verify Telegram setup |
| `/bash-confirm debug` | Display current configuration status |

## Configuration Priority

Settings are loaded in this order (later overrides earlier):

1. Extension defaults
2. Global settings (`~/.pi/agent/settings.json`)
3. Project settings (`.pi/settings.json`)
4. Environment variables (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`)

## Non-Interactive Mode

When pi is running in non-interactive mode (print, JSON, RPC), the extension will:

- Block all bash commands unless they match a `safeCommands` pattern
- Send blocked command notifications (if configured)

To allow commands in non-interactive mode, add them to `safeCommands`.

## Troubleshooting

### Notifications Not Working

1. Run `/bash-confirm debug` to check configuration
2. Verify bot token and chat ID are correct
3. Make sure notifications are enabled: `bashConfirm.notifications.enabled: true`
4. Check Telegram bot is running (send it a message)
5. Verify bot token hasn't expired

### All Commands Blocked

If commands are being blocked unexpectedly:

1. Check if `bashConfirm.enabled` is `true`
2. Verify commands don't match `blockedCommands` patterns
3. Run `/bash-confirm debug` to see current configuration
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
2. Run `/bash-confirm debug` to verify the extension loaded
3. Run `/bash-confirm test-notify` to test notifications
4. Try running a bash command to see the confirmation dialog

### Development Workflow

1. Make changes to `extensions/bash-confirm.ts`
2. For Method 1: Re-copy the file to the extensions directory
3. For Methods 2 & 3: Restart pi to reload changes
4. Test with `/bash-confirm debug` and bash commands

## Related

- [pi](https://github.com/mariozechner/pi) - AI coding agent
- [pi packages documentation](https://github.com/mariozechner/pi/blob/main/docs/packages.md)
- [pi extensions documentation](https://github.com/mariozechner/pi/blob/main/docs/extensions.md)
