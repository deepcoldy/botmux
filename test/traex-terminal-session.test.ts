import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PtyHandle } from '../src/adapters/cli/types.js';
import { TRAEX_EMPTY_COMPOSER_HINTS, TRAEX_SPINNER_LABELS } from '../src/adapters/cli/traex-footer.js';
import { findTraexRolloutSetByPid } from '../src/services/traex-transcript.js';
import {
  refreshTraexTerminalSession, traexTerminalSessionIsBound, traexTerminalIdentityNeedsRefresh,
  traexEmptyComposer, traexStatusSessionId, bindTraexSessionFromCorrelatedInput,
  traexTerminalInputBlocked, traexTerminalIdentityGeneration,
} from '../src/services/traex-terminal-session.js';

vi.mock('../src/services/traex-transcript.js', () => ({ findTraexRolloutSetByPid: vi.fn() }));
const sid = '01a0ec3d-3751-7882-9b25-49bc90078561';
const other = '01a0ec3d-3751-7882-9b25-49bc90078562';
const idle = (body = 'latest answer', input = 'Implement {feature}') => ({
  viewport: `${body}\n❯ ${input}\n▀▀▀▀▀\n  GPT-6 · ~/work · Context 79% left\n  ? for shortcuts`,
  cursor: { x: 2, y: 1 },
});
const panel = (id = sid) => ({
  viewport: `────────────────\n >_ TRAE CLI (v0.216.0)\n\n Execution host: Local background server\n Directory: ~/work\n Session: ${id}\n Limits: data not available yet`,
  cursor: { x: 45, y: 6 },
});

function terminal() {
  let state = idle();
  let currentSid = sid;
  const sendText = vi.fn((text: string) => { state = idle('latest answer', text); });
  const sendSpecialKeys = vi.fn((key: string) => {
    state = key === 'Enter' ? panel(currentSid) : idle();
  });
  const pty: PtyHandle = { cliPid: 43212, write: vi.fn(), sendText, sendSpecialKeys, captureInputState: () => state };
  return { pty, sendText, sendSpecialKeys,
    changeState: (value: typeof state) => { state = value; },
    changeSession: (value: string) => { currentSid = value; },
  };
}

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

async function resolve<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

