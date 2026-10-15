/**
 * 适配器共享原语：tui-input（writeTextThenEnter / bracketed paste）、runner-path、
 * model-catalog-json 的 detect 帮手。
 *
 * 这些原先是 aiden / copilot / gemini / mtr、codex-app / dsh / mira / mir / minimax、
 * coco / traex / opencode / codex 里逐字重复的实现；这里直接锁住共享实现的行为，
 * 并抽样在多个「别的 CLI」上确认它们确实接上了共享实现（行为由 write-input.test.ts 等覆盖）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { flushFakeTimers } from './helpers/flush-fake-timers.js';
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  wrapBracketedPaste,
  writeTextThenEnter,
} from '../src/adapters/cli/tui-input.js';
import { resolveRunnerPath } from '../src/adapters/cli/runner-path.js';
import { capabilitySlugs } from '../src/adapters/cli/model-catalog-json.js';
import { createAidenAdapter } from '../src/adapters/cli/aiden.js';
import { createCopilotAdapter } from '../src/adapters/cli/copilot.js';
import { createGeminiAdapter } from '../src/adapters/cli/gemini.js';
import { createMtrAdapter } from '../src/adapters/cli/mtr.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

function recorderPty(withSendKeys: boolean): { pty: PtyHandle; calls: string[] } {
  const calls: string[] = [];
  const pty = {
    write: (data: string) => { calls.push(`write:${JSON.stringify(data)}`); },
    ...(withSendKeys
      ? {
          sendText: (data: string) => { calls.push(`sendText:${JSON.stringify(data)}`); },
          sendSpecialKeys: (key: string) => { calls.push(`keys:${key}`); },
        }
      : {}),
  } as unknown as PtyHandle;
  return { pty, calls };
}

describe('tui-input', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('wraps content in xterm bracketed-paste markers', () => {
    expect(BRACKETED_PASTE_START).toBe('\x1b[200~');
    expect(BRACKETED_PASTE_END).toBe('\x1b[201~');
    expect(wrapBracketedPaste('a\nb')).toBe('\x1b[200~a\nb\x1b[201~');
  });

  it('persistent backends: sendText, 200ms settle, Enter', async () => {
    const { pty, calls } = recorderPty(true);
    const done = writeTextThenEnter(pty, 'hello');
    await vi.advanceTimersByTimeAsync(199);
    expect(calls).toEqual(['sendText:"hello"']);
    await flushFakeTimers(400);
    await done;
    expect(calls).toEqual(['sendText:"hello"', 'keys:Enter']);
  });

  it('raw PTY: write, 1s settle, CR', async () => {
    const { pty, calls } = recorderPty(false);
    const done = writeTextThenEnter(pty, 'hi');
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toEqual(['write:"hi"']);
    await flushFakeTimers(2_000);
    await done;
    expect(calls).toEqual(['write:"hi"', 'write:"\\r"']);
  });

  it.each([
    ['aiden', createAidenAdapter('/bin/aiden')],
    ['copilot', createCopilotAdapter('/bin/copilot')],
    ['gemini', createGeminiAdapter('/bin/gemini')],
    ['mtr', createMtrAdapter('/bin/mtr')],
  ])('%s adapter submits through the shared sequence', async (_name, adapter) => {
    const { pty, calls } = recorderPty(true);
    const done = adapter.writeInput(pty, 'x\ny');
    await flushFakeTimers(1_000);
    await done;
    expect(calls).toEqual(['sendText:"x\\ny"', 'keys:Enter']);
  });
});

describe('resolveRunnerPath', () => {
  const ENV = 'BOTMUX_TEST_SHARED_RUNNER_PATH';
  afterEach(() => { delete process.env[ENV]; vi.unstubAllEnvs(); });

  it('honours the test override only under NODE_ENV=test', () => {
    process.env[ENV] = '/tmp/custom-runner.js';
    vi.stubEnv('NODE_ENV', 'test');
    expect(resolveRunnerPath('x-runner.js', { testOverrideEnv: ENV })).toBe(resolve('/tmp/custom-runner.js'));
    vi.stubEnv('NODE_ENV', 'production');
    expect(resolveRunnerPath('x-runner.js', { testOverrideEnv: ENV })).not.toBe(resolve('/tmp/custom-runner.js'));
  });

  it('an unset override env var never redirects resolution', () => {
    vi.stubEnv('NODE_ENV', 'test');
    expect(resolveRunnerPath('nonexistent-runner.js', { testOverrideEnv: ENV })).toMatch(/nonexistent-runner\.js$/);
  });

  it('falls back to the compiled sibling by default and to dist/ for fallback=dist when neither exists', () => {
    const sibling = resolveRunnerPath('definitely-missing-runner.js');
    const dist = resolveRunnerPath('definitely-missing-runner.js', { fallback: 'dist' });
    expect(sibling).toMatch(/src[\\/]definitely-missing-runner\.js$/);
    expect(dist).toMatch(/dist[\\/]definitely-missing-runner\.js$/);
    expect(existsSync(sibling)).toBe(false);
    expect(existsSync(dist)).toBe(false);
  });
});

describe('capabilitySlugs', () => {
  it('maps a capability catalogue to its slugs and keeps null/undefined as null', () => {
    expect(capabilitySlugs([{ slug: 'a', serviceTiers: [] }, { slug: 'b', serviceTiers: ['fast'] }])).toEqual(['a', 'b']);
    expect(capabilitySlugs([])).toEqual([]);
    expect(capabilitySlugs(null)).toBeNull();
    expect(capabilitySlugs(undefined)).toBeNull();
  });
});
