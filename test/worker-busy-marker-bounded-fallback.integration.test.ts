/**
 * Bounded fallback for an unbounded viewport busy-marker veto.
 *
 * A CLI can settle back at its composer (the `❯` input line is on screen and
 * the screen stops changing) while a stale busy footer glyph still matches the
 * adapter busyPattern — under host load this previously withheld prompt_ready
 * forever, so a queued turn was never re-driven. The bounded fallback in
 * scheduleBusyPatternIdleProbe must release readiness once the composer is
 * visible and the screen has been frozen past the threshold, while a CLI that
 * is genuinely still streaming (screen keeps changing) keeps deferring.
 *
 * The timing thresholds are shortened through BOTMUX_TEST_* env vars so the
 * behaviour is deterministic without waiting the production ~17.5s window.
 */
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const ENV = {
  BOTMUX_TEST_BUSY_READY_FALLBACK_MS: '2000',
  BOTMUX_TEST_BUSY_STABLE_SCREEN_MS: '800',
};

/** A screen that carries BOTH a Claude busy footer and the idle composer. */
const SCREEN = [
  '\x1b[2J\x1b[H',
  'Fake Claude Code',
  '',
  '─'.repeat(48),
  '❯ ',
  '─'.repeat(48),
  // Tail region: a busy footer that matches CLAUDE_BUSY_FOOTER_RE yet lingers
  // after the CLI has actually returned to the composer.
  '⏵⏵ work on hold · esc to interrupt',
].join('\r\n');

function writeFakeCli(path: string, mode: 'stale' | 'active'): void {
  const body = `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('2.1.305 (Claude Code)'); process.exit(0); }
const SCREEN = ${JSON.stringify(SCREEN)};
process.stdout.write(SCREEN);
if (${mode === 'active'}) {
  // Genuinely still working: keep redrawing so the backend screen revision
  // advances on every frame. The bounded fallback must never fire.
  let n = 0;
  setInterval(() => {
    process.stdout.write('\\x1b[2J\\x1b[H' + SCREEN + '\\r\\nframe:' + (n++));
  }, 250);
}
setInterval(() => {}, 1_000);
`;
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

interface Generation {
  child: ReturnType<typeof spawnNodeTsScript>;
  messages: WorkerToDaemon[];
  logs: string[];
}

function startWorker(fakeCli: string, root: string, dataDir: string): Generation {
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  const sessionId = `busy-fallback-${randomUUID()}`;
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: { ...process.env, HOME: root, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId, ...ENV },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.on('message', m => messages.push(m as WorkerToDaemon));
  child.stdout?.on('data', c => logs.push(c.toString()));
  child.stderr?.on('data', c => logs.push(c.toString()));
  child.send({
    type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root',
    workingDir: dataDir, cliId: 'claude-code', cliPathOverride: fakeCli, backendType: 'pty',
    prompt: '', larkAppId: 'app_test', larkAppSecret: 'secret',
  } satisfies DaemonToWorker);
  return { child, messages, logs };
}

const roots: string[] = [];
const children: Generation['child'][] = [];
afterEach(async () => {
  await Promise.all(children.map(c => new Promise<void>(done => {
    if (c.exitCode !== null) return done();
    c.once('exit', () => done());
    c.kill('SIGKILL');
    setTimeout(done, 3_000);
  })));
  children.length = 0;
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

describe('bounded busy-marker prompt-ready fallback', () => {
  it('releases prompt_ready when a busy footer lingers over a visible, frozen composer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bmx-busy-stale-'));
    roots.push(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });
    const fakeCli = join(root, 'fake-claude');
    writeFakeCli(fakeCli, 'stale');
    const g = startWorker(fakeCli, root, dataDir);
    children.push(g.child);

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !g.messages.some(m => m.type === 'prompt_ready')) {
      if (g.child.exitCode !== null) throw new Error(`worker exited early\n${g.logs.join('')}`);
      await new Promise(r => setTimeout(r, 100));
    }
    expect(g.messages.some(m => m.type === 'prompt_ready'), `expected bounded prompt_ready\n${g.logs.join('')}`).toBe(true);
    // The release must come from the bounded fallback, not the ordinary probe.
    expect(g.logs.join('')).toMatch(/bounded fallback window/);
  }, 25_000);

  it('does not force readiness while the screen is still streaming (real active work)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bmx-busy-active-'));
    roots.push(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });
    const fakeCli = join(root, 'fake-claude');
    writeFakeCli(fakeCli, 'active');
    const g = startWorker(fakeCli, root, dataDir);
    children.push(g.child);

    // Wait well past fallbackMs (2s) and several 3.5s probe intervals: a forced
    // release would have fired by now if the stability gate were not holding.
    await new Promise(r => setTimeout(r, 12_000));
    expect(g.child.exitCode === null).toBe(true);
    expect(g.messages.filter(m => m.type === 'prompt_ready')).toHaveLength(0);
    expect(g.logs.join('')).not.toMatch(/bounded fallback window/);
  }, 18_000);
});
