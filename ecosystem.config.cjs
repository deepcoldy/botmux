module.exports = {
  apps: [
    {
      name: 'claude-code-robot',
      script: 'dist/index-daemon.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'data/logs/daemon-error.log',
      out_file: 'data/logs/daemon-out.log',
      merge_logs: true,
    },
  ],
};
