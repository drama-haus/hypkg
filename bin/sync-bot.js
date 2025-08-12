#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

class ForkSyncBot {
  constructor(configPath = 'sync-bot.config.json') {
    this.configPath = configPath;
    this.config = this.loadConfig();
    this.logFile = this.config.logFile || 'sync-bot.log';
  }

  loadConfig() {
    try {
      const configFile = path.resolve(this.configPath);
      if (!fs.existsSync(configFile)) {
        throw new Error(`Config file not found: ${configFile}`);
      }
      return JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (error) {
      console.error('Failed to load config:', error.message);
      process.exit(1);
    }
  }

  log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
    
    try {
      fs.appendFileSync(this.logFile, logMessage + '\n');
    } catch (error) {
      console.error('Failed to write to log file:', error.message);
    }
  }

  execCommand(command, options = {}) {
    try {
      this.log(`Executing: ${command}`);
      const result = execSync(command, { 
        encoding: 'utf8', 
        stdio: options.silent ? 'pipe' : 'inherit',
        ...options 
      });
      return result;
    } catch (error) {
      this.log(`Command failed: ${command}`);
      this.log(`Error: ${error.message}`);
      throw error;
    }
  }

  async sendDiscordNotification(type, title, description, fields = []) {
    if (!this.config.discord?.enabled || !this.config.discord?.webhookUrl) {
      return;
    }

    const color = this.config.discord.colors?.[type] || this.config.discord.colors?.info || 3447003;
    const mentions = this.config.discord.mentions?.[`on${type.charAt(0).toUpperCase() + type.slice(1)}`] || [];
    
    const embed = {
      title,
      description,
      color,
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Hypkg Fork Sync Bot'
      }
    };

    if (fields.length > 0) {
      embed.fields = fields;
    }

    const payload = {
      embeds: [embed]
    };

    if (mentions.length > 0) {
      payload.content = mentions.join(' ');
    }

