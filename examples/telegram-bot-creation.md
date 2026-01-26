# Quick Start: Creating a Telegram Bot

This guide helps you quickly create a Telegram bot for pi-bash-confirm notifications.

## Step-by-Step

### 1. Create the Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Choose a name: `Pi Confirm Bot`
4. Choose a username: `my_pi_confirm_bot` (must end in `bot`)
5. **Copy the token** provided:
   ```
   1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
   ```

### 2. Get Your Chat ID

1. Start a chat with your new bot
2. Send `/start` to your bot
3. Run this command (replace `YOUR_TOKEN`):

   ```bash
   curl https://api.telegram.org/botYOUR_TOKEN/getUpdates
   ```

4. Find the `"id"` number in the response:
   ```json
   {
     "message": {
       "chat": {
         "id": 987654321  <-- This is your chat ID
       }
     }
   }
   ```
5. **Copy the chat ID** (e.g., `987654321`)

### 3. Configure pi-bash-confirm

Add to `~/.pi/agent/settings.json`:

```json
{
  "bashConfirm": {
    "notifications": {
      "enabled": true,
      "onBlocked": true,
      "onModified": true,
      "telegram": {
        "enabled": true,
        "token": "YOUR_BOT_TOKEN",
        "chatId": "YOUR_CHAT_ID"
      }
    }
  }
}
```

Or use environment variables:

```bash
export PI_TELEGRAM_TOKEN="YOUR_BOT_TOKEN"
export PI_TELEGRAM_CHAT_ID="YOUR_CHAT_ID"
```

### 4. Test

Start pi and run:

```
/bash-confirm test-notify
```

You should receive a test notification in Telegram!

## Quick Test Command

Test your bot is working with a single command:

```bash
# Replace YOUR_TOKEN and YOUR_CHAT_ID
curl -X POST "https://api.telegram.org/botYOUR_TOKEN/sendMessage" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "YOUR_CHAT_ID", "text": "Test from pi-bash-confirm"}'
```

## Troubleshooting

### No notification?

- Make sure you sent `/start` to your bot
- Check the token and chat ID are correct (no extra spaces)
- Run `/bash-confirm debug` in pi to check configuration

### "Unauthorized" error?

- Token is incorrect - double-check you copied the full token
- Revoke and create a new token via BotFather: `/revoke`

### "Chat not found" error?

- Make sure you sent `/start` to your bot first
- Verify you're using your chat ID (from `getUpdates`), not the bot's ID

## Next Steps

- See [telegram-setup.md](telegram-setup.md) for detailed setup
- See [notifications.md](notifications.md) for notification configuration
- Configure safe/blocked command patterns in your `settings.json`

## Bot Management

Use these commands in @BotFather:

| Command | Description |
|---------|-------------|
| `/mybots` | List your bots |
| `/setuserpic` | Set bot profile picture |
| `/setdescription` | Set bot description |
| `/setabouttext` | Set about text |
| `/revoke` | Regenerate bot token |
| `/deletebot` | Delete your bot |

## Security Tips

- **Never** share your bot token publicly
- **Never** commit tokens to git
- Add `settings.json` to `.gitignore` if it contains tokens
- Rotate tokens periodically via `/revoke`
- Use environment variables in production
