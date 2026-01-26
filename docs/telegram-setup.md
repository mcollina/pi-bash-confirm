# Telegram Bot Setup Guide

This guide walks you through setting up a Telegram bot for receiving notifications from pi-bash-confirm.

## Overview

pi-bash-confirm can send notifications to Telegram when:
- A command is blocked (by pattern or by user)
- A command is modified by the user

## Step 1: Create a Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Start a chat with BotFather
3. Send `/newbot` command
4. Follow the prompts:
   - Choose a name for your bot (e.g., "Pi Confirm Bot")
   - Choose a username (must end in `bot`, e.g., `my_pi_confirm_bot`)
5. BotFather will respond with a message like this:

   ```
   Done! Congratulations on your new bot. You will find it at t.me/my_pi_confirm_bot. You can now add a description, about section and profile picture for it, see /help for a list of commands.

   Use this token to access the HTTP API:
   1234567890:ABCdefGHIjklMNOpqrsTUVwxyz

   Keep your token secure and store it safely, it can be used by anyone to control your bot.
   ```

6. **Copy the token** - you'll need it for configuration

## Step 2: Get Your Chat ID

You need your personal Telegram chat ID to send messages to yourself.

### Method 1: Using curl (Recommended)

1. Start a chat with your new bot
2. Send `/start` to your bot
3. Run the following command (replace `YOUR_BOT_TOKEN`):

   ```bash
   curl https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates
   ```

4. Look for the `chat` section in the response:

   ```json
   {
     "ok": true,
     "result": [
       {
         "update_id": 123456789,
         "message": {
           "message_id": 1,
           "from": {
             "id": 987654321,
             "is_bot": false,
             "first_name": "Your Name",
             "language_code": "en"
           },
           "chat": {
             "id": 987654321,
             "first_name": "Your Name",
             "type": "private"
           },
           "date": 1737926700,
           "text": "/start"
         }
       }
     ]
   }
   ```

5. **Copy the `id` number** from `message.chat.id` (e.g., `987654321`)

### Method 2: Using a Python Script

Create a script `get_chat_id.py`:

```python
import requests

token = "YOUR_BOT_TOKEN"
response = requests.get(f"https://api.telegram.org/bot{token}/getUpdates")
print(response.json())
```

Run it and find your chat ID in the output.

## Step 3: Configure pi-bash-confirm

### Option A: Using Settings File

Edit your `settings.json` file (global: `~/.pi/agent/settings.json`, or project: `.pi/settings.json`):

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
        "token": "1234567890:ABCdefGHIjklMNOpqrsTUVwxyz",
        "chatId": "987654321",
        "timeoutMs": 5000,
        "forceIpv4": true
      }
    }
  }
}
```

### Option B: Using Environment Variables

Set environment variables before running pi:

```bash
export TELEGRAM_BOT_TOKEN="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"
export TELEGRAM_CHAT_ID="987654321"

# Or use PI_ prefix
export PI_TELEGRAM_TOKEN="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"
export PI_TELEGRAM_CHAT_ID="987654321"

pi
```

For permanent configuration, add to your shell profile (e.g., `~/.bashrc`, `~/.zshrc`):

```bash
export PI_TELEGRAM_TOKEN="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"
export PI_TELEGRAM_CHAT_ID="987654321"
```

## Step 4: Test the Setup

Start pi and run the test command:

```
/bash-confirm test-notify
```

If successful, you should receive a notification in Telegram:

```
⛔ Command Blocked

Session: abc12345
Directory: /home/user/project

Command
test-command --dry-run

Reason
Test notification from /bash-confirm test-notify

2026-01-26T17:00:00.000Z
```

## Troubleshooting

### No Notification Received

1. **Check configuration**: Run `/bash-confirm debug` to verify settings
2. **Verify bot token**: Make sure you copied the full token correctly
3. **Check chat ID**: Ensure the chat ID is correct (no extra spaces)
4. **Start the bot**: Make sure you've sent `/start` to your bot
5. **Test manually**:

   ```bash
   curl -X POST \
     https://api.telegram.org/botYOUR_TOKEN/sendMessage \
     -H "Content-Type: application/json" \
     -d '{"chat_id": "YOUR_CHAT_ID", "text": "Test message"}'
   ```

### Bot Token Invalid

If you see an error about invalid token:

- Make sure you didn't include `bot` prefix (the API adds it automatically)
- Check for extra spaces or characters
- Re-generate the token using BotFather (`/revoke` command in BotFather)

### Chat ID Not Found

If the API returns "chat not found":

- Make sure you've started a conversation with your bot (send `/start`)
- Check that you're using your personal chat ID, not the bot's ID
- Verify you're using the correct chat ID from `getUpdates`

### Network Issues

If notifications fail with network errors:

- Check your internet connection
- Try setting `"forceIpv4": false` in settings
- Increase `"timeoutMs"` if you have a slow connection
- Check if Telegram API is blocked in your region

### Configuration Not Applied

1. Verify settings file path is correct
2. Check JSON syntax (use a JSON validator)
3. Restart pi after changing settings
4. Use `/bash-confirm debug` to see loaded configuration

## Advanced Configuration

### Multiple Chat IDs

To send notifications to multiple recipients, create a group or channel:

1. Create a Telegram group/channel
2. Add your bot as an administrator
3. Get the group/channel ID (negative numbers start with `-100`)
4. Use that ID in `chatId`:

   ```json
   {
     "bashConfirm": {
       "notifications": {
         "telegram": {
           "chatId": "-1001234567890"
         }
       }
     }
   }
   ```

### Proxy Configuration

If you need a proxy to access Telegram, you can set environment variables:

```bash
export HTTPS_PROXY="http://proxy.example.com:8080"
export HTTP_PROXY="http://proxy.example.com:8080"
```

### Custom Timeout

Adjust timeout based on your network conditions:

```json
{
  "bashConfirm": {
    "notifications": {
      "telegram": {
        "timeoutMs": 10000
      }
    }
  }
}
```

## Security Best Practices

1. **Never commit tokens to git**: Add `settings.json` to `.gitignore` if it contains tokens
2. **Use environment variables**: For production, prefer environment variables over settings files
3. **Restrict bot permissions**: Only give your bot the minimum permissions needed
4. **Monitor bot usage**: Regularly check your bot's activity via BotFather (`/mybots`)
5. **Revoke compromised tokens**: Use `/revoke` in BotFather if a token is leaked

## Managing Your Bot

### Bot Commands (via BotFather)

- `/setuserpic` - Set bot profile picture
- `/setdescription` - Set bot description
- `/setabouttext` - Set about text
- `/setcommands` - Set bot commands
- `/deletebot` - Delete your bot
- `/revoke` - Revoke and regenerate bot token

### Disabling Notifications

To temporarily disable notifications without changing settings:

```json
{
  "bashConfirm": {
    "notifications": {
      "enabled": false
    }
  }
}
```

Or set environment variable:

```bash
export PI_TELEGRAM_BOT_TOKEN=""
```

## Additional Resources

- [Telegram Bot API Documentation](https://core.telegram.org/bots/api)
- [BotFather](https://t.me/BotFather)
- [Telegram API: Getting Updates](https://core.telegram.org/bots/api#getupdates)
- [Telegram API: sendMessage](https://core.telegram.org/bots/api#sendmessage)