describe('TRAE shared-daemon terminal identity', () => {
  it('queries native status and binds only this frontend/backend generation', async () => {
    vi.useFakeTimers();
    vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    const request = refreshTraexTerminalSession(t.pty);
    expect(refreshTraexTerminalSession(t.pty)).toBe(request);
    expect(await resolve(request)).toEqual({ kind: 'terminal', sessionId: sid, inputReleased: true });
    expect(t.sendText).toHaveBeenCalledExactlyOnceWith('/status');
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter'], ['Escape']]);
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(true);
    expect(traexTerminalSessionIsBound(t.pty, other)).toBe(false);
    expect(traexTerminalIdentityNeedsRefresh(t.pty)).toBe(false);
    expect(traexTerminalSessionIsBound({ ...t.pty }, sid)).toBe(false);
    t.pty.cliPid!++;
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(false);
  });

  it('retains the embedded-process ownership path without querying or editing the terminal', async () => {
    vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set([sid]));
    const t = terminal();
    expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'legacy' });
    expect(t.sendText).not.toHaveBeenCalled();
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it.each([undefined, null])('does not probe when ownership/snapshot enumeration is unavailable (%s)', async value => {
    vi.mocked(findTraexRolloutSetByPid).mockReturnValue(value === null ? new Set() : undefined);
    const t = terminal();
    if (value === null) t.pty.captureInputState = undefined;
    expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'legacy' });
    expect(t.sendText).not.toHaveBeenCalled();
  });

  it.each(['my unsent draft', 'Implement {feature} extra', 'Ask TraeCode CLI my unsent draft'])('preserves a human draft: %s', async draft => {
    vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal(); t.changeState(idle('latest answer', draft));
    expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
    expect(t.sendText).not.toHaveBeenCalled();
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('keeps an active task untouched until its empty composer returns', async () => {
    vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal(); t.changeState({ viewport: 'Working (2s · esc to interrupt)', cursor: { x: 0, y: 0 } });
    expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
    expect(t.sendText).not.toHaveBeenCalled();
    expect(traexTerminalIdentityNeedsRefresh(t.pty)).toBe(true);
  });

  it('revalidates a changed local conversation before forwarding its final', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    await resolve(refreshTraexTerminalSession(t.pty));
    expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'terminal', sessionId: sid });
    expect(t.sendText).toHaveBeenCalledTimes(1);
    t.changeState(idle('new local turn finished')); t.changeSession(other);
    expect(traexTerminalIdentityNeedsRefresh(t.pty)).toBe(true);
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toMatchObject({ kind: 'terminal', sessionId: other });
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(false);
    expect(traexTerminalSessionIsBound(t.pty, other)).toBe(true);
  });

  it('never submits a draft added while the read-only query is waiting to send Enter', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal(); const request = refreshTraexTerminalSession(t.pty);
    t.changeState(idle('latest answer', '/status and a human draft'));
    expect(await resolve(request)).toEqual({ kind: 'unavailable' });
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('does not send Escape or bind after the worker generation is replaced', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal(); let current = true;
    const request = refreshTraexTerminalSession(t.pty, () => current);
    current = false;
    expect(await resolve(request)).toEqual({ kind: 'unavailable' });
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(false);
  });

  it('never binds after cancellation during the status-page close wait', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal(); let current = true;
    const original = t.sendSpecialKeys.getMockImplementation()!;
    t.sendSpecialKeys.mockImplementation(key => {
      original(key);
      if (key === 'Escape') setTimeout(() => { current = false; }, 10);
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty, () => current))).toEqual({ kind: 'unavailable' });
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(false);
  });

  it('refuses a multiline draft even when its cursor has moved back to the query row', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal(); const request = refreshTraexTerminalSession(t.pty);
    t.changeState({ viewport: 'latest answer\n❯ /status\n  my human draft\n▀▀▀▀▀\n  GPT-6 · Context 79% left\n  ? for shortcuts', cursor: { x: 9, y: 1 } });
    expect(await resolve(request)).toEqual({ kind: 'unavailable' });
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('does not mistake a divider or Context-like draft line for the native footer', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.changeState({ viewport: 'latest answer\n❯ Implement {feature}\n  Context 42% left\n▀▀▀▀▀\n  GPT-6 · Context 79% left\n  ? for shortcuts', cursor: { x: 2, y: 1 } });
    expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
    t.changeState(idle());
    const request = refreshTraexTerminalSession(t.pty);
    t.changeState({ viewport: 'latest answer\n❯ /status\n─────\n  human draft\n▀▀▀▀▀\n  GPT-6 · Context 79% left\n  ? for shortcuts', cursor: { x: 9, y: 1 } });
    expect(await resolve(request)).toEqual({ kind: 'unavailable' });
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('blocks concatenating a later task after an unconfirmed native query and releases only on a clean composer', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendSpecialKeys.mockImplementation(() => false as never);
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable' });
    expect(traexTerminalInputBlocked(t.pty)).toBe(true);
    t.changeState(idle());
    expect(traexTerminalInputBlocked(t.pty)).toBe(false);
    expect(traexTerminalInputBlocked({ write: vi.fn() })).toBe(false);
  });

  it('cannot mistake a historical status card or two identities for the active status panel', () => {
    const stale = { viewport: `${panel().viewport}\n❯ Implement {feature}`, cursor: { x: 2, y: 7 } };
    expect(traexStatusSessionId(stale)).toBeUndefined();
    const ambiguous = panel(); ambiguous.viewport += `\n Session: ${other}`;
    expect(traexStatusSessionId(ambiguous)).toBeUndefined();
    const busy = panel(); busy.viewport += '\n Working (1s · esc to interrupt)'; busy.cursor = { x: 0, y: 7 };
    expect(traexStatusSessionId(busy)).toBeUndefined();
    expect(traexStatusSessionId(panel())).toBe(sid);
    expect(traexEmptyComposer(idle())).toBe(true);
    expect(traexEmptyComposer({ ...idle(), cursor: { x: 4, y: 1 } })).toBe(false);
  });

  it('does not dismiss a new active task when historical status text remains during a redraw', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendSpecialKeys.mockImplementation(key => {
      const current = panel(other);
      if (key === 'Enter') {
        current.viewport += '\n Working (1s · esc to interrupt)'; current.cursor = { x: 0, y: 7 };
        t.changeState(current);
      }
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable' });
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter']]);
    expect(traexTerminalSessionIsBound(t.pty, other)).toBe(false);
  });

  it('pins an exact input receipt to its submitting backend, never a same-PID peer or successor', () => {
    const t = terminal();
    expect(bindTraexSessionFromCorrelatedInput(t.pty, 43212, sid, traexTerminalIdentityGeneration(t.pty))).toBe(true);
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(true);
    expect(traexTerminalSessionIsBound({ ...t.pty }, sid)).toBe(false);
    t.pty.cliPid = 43213;
    expect(bindTraexSessionFromCorrelatedInput(t.pty, 43212, other, traexTerminalIdentityGeneration(t.pty))).toBe(false);
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(false);
  });

  it('accepts every native empty-composer hint while preserving cursor geometry', () => {
    for (const hint of TRAEX_EMPTY_COMPOSER_HINTS) {
      expect(traexEmptyComposer(idle('latest answer', hint)), hint).toBe(true);
    }
    expect(traexEmptyComposer({ ...idle('latest answer', 'Summarize recent commits'), cursor: { x: 26, y: 1 } })).toBe(false);
  });

  it('never dismisses a status panel that overlaps any native active-turn label', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    for (const label of TRAEX_SPINNER_LABELS) {
      const t = terminal();
      t.sendSpecialKeys.mockImplementation(key => {
        if (key !== 'Enter') return;
        const current = panel(other);
        const activeLabel = label.endsWith('…') ? label : `${label}…`;
        current.viewport += `\n❖ ${activeLabel} (12s • esc to interrupt)`;
        current.cursor = { x: 0, y: 7 };
        t.changeState(current);
      });
      expect(await resolve(refreshTraexTerminalSession(t.pty)), label).toEqual({ kind: 'unavailable' });
      expect(t.sendSpecialKeys.mock.calls, label).toEqual([['Enter']]);
      expect(traexTerminalSessionIsBound(t.pty, other)).toBe(false);
    }
  });

  it('closes a recognised negative status result, releases commands, and does not reopen it on an unchanged idle screen', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendSpecialKeys.mockImplementation(key => {
      if (key === 'Enter') t.changeState({
        ...panel(sid),
        viewport: panel(sid).viewport.replace('Local background server', 'Embedded process'),
      });
      if (key === 'Escape') t.changeState(idle());
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable', inputReleased: true });
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter'], ['Escape']]);
    expect(traexTerminalInputBlocked(t.pty)).toBe(false);
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(false);
    expect(traexTerminalIdentityNeedsRefresh(t.pty)).toBe(false);
    expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
    expect(t.sendText).toHaveBeenCalledTimes(1);
  });

  it('waits for a shared-server panel painted across multiple frames before binding', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendSpecialKeys.mockImplementation(key => {
      if (key === 'Enter') {
        const complete = panel(sid);
        const partial = {
          ...complete,
          viewport: complete.viewport.replace(` Session: ${sid}\n Limits: data not available yet`, ''),
          cursor: { x: 45, y: 4 },
        };
        t.changeState(partial);
        setTimeout(() => t.changeState(complete), 100);
      }
      if (key === 'Escape') t.changeState(idle());
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'terminal', sessionId: sid, inputReleased: true });
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter'], ['Escape']]);
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(true);
  });

  it('closes a persistently incomplete local-host panel without caching it as unsupported', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendSpecialKeys.mockImplementation(key => {
      if (key === 'Enter') {
        const complete = panel(sid);
        t.changeState({
          ...complete,
          viewport: complete.viewport.replace(` Session: ${sid}\n Limits: data not available yet`, ''),
          cursor: { x: 45, y: 4 },
        });
      }
      if (key === 'Escape') t.changeState(idle());
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable', inputReleased: true });
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter'], ['Escape']]);
    expect(traexTerminalInputBlocked(t.pty)).toBe(false);
    expect(traexTerminalIdentityNeedsRefresh(t.pty)).toBe(true);
  });

  it('rejects a delayed receipt captured before a newer same-PID status identity', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    const staleGeneration = traexTerminalIdentityGeneration(t.pty);
    t.sendSpecialKeys.mockImplementation(key => {
      if (key === 'Enter') t.changeState(panel(other));
      if (key === 'Escape') t.changeState(idle());
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toMatchObject({ kind: 'terminal', sessionId: other });
    expect(bindTraexSessionFromCorrelatedInput(t.pty, 43212, sid, staleGeneration)).toBe(false);
    expect(traexTerminalSessionIsBound(t.pty, other)).toBe(true);
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(false);
  });
});
