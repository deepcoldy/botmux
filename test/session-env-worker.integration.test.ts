/**
 * End to end through a real worker: the composed session env overlay reaches
 * the CLI process. Removals win over the host env (pty) and over the managed
 * tmux server's frozen global env (tmux); set values arrive; botmux's own
 * session identity is untouched; the launched CLI is stamped with the
 * fingerprint the daemon sent.
 */
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

const hasTmux = process.platform === 'linux' && spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
const backends = ['pty', ...(hasTmux ? ['tmux'] : [])] as const;

describe('session env overlay reaches the CLI through a real worker', () => {
  it.each(backends)('%s', async (backendType) => {
    const sessionId = randomUUID();
    const dir = mkdtempSync(join(tmpdir(), 'session-env-worker-'));
    // .cjs: an extensionless script under a /tmp with an ESM package.json
    // would be loaded as ESM and exit before reporting.
    const script = join(dir, 'fake-cli.cjs');
    const report = join(dir, 'report.json');
    const bots = join(dir, 'bots.json');
    writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(); }
const pick = ['LEAKED_HOST_TOKEN', 'LEAKED_SERVER_TOKEN', 'HOST_KEPT', 'SET_BY_LAYER', 'BOTMUX_SESSION_ID', 'PATH'];
fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify(Object.fromEntries(pick.map(k => [k, process.env[k] ?? null]))));
console.log('Ready >'); setTimeout(() => {}, 30000);
`, { mode: 0o700 });
    writeFileSync(bots, JSON.stringify([{ larkAppId: 'app_probe', larkAppSecret: '', apiOnly: true, cliId: 'claude-code' }]));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: dir,
      SESSION_DATA_DIR: join(dir, 'data'),
      BOTS_CONFIG: bots,
      BOTMUX_NO_CLAIM: '1',
      LEAKED_HOST_TOKEN: 'host-sentinel',
      HOST_KEPT: 'kept',
    };
    if (backendType === 'tmux') {
      // The managed server already exists and froze a variable the user wants
      // out of sessions (the fence keeps this socket inside a private TMUX_TMPDIR).
      execFileSync('tmux', ['-L', 'botmux', 'new-session', '-d', '-s', 'seed', 'sleep', '60'], {
        env: { ...env, LEAKED_SERVER_TOKEN: 'server-sentinel' },
      });
    }
    const worker = spawnNodeTsScript('src/worker.ts', [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let diagnostics = '';
    worker.stdout?.on('data', data => diagnostics += String(data));
    worker.stderr?.on('data', data => diagnostics += String(data));
    try {
      worker.send({
        type: 'init', sessionId, chatId: 'virtual_probe', rootMessageId: 'oc_probe', workingDir: dir,
        cliId: 'claude-code', cliPathOverride: script, backendType, prompt: '', apiOnly: true,
        larkAppId: 'app_probe', larkAppSecret: '', ownerOpenId: 'ou_owner',
        env: { SET_BY_LAYER: 'layer-value' },
        envUnset: ['LEAKED_HOST_TOKEN', 'LEAKED_SERVER_TOKEN'],
        envFingerprint: 'fp-session-env-test',
        loadedBotsConfigPath: bots, loadedBotsConfigProvenance: 'loaded', promptInjection: 'none',
      });
      await vi.waitFor(() => expect(existsSync(report), diagnostics).toBe(true), { timeout: 25_000 });
      const seen = JSON.parse(readFileSync(report, 'utf8'));
      expect(seen.HOST_KEPT, diagnostics).toBe('kept');
      expect(seen.SET_BY_LAYER).toBe('layer-value');
      expect(seen.LEAKED_HOST_TOKEN).toBeNull();
      expect(seen.LEAKED_SERVER_TOKEN).toBeNull();
      expect(seen.BOTMUX_SESSION_ID).toBe(sessionId);
      expect(seen.PATH).toBeTruthy();
      // The stamp is written once backend.spawn() returns; under tmux the CLI
      // can already be running (and reporting) before that.
      const stamp = join(dir, 'data', 'sessions', `${sessionId}.env-stamp`);
      await vi.waitFor(() => expect(existsSync(stamp) && readFileSync(stamp, 'utf8'), diagnostics).toBe('fp-session-env-test'), { timeout: 10_000 });
    } finally {
      const exited = once(worker, 'exit');
      if (worker.connected) worker.send({ type: 'close' });
      const killTimeout = setTimeout(() => worker.kill('SIGKILL'), 5000);
      try { if (worker.exitCode === null && worker.signalCode === null) await exited; }
      finally { clearTimeout(killTimeout); }
      if (backendType === 'tmux') {
        spawnSync('tmux', ['-L', 'botmux', 'kill-session', '-t', 'seed'], { stdio: 'ignore' });
        spawnSync('tmux', ['-L', 'botmux', 'kill-session', '-t', `bmx-${sessionId.slice(0, 8)}`], { stdio: 'ignore' });
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
