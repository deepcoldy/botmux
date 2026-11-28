import './helpers/require-fenced-data-dir.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PtyHandle } from '../src/adapters/cli/types.js';

// Fault injection stays in this vitest-only file so the main ownership suite
// remains runnable on Bun (which does not support hoisted importOriginal mocks).
const fsControl = vi.hoisted(() => ({ failPath: '', failOnce: false, failExistsPath: '', failExistsOnce: false }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const statSync = ((path: any, ...args: any[]) => {
    if (fsControl.failOnce && String(path) === fsControl.failPath) {
      fsControl.failOnce = false;
      throw Object.assign(new Error('injected transient transcript stat failure'), { code: 'EIO' });
    }
    return (actual.statSync as any)(path, ...args);
  }) as typeof actual.statSync;
  const existsSync = ((path: any) => {
    if (fsControl.failExistsOnce && String(path) === fsControl.failExistsPath) {
      fsControl.failExistsOnce = false;
      return false; // existsSync hides EACCES/EIO/replace races as false.
    }
    return actual.existsSync(path);
  }) as typeof actual.existsSync;
  return { ...actual, statSync, existsSync };
});

const home = mkdtempSync(join(tmpdir(), 'agy-baseline-io-home-'));
const previousHome = process.env.HOME;
const previousScale = process.env.BOTMUX_TIME_SCALE;
process.env.HOME = home;
process.env.BOTMUX_TIME_SCALE = '0.05';
const { createAntigravityAdapter } = await import('../src/adapters/cli/antigravity.js');
const cliHome = join(home, '.gemini', 'antigravity-cli');
const history = join(cliHome, 'history.jsonl');
const cid = randomUUID();
const transcript = join(cliHome, 'brain', cid, '.system_generated', 'logs', 'transcript_full.jsonl');

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousScale === undefined) delete process.env.BOTMUX_TIME_SCALE; else process.env.BOTMUX_TIME_SCALE = previousScale;
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  fsControl.failPath = '';
  fsControl.failOnce = false;
  fsControl.failExistsPath = '';
  fsControl.failExistsOnce = false;
  mkdirSync(cliHome, { recursive: true });
  mkdirSync(join(transcript, '..'), { recursive: true });
  writeFileSync(history, '');
  writeFileSync(transcript, '');
});

function historyLine(display: string): string {
  return `${JSON.stringify({ display, timestamp: Date.now(), workspace: '/w', conversationId: cid })}\n`;
}
function userInput(payload: string): void {
  mkdirSync(join(transcript, '..'), { recursive: true });
  appendFileSync(transcript, JSON.stringify({
    type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE',
    content: `<USER_REQUEST>\n${payload}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnow\n</ADDITIONAL_METADATA>`,
  }) + '\n');
}
function makePty(onEnter: () => void): PtyHandle {
  return {
    write: () => true,
    sendText: () => true,
    sendSpecialKeys: (...keys: string[]) => { if (keys[0] === 'Enter') onEnter(); return true; },
  } as unknown as PtyHandle;
}

describe('Antigravity transcript baseline I/O failure', () => {
  it('does not turn a failed size sample into a zero baseline that accepts an old identical record', async () => {
    mkdirSync(cliHome, { recursive: true });
    writeFileSync(history, '');
    const content = 'repeated-static-prompt';
    userInput(content); // Only a pre-write record exists.
    const adapter = createAntigravityAdapter('/usr/local/bin/agy');
    const args = adapter.buildArgs({ sessionId: 'baseline-io', resume: true, resumeSessionId: cid, reattach: false } as any);
    const logPath = args[args.indexOf('--log-file') + 1]!;
    fsControl.failPath = transcript;
    fsControl.failOnce = true;
    const result = await adapter.writeInput(makePty(() => {
      appendFileSync(history, historyLine(content));
      appendFileSync(logPath, `I1127 10:00:00.000000 1 x.go:1] Streaming conversation ${cid}\n`);
      // This Enter never produces a new USER_INPUT.
    }), content);
    expect(result).toEqual({
      submitted: true,
      cliSessionId: cid,
      proveConsumed: expect.any(Function),
      settleConsumed: expect.any(Function),
    });
    expect((result as any).proveConsumed()).toBeUndefined();
  });

  it('does not treat an existence-probe failure as a newly created transcript', async () => {
    const content = 'existing-record-after-exists-error';
    userInput(content); // Only a pre-write record exists.
    const adapter = createAntigravityAdapter('/usr/local/bin/agy');
    const args = adapter.buildArgs({ sessionId: 'baseline-exists-io', resume: true, resumeSessionId: cid, reattach: false } as any);
    const logPath = args[args.indexOf('--log-file') + 1]!;
    fsControl.failExistsPath = transcript;
    fsControl.failExistsOnce = true;
    const result = await adapter.writeInput(makePty(() => {
      appendFileSync(history, historyLine(content));
      appendFileSync(logPath, `I1127 10:00:00.000000 1 x.go:1] Streaming conversation ${cid}\n`);
      // This Enter never produces a new USER_INPUT.
    }), content);
    expect(result).toMatchObject({ submitted: true, cliSessionId: cid });
    expect((result as any).ownershipProven).toBeUndefined();
    expect((result as any).proveConsumed()).toBeUndefined();
  });
});
