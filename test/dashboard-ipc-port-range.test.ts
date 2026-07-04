import { describe, it, expect } from 'vitest';
import { config } from '../src/config.js';
import { DEFAULT_PROBE_SPAN } from '../src/utils/listen-with-probe.js';

// Regression guard for the "dashboard 一直报错" bug.
//
// The dashboard binds wildcard (0.0.0.0) and, on EADDRINUSE, probes upward up to
// listenWithProbe's default maxProbe ports. The daemon IPC servers bind
// 127.0.0.1 at ipcBasePort + botIndex. When the IPC base port sits INSIDE the
// dashboard's probe-fallback range, a restart race lets the dashboard bind
// 0.0.0.0:P while an IPC server already (or concurrently) holds 127.0.0.1:P — on
// macOS both coexist, loopback connections route to the more-specific 127.0.0.1
// socket (the IPC server), and the dashboard becomes unreachable on the very port
// it advertised in ~/.botmux/.dashboard-port (browser/CLI get the IPC server's
// 404 {"error":"not_found"}). Keep the two ranges disjoint so the collision is
// structurally impossible, not merely race-dependent.

describe('dashboard vs daemon IPC port ranges', () => {
  it('keeps the IPC base port outside the dashboard probe-fallback range', () => {
    const gap = config.dashboard.ipcBasePort - config.dashboard.port;
    // Dashboard can occupy [port, port + DEFAULT_PROBE_SPAN]; the lowest IPC
    // port (ipcBasePort) must be strictly above that ceiling.
    expect(gap).toBeGreaterThan(DEFAULT_PROBE_SPAN);
  });
});
