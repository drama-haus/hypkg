#!/bin/bash

# Hypkg Fork Sync Bot Setup Script

set -e

echo "🚀 Setting up Hypkg Fork Sync Bot..."

# Create logs directory
echo "📁 Creating logs directory..."
mkdir -p logs

# Make scripts executable
echo "🔧 Making scripts executable..."
chmod +x bin/sync-bot.js
chmod +x bin/sync-webhook.js

# Check if pm2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "❌ PM2 not found. Installing PM2 globally..."
    npm install -g pm2
else
    echo "✅ PM2 is already installed"
fi

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    echo "❌ GitHub CLI (gh) not found. Please install it first:"
    echo "   - Visit: https://cli.github.com/"
    echo "   - Or use: brew install gh (macOS) / apt install gh (Ubuntu)"
    exit 1
else
    echo "✅ GitHub CLI is installed"
fi

# Check gh authentication
if ! gh auth status &> /dev/null; then
    echo "⚠️  GitHub CLI not authenticated. Please run: gh auth login"
    exit 1
else
    echo "✅ GitHub CLI is authenticated"
fi

echo ""
echo "🎉 Setup complete!"
echo ""
echo "📝 Next steps:"
echo "1. Edit sync-bot.config.json with your repository details"
echo "2. Start the sync bot: pm2 start ecosystem.config.js"
echo "3. Monitor logs: pm2 logs hypkg-sync-bot"
echo ""
echo "🔧 Configuration:"
echo "- Edit sync-bot.config.json to set your target repositories"
echo "- For webhook mode, set up GitHub webhooks pointing to your server"
echo "- For polling mode, the bot will check for updates every 5 minutes by default"
echo ""
echo "📊 Useful PM2 commands:"
echo "- pm2 start ecosystem.config.js    # Start all services"
echo "- pm2 stop hypkg-sync-bot          # Stop sync bot"
echo "- pm2 restart hypkg-sync-bot       # Restart sync bot"
echo "- pm2 logs hypkg-sync-bot          # View logs"
echo "- pm2 monit                        # Monitor dashboard"
echo "- pm2 save                         # Save current process list"
echo "- pm2 startup                      # Generate startup script"