    try {
      await this.makeDiscordRequest(payload);
      this.log(`Discord notification sent: ${title}`);
    } catch (error) {
      this.log(`Failed to send Discord notification: ${error.message}`);
    }
  }

  makeDiscordRequest(payload) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.config.discord.webhookUrl);
      const data = JSON.stringify(payload);

      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      };

      const req = https.request(options, (res) => {
        let responseData = '';
        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(responseData);
          } else {
            reject(new Error(`Discord webhook failed with status ${res.statusCode}: ${responseData}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.write(data);
      req.end();
    });
  }

  async checkForUpdates() {
    this.log('Checking for updates on canonical dev branch...');
    
    try {
      // Get latest commit from canonical repo
      const latestCommit = this.execCommand(
        `gh api repos/${this.config.canonicalRepo}/commits/dev --jq '.sha'`,
        { silent: true }
      ).trim();

      // Check if we have this commit locally
      try {
        this.execCommand(`git cat-file -e ${latestCommit}`, { silent: true });
        this.log('Already up to date');
        return false;
      } catch {
        this.log(`New commit found: ${latestCommit}`);
        return true;
      }
    } catch (error) {
      this.log(`Failed to check for updates: ${error.message}`);
      return false;
    }
  }

  async syncRepository(targetRepo) {
    this.log(`Syncing repository: ${targetRepo}`);
    
    try {
      // Clone or update local copy
      const repoName = targetRepo.split('/').pop();
      const localPath = path.join(this.config.workDir, repoName);
      
      if (!fs.existsSync(localPath)) {
        this.log(`Cloning ${targetRepo}...`);
        this.execCommand(`git clone https://github.com/${targetRepo}.git ${localPath}`);
      }

      // Navigate to repo directory
      process.chdir(localPath);

      // Get current commit before sync
      let beforeCommit = '';
      try {
        beforeCommit = this.execCommand('git rev-parse HEAD', { silent: true }).trim();
      } catch (error) {
        this.log('Could not get current commit hash');
      }

      // Checkout dev branch and pull
      this.log('Checking out dev branch...');
      this.execCommand('git checkout dev');
      
      this.log('Pulling latest changes...');
      this.execCommand('git pull');

      // Get commit info for notifications
      const canonicalCommit = this.execCommand('git rev-parse HEAD', { silent: true }).trim();
      const canonicalMessage = this.execCommand('git log -1 --pretty=format:"%s" HEAD', { silent: true }).trim();

      // Push to all remotes (except canonical)
      this.log('Pushing to all remotes...');
      const remotes = this.execCommand('git remote', { silent: true }).trim().split('\n').filter(r => r.trim() && r !== 'canonical');
      
      for (const remote of remotes) {
        this.log(`Pushing to remote: ${remote}`);
        this.execCommand(`git push ${remote} dev`);
      }

      // Send success notification
      await this.sendDiscordNotification('success', 
        `✅ Successfully synced ${targetRepo}`,
        `Updated fork with latest changes from \`${this.config.canonicalRepo}\``,
        [
          {
            name: 'Repository',
            value: `[${targetRepo}](https://github.com/${targetRepo})`,
            inline: true
          },
          {
            name: 'Latest Commit',
            value: `\`${canonicalCommit.slice(0, 7)}\` ${canonicalMessage}`,
            inline: false
          }
        ]
      );

      this.log(`Successfully synced ${targetRepo}`);
      return true;
    } catch (error) {
      // Send error notification
      await this.sendDiscordNotification('error',
        `❌ Failed to sync ${targetRepo}`,
        `Sync operation failed with error: \`${error.message}\``,
        [
          {
            name: 'Repository',
            value: `[${targetRepo}](https://github.com/${targetRepo})`,
            inline: true
          },
          {
            name: 'Error Details',
            value: error.message.length > 1000 ? error.message.slice(0, 1000) + '...' : error.message,
            inline: false
          }
        ]
      );

      this.log(`Failed to sync ${targetRepo}: ${error.message}`);
      return false;
    }
  }

  async syncAllRepositories() {
    this.log('Starting sync process for all repositories...');
    const startTime = new Date();
    
    // Send initial notification
    await this.sendDiscordNotification('info',
      '🔄 Starting repository sync',
      `Syncing ${this.config.targetRepositories.length} repositories with \`${this.config.canonicalRepo}\``,
      [
        {
          name: 'Target Repositories',
          value: this.config.targetRepositories.map(repo => `• ${repo}`).join('\n'),
          inline: false
        }
      ]
    );
    
    const results = {
      success: [],
      failed: []
    };

    for (const targetRepo of this.config.targetRepositories) {
      try {
        const success = await this.syncRepository(targetRepo);
        if (success) {
          results.success.push(targetRepo);
        } else {
          results.failed.push(targetRepo);
        }
      } catch (error) {
        this.log(`Unexpected error syncing ${targetRepo}: ${error.message}`);
        results.failed.push(targetRepo);
      }
    }

    const endTime = new Date();
    const duration = Math.round((endTime - startTime) / 1000);

    this.log(`Sync completed. Success: ${results.success.length}, Failed: ${results.failed.length}`);
    
    if (results.failed.length > 0) {
      this.log(`Failed repositories: ${results.failed.join(', ')}`);
    }

    // Send summary notification
    const summaryType = results.failed.length > 0 ? 'error' : 'success';
    const summaryTitle = results.failed.length > 0 
      ? '⚠️ Sync completed with errors'
      : '✅ All repositories synced successfully';
    
    const fields = [
      {
        name: 'Summary',
        value: `✅ Successful: ${results.success.length}\n❌ Failed: ${results.failed.length}\n⏱️ Duration: ${duration}s`,
        inline: true
      }
    ];

    if (results.success.length > 0) {
      fields.push({
        name: 'Successfully Synced',
        value: results.success.map(repo => `• ${repo}`).join('\n'),
        inline: false
      });
    }

    if (results.failed.length > 0) {
      fields.push({
        name: 'Failed to Sync',
        value: results.failed.map(repo => `• ${repo}`).join('\n'),
        inline: false
      });
    }

    await this.sendDiscordNotification(summaryType, summaryTitle, 
      `Sync operation completed in ${duration} seconds`, fields);

    return results;
  }

  async run() {
    this.log('Fork sync bot started');
    
    try {
      // Create work directory if it doesn't exist
      if (!fs.existsSync(this.config.workDir)) {
        fs.mkdirSync(this.config.workDir, { recursive: true });
      }

      if (this.config.mode === 'webhook') {
        this.log('Running in webhook mode - waiting for trigger...');
        // In webhook mode, just run once when triggered
        await this.syncAllRepositories();
      } else {
        // Polling mode
        this.log(`Running in polling mode - checking every ${this.config.pollInterval || 300} seconds`);
        
        const poll = async () => {
          try {
            const hasUpdates = await this.checkForUpdates();
            if (hasUpdates) {
              await this.syncAllRepositories();
            }
          } catch (error) {
            this.log(`Polling error: ${error.message}`);
          }
        };

        // Initial check
        await poll();

        // Set up polling interval
        setInterval(poll, (this.config.pollInterval || 300) * 1000);
      }
    } catch (error) {
      this.log(`Fatal error: ${error.message}`);
      process.exit(1);
    }
  }
}

// Handle process signals
process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Run the bot
if (require.main === module) {
  const configPath = process.argv[2] || 'sync-bot.config.json';
  const bot = new ForkSyncBot(configPath);
  bot.run().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = ForkSyncBot;