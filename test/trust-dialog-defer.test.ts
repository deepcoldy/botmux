/**
 * Trust-dialog Enter deferral (C-3).
 *
 * Root cause: Codex 0.149's key handler is not ready the instant the trust
 * dialog renders, so a synchronous Enter lands in a dead input queue and is
 * silently dropped (upstream openai/codex#39487) — the confirmation never
 * submits until the ~20s submit_unconfirmed fallback. Production now sets
 * trustHandled synchronously (no re-entry) and defers the Enter by 400ms.
 *
 * worker.ts is a process entry point with no exports, so the handler under
 * test is extracted from source, transpiled, and evaluated with its module
 * level dependencies injected as globals — the same source-truth pattern
 * backend-gate.test.ts uses for the same helper.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

type TrustHandler = (data: string) => boolean;

// The handler's free variables, injected as globals for the eval'd copy.
let trustHandledValue = false;

function installGlobals(backend: unknown): void {
  const g = globalThis as Record<string, unknown>;
  Object.defineProperty(globalThis, 'trustHandled', {
    configurable: true,
    get: () => trustHandledValue,
    set: (v: boolean) => { trustHandledValue = v; },
  });
  g.dismissAidenCodexUpdateDialog = () => false;
  g.lastInitConfig = {};
  g.log = () => {};
  g.backend = backend;
  // 围栏变量：延迟 Enter 回调校验 respawn 代际，eval 上下文需注入
  g.cliSpawnGeneration = 0;
  const patternMatch = workerSource.match(/const TRUST_DIALOG_PATTERN = (\/[^;]+\/);/);
  if (!patternMatch) throw new Error('TRUST_DIALOG_PATTERN not found in worker.ts');
  // eslint-disable-next-line no-new-func
  g.TRUST_DIALOG_PATTERN = new Function(`return ${patternMatch[1]};`)();
}

function extractTrustHandler(): TrustHandler {
  const start = workerSource.indexOf('function handleVisibleStartupInteraction(');
  if (start < 0) throw new Error('handleVisibleStartupInteraction not found in worker.ts');
  // Brace-match to the function's closing brace. Safe here: the function body
  // contains no braces inside strings, regexes, or comments.
  const bodyOpen = workerSource.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = bodyOpen; i < workerSource.length; i++) {
    const ch = workerSource[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) throw new Error('handleVisibleStartupInteraction brace match failed');
  const fnSource = workerSource.slice(start, end + 1);
  const { outputText } = ts.transpileModule(fnSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  });
  // eslint-disable-next-line no-new-func
  return new Function(`${outputText}; return handleVisibleStartupInteraction;`)() as TrustHandler;
}

describe('trust dialog Enter deferral (Codex 0.149 key-handler race)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    trustHandledValue = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks trustHandled immediately but defers Enter by 400ms', () => {
    const sendSpecialKeys = vi.fn();
    installGlobals({ sendSpecialKeys });
    const handler = extractTrustHandler();

    expect(handler('Do you trust this folder? Yes, continue')).toBe(true);
    expect(trustHandledValue, 'trustHandled is set synchronously to block re-entry').toBe(true);
    expect(sendSpecialKeys, 'Enter must not fire while the key handler is still warming up').not.toHaveBeenCalled();

    vi.advanceTimersByTime(399);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sendSpecialKeys).toHaveBeenCalledTimes(1);
    expect(sendSpecialKeys).toHaveBeenCalledWith('Enter');
  });

  it('does not re-enter when the same trust text arrives again within the window', () => {
    const sendSpecialKeys = vi.fn();
    installGlobals({ sendSpecialKeys });
    const handler = extractTrustHandler();

    handler('Yes, I trust this folder');
    expect(handler('Yes, I trust this folder'), 'repeat match must be swallowed').toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(sendSpecialKeys, 'exactly one Enter for the whole dialog').toHaveBeenCalledTimes(1);
  });

  it('falls back to backend.write("\\r") when sendSpecialKeys is unavailable', () => {
    const write = vi.fn();
    installGlobals({ write });
    const handler = extractTrustHandler();

    handler('Yes, continue');
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('\r');
  });

  it('ignores output without trust text and schedules nothing', () => {
    const sendSpecialKeys = vi.fn();
    installGlobals({ sendSpecialKeys });
    const handler = extractTrustHandler();

    expect(handler('ordinary startup output')).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('does not fire the deferred Enter after a respawn (generation fence)', () => {
    const sendSpecialKeys = vi.fn();
    installGlobals({ sendSpecialKeys });
    const handler = extractTrustHandler();

    handler('Yes, continue');
    // 400ms 窗口内发生 respawn（cliSpawnGeneration 递增 + backend 替换）
    (globalThis as Record<string, unknown>).cliSpawnGeneration = 1;
    (globalThis as Record<string, unknown>).backend = { sendSpecialKeys: vi.fn() };
    vi.advanceTimersByTime(1_000);
    expect(sendSpecialKeys, '旧 timer 不得向新会话 backend 发 Enter').not.toHaveBeenCalled();
  });

  it('keeps the 400ms deferral in the production trust branch', () => {
    // Source-level guard: the behavioral tests above extract the real
    // function, but pin the intent here so a "simplification" back to a
    // synchronous send is caught even at a glance.
    const start = workerSource.indexOf('function handleVisibleStartupInteraction(');
    const end = workerSource.indexOf('const APP_RUNNER_OSC_CLI_IDS', start);
    const helper = workerSource.slice(start, end);
    expect(helper).toMatch(/setTimeout\([^]*\},\s*400\)/);
    expect(helper.indexOf('trustHandled = true;')).toBeLessThan(helper.indexOf('setTimeout('));
  });
});
