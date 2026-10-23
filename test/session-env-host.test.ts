/**
 * Daemon-side session-env views (core/session-env-host.ts): masking of the
 * machine baseline, both tmux servers' frozen global env (read + one-off
 * removal), and a running CLI's real environment from /proc.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const botConfig = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../src/bot-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/bot-registry.js')>()),
  getBot: () => ({ config: botConfig.current }),
}));

import { config } from '../src/config.js';
import {
  botSessionEnvView,
  globalSessionEnvView,
  liveSessionEnvView,
  readTmuxServerGlobalEnv,
  removeTmuxServerGlobalEnv,
  revealLiveSessionEnvValue,
  revealSessionEnvValue,
  sessionEnvTmuxSockets,
  tmuxServersEnvView,
} from '../src/core/session-env-host.js';
import { sessionEnvFingerprint, writeSessionEnvStamp } from '../src/services/session-env-stamp.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';

let cfgDir: string;
beforeAll(() => {
  cfgDir = mkdtempSync(join(tmpdir(), 'session-env-host-'));
  process.env.BOTMUX_GLOBAL_CONFIG_FILE = join(cfgDir, 'config.json');
});
afterAll(() => {
  delete process.env.BOTMUX_GLOBAL_CONFIG_FILE;
  rmSync(cfgDir, { recursive: true, force: true });
});

describe('machine baseline views', () => {
  afterEach(() => { delete process.env.SE_HOST_SECRET_TOKEN; delete process.env.GITHUB_TOKEN; delete process.env.SE_PLAIN; });

  it('masks credentials, lists redacted host names, and reveals on request', () => {
    process.env.SE_HOST_SECRET_TOKEN = 'host-secret-sentinel-0000';
    process.env.GITHUB_TOKEN = 'gh-sentinel';
    process.env.SE_PLAIN = 'plain-value';
    const view = globalSessionEnvView();
    const json = JSON.stringify(view);
    expect(json).not.toContain('host-secret-sentinel');
    expect(json).not.toContain('gh-sentinel');
    expect(view.redactedHostKeys).toContain('GITHUB_TOKEN');
    expect(view.rows.find(r => r.key === 'SE_HOST_SECRET_TOKEN')).toMatchObject({ source: 'host', masked: true });
    expect(view.rows.find(r => r.key === 'SE_PLAIN')).toMatchObject({ value: 'plain-value' });
    expect(view.rows.some(r => r.key.startsWith('BOTMUX'))).toBe(false);
    expect(revealSessionEnvValue('SE_HOST_SECRET_TOKEN')).toBe('host-secret-sentinel-0000');
    // viewers without reveal rights see nothing readable
    expect(JSON.stringify(globalSessionEnvView({ maskAll: true }))).not.toContain('plain-value');
  });

  it('bot view applies the global layer under the bot layer and the identity lock', () => {
    process.env.SE_PLAIN = 'plain-value';
    botConfig.current = { larkAppId: 'app_a', cliId: 'claude-code', env: { SE_PLAIN: 'bot-value', ZDOTDIR: '/z' }, envUnset: ['LANG'] };
    const view = botSessionEnvView(botConfig.current as any);
    expect(view.rows.find(r => r.key === 'SE_PLAIN')).toMatchObject({ source: 'bot', state: 'set', entry: 'set', value: 'bot-value' });
    expect(view.identityLockedKeys).toEqual(['ZDOTDIR', 'BASH_ENV']);
    expect(view.identityIgnoredKeys).toEqual(['ZDOTDIR']);
    expect(view.rows.find(r => r.key === 'ZDOTDIR')).toBeUndefined();
  });
});

const hasTmux = process.platform === 'linux' && spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

describe('tmux servers', () => {
  it('lists the default server and the managed socket, marking where new managed sessions go', () => {
    expect(sessionEnvTmuxSockets()).toEqual([{ socket: null, managed: false }, { socket: 'botmux', managed: true }]);
  });

  it.skipIf(!hasTmux)('reads each frozen global env and removes one variable on request', () => {
    // Private servers (the test fence gives this file its own TMUX_TMPDIR).
    spawnSync('tmux', ['new-session', '-d', '-s', 'd', 'sleep', '30'], { env: { ...process.env, SE_FROZEN_TOKEN: 'frozen-secret-sentinel', SE_FROZEN_PLAIN: 'p' } });
    spawnSync('tmux', ['-L', 'botmux', 'new-session', '-d', '-s', 'm', 'sleep', '30'], { env: { ...process.env, SE_MANAGED_ONLY: 'm' } });
    try {
      expect(readTmuxServerGlobalEnv(null).vars).toMatchObject({ SE_FROZEN_TOKEN: 'frozen-secret-sentinel', SE_FROZEN_PLAIN: 'p' });
      expect(readTmuxServerGlobalEnv('botmux').vars.SE_MANAGED_ONLY).toBe('m');
      const views = tmuxServersEnvView();
      expect(views.map(v => [v.socket, v.managed, v.found])).toEqual([[null, false, true], ['botmux', true, true]]);
      expect(JSON.stringify(views)).not.toContain('frozen-secret-sentinel');

      expect(removeTmuxServerGlobalEnv(null, 'SE_FROZEN_TOKEN')).toEqual({ ok: true, removed: true });
      expect(readTmuxServerGlobalEnv(null).vars.SE_FROZEN_TOKEN).toBeUndefined();
      expect(readTmuxServerGlobalEnv(null).vars.SE_FROZEN_PLAIN).toBe('p');
      expect(removeTmuxServerGlobalEnv(null, 'SE_FROZEN_TOKEN')).toEqual({ ok: true, removed: false });
      expect(removeTmuxServerGlobalEnv('elsewhere', 'SE_FROZEN_PLAIN')).toEqual({ ok: false, error: 'unknown_socket' });
    } finally {
      spawnSync('tmux', ['kill-session', '-t', 'd'], { stdio: 'ignore' });
      spawnSync('tmux', ['-L', 'botmux', 'kill-session', '-t', 'm'], { stdio: 'ignore' });
    }
  });
});

describe('running session real env', () => {
  let child: ChildProcess | undefined;
  afterEach(() => { child?.kill('SIGKILL'); child = undefined; });

  function startCli(env: Record<string, string>): number {
    child = spawn('sleep', ['30'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }, stdio: 'ignore' });
    return child.pid!;
  }
  function ds(pid: number, extra: Record<string, unknown> = {}): any {
    return {
      larkAppId: 'app_a',
      chatId: 'oc_x',
      session: { sessionId: 'sess-live', backendType: 'pty', title: 't' },
      worker: { killed: false },
      localProcessAttestation: { backendType: 'pty', credentialIsolated: false, cliPid: pid, cliProcStart: readProcessStartIdentity(pid) },
      ...extra,
    };
  }

  it.skipIf(process.platform !== 'linux')('shows the process env masked, attributes sources and flags drift', async () => {
    botConfig.current = { larkAppId: 'app_a', cliId: 'claude-code', larkToolBinding: false, env: { BOT_SET: 'v', CHANGED: 'new' }, envUnset: ['LEAKED'] };
    const pid = startCli({ BOT_SET: 'v', CHANGED: 'old', LEAKED: 'x', LIVE_SECRET_TOKEN: 'live-secret-sentinel-0000', BOTMUX_SESSION_ID: 'sess-live' });
    await new Promise(r => setTimeout(r, 50));
    const view = liveSessionEnvView(ds(pid));
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const row = (k: string) => view.rows.find(r => r.key === k);
    expect(row('BOT_SET')).toMatchObject({ source: 'bot' });
    expect(row('BOTMUX_SESSION_ID')).toMatchObject({ source: 'reserved' });
    expect(row('LEAKED')).toMatchObject({ drift: 'unset' });
    expect(row('CHANGED')).toMatchObject({ drift: 'changed' });
    expect(row('LIVE_SECRET_TOKEN')).toMatchObject({ masked: true });
    expect(JSON.stringify(view)).not.toContain('live-secret-sentinel');
    expect(revealLiveSessionEnvValue(ds(pid), 'LIVE_SECRET_TOKEN')).toBe('live-secret-sentinel-0000');
    expect(view.stale).toBeNull();

    // stamped with an older configuration → stale
    writeSessionEnvStamp(config.session.dataDir, 'sess-live', sessionEnvFingerprint({ set: {}, unset: [] }));
    const stale = liveSessionEnvView(ds(pid));
    expect(stale.ok && stale.stale).toBe(true);
  });

  it('refuses a pid that no longer belongs to the attested process, and adopted sessions', () => {
    expect(liveSessionEnvView(ds(process.pid, {
      localProcessAttestation: { backendType: 'pty', credentialIsolated: false, cliPid: process.pid, cliProcStart: 'not-this-process' },
    }))).toEqual(process.platform === 'linux' ? { ok: false, error: 'process_gone' } : { ok: false, error: 'unsupported_platform' });
    expect(liveSessionEnvView(ds(process.pid, { adoptedFrom: { kind: 'tmux' } }))).toEqual({ ok: false, error: 'adopted' });
    expect(liveSessionEnvView(ds(process.pid, { worker: null }))).toEqual({ ok: false, error: 'not_running' });
  });
});
