/**
 * Regression: two botmux daemons on one machine that resolve the same IPC port
 * (e.g. both default to BOTMUX_DAEMON_IPC_BASE_PORT 7950 + idx 0) must NOT take
 * each other down. Before the fix, startIpcServer did a single fixed-port
 * server.listen + server.once('error', reject); the daemon awaits it unguarded
 * (daemon.ts), so an EADDRINUSE rejected -> the WHOLE daemon crashed at startup.
 * After: startIpcServer probes to the next free port and resolves with it (the
 * daemon then republishes the bound port into its descriptor).
 *
 * Run: pnpm vitest run test/dashboard-ipc-probe.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startIpcServer } from '../src/core/dashboard-ipc-server.js';

const handles: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => { for (const h of handles.splice(0)) await h.close(); });

describe('startIpcServer EADDRINUSE resilience', () => {
  it('binds the next free port when the requested IPC port is already in use', async () => {
    const first = await startIpcServer({ port: 0, host: '127.0.0.1' });
    handles.push(first);
    // Second daemon resolves the SAME port -> must step up, not reject/crash.
    const second = await startIpcServer({ port: first.port, host: '127.0.0.1' });
    handles.push(second);
    expect(second.port).toBe(first.port + 1);
  });
});
