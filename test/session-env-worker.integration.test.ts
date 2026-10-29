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
import { killProcessTree } from './helpers/process-tree.js';

const hasTmux = process.platform === 'linux' && spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
const backends = ['pty', ...(hasTmux ? ['tmux'] : [])] as const;

// The fake CLI writes the report with writeFileSync: truncate-create makes the
// path exist before the bytes land. Waiting on existsSync() and then parsing
// synchronously hits that empty window under the tmux backend (JSON Parse
// error: Unexpected EOF). Poll until the content is a complete JSON object —
// same race and same fix as strict-env-worker.integration.test.ts (#2386).
function waitForJsonReport(path: string, timeoutMs: number): Record<string, unknown> | null {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const body = readFileSync(path, 'utf8');
      if (body.length > 0) return JSON.parse(body) as Record<string, unknown>;
    } catch {
      // Not created yet / empty truncate window / partially written JSON — keep polling.
    }
    if (Date.now() >= deadline) return null;
    spawnSync('sleep', ['0.05']);
  }
}

describe('session env overlay reaches the CLI through a real worker', () => {
  // Drive one real worker against the fake CLI. reportDelayMs > 0 makes the fake
  // CLI truncate-create the report, pause, and only then write the JSON body —
  // deterministically widening the create-vs-write gap that existsSync-only
  // waiting used to observe as an empty file (Unexpected EOF).
  async function runOverlayCheck(
    backendType: (typeof backends)[number],
    reportDelayMs = 0,
  ): Promise<void> {
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
const pick = ['LEAKED_HOST_TOKEN', 'LEAKED_SERVER_TOKEN', 'HOST_KEPT', 'SET_BY_LAYER', 'BOTMUX_SESSION_ID', 'PATH', 'PROBE_REPORT_DELAY_MS'];
const reportPath = ${JSON.stringify(report)};
const writeReport = () => {
  fs.writeFileSync(reportPath, JSON.stringify(Object.fromEntries(pick.map(k => [k, process.env[k] ?? null]))));
  console.log('Ready >');
};
const reportDelayMs = Number(process.env.PROBE_REPORT_DELAY_MS || 0);
if (reportDelayMs > 0) {
  fs.closeSync(fs.openSync(reportPath, 'w'));
  setTimeout(writeReport, reportDelayMs);
} else {
  writeReport();
}
setTimeout(() => {}, 30000);
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
        env: {
          SET_BY_LAYER: 'layer-value',
          ...(reportDelayMs > 0 ? { PROBE_REPORT_DELAY_MS: String(reportDelayMs) } : {}),
        },
        envUnset: ['LEAKED_HOST_TOKEN', 'LEAKED_SERVER_TOKEN'],
        envFingerprint: 'fp-session-env-test',
        loadedBotsConfigPath: bots, loadedBotsConfigProvenance: 'loaded', promptInjection: 'none',
      });
      const seen = waitForJsonReport(report, 25_000);
      expect(seen, diagnostics).not.toBeNull();
      expect(seen.HOST_KEPT, diagnostics).toBe('kept');
      expect(seen.SET_BY_LAYER).toBe('layer-value');
      expect(seen.LEAKED_HOST_TOKEN).toBeNull();
      expect(seen.LEAKED_SERVER_TOKEN).toBeNull();
      expect(seen.BOTMUX_SESSION_ID).toBe(sessionId);
      expect(seen.PATH).toBeTruthy();
      if (reportDelayMs > 0) {
        // Self-check the widening lever itself. PROBE_REPORT_DELAY_MS must reach
        // the fake CLI through the same env overlay under test; if the injection
        // were dropped, the empty file would never be pre-created and this guard
        // would pass vacuously against an immediately-written report.
        expect(seen.PROBE_REPORT_DELAY_MS, diagnostics).toBe(String(reportDelayMs));
      }
      // The stamp is written once backend.spawn() returns; under tmux the CLI
      // can already be running (and reporting) before that.
      const stamp = join(dir, 'data', 'sessions', `${sessionId}.env-stamp`);
      await vi.waitFor(() => expect(existsSync(stamp) && readFileSync(stamp, 'utf8'), diagnostics).toBe('fp-session-env-test'), { timeout: 10_000 });
    } finally {
      const exited = once(worker, 'exit');
      if (worker.connected) worker.send({ type: 'close' });
      // With any tmux call still in flight, before the test's files go below.
      const killTimeout = setTimeout(() => { void killProcessTree(worker); }, 5000);
      try { if (worker.exitCode === null && worker.signalCode === null) await exited; }
      finally { clearTimeout(killTimeout); }
      if (backendType === 'tmux') {
        spawnSync('tmux', ['-L', 'botmux', 'kill-session', '-t', 'seed'], { stdio: 'ignore' });
        spawnSync('tmux', ['-L', 'botmux', 'kill-session', '-t', `bmx-${sessionId.slice(0, 8)}`], { stdio: 'ignore' });
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.each(backends)('%s', async (backendType) => {
    await runOverlayCheck(backendType);
  }, 40_000);

  it.each(backends)('%s keeps waiting until the report body is fully written (widened create-then-write window)', async (backendType) => {
    // 400ms dwarfs the 50ms read poll: an existsSync-then-JSON.parse predicate
    // observes the pre-created empty file and throws Unexpected EOF every run.
    // Run on every backend — the production flake surfaced specifically on tmux.
    await runOverlayCheck(backendType, 400);
  }, 40_000);
});
