module.exports = {
  apps: [
    {
      name: 'claude-code-robot',
      script: 'dist/index-daemon.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      error_file: 'data/logs/daemon.log',
      out_file: '/dev/null',
      merge_logs: true,
    },
  ],
};
