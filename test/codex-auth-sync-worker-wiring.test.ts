import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const pool = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');
const types = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
const dashboardIpc = readFileSync(new URL('../src/core/dashboard-ipc-server.ts', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');

describe('codexAuthSync daemon → worker cold-spawn wiring', () => {
  it('declares and sends the policy through init IPC with shared fallback', () => {
    expect(types).toContain("codexAuthSync?: import('./services/codex-auth-sync.js').CodexAuthSyncMode");
    const initStart = pool.indexOf('initMsg = {');
    const initEnd = pool.indexOf('worker.send(initMsg)', initStart);
    const init = pool.slice(initStart, initEnd);
    expect(init).toContain("codexAuthSync: botCfg.codexAuthSync ?? 'shared'");
  });

  it('provisions auth only inside the sandbox/read-isolation redirect branch', () => {
    const gate = worker.indexOf('if (willRedirectCliData) {');
    const provision = worker.indexOf('provisionIsolatedBotHome(', gate);
    const nextLifecycle = worker.indexOf('// Predict reattach vs fresh', gate);
    expect(gate).toBeGreaterThan(-1);
    expect(provision).toBeGreaterThan(gate);
    expect(provision).toBeLessThan(nextLifecycle);
    expect(worker.slice(provision, nextLifecycle)).toContain("cfg.codexAuthSync ?? 'shared'");
  });

  it('passes per-bot env at backend spawn after sandbox wrapping is selected', () => {
    const spawn = worker.indexOf('backend.spawn(spawnBin, spawnArgs, {');
    const end = worker.indexOf('});', spawn);
    expect(worker.slice(spawn, end)).toContain('injectEnv: perBotInjectKeys.length ? perBotInjectEnv : undefined');
  });

  it('exposes the policy through dashboard read, write and aggregator proxy routes', () => {
    expect(dashboardIpc).toContain('codexAuthSync,');
    expect(dashboardIpc).toContain("ipcRoute('PUT', '/api/bot-codex-auth-sync'");
    expect(dashboardIpc).toContain("applyConfigField(cachedLarkAppId, spec, body.codexAuthSync)");
    expect(dashboard).toContain('mBotCodexAuthSync = url.pathname.match(');
    expect(dashboard).toContain('codex-auth-sync$/');
    expect(dashboard).toContain("proxyToDaemon(appId, `/api/bot-codex-auth-sync`");
  });
});
