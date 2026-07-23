/**
 * Unit tests for StuckDetector.
 *
 * Run: pnpm vitest run test/stuck-detector.test.ts
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyHookReviewScreen, resolveStuckWarningAction, StuckDetector, writeStuckWarningAction } from '../src/utils/stuck-detector.js';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';

const hooksOverview = readFileSync(new URL('./fixtures/codex-hooks-overview.snap', import.meta.url), 'utf8');
const preToolUseDetail = readFileSync(new URL('./fixtures/codex-pretooluse-hooks-detail.snap', import.meta.url), 'utf8');

describe('classifyHookReviewScreen', () => {
  it('recognizes the official Codex Hooks overview snapshot', () => {
    expect(classifyHookReviewScreen(hooksOverview)).toBe('hooks overview');
  });

  it('recognizes the official Hooks overview rendered at 80 columns', async () => {
    const renderer = new TerminalRenderer(80, 50);
    renderer.write(hooksOverview);
    const snapshot = await renderer.rawSnapshotAsync();
    expect(snapshot.split('\n').length).toBeGreaterThan(24);
    expect(classifyHookReviewScreen(snapshot)).toBe('hooks overview');
    renderer.dispose();
  });

  it('recognizes the official Codex PreToolUse detail snapshot', () => {
    expect(classifyHookReviewScreen(preToolUseDetail)).toBe('pretooluse hooks detail');
  });

  it('normalizes soft wraps in the active screen', () => {
    const wrapped = hooksOverview
      .replace('1 hook needs review before it can run.', '1 hook needs review before it\ncan run.')
      .replace('Before a tool executes', 'Before a tool\nexecutes');
    expect(classifyHookReviewScreen(wrapped)).toBe('hooks overview');
  });

  it('prefers an active detail modal over retained overview content', () => {
    expect(classifyHookReviewScreen(`${hooksOverview}\n${preToolUseDetail}`)).toBe('pretooluse hooks detail');
  });

  it('rejects mixed stale detail content inside an overview screen', () => {
    const mixed = hooksOverview.replace(
      '  Event                 Installed   Active      Review      Description',
      `${preToolUseDetail}\n  Event                 Installed   Active      Review      Description`,
    );
    expect(classifyHookReviewScreen(mixed)).toBeUndefined();
  });

  it('rejects a pasted full-screen transcript above an active prompt', () => {
    expect(classifyHookReviewScreen(`${hooksOverview}\n› explain this transcript`)).toBeUndefined();
  });

  it.each([
    ['ordinary chat quoting the title', 'I am investigating PreToolUse hooks today.'],
    ['pasted overview text without controls', 'Hooks\n1 hook needs review before it can run.\nPreToolUse 1 0 1 Before a tool executes'],
    ['overview controls without event review row', 'Hooks\n1 hook needs review before it can run.\nPress t to trust all; enter to review hooks; esc to close'],
    ['pasted detail text without controls', 'PreToolUse hooks\n1 hook needs review before it can run.\nEvent PreToolUse'],
    ['detail controls without event identity', 'PreToolUse hooks\n1 hook needs review before it can run.\nPress t to trust; esc to go back'],
  ])('rejects %s', (_name, snapshot) => {
    expect(classifyHookReviewScreen(snapshot)).toBeUndefined();
  });
});

describe('stuck-warning actions', () => {
  it('derives whitelisted actions from screen type and option identity', () => {
    expect(resolveStuckWarningAction('hooks overview', 0)).toEqual({ keys: ['t'], text: '信任全部 (trust all)', isFinal: true, rearmStuckDetector: false });
    expect(resolveStuckWarningAction('hooks overview', 1)).toEqual({ keys: ['Enter'], text: '逐项审核 (review hooks)', isFinal: true, rearmStuckDetector: true });
    expect(resolveStuckWarningAction('hooks overview', 2)?.keys).toEqual(['Escape']);
    expect(resolveStuckWarningAction('pretooluse hooks detail', 0)?.keys).toEqual(['t']);
    expect(resolveStuckWarningAction('pretooluse hooks detail', 1)?.keys).toEqual(['Escape']);
    expect(resolveStuckWarningAction('pretooluse hooks detail', 2)).toBeUndefined();
  });

  it('performs zero writes for forged or stale actions', async () => {
    const write = vi.fn();
    await expect(writeStuckWarningAction('hooks overview', ['x'], () => hooksOverview, write)).resolves.toBe(false);
    await expect(writeStuckWarningAction('hooks overview', ['t'], () => preToolUseDetail, write)).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('fails with zero writes when the backend changes after capture', async () => {
    const write = vi.fn();
    let current = true;
    const result = await writeStuckWarningAction(
      'hooks overview',
      ['Enter'],
      async () => { current = false; return hooksOverview; },
      write,
      () => current,
    );
    expect(result).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('treats backend delivery failure as rejected', async () => {
    await expect(writeStuckWarningAction(
      'hooks overview',
      ['t'],
      async () => hooksOverview,
      () => { throw new Error('sendSpecialKeys returned false'); },
    )).resolves.toBe(false);
  });

  it('awaits an authoritative async capture before one authorized write', async () => {
    const order: string[] = [];
    let resolveCapture!: (snapshot: string) => void;
    const capture = new Promise<string>(resolve => { resolveCapture = resolve; });
    const result = writeStuckWarningAction(
      'pretooluse hooks detail',
      ['Escape'],
      async () => { order.push('capture:start'); const snapshot = await capture; order.push('capture:resolved'); return snapshot; },
      key => { order.push(`write:${key}`); },
    );
    await Promise.resolve();
    expect(order).toEqual(['capture:start']);
    resolveCapture(preToolUseDetail);
    await expect(result).resolves.toBe(true);
    expect(order).toEqual(['capture:start', 'capture:resolved', 'write:Escape']);
  });
});

describe('StuckDetector', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function createDetector(snapshot: string, isActuallyStuck: () => boolean = () => true) {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, { isActuallyStuck, onStuck, getSnapshot: () => snapshot });
    return { detector, onStuck };
  }

  it.each([
    ['overview', hooksOverview, 'hooks overview'],
    ['detail', preToolUseDetail, 'pretooluse hooks detail'],
  ])('fires after timeout for the %s screen', (_name, snapshot, expectedType) => {
    const { detector, onStuck } = createDetector(snapshot);
    detector.arm();
    vi.advanceTimersByTime(1000);
    expect(onStuck).toHaveBeenCalledTimes(1);
    expect(onStuck.mock.calls[0][0]).toBeGreaterThanOrEqual(1000);
    expect(onStuck.mock.calls[0][1]).toBe(expectedType);
    detector.dispose();
  });

  it('does not fire when isActuallyStuck returns false', () => {
    const { detector, onStuck } = createDetector(hooksOverview, () => false);
    detector.arm();
    vi.advanceTimersByTime(1000);
    expect(onStuck).not.toHaveBeenCalled();
    detector.dispose();
  });

  it('re-arms when isActuallyStuck returns false', () => {
    let stuck = false;
    const { detector, onStuck } = createDetector(hooksOverview, () => stuck);
    detector.arm();
    vi.advanceTimersByTime(1000);
    expect(onStuck).not.toHaveBeenCalled();
    stuck = true;
    vi.advanceTimersByTime(1000);
    expect(onStuck).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('silently re-arms when the snapshot is not a hook-review screen', () => {
    const { detector, onStuck } = createDetector('Proceed? [Y/n]\nPress space or enter to toggle');
    detector.arm();
    vi.advanceTimersByTime(2000);
    expect(onStuck).not.toHaveBeenCalled();
    detector.dispose();
  });

  it('disarm cancels the pending timer', () => {
    const { detector, onStuck } = createDetector(hooksOverview);
    detector.arm();
    detector.disarm();
    vi.advanceTimersByTime(2000);
    expect(onStuck).not.toHaveBeenCalled();
    detector.dispose();
  });

  it('arm starts a fresh window that can fire again', () => {
    const { detector, onStuck } = createDetector(hooksOverview);
    detector.arm();
    vi.advanceTimersByTime(1000);
    detector.arm();
    vi.advanceTimersByTime(1000);
    expect(onStuck).toHaveBeenCalledTimes(2);
    detector.dispose();
  });

  it('dispose prevents any further firing', () => {
    const { detector, onStuck } = createDetector(hooksOverview);
    detector.arm();
    detector.dispose();
    vi.advanceTimersByTime(5000);
    expect(onStuck).not.toHaveBeenCalled();
  });

  it('does not fire twice within the same window', () => {
    const { detector, onStuck } = createDetector(hooksOverview);
    detector.arm();
    vi.advanceTimersByTime(6000);
    expect(onStuck).toHaveBeenCalledTimes(1);
    detector.dispose();
  });
});
