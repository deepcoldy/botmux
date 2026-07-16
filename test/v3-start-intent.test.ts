import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import { persistV3StartIntent } from '../src/workflows/v3/start-intent.js';

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for start-intent child process');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function startIntentChild(runDir: string, readyPath: string, barrierPath: string): Promise<void> {
  const moduleUrl = new URL('../src/workflows/v3/start-intent.ts', import.meta.url).href;
  const script = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { persistV3StartIntent } from ${JSON.stringify(moduleUrl)};
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    writeFileSync(process.env.READY_PATH, 'ready');
    while (!existsSync(process.env.BARRIER_PATH)) Atomics.wait(sleeper, 0, 0, 10);
    persistV3StartIntent(process.env.RUN_ID, process.env.RUN_DIR);
    persistV3StartIntent(process.env.RUN_ID, process.env.RUN_DIR);
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RUN_ID: 'concurrent-run',
      RUN_DIR: runDir,
      READY_PATH: readyPath,
      BARRIER_PATH: barrierPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`start-intent child exited ${code}: ${stderr || stdout}`));
    });
  });
}

describe('persistV3StartIntent', () => {
  it('durably creates one idempotent runStarted boundary', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-start-intent-'));
    try {
      const runDir = join(base, 'saved-run');
      persistV3StartIntent('saved-run', runDir);
      persistV3StartIntent('saved-run', runDir);
      expect(readJournal(join(runDir, 'journal.ndjson'))).toMatchObject([
        { type: 'runStarted', runId: 'saved-run' },
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('serializes real concurrent child processes into exactly one idempotent runStarted', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-start-intent-race-'));
    try {
      const runDir = join(base, 'concurrent-run');
      const journalPath = join(runDir, 'journal.ndjson');
      const barrierPath = join(base, 'go');
      mkdirSync(runDir, { recursive: true });

      // Hold the exact advisory lock that persistV3StartIntent must honor.
      // This makes the test deterministic: every child reaches the function,
      // but none may inspect or create the journal until we release it.
      writeFileSync(`${journalPath}.lock`, String(process.pid));
      const readyPaths = Array.from({ length: 6 }, (_, index) => join(base, `ready-${index}`));
      const children = readyPaths.map((readyPath) => startIntentChild(runDir, readyPath, barrierPath));
      await waitUntil(() => readyPaths.every(existsSync));
      writeFileSync(barrierPath, 'go');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(existsSync(journalPath)).toBe(false);

      unlinkSync(`${journalPath}.lock`);
      await Promise.all(children);
      expect(readJournal(journalPath)).toMatchObject([
        { type: 'runStarted', runId: 'concurrent-run' },
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects mismatched identity but repairs a torn-only cold-start journal', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-start-intent-bad-'));
    try {
      const runDir = join(base, 'actual');
      expect(() => persistV3StartIntent('claimed', runDir)).toThrow(/directory identity mismatch/);
      appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId: 'other' });
      expect(() => persistV3StartIntent('actual', runDir)).toThrow(/journal identity mismatch/);

      const tornDir = join(base, 'torn');
      mkdirSync(tornDir, { recursive: true });
      writeFileSync(join(tornDir, 'journal.ndjson'), '{"type":"runSta');
      persistV3StartIntent('torn', tornDir);
      expect(readJournal(join(tornDir, 'journal.ndjson'))).toMatchObject([
        { type: 'runStarted', runId: 'torn' },
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
