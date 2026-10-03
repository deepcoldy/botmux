import { selectSessionBackend } from '../src/adapters/backend/session-backend-selector.js';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import { isObserveBackend } from '../src/adapters/backend/types.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aidenCodexResumeNeedsRedraw, CodexUpdateDialogGuard, codexUpdateDialogSafeKeys, codexUpdatePickerKey, dismissCodexUpdatePicker } from '../src/utils/codex-update-dialog.js';

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

describe('startup update picker recovery', () => {
  const menu = (selected: number) => `Update available!\n${selected === 1 ? '›' : ' '} 1. Update now (runs npm install)\n${selected === 2 ? '›' : ' '} 2. Skip\n  3. Skip until next version\nPress enter to continue`;

  it('submits only an observed safe selection', () => {
    expect(codexUpdatePickerKey(menu(1))).toBe('Down');
    expect(codexUpdatePickerKey(menu(2))).toBe('Enter');
    expect(codexUpdatePickerKey(menu(1).replace('Press enter to continue', ''))).toBe('wait');
    expect(codexUpdatePickerKey(menu(1).replace('›', ' '))).toBe('wait');
    expect(codexUpdatePickerKey('› Ask Codex to do anything')).toBe('gone');
  });

  it('recovers dropped navigation and submit inputs using fresh screen observations', async () => {
    let screen = menu(1);
    const keys: string[] = [];
    const pauses: number[] = [];
    let down = 0;
    let enter = 0;
    const result = await dismissCodexUpdatePicker({
      isCurrent: () => true,
      capture: () => screen,
      pause: async ms => { pauses.push(ms); },
      send: key => {
        expect(pauses.length).toBeGreaterThan(keys.length);
        keys.push(key);
        if (key === 'Down' && ++down === 2) screen = menu(2);
        if (key === 'Enter' && ++enter === 2) screen = '› Ask Codex to do anything';
      },
    });
    expect(result).toBe('closed');
    expect(keys).toEqual(['Down', 'Down', 'Enter', 'Enter']);
    expect(pauses.every(ms => ms === 400)).toBe(true);
  });

  it('does not send delayed input across a backend generation change', async () => {
    let current = true;
    const keys: string[] = [];
    const result = await dismissCodexUpdatePicker({
      isCurrent: () => current,
      capture: () => menu(1),
      pause: async () => { current = false; },
      send: key => { keys.push(key); },
    });
    expect(result).toBe('cancelled');
    expect(keys).toEqual([]);
  });

  it('stops after a transport rejection and never follows it with Enter', async () => {
    const keys: string[] = [];
    const result = await dismissCodexUpdatePicker({
      isCurrent: () => true,
      capture: () => menu(1),
      pause: async () => {},
      send: key => { keys.push(key); return false; },
    });
    expect(result).toBe('input_rejected');
    expect(keys).toEqual(['Down']);
  });

  it('bounds retries and never submits an unconfirmed selection', async () => {
    const keys: string[] = [];
    const result = await dismissCodexUpdatePicker({
      isCurrent: () => true,
      capture: () => menu(1),
      pause: async () => {},
      send: key => { keys.push(key); },
    });
    expect(result).toBe('unconfirmed');
    expect(keys).toEqual(Array(8).fill('Down'));
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

    expect(dismiss).toContain('dismissCodexUpdatePicker({');
    expect(dismiss).toContain('if (aidenCodexUpdateRecovering) return true;');
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
it.each([false, true, undefined])('counts only a recovery with accepted input (%s)', result => {
  const worker = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
  const start = worker.indexOf("      const accepted = 'sendSpecialKeys' in target", worker.indexOf('function dismissAidenCodexUpdateDialog('));
  const end = worker.indexOf('      return accepted;', start);
  const code = worker.slice(start, end).replace('(target as any)', 'target');
  const run = new Function('target', 'key', 'let delivered = false; let aidenCodexUpdateAttempts = 0; ' + code + 'return aidenCodexUpdateAttempts;');
  expect(run({ sendSpecialKeys: () => result }, 'Enter')).toBe(result === false ? 0 : 1);
});

describe('Aiden resumed composer redraw', () => {
  it('requests a redraw only for an empty resumed composer with the configured runtime footer', () => {
    const screen = 'Previous answer\n\n› Ask Codex to do anything\n\n  gpt-5.6-sol high · /tmp/project · Task title\n';
    expect(aidenCodexResumeNeedsRedraw(screen)).toBe(true);
    for (const prefix of ['│ model: loading │\n', 'Resuming session...\n', 'Working (esc to interrupt)\n', 'Queued for capacity\n']) {
      expect(aidenCodexResumeNeedsRedraw(prefix + screen)).toBe(false);
    }
    expect(aidenCodexResumeNeedsRedraw(screen.replace('Ask Codex to do anything', 'unsent draft'))).toBe(false);
    expect(aidenCodexResumeNeedsRedraw(screen + 'Press enter to continue')).toBe(false);
    expect(aidenCodexResumeNeedsRedraw('› Ask Codex to do anything\n  ? for shortcuts')).toBe(false);
  });
});
