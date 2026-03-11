module.exports = {
  apps: [
    {
      name: 'botmux',
      script: 'dist/index-daemon.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      error_file: 'data/logs/error.log',
      out_file: 'data/logs/daemon.log',
      merge_logs: true,
    },
  ],
};
