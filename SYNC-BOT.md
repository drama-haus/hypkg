# Hypkg Fork Sync Bot

A PM2-managed service that automatically keeps your Hyperfy forks in sync with the canonical `hyperfy-xyz/hyperfy` dev branch.

## Features

- **Automatic Sync**: Keeps multiple forks synchronized with the canonical dev branch
- **Two Modes**: Polling mode for regular checks, webhook mode for real-time updates
- **PM2 Integration**: Process management with automatic restarts and logging
- **GitHub CLI Integration**: Uses `gh` commands for reliable GitHub operations
- **Discord Notifications**: Rich embed notifications with sync status updates
- **Comprehensive Logging**: Detailed logs for monitoring and debugging

## Setup

### Prerequisites

- Node.js and npm installed
- GitHub CLI (`gh`) installed and authenticated
- PM2 installed globally (`npm install -g pm2`)
- Write access to the repositories you want to sync
- Discord webhook URL (optional, for notifications)

### Quick Start

1. **Run the setup script:**
   ```bash
   ./setup-sync-bot.sh
   ```

2. **Configure your repositories:**
   Edit `sync-bot.config.json`:
   ```json
   {
     "canonicalRepo": "hyperfy-xyz/hyperfy",
     "targetRepositories": [
       "your-username/hyperfy-fork1",
       "your-username/hyperfy-fork2"
     ],
     "workDir": "./sync-work",
     "mode": "polling",
     "pollInterval": 300,
     "discord": {
       "webhookUrl": "https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN",
       "enabled": true
     }
   }
   ```

3. **Start the service:**
   ```bash
   pm2 start ecosystem.config.js
   ```

## Configuration

### sync-bot.config.json

```json
{
  "canonicalRepo": "hyperfy-xyz/hyperfy",
  "targetRepositories": [
    "your-username/hyperfy-fork1", 
    "your-username/hyperfy-fork2"
  ],
  "workDir": "./sync-work",
  "mode": "polling",
  "pollInterval": 300,
  "logFile": "sync-bot.log",
  "webhook": {
    "port": 3000,
    "secret": "your-webhook-secret"
  },
  "discord": {
    "webhookUrl": "https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN",
    "enabled": true,
    "mentions": {
      "onSuccess": [],
      "onError": ["@here"]
    },
    "colors": {
      "success": 5763719,
      "error": 15548997,
      "info": 3447003
    }
  }
}
```

#### Configuration Options

- **canonicalRepo**: The source repository to sync from (usually `hyperfy-xyz/hyperfy`)
- **targetRepositories**: Array of fork repositories to sync to
- **workDir**: Directory where repositories are cloned for syncing
- **mode**: Either `"polling"` or `"webhook"`
- **pollInterval**: Seconds between checks in polling mode (default: 300)
- **logFile**: Path to the log file
- **webhook.port**: Port for webhook server (default: 3000)
- **webhook.secret**: Secret for webhook signature verification
- **discord.webhookUrl**: Discord webhook URL for notifications
- **discord.enabled**: Enable/disable Discord notifications
- **discord.mentions.onSuccess**: Array of mentions for successful syncs
- **discord.mentions.onError**: Array of mentions for failed syncs (e.g., ["@here", "@role"])
- **discord.colors**: Hex color codes for different notification types

## Usage

### Polling Mode (Default)

The bot checks for updates every 5 minutes (configurable) and syncs when changes are detected.

```bash
# Start in polling mode
pm2 start ecosystem.config.js --only hypkg-sync-bot
```

### Webhook Mode

Real-time syncing triggered by GitHub webhooks. Set up a webhook in the canonical repository:

1. Go to `https://github.com/hyperfy-xyz/hyperfy/settings/hooks`
2. Add webhook with:
   - **Payload URL**: `http://your-server:3000/webhook`
   - **Content type**: `application/json`
   - **Secret**: Your webhook secret from config
   - **Events**: Just push events
   - **Active**: ✅

```bash
# Start webhook server
pm2 start ecosystem.config.js --only hypkg-sync-webhook
```

## Discord Integration

### Setting up Discord Webhooks

1. **Create a Discord Webhook:**
   - Go to your Discord server settings
   - Navigate to "Integrations" → "Webhooks"
   - Click "New Webhook"
   - Choose the channel for notifications
   - Copy the webhook URL

2. **Configure the bot:**
   ```json
   {
     "discord": {
       "webhookUrl": "https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN",
       "enabled": true,
       "mentions": {
         "onSuccess": [],
         "onError": ["@here"]
       },
       "colors": {
         "success": 5763719,
         "error": 15548997, 
         "info": 3447003
       }
     }
   }
   ```

### Notification Types

The bot sends different types of Discord notifications:

- **🔄 Sync Start**: When a sync operation begins (polling mode)
- **🔔 Push Detected**: When a webhook receives a push event
- **✅ Repository Synced**: When individual repositories are successfully synced
- **❌ Sync Failed**: When repository sync fails
- **📊 Sync Summary**: Final summary with success/failure counts

### Customizing Notifications

- **Colors**: Use decimal color codes (convert hex to decimal)
- **Mentions**: Add role mentions like `@role-name` or `@here`/`@everyone`
- **Disable**: Set `enabled: false` to disable Discord notifications

## PM2 Commands

```bash
# Start all services
pm2 start ecosystem.config.js

# Start specific service
pm2 start ecosystem.config.js --only hypkg-sync-bot

# View logs
pm2 logs hypkg-sync-bot
pm2 logs hypkg-sync-webhook

# Monitor processes
pm2 monit

# Restart services
pm2 restart hypkg-sync-bot
pm2 restart hypkg-sync-webhook

# Stop services
pm2 stop hypkg-sync-bot
pm2 delete hypkg-sync-bot

# Save current processes (for auto-restart on reboot)
pm2 save
pm2 startup
```

## How It Works

1. **Detection**: The bot detects new commits on the canonical dev branch
2. **Clone/Update**: Clones or updates local copies of target repositories
3. **Merge**: Fetches canonical changes and merges them into the dev branch
4. **Push**: Pushes the updated dev branch to the fork

## Error Handling

- Failed syncs are logged but don't stop the process
- Individual repository failures don't affect other repositories
- PM2 automatically restarts the process if it crashes
- State restoration ensures repositories aren't left in inconsistent states

## Logs

Logs are written to:
- `./logs/sync-bot.log` - Main bot output
- `./logs/sync-bot-error.log` - Error logs
- `./logs/sync-webhook.log` - Webhook server logs
- `sync-bot.log` - Combined application logs

## Security

- Webhook signatures are verified using HMAC-SHA256
- GitHub CLI handles authentication securely
- No credentials are stored in configuration files
- Process isolation through PM2

## Troubleshooting

### Common Issues

1. **Authentication Failed**
   ```bash
   gh auth login
   gh auth refresh
   ```

2. **Permission Denied**
   - Ensure you have write access to target repositories
   - Check that SSH keys are properly configured

3. **Merge Conflicts**
   - Manual intervention may be required
   - Check logs for specific conflict details

4. **Process Not Starting**
   ```bash
   pm2 logs hypkg-sync-bot
   pm2 describe hypkg-sync-bot
   ```

### Debug Mode

Enable verbose logging by modifying the ecosystem config:
```javascript
env: {
  NODE_ENV: 'development',
  DEBUG: 'true'
}
```

## License

Same as the main hypkg project (GPL-3.0-only).