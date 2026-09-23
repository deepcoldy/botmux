import { selectSessionBackend } from '../src/adapters/backend/session-backend-selector.js';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import { isObserveBackend } from '../src/adapters/backend/types.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexUpdateDialogGuard, codexUpdateDialogSafeKeys } from '../src/utils/codex-update-dialog.js';

describe('CodexUpdateDialogGuard', () => {
  it('detects the numbered Update now / Skip picker through ANSI', () => {
    const guard = new CodexUpdateDialogGuard();
    const menu = '\x1b[1;1H› 1. Update now\x1b[2;3H2. Skip';

    expect(guard.inspect(menu)).toBe('dismiss');
    expect(guard.inspect(menu)).toBe('suppress');
  });

  it('detects the Codex 0.154 to 0.155 three-choice picker', () => {
    const guard = new CodexUpdateDialogGuard();
    const menu = [
      '✨ Update available! 0.154.0 -> 0.155.1',
      '1. Update now (runs `npm install -g @openai/codex`)',
      '2. Skip',
      '3. Skip until next version',
      'Press enter to continue',
    ].join('\n');

    expect(guard.inspect(menu)).toBe('dismiss');
    expect(codexUpdateDialogSafeKeys(menu.replace('1. Update now', '› 1. Update now')))
      .toEqual(['Down', 'Enter']);
  });

  it.each([
    ['› 1. Update now\n  2. Skip\n  3. Skip until next version', ['Down', 'Enter']],
    ['  1. Update now\n› 2. Skip\n  3. Skip until next version', ['Enter']],
    ['  1. Update now\n  2. Skip\n› 3. Skip until next version', ['Enter']],
  ] as const)('keeps retries on a non-upgrade selection: %s', (screen, keys) => {
    expect(codexUpdateDialogSafeKeys(screen)).toEqual(keys);
  });

  it('waits for a rendered selection cursor instead of guessing', () => {
    expect(codexUpdateDialogSafeKeys('1. Update now\n2. Skip')).toBeUndefined();
  });

  it('detects the newer Remind me later wording across PTY chunks', () => {
    const guard = new CodexUpdateDialogGuard();

    expect(guard.inspect('\x1b[4;3HUpdate now (runs `npm install')).toBe('pass');
    expect(guard.inspect('\x1b[5;3HRemind me later')).toBe('dismiss');
  });

  it('does not mistake the normal composer for an update picker', () => {
    const guard = new CodexUpdateDialogGuard();

    expect(guard.inspect('\x1b[10;1H›\x1b[10;3HWrite tests for @filename')).toBe('pass');
  });

  it('can be reset for a fresh CLI spawn', () => {
    const guard = new CodexUpdateDialogGuard();
    const menu = '› 1. Update now\n  2. Skip';

    expect(guard.inspect(menu)).toBe('dismiss');
    guard.reset();
    expect(guard.inspect(menu)).toBe('dismiss');
  });
});

describe('Aiden Codex update dialog worker wiring', () => {
  const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

  it('checks the rendered screen while the first prompt is held', () => {
    const start = workerSource.indexOf('function startScreenUpdates()');
    const end = workerSource.indexOf('function stopScreenUpdates()', start);
    const screenUpdates = workerSource.slice(start, end);

    expect(screenUpdates).toContain('if (awaitingFirstPrompt)');
    expect(screenUpdates).toContain('inspectAidenCodexUpdateDialogOnScreen();');
    const s = workerSource.indexOf('function inspectAidenCodexUpdateDialogOnScreen(');
    const e = workerSource.indexOf('function handleVisibleStartupInteraction(', s);
    const code = workerSource.slice(s, e).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).toMatch(/\bcaptureBackendScreen\s*\(|\bcaptureViewport\s*(?:\?\.)?\s*\(|\bcaptureCurrentScreen\s*(?:\?\.)?\s*\(/);
  });

  it('limits automatic retries and only warns from an authoritative screen check', () => {
    const start = workerSource.indexOf('function dismissAidenCodexUpdateDialog(');
    const end = workerSource.indexOf('function inspectAidenCodexUpdateDialogOnScreen()', start);
    const dismiss = workerSource.slice(start, end);

    expect(dismiss).toContain('codexUpdateDialogSafeKeys(data)');
    expect(dismiss).toContain('AIDEN_CODEX_UPDATE_RETRY_MS');
    expect(workerSource).toContain('const AIDEN_CODEX_UPDATE_MAX_ATTEMPTS = 3;');
    expect(dismiss).toContain("source === 'screen'");
    expect(dismiss).toContain("type: 'user_notify'");
  });
});

it('uses an observer backend in the production tmux selector', () => {
  const { backend } = selectSessionBackend({ sessionId: 'abcdef1234567890', backendType: 'tmux' });
  expect(backend instanceof TmuxBackend).toBe(false);
  expect(isObserveBackend(backend)).toBe(true);
  expect('capturePaneViewport' in backend).toBe(false);
});
it.each([false, true, undefined])('does not count refused special keys (%s)', result => {
  const start = workerSourceForDelivery.indexOf('  let delivered = false;', workerSourceForDelivery.indexOf('function dismissAidenCodexUpdateDialog('));
  const end = workerSourceForDelivery.indexOf('  aidenCodexUpdateAttempts += 1;', start);
  const code = workerSourceForDelivery.slice(start, end).replace('(backend as any)', 'backend');
  const run = new Function('backend', 'keys', 'log', 'aidenCodexUpdateLastActionAt', code + 'return false;');
  expect(run({ sendSpecialKeys: () => result }, ['Enter'], () => {}, 1)).toBe(result === false);
});
const workerSourceForDelivery = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
