# Notification System Documentation

The pi-bash-confirm package includes a comprehensive notification system that can alert you via Telegram when commands are blocked or modified.

## Overview

Notifications are sent for the following events:

- **Dialog Shown** (optional): When the confirmation dialog is displayed (disabled by default to avoid noise)
- **Blocked Commands**: When a command is blocked by pattern matching or user rejection
- **Modified Commands**: When a user edits a command via the Edit option in the confirmation dialog
- **Allowed Commands** (optional): When a command is allowed (disabled by default to avoid noise)

## Configuration

### Enable/Disable Notifications

```json
{
  "bashConfirm": {
    "notifications": {
      "enabled": true
    }
  }
}
```

### Notification Types

Control which events trigger notifications:

```json
{
  "bashConfirm": {
    "notifications": {
      "enabled": true,
      "onShown": false,     // Send notifications when dialog is shown
      "onBlocked": true,    // Send notifications for blocked commands
      "onModified": true,   // Send notifications for modified commands
      "onAllowed": false    // Send notifications for allowed commands (noisy!)
    }
  }
}
```

### Telegram Configuration

```json
{
  "bashConfirm": {
    "notifications": {
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

**Settings:**

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable Telegram notifications |
| `token` | string | - | Telegram bot API token |
| `chatId` | string | - | Telegram chat ID to send messages to |
| `timeoutMs` | number | `5000` | HTTP request timeout in milliseconds |
| `forceIpv4` | boolean | `true` | Force IPv4 for API requests |

### Environment Variables

Telegram settings can also be configured via environment variables:

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` or `PI_TELEGRAM_TOKEN` | Bot token |
| `TELEGRAM_CHAT_ID` or `PI_TELEGRAM_CHAT_ID` | Chat ID |

**Priority:** Settings file values > Environment variables

## Notification Formats

### Dialog Shown

```
⏳ Command Confirmation Requested

Session: abc12345
Directory: /home/user/project

Command
ls -la /home/user/project

2026-01-26T16:51:49.123Z
```

### Blocked Command

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

### Modified Command

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

### Allowed Command (Optional)

```
✅ Command Allowed

Session: abc12345
Directory: /home/user/project

Command
ls -la

2026-01-26T16:53:00.789Z
```

## Message Formatting

### HTML Formatting

Notifications use Telegram's HTML parse mode with the following elements:

- `<b>bold text</b>` - Bold text
- `<i>italic text</i>` - Italic text
- `<code>code</code>` - Monospace/inline code
- `<pre>preformatted</pre>` - Preformatted block

### Character Limits

- Telegram messages limited to **4096 characters**
- Long commands are truncated with `...(truncated)` indicator
- Truncation preserves up to 1000 characters for blocked commands
- Truncation preserves up to 500 characters for each command in modified notifications

### HTML Escaping

All user-provided content is HTML-escaped to prevent formatting issues:

- `&` → `&amp;`
- `<` → `&lt;`
- `>` → `&gt;`
- `"` → `&quot;`
- `'` → `&#39;`

## Error Handling

### Notification Failures

Notification failures are **non-blocking** - they don't interrupt the confirmation flow. Failures are logged but don't affect command execution.

### Common Errors

1. **Invalid Token**: Bot token is incorrect or expired
2. **Chat Not Found**: Chat ID is invalid or bot hasn't been started
3. **Network Error**: Connection issues or Telegram API unreachable
4. **Timeout**: Request exceeded configured timeout

### Error Response Format

```typescript
{
  ok: false,
  error_code?: number,
  description?: string
}
```

## Testing

### Test Notification Command

Send a test notification to verify your setup:

```
/bash-confirm test-notify
```

This sends a blocked command notification for a test command.

### Debug Configuration

View current notification configuration:

```
/bash-confirm debug
```

Output includes:
- Notification enabled status
- Telegram enabled status
- Event type settings (onShown, onBlocked, onModified, onAllowed)
- Token and chat ID status (configured/missing)
- Settings file paths

## Performance Considerations

### Async Sending

Notifications are sent asynchronously using `fire-and-forget` semantics:

- Confirmation flow continues without waiting for notification
- Network delays don't block command execution
- Failed notifications don't prevent commands from running

### Timeouts

- Default timeout: 5000ms (5 seconds)
- Adjust based on network conditions
- Longer timeouts may increase perceived latency

### Rate Limits

Telegram Bot API has rate limits (approx. 30 messages/second):
- High-frequency command blocks may result in some notifications being dropped
- Consider enabling only critical notifications in high-use scenarios

## Security

### Token Storage

**Best practices:**

