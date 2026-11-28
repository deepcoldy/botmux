import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  cliHasNoRawPassthroughSurface,
  cliSupportsCompactAction,
} from '../src/core/passthrough-commands.js';
import { minimaxCompactQueueSuppressesPromptReady } from '../src/core/inject-queue-policy.js';
import { spawnTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(r => child.once('close', () => r()));
      child.kill('SIGTERM');
      await closed;
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('AtomCode /compact card and queue gates', () => {
  it('blocks arbitrary raw passthrough commands while enabling card /compact', () => {
    expect(cliHasNoRawPassthroughSurface('atomcode')).toBe(true);
    expect(cliSupportsCompactAction('atomcode')).toBe(true);
  });

  it('suppresses prompt_ready while an AtomCode /compact command is queued', () => {
    expect(minimaxCompactQueueSuppressesPromptReady('atomcode', [{ content: '/compact' }])).toBe(true);
    expect(minimaxCompactQueueSuppressesPromptReady('atomcode', [{ content: '  /compact  ' }])).toBe(true);
    expect(minimaxCompactQueueSuppressesPromptReady('atomcode', [{ content: '/status' }])).toBe(false);
  });

  it('executes /compact through atomcode-runner and emits a compact final marker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-atomcode-compact-'));
    roots.push(root);
    const bin = join(root, 'atomcode');
    const prefix = tsRunnerPrefix();
    writeFileSync(
      bin,
      `#!/bin/sh\nexec ${[prefix.command, resolve('test/fixtures/fake-atomcode-acp.mjs')].map(quote).join(' ')} "$@"\n`,
      { mode: 0o700 },
    );
    const child = spawnTsScript(
      resolve('src/atomcode-runner.ts'),
      ['--atomcode-bin', bin, '--cwd', root, '--native-session-id', 'acp-compact-1'],
    ) as ChildProcessWithoutNullStreams;
    children.push(child);

    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    const waitFor = async (check: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for atomcode-runner compact');
        await new Promise(r => setTimeout(r, 20));
      }
    };
    const markers = () => [...stdout.matchAll(/\x1b\]777;botmux:(\w+):([A-Za-z0-9+/=]+)\x07/g)]
      .map(m => ({ kind: m[1], payload: JSON.parse(Buffer.from(m[2], 'base64').toString('utf8')) }));

    await waitFor(() => /^›$/m.test(stdout));
    const frame = Buffer.from(JSON.stringify({
      type: 'message',
      content: '/compact',
      replyTurnId: 'compact-turn-1',
    })).toString('base64');
    child.stdin.write(`::botmux-atomcode:${frame}\n`);
    await waitFor(() => markers().some(m => m.kind === 'final' && m.payload.turnId === 'compact-turn-1'));

    const final = markers().find(m => m.kind === 'final' && m.payload.turnId === 'compact-turn-1')?.payload;
    expect(final?.content).toContain('compact requested');
    expect(final?.errorCode).toBeUndefined();
  });
});
