/**
 * Worker-side implementation of the effort controller's pre-submit re-check.
 *
 * The controller (src/utils/codex-effort-menu.ts) types `/model`, then awaits
 * `submitGuard()` and only then presses Enter. This file pins the worker's
 * implementation of that hook: it must drain the renderer, read the LIVE
 * viewport, and refuse when a Codex selection surface owns the keyboard — and it
 * must refuse when the screen cannot be read at all, because "no evidence" is
 * not "clear".
 *
 * Executed through test/helpers/worker-function-harness.ts: worker.ts is a
 * process script whose module body installs IPC handlers and starts services, so
 * the functions are loaded individually instead of importing the module.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { detectCodexChoiceModal } from '../src/utils/codex-choice-modal.js';
import { hasEmptyCodexComposer, parseCodexEffortMenu } from '../src/utils/codex-effort-menu.js';
import { stripAnsiScreenText } from '../src/utils/idle-detector.js';

const FULL_ACCESS_DIALOG = [
  '                         Enable full access?',
  '› Ask Codex to do anything  When Codex runs with full access, it can edit any file',
  '  GPT-6.1-Sol xhigh · /tmp/x  Exercise caution when enabling full access.',
  '',
  '› 1. Yes, continue anyway  Apply full access for this session',
  '  2. Cancel                Go back without enabling full access',
  '',
  '                          enter select · esc back',
].join('\n');

const IDLE_COMPOSER = [
  'Working',
  '› Ask Codex to do anything',
  '',
  '  GPT-6.1-Sol xhigh · /tmp/project · ← for agents',
].join('\n');

interface Harness {
  /** Screen returned by the renderer after the drain. */
  screen?: string;
  /** Whether the drain reports a settled frame. */
  settled?: boolean;
  /** Whether the capture throws. */
  throws?: boolean;
}

function loadGuard(harness: Harness) {
  const logged: string[] = [];
  const settleSpy = vi.fn(async () => harness.settled ?? true);
  const scope = {
    renderer: {
      rawSnapshot: () => {
        if (harness.throws) throw new Error('renderer exploded');
        return harness.screen ?? '';
      },
    },
    renderCols: 160,
    renderRows: 50,
    isObserveBackend: () => false,
    snapshotToText: vi.fn(async () => null),
    stripAnsiScreenText,
    detectCodexChoiceModal,
    settleCodexModelMigrationRenderer: settleSpy,
    log: (line: string) => { logged.push(line); },
  };
  // One entry point: both the controller's pre-Enter gate and the raw writer's
  // beforeSubmit hook are wired to this same function.
  const allowed = loadWorkerFunction<(...args: unknown[]) => Promise<boolean>>('codexChoiceSurfaceClear', scope);
  return { allowed, logged, settleSpy };
}

describe('effort submit re-check (worker implementation)', () => {
  it('allows the submit when the live viewport is a plain composer', async () => {
    const { allowed, settleSpy } = loadGuard({ screen: IDLE_COMPOSER });
    expect(await allowed({}, () => true)).toBe(true);
    // It must drain first: reading a pre-popup frame would defeat the guard.
    expect(settleSpy).toHaveBeenCalled();
  });

  it('withholds the submit while a centered confirmation dialog is open', async () => {
    const { allowed, logged } = loadGuard({ screen: FULL_ACCESS_DIALOG });
    expect(await allowed({}, () => true)).toBe(false);
    // Diagnostics name the surface, never its option text or the raw screen.
    expect(logged.join('\n')).toContain('choice-list');
    expect(logged.join('\n')).not.toContain('Yes, continue anyway');
  });

  it('treats an unreadable screen as not-clear', async () => {
    expect(await loadGuard({ screen: '' }).allowed({}, () => true)).toBe(false);
    expect(await loadGuard({ screen: '   \n\n' }).allowed({}, () => true)).toBe(false);
    expect(await loadGuard({ throws: true }).allowed({}, () => true)).toBe(false);
    expect(await loadGuard({ screen: IDLE_COMPOSER, settled: false }).allowed({}, () => true)).toBe(false);
  });

  it('refuses when the CLI generation moved, without reading a stale screen', async () => {
    const { allowed, settleSpy } = loadGuard({ screen: IDLE_COMPOSER });
    expect(await allowed({}, () => false)).toBe(false);
    expect(settleSpy).not.toHaveBeenCalled();
  });

  it('re-checks inside the drain: a generation change during it still refuses', async () => {
    let current = true;
    const { allowed, settleSpy } = loadGuard({ screen: IDLE_COMPOSER });
    settleSpy.mockImplementation(async () => { current = false; return true; });
    expect(await allowed({}, () => current)).toBe(false);
  });
});