1. Never commit tokens to version control
2. Add `settings.json` to `.gitignore` if it contains tokens
3. Prefer environment variables in production
4. Use file permissions: `chmod 600 ~/.pi/agent/settings.json`
5. Rotate tokens periodically via BotFather

### Chat ID Privacy

Chat IDs are not secret, but:
- They can reveal your Telegram account
- Consider using a group/channel for team notifications
- Use environment variables to keep them out of config files

### Message Content

Notifications include:
- Command text (may contain sensitive information)
- Working directory path
- Session ID (first 8 characters)
- Timestamp

Be aware of what commands you run if notifications are enabled.

## Advanced Usage

### Conditional Notifications

Use project-specific settings to control notifications per workspace:

`~/.pi/agent/settings.json` (global defaults):
```json
{
  "bashConfirm": {
    "notifications": {
      "enabled": true,
      "onBlocked": true,
      "onModified": false
    }
  }
}
```

`.pi/settings.json` (project override):
```json
{
  "bashConfirm": {
    "notifications": {
      "onModified": true
    }
  }
}
```

### Pattern-Based Notification Control

Use blocked command patterns to control what gets notified:

```json
{
  "bashConfirm": {
    "blockedCommands": [
      "rm -rf",           // Blocks and notifies
      "chmod 777",        // Blocks and notifies
      "docker .* rm"      // Blocks and notifies
    ],
    "safeCommands": [
      "^ls",              // Auto-allows, no notification
      "^cat .+\\.md$"     // Auto-allows, no notification
    ]
  }
}
```

### Multiple Channels

Currently only Telegram is supported, but the architecture supports extension:

```typescript
// Future: Add Slack, Discord, etc.
const channels = [
  { type: "telegram", enabled: true },
  { type: "slack", enabled: false },
  { type: "discord", enabled: false }
];
```

## Troubleshooting

### Notifications Not Arriving

1. Check `/bash-confirm debug` output
2. Verify bot is running (send `/start` to your bot)
3. Test API directly:
   ```bash
   curl https://api.telegram.org/botTOKEN/sendMessage \
     -d "chat_id=CHAT_ID&text=Test"
   ```
4. Check for rate limiting (don't send too many test messages)
5. Verify network connectivity to `api.telegram.org`

### Incorrect Chat ID

Symptoms:
- Bot accepts message but you don't receive it
- API returns "chat not found" error

Solution:
1. Re-run `/getUpdates` after sending a message to your bot
2. Use `result[0].message.chat.id` from the response
3. Ensure you're using the chat ID, not the bot ID

### Invalid Token

Symptoms:
- API returns "Unauthorized" error
- `error_code: 401`

Solution:
1. Verify token format: `NUMBER:STRING`
2. Check for extra spaces or missing characters
3. Revoke and regenerate via BotFather

### Timeout Errors

Symptoms:
- Intermittent notification failures
- API calls take too long

Solution:
1. Increase `timeoutMs` in settings
2. Check network connectivity
3. Try setting `forceIpv4: false` if you have IPv6 issues

## API Reference

### Telegram Bot API Methods Used

- **sendMessage**: Send text messages
- Endpoint: `POST https://api.telegram.org/bot<token>/sendMessage`

### Request Format

```json
{
  "chat_id": "123456789",
  "text": "<b>⛔ Command Blocked</b>\n\n...",
  "parse_mode": "HTML",
  "disable_web_page_preview": true
}
```

### Response Format

**Success:**
```json
{
  "ok": true,
  "result": {
    "message_id": 123,
    "from": { ... },
    "chat": { ... },
    "date": 1737926700,
    "text": "..."
  }
}
```

**Error:**
```json
{
  "ok": false,
  "error_code": 400,
  "description": "Bad Request: chat not found"
}
```

## Future Enhancements

Potential future notification features:

- **Slack integration**: Webhook-based notifications
- **Discord integration**: Bot-based notifications
- **Email notifications**: SMTP-based alerts
- **Interactive buttons**: Approve/deny commands directly from Telegram
- **Notification templates**: Custom message formats
- **Rate limiting**: Built-in throttling to avoid API limits
- **Filtering**: Regex patterns to control which commands are notified
- **Aggregation**: Batch multiple command events into single notifications
- **Rich formatting**: More detailed notification content with code blocks

## Related Documentation

- [Telegram Setup Guide](telegram-setup.md) - Full setup instructions for Telegram
- [Telegram Bot API](https://core.telegram.org/bots/api) - Official API documentation
- [HTML Parsing](https://core.telegram.org/bots/api#html-style) - Telegram HTML formatting
