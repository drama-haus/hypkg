#!/usr/bin/env node

const http = require('http');
const crypto = require('crypto');
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class SyncWebhook {
  constructor(configPath = 'sync-bot.config.json') {
    this.configPath = configPath;
    this.config = this.loadConfig();
    this.port = process.env.PORT || this.config.webhook?.port || 3000;
    this.secret = this.config.webhook?.secret;
    this.logFile = this.config.logFile || 'sync-webhook.log';
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
    const logMessage = `[${timestamp}] [WEBHOOK] ${message}`;
    console.log(logMessage);
    
    try {
      fs.appendFileSync(this.logFile, logMessage + '\n');
    } catch (error) {
      console.error('Failed to write to log file:', error.message);
    }
  }

  verifySignature(payload, signature) {
    if (!this.secret) {
      this.log('Warning: No webhook secret configured');
      return true;
    }

    const expectedSignature = crypto
      .createHmac('sha256', this.secret)
      .update(payload)
      .digest('hex');

    const providedSignature = signature.replace('sha256=', '');
    
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(providedSignature, 'hex')
    );
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
        text: 'Hypkg Fork Sync Bot - Webhook'
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

  async handleWebhook(payload) {
    try {
      const data = JSON.parse(payload);
      
      // Check if this is a push to the dev branch of the canonical repo
      if (data.ref === 'refs/heads/dev' && 
          data.repository?.full_name === this.config.canonicalRepo) {
        
        this.log(`Push detected to ${this.config.canonicalRepo}/dev`);
        this.log(`Commit: ${data.head_commit?.id} - ${data.head_commit?.message}`);
        
        // Send webhook trigger notification
        await this.sendDiscordNotification('info',
          '🔔 Push detected - triggering sync',
          `New commit pushed to \`${this.config.canonicalRepo}/dev\``,
          [
            {
              name: 'Commit',
              value: `[\`${data.head_commit?.id?.slice(0, 7)}\`](${data.head_commit?.url}) ${data.head_commit?.message}`,
              inline: false
            },
            {
              name: 'Author',
              value: data.head_commit?.author?.name || 'Unknown',
              inline: true
            },
            {
              name: 'Target Repositories',
              value: this.config.targetRepositories.map(repo => `• ${repo}`).join('\n'),
              inline: false
            }
          ]
        );
        
        // Trigger sync
        this.triggerSync(data);
        return { success: true, message: 'Sync triggered' };
      } else {
        this.log(`Ignoring webhook - not a dev branch push to canonical repo`);
        return { success: false, message: 'Not a relevant push event' };
      }
    } catch (error) {
      this.log(`Error parsing webhook payload: ${error.message}`);
      return { success: false, message: 'Invalid payload' };
    }
  }

  triggerSync() {
    this.log('Triggering sync process...');
    
    // Create a modified config for webhook mode
    const webhookConfig = {
      ...this.config,
      mode: 'webhook'
    };
    
    const configPath = path.join(process.cwd(), 'sync-bot-webhook.config.json');
    fs.writeFileSync(configPath, JSON.stringify(webhookConfig, null, 2));
    
    // Spawn the sync bot process
    const syncProcess = spawn('node', ['./bin/sync-bot.js', configPath], {
      detached: true,
      stdio: 'pipe'
    });

    syncProcess.stdout.on('data', (data) => {
      this.log(`SYNC: ${data.toString().trim()}`);
    });

    syncProcess.stderr.on('data', (data) => {
      this.log(`SYNC ERROR: ${data.toString().trim()}`);
    });

    syncProcess.on('close', (code) => {
      this.log(`Sync process completed with code ${code}`);
      // Clean up temp config
      try {
        fs.unlinkSync(configPath);
      } catch (error) {
        this.log(`Failed to clean up temp config: ${error.message}`);
      }
    });

    syncProcess.unref();
  }

  createServer() {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }

      if (req.url !== '/webhook') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });

      req.on('end', async () => {
        const signature = req.headers['x-hub-signature-256'];
        
        if (!this.verifySignature(body, signature)) {
          this.log('Invalid signature in webhook request');
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid signature' }));
          return;
        }

        const result = await this.handleWebhook(body);
        
        res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      });
    });

    return server;
  }

  start() {
    const server = this.createServer();
    
    server.listen(this.port, () => {
      this.log(`Sync webhook server listening on port ${this.port}`);
      this.log(`Webhook URL: http://localhost:${this.port}/webhook`);
      this.log(`Monitoring ${this.config.canonicalRepo} for dev branch pushes`);
    });

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      this.log('Received SIGINT, shutting down webhook server...');
      server.close(() => {
        this.log('Webhook server closed');
        process.exit(0);
      });
    });

    process.on('SIGTERM', () => {
      this.log('Received SIGTERM, shutting down webhook server...');
      server.close(() => {
        this.log('Webhook server closed');
        process.exit(0);
      });
    });

    return server;
  }
}

// Run the webhook server
if (require.main === module) {
  const configPath = process.argv[2] || 'sync-bot.config.json';
  const webhook = new SyncWebhook(configPath);
  webhook.start();
}

module.exports = SyncWebhook;