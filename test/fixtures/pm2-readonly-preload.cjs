// Only the PM2 protocol is faked: pm2-readonly-client.ts and its stdout pipe
// remain real. PM2 is an optional legacy dependency, absent from clean installs.
const Module = require('node:module');
const originalLoad = Module._load;
const list = Array.from({ length: 6 }, (_, index) => ({
  name: `flush-probe-${index}`,
  pm_id: index,
  pm2_env: { BOTMUX_FLUSH_PROBE: 'x'.repeat(256 * 1024) },
}));
const pm2 = {
  Client: {
    client: { sock: { set() {}, retry: 1 } },
    pingDaemon(callback) { callback(true); },
    launchRPC(callback) { callback(null); },
  },
  list(callback) { callback(null, list); },
  // Disconnect completes immediately, so exiting before the stdout callback
  // would lose the tail of the large write instead of being hidden by RPC delay.
  disconnect(callback) { callback(); },
};
Module._load = function (request, ...args) {
  if (request === 'pm2') return pm2;
  return originalLoad.call(this, request, ...args);
};
