/** Regression coverage for tool descendants whose stdio closes before their process exits. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAntigravityAcp } from '../src/services/antigravity-acp.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

interface FixtureState {
  nativePid: number;
  descendantPid: number;
  ready: boolean;
}

const fixtures: Array<{ root: string; stateFile: string; controller: AbortController; settled: Promise<unknown> }> = [];

/** Read the fixture's own process receipt, which is published before its terminal response. */
function state(path: string): FixtureState | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as FixtureState; }
  catch { return undefined; }
}

/** PID probes are scoped to the unique state-file argument, preventing cleanup of reused PIDs. */
function ownedProcess(pid: number, stateFile: string): { running: boolean } | undefined {
  try {
    const info = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'stat=', '-o', 'args='], {
      encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!info.includes(stateFile)) return undefined;
    return { running: !/^[ZX]/.test(info) };
  } catch { return undefined; }
}

/** Wait for the exact receipt or stopped process, using a bounded deadline instead of a fixed sleep. */
async function until(check: () => boolean, failure: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(failure);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.controller.abort();
    await fixture.settled;
    const receipt = state(fixture.stateFile);
    for (const pid of [receipt?.descendantPid, receipt?.nativePid]) {
      if (!pid || !ownedProcess(pid, fixture.stateFile)?.running) continue;
      try { process.kill(pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

/** Start a native ACP peer and its same-group, SIGTERM-resistant tool process. */
function execute(mode: 'complete' | 'cancel') {
  const root = mkdtempSync(join(tmpdir(), 'botmux-agy-cleanup-'));
  const stateFile = join(root, 'processes.json');
  const executable = join(root, 'agy');
  const runtime = tsRunnerPrefix();
  const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
  // The fixture is already JavaScript; tsx's bare import cannot resolve from
  // the isolated native cwd, and no TypeScript loader is needed there.
  writeFileSync(executable, `#!/bin/sh\nexec ${[
    runtime.command, resolve('test/fixtures/fake-antigravity-acp-cleanup.mjs'), '--state-file', stateFile,
  ].map(quote).join(' ')} "$@"\n`, { mode: 0o700 });
  const controller = new AbortController();
  const task = runAntigravityAcp({
    executable, cwd: root, env: { ...process.env, AGY_CLEANUP_MODE: mode },
    content: 'cleanup fixture', onSession: () => {},
  }, controller.signal);
  fixtures.push({ root, stateFile, controller, settled: task.catch(() => {}) });
  return { task, controller, stateFile };
}

describe.skipIf(!['linux', 'darwin'].includes(process.platform))('Antigravity ACP owned descendant cleanup', () => {
  it('stops a detached-stdio descendant after normal completion, even when it ignores SIGTERM', async () => {
    const fixture = execute('complete');
    await expect(fixture.task).resolves.toBe('cleanup answer');
    const receipt = state(fixture.stateFile);
    expect(receipt?.ready).toBe(true);
    expect(receipt?.descendantPid).toBeGreaterThan(0);
    await until(() => !ownedProcess(receipt!.descendantPid, fixture.stateFile)?.running,
      'Antigravity ACP left its SIGTERM-resistant descendant running after normal completion');
  });

  it('stops a detached-stdio descendant when a running turn is cancelled', async () => {
    const fixture = execute('cancel');
    const rejected = fixture.task.catch((error: unknown) => error);
    await until(() => state(fixture.stateFile)?.ready === true, 'ACP descendant did not publish its ready receipt');
    const receipt = state(fixture.stateFile)!;
    expect(ownedProcess(receipt.descendantPid, fixture.stateFile)?.running).toBe(true);
    fixture.controller.abort();
    const error = await rejected;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('cancelled');
    await until(() => !ownedProcess(receipt.descendantPid, fixture.stateFile)?.running,
      'Antigravity ACP left its SIGTERM-resistant descendant running after cancellation');
  });
});
