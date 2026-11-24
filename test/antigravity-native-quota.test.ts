import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntigravityNativeQuotaLog, currentAntigravityNativeQuota } from '../src/services/antigravity-native-quota.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { supportsAntigravityReadyFooterQuota } from '../src/adapters/cli/antigravity.js';

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function setup() {
  root = mkdtempSync(join(tmpdir(), 'botmux-agy-native-quota-'));
  const path = join(root, 'session.log');
  return { path, log: new AntigravityNativeQuotaLog(path) };
}

const input = (text: string, time = '20:52:20.000000') =>
  `I1123 ${time} 100 input_loop.go:104] HandleUserInput called with text: ${JSON.stringify(text)}\n`;
const quota = (time = '20:52:28.722278', duration = '2h39m35s') =>
  `E1123 ${time} 200 errorreport.go:282] agent executor error: generating and executing: transport error (ResourceExhausted, HTTP 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in ${duration}.: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in ${duration}.\n`;
const noise = (bytes: number) => Array.from({ length: Math.ceil(bytes / 1024) }, () =>
  `I1123 20:52:21.000000 300 runner.go:1] ${'x'.repeat(1000)}`).join('\n') + '\n';

describe('Antigravity native quota log evidence', () => {
  it('keeps older or unknown agy versions on footer-only recovery semantics', () => {
    expect(supportsAntigravityReadyFooterQuota('1.5.15')).toBe(true);
    expect(supportsAntigravityReadyFooterQuota('1.5.16')).toBe(true);
    expect(supportsAntigravityReadyFooterQuota('1.5.14')).toBe(false);
    expect(supportsAntigravityReadyFooterQuota('1.2.13')).toBe(false);
    expect(supportsAntigravityReadyFooterQuota(undefined)).toBe(false);
    const read = loadWorkerFunction<() => unknown>('readAntigravityNativeQuota', {
      cliAdapter: { id: 'antigravity' }, lastInitConfig: { cliVersion: '1.2.13' },
      supportsAntigravityReadyFooterQuota,
    });
    expect(read()).toBeUndefined();
  });

  it('keeps ACP runner sessions off the terminal-only log/screen rotation path', () => {
    const read = loadWorkerFunction<() => unknown>('readAntigravityNativeQuota', {
      cliAdapter: { id: 'antigravity', runnerFramedInput: true },
    });
    expect(read()).toBeUndefined();
  });

  it('correlates a ResourceExhausted refusal with the exact latest native input', () => {
    const { path, log } = setup();
    const text = 'do work\nwith a second line';
    writeFileSync(path, input(text) + quota());
    // agy also emits a generic errorreport line; it must not create an episode.
    appendFileSync(path, 'E1123 20:52:28.726000 201 errorreport.go:282] generating and executing: transport error (ResourceExhausted, HTTP 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h39m35s.: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h39m35s.\n');
    const state = log.read();
    expect(state.quota).toMatchObject({ key: 'E1123 20:52:28.722278', inputSequence: 1 });
    expect(currentAntigravityNativeQuota(state, text)?.text).toContain('Resets in 2h39m35s.');
    expect(currentAntigravityNativeQuota(state, 'different input')).toBeUndefined();
    expect(currentAntigravityNativeQuota(state)?.key).toBe('E1123 20:52:28.722278');
    expect(log.read().quota?.key).toBe('E1123 20:52:28.722278');
  });

  it('reads a first-turn log larger than one chunk from byte zero', () => {
    const { path, log } = setup();
    writeFileSync(path, input('large first turn') + noise(370 * 1024) + quota());
    expect(currentAntigravityNativeQuota(log.read(), 'large first turn')).toMatchObject({
      key: 'E1123 20:52:28.722278', inputSequence: 1,
    });
  });

  it('drains an increment larger than one chunk in a single read', () => {
    const { path, log } = setup();
    writeFileSync(path, noise(9 * 1024));
    expect(log.read().quota).toBeUndefined();
    appendFileSync(path, input('large increment') + noise(350 * 1024) + quota());
    expect(currentAntigravityNativeQuota(log.read(), 'large increment')).toMatchObject({
      key: 'E1123 20:52:28.722278', inputSequence: 1,
    });
  });

  it('recognizes a larger same-inode replacement after the process reader is reset', () => {
    const { path, log } = setup();
    writeFileSync(path, input('task-1') + noise(14 * 1024) + quota());
    expect(currentAntigravityNativeQuota(log.read(), 'task-1')).toBeDefined();
    const inode = statSync(path).ino;
    writeFileSync(path, input('task-2') + noise(24 * 1024) + quota('20:53:28.722278'));
    expect(statSync(path).ino).toBe(inode);

    const scope: Record<string, any> = { antigravityNativeQuotaLog: log };
    const reset = loadWorkerFunction<() => void>('resetAntigravityNativeQuotaLog', scope);
    reset();
    expect(scope.antigravityNativeQuotaLog).toBeUndefined();
    const replacement = new AntigravityNativeQuotaLog(path);
    expect(currentAntigravityNativeQuota(replacement.read(), 'task-2')).toMatchObject({
      key: 'E1123 20:53:28.722278', inputSequence: 1,
    });
  });

  it('normalizes CRLF before comparing the native input', () => {
    const { path, log } = setup();
    writeFileSync(path, input('first line\nsecond line') + quota());
    expect(currentAntigravityNativeQuota(log.read(), 'first line\r\nsecond line')).toBeDefined();
  });

  it('invalidates an old refusal after any later native input, including an identical resend', () => {
    const { path, log } = setup();
    writeFileSync(path, input('same task') + quota());
    expect(currentAntigravityNativeQuota(log.read(), 'same task')).toBeDefined();
    appendFileSync(path, input('same task', '20:53:00.000000'));
    expect(currentAntigravityNativeQuota(log.read(), 'same task')).toBeUndefined();
  });

  it('rejects text without the executor ResourceExhausted protocol markers', () => {
    const { path, log } = setup();
    writeFileSync(path, input('quote a log')
      + '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h39m35s.\nError ID: quoted\n');
    expect(currentAntigravityNativeQuota(log.read(), 'quote a log')).toBeUndefined();
  });

  it('follows a new episode and drops stale state after the native log is truncated', () => {
    const { path, log } = setup();
    writeFileSync(path, input('first') + quota());
    expect(currentAntigravityNativeQuota(log.read(), 'first')?.key).toContain('20:52:28');
    appendFileSync(path, input('second', '21:00:00.000000') + quota('21:00:01.000000', '1h2m3s'));
    expect(currentAntigravityNativeQuota(log.read(), 'second')).toMatchObject({
      key: 'E1123 21:00:01.000000', inputSequence: 2,
    });
    writeFileSync(path, input('fresh process', '21:01:00.000000'));
    expect(currentAntigravityNativeQuota(log.read(), 'fresh process')).toBeUndefined();
    expect(log.read().quota).toBeUndefined();
  });
});
