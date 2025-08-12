module.exports = {
  apps: [
    {
      name: 'hypkg-sync-bot',
      script: './bin/sync-bot.js',
      args: './sync-bot.config.json',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production'
      },
      log_file: './logs/sync-bot.log',
      out_file: './logs/sync-bot-out.log',
      error_file: './logs/sync-bot-error.log',
      time: true,
      merge_logs: true,
      kill_timeout: 5000,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s'
    },
  ]
};