describe('discarding the typed /model after a refused guard', () => {
  const COMPOSER_WITH_OUR_TEXT = [
    'Working',
    '› /model',
    '',
    '  GPT-6.1-Sol xhigh · /tmp/project · ← for agents',
  ].join('\n');

  function loadDiscard(harness: { screen?: string; throws?: boolean }) {
    const writes: string[] = [];
    const target = { write: (data: string) => { writes.push(data); return true; } };
    const scope = {
      renderer: {
        rawSnapshot: () => {
          if (harness.throws) throw new Error('renderer exploded');
          return harness.screen ?? '';
        },
      },
      renderCols: 160,
      renderRows: 50,
      isObserveBackend: () => false,
      snapshotToText: vi.fn(async () => null),
      stripAnsiScreenText,
      detectCodexChoiceModal,
      log: vi.fn(),
    };
    // The discard path shares its "may we send a clear key" predicate with the
    // recovery self-heal; load the real one.
    scope.codexEffortOrphanedLiteral = loadWorkerFunction<(s: string) => boolean>('codexEffortOrphanedLiteral', scope);
    const discard = loadWorkerFunction<(t: unknown, current: () => boolean) => Promise<void>>(
      'discardTypedCodexEffortCommand', scope,
    );
    return { discard, target, writes };
  }

  it('clears our own untouched /model literal', async () => {
    const { discard, target, writes } = loadDiscard({ screen: COMPOSER_WITH_OUR_TEXT });
    await discard(target, () => true);
    // Ctrl-U (kill_line_start) — the composer-only clear binding.
    expect(writes).toEqual(['\x15']);
  });

  it('never clears a selection surface that owns the keyboard', async () => {
    // A dialog whose composer row BELOW it happens to read exactly `/model`
    // (the resize shape): the surface check is the only thing standing between
    // this key and the popup, since the literal check would pass.
    const dialogOverOurLiteral = [
      FULL_ACCESS_DIALOG,
      '› /model',
      '',
      '  GPT-6.1-Sol xhigh · /tmp/x · ← for agents',
    ].join('\n');
    const { discard, target, writes } = loadDiscard({ screen: dialogOverOurLiteral });
    await discard(target, () => true);
    expect(writes).toEqual([]);
  });

  it('never clears somebody else’s draft', async () => {
    const { discard, target, writes } = loadDiscard({
      screen: ['Working', '› /model please also check the logs', '', '  GPT-6.1-Sol xhigh · /tmp/p'].join('\n'),
    });
    await discard(target, () => true);
    expect(writes).toEqual([]);
  });

  it('does nothing on an unreadable screen or a stale generation', async () => {
    expect((await loadDiscard({ screen: '' }).discard({ write: () => true }, () => true))).toBeUndefined();
    const { discard, target, writes } = loadDiscard({ screen: COMPOSER_WITH_OUR_TEXT });
    await discard(target, () => false);
    expect(writes).toEqual([]);
  });
});

describe('recovery hold self-heals an orphaned /model draft', () => {
  // Failure shape, reproduced against real 0.164: a popup appears inside the
  // submit beat, the guard refuses, and `discardTypedCommand` correctly declines
  // to send a clear key into the popup. The literal then stays in the composer.
  // Without this self-heal the recovery hold — which keeps queued input out until
  // the composer is provably empty — never releases: every later Lark message is
  // silently swallowed, with no visible reason, until someone clears the terminal
  // by hand. The trigger is exactly the working-session window this PR opens.
  const POPUP_WITH_OUR_LITERAL = [
    '                         Enable full access?',
    '› /model                   When Codex runs with full access…',
    '› 1. Yes, continue anyway  Apply full access for this session',
    '  2. Cancel                Go back without enabling full access',
    '',
    '                          enter select · esc back',
  ].join('\n');
  const ORPHAN = ['Working', '› /model', '', '  GPT-6.1-Sol xhigh · /tmp/p · ← for agents'].join('\n');
  const CLEAN = ['Working', '› Ask Codex to do anything', '', '  GPT-6.1-Sol xhigh · /tmp/p · ← for agents'].join('\n');

  function loadRecovery(initial: string, opts: { ignoreClear?: boolean } = {}) {
    const backend: Record<string, unknown> = { id: 'pane' };
    let screen = initial;
    const writes: string[] = [];
    backend.write = (data: string) => {
      writes.push(data);
      if (!opts.ignoreClear) screen = CLEAN;
      return true;
    };
    const scope: Record<string, unknown> = {
      backend,
      cliLifetimeNonce: 7,
      codexCliEffortRecovery: { backend, lifetime: 7 },
      codexEffortRecoveryClearAttempted: false,
      hasEmptyCodexComposer,
      parseCodexEffortMenu,
      detectCodexChoiceModal,
      stripAnsiScreenText,
      captureBackendScreen: () => screen,
      log: vi.fn(),
    };
    scope.codexEffortOrphanedLiteral = loadWorkerFunction<(s: string) => boolean>('codexEffortOrphanedLiteral', scope);
    const needs = loadWorkerFunction<(self?: unknown) => boolean>('codexCliEffortNeedsRecovery', scope);
    return { needs, writes, scope };
  }

  it('holds while the popup still owns the keyboard, and sends no key', async () => {
    const { needs, writes } = loadRecovery(POPUP_WITH_OUR_LITERAL);
    expect(needs({})).toBe(true);
    expect(needs({})).toBe(true);
    expect(writes).toEqual([]);
  });

  it('clears the orphan once the popup is gone, then releases the hold', () => {
    const { needs, writes, scope } = loadRecovery(ORPHAN);
    expect(needs({})).toBe(true);
    expect(writes).toEqual(['\x15']);
    // Next frame: composer is clean, so queued input resumes.
    expect(needs({})).toBe(false);
    expect(scope.codexCliEffortRecovery).toBeUndefined();
  });

  it('does not loop keystrokes when the CLI ignores the clear', () => {
    const { needs, writes } = loadRecovery(ORPHAN, { ignoreClear: true });
    for (let i = 0; i < 4; i++) expect(needs({})).toBe(true);
    expect(writes).toEqual(['\x15']);
  });

  it('still releases normally when the composer was already clean', () => {
    const { needs, writes } = loadRecovery(CLEAN);
    expect(needs({})).toBe(false);
    expect(writes).toEqual([]);
  });
});
