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
