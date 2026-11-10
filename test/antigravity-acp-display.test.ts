/** Real runner output must not allow model/tool text to release a pending native turn. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createAntigravityAcpAdapter } from '../src/adapters/cli/antigravity-acp.js';
import { RunnerControlDecoder } from '../src/adapters/cli/runner-control-channel.js';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { spawnTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3_000);
    try { await closed; } finally { clearTimeout(timeout); }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Antigravity ACP display boundaries', () => {
  it('keeps a pending turn busy when model and tool text contain Unicode line separators', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-agy-display-')); roots.push(root);
    const executable = join(root, 'agy');
    const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
    writeFileSync(executable, `#!/bin/sh\nexec ${[tsRunnerPrefix().command,
      resolve('test/fixtures/fake-antigravity-display.mjs')].map(quote).join(' ')} "$@"\n`, { mode: 0o700 });
    const child = spawnTsScript(resolve('src/antigravity-runner.ts'), ['--agy-bin', executable, '--cwd', root],
      { env: process.env }) as ChildProcessWithoutNullStreams;
    children.push(child);
    let output = '';
    let sent = false;
    const captured = new Promise<string>((resolveCaptured, reject) => {
      const timeout = setTimeout(() => reject(new Error('Antigravity display fixture did not emit its progress marker')), 10_000);
      child.once('error', reject);
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (!sent && output.includes('Antigravity ACP runner ready.\n›\n')) {
          sent = true;
          child.stdin.write(`::botmux-antigravity:${Buffer.from(JSON.stringify({
            type: 'message', content: 'display probe', replyTurnId: 'display-turn',
          })).toString('base64')}\n`);
        }
        if (output.includes('ACP_DISPLAY_END')) { clearTimeout(timeout); resolveCaptured(output); }
      });
    });
    const bytes = await captured;
    const kinds: string[] = [];
    const display = new RunnerControlDecoder().push(bytes, true, body => kinds.push(body.split(':', 1)[0]));
    expect(kinds).toContain('thread');
    expect(kinds).not.toContain('final');

    vi.useFakeTimers();
    const detector = new IdleDetector(createAntigravityAcpAdapter('/bin/true'));
    const idle = vi.fn(); detector.onIdle(idle);
    try {
      detector.reset();
      detector.feed(display);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(idle).not.toHaveBeenCalled();
      expect(detector.isIdleNow()).toBe(false);
      detector.feed('›\n');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(idle).toHaveBeenCalledTimes(1);
    } finally { detector.dispose(); vi.useRealTimers(); }
  });
});
