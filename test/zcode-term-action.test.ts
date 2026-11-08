/**
 * The card's Stop button and `/stop` both request `ctrlc`. ZCode quits the
 * whole process on a single Ctrl+C (0.16.9), so its adapter declares
 * `interruptKey: 'esc'` and `handleTermAction` must normalise interrupt-class
 * keys to it. Without this, pressing "stop this turn" destroys the session and
 * its context — the exact failure this adapter set out to remove.
 *
 * These tests execute the REAL `handleTermAction` (and the real key writer)
 * from src/worker.ts inside a `with (state)` scope, because importing the
 * worker would start its IPC runtime.
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCriticalInterruptKey, sendCriticalControlKey } from '../src/adapters/backend/critical-control-key.js';
import { createPiAdapter } from '../src/adapters/cli/pi.js';
import { cursorStopLeftParkedFollowUp } from '../src/adapters/cli/cursor.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';

const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const start = source.indexOf('// Quick-action key → real key event for the CLI');
const end = source.indexOf('/** Deliver Ctrl+C only when the daemon', start);
if (start < 0 || end < start) throw new Error('term action helpers not found');
const slice = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function harness(
  interruptKey?: 'esc',
  backendType: 'pty' | 'tmux' = 'pty',
  adapter?: object,
  opts: { doubao?: boolean } = {},
) {
  // A PTY backend writes raw ANSI; a tmux backend goes through send-keys names.
  // Both forms must be covered: the card's Stop button takes a different path
  // per backend, and a wrong TMUX_KEY_MAP entry (esc → 'C-c') quits ZCode.
  const written: string[] = [];
  const specialKeys: string[] = [];
  const backend = backendType === 'tmux'
    ? { sendSpecialKeys: (key: string) => { specialKeys.push(key); return true; } }
    : { write: (data: string) => { written.push(data); return true; } };
  const state: Record<string, any> = {
    lastInitConfig: null,
    cliAdapter: adapter ?? (interruptKey ? { id: 'zcode', interruptKey } : { id: 'codex' }),
    backend,
    effectiveBackendType: backendType,
    isRemoteBackendType: () => false,
    nativeSessionForkPending: () => false,
    cliLifetimeNonce: 1,
    codexCliEffortOperation: undefined,
    currentBotmuxTurnId: 'om_turn',
    currentBotmuxDispatchAttempt: undefined,
    tuiPromptBlocking: false,
    log: vi.fn(),
    send: vi.fn(),
    scheduleOneShotAfterAction: vi.fn(),
    flushPending: vi.fn(),
    cliName: () => 'ZCode',
    t: (key: string) => key,
    isCriticalInterruptKey,
    sendCriticalControlKey,
    // The real retireDoubaoBridgeTurnOnInterrupt lives inside this slice; give
    // it the same queue the handler uses. Doubao-specific tests flip the
    // structuredBridgeIs predicate; other-CLI tests keep it inert.
    structuredBridgeIs: (id: string) => (opts.doubao ? id === 'doubao' : false),
    codexBridgeQueue: new CodexBridgeQueue(Date.now),
    codexBridgeIngest: vi.fn(),
    isPromptReady: false,
    // These are not quota pools; quota recovery must remain inert.
    traexQuotaPending: undefined, traexAutoModelController: null,
    emitReadyCodexTurns: vi.fn(),
    runAfterAmbiguousSubmissionWrites: async (_backend: unknown, action: () => unknown) => action(),
    screen: '',
    captureBackendScreen: () => state.screen,
    backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    isFlushing: false,
    injectionFlushing: false,
    commandLineWritesPending: 0,
    sessionRenameInFlight: () => false,
    cursorStopLeftParkedFollowUp,
  };
  const factory = new Function('state', `with (state) { ${slice}; return { handleTermAction }; }`);
  const handler = factory(state) as { handleTermAction: (key: string) => Promise<void> };
  return {
    state, written, specialKeys,
    queue: state.codexBridgeQueue as CodexBridgeQueue,
    handle: (key: string) => handler.handleTermAction(key),
  };
}

describe('handleTermAction interrupt-key normalisation', () => {
  it('sends Escape, not Ctrl+C, when ZCode is asked to stop', async () => {
    const h = harness('esc');
    await h.handle('ctrlc');
    expect(h.written).toEqual(['\x1b']);
    expect(h.state.log).toHaveBeenCalledWith(expect.stringContaining("'ctrlc' normalized to 'esc'"));
  });

  it('leaves Ctrl+C alone for adapters that do not override the key', async () => {
    const h = harness();
    await h.handle('ctrlc');
    expect(h.written).toEqual(['\x03']);
  });

  it('does not touch non-interrupt keys on ZCode', async () => {
    const h = harness('esc');
    await h.handle('enter');
    expect(h.written).toEqual(['\r']);
  });

  // The tmux backend never writes ANSI — it calls sendSpecialKeys with a
  // send-keys name. Asserted separately because a wrong entry here (esc →
  // 'C-c') is invisible to the PTY assertions above and quits ZCode outright.
  it('sends Escape as a tmux key name for ZCode', async () => {
    const h = harness('esc', 'tmux');
    await h.handle('ctrlc');
    expect(h.specialKeys).toEqual(['Escape']);
    expect(h.written).toEqual([]);
  });

  it('sends C-c as a tmux key name for adapters that do not override the key', async () => {
    const h = harness(undefined, 'tmux');
    await h.handle('ctrlc');
    expect(h.specialKeys).toEqual(['C-c']);
    expect(h.written).toEqual([]);
  });
});

// Pi stops on Escape. Its Ctrl+C only clears the editor (and a second one
// within 500ms quits Pi), so a Stop that sent it left a retrying turn running.
describe('handleTermAction for Pi', () => {
  for (const backendType of ['pty', 'tmux'] as const) {
    it(`sends Escape when Pi is asked to stop (${backendType})`, async () => {
      const h = harness(undefined, backendType, createPiAdapter('/bin/true', () => '/dev/null'));
      await h.handle('ctrlc');
      expect(backendType === 'tmux' ? h.specialKeys : h.written).toEqual([backendType === 'tmux' ? 'Escape' : '\x1b']);
    });
  }
});

// Doubao leaves no trajectory record after an explicit stop, so card ⏹ / the
// ^C quick key / `/stop` — all of which request ctrlc — must retire its
// structured-bridge mark at the shared delivery point. A bare terminal `esc`
// (card Esc quick key / physical Esc in the Web terminal) is different: in the
// TUI it often just dismisses a menu (e.g. /model), so it must NOT retire the
// still-running turn.
describe('handleTermAction doubao bridge-mark retirement', () => {
  it('retires the current turn mark after a delivered ctrlc', async () => {
    const h = harness('esc', 'pty', { id: 'doubao', interruptKey: 'esc' }, { doubao: true });
    h.queue.mark('om_turn', '正在运行的任务：只回复 X');
    await h.handle('ctrlc');
    expect(h.queue.peek()).toEqual([]);
    expect(h.state.codexBridgeIngest).toHaveBeenCalled();
  });

  it('does not retire on a bare esc key (dismissing a TUI menu is not a stop)', async () => {
    const h = harness('esc', 'pty', { id: 'doubao', interruptKey: 'esc' }, { doubao: true });
    h.queue.mark('om_turn', '正在运行的任务：只回复 X');
    await h.handle('esc');
    expect(h.queue.peek().map(t => t.turnId)).toEqual(['om_turn']);
    expect(h.state.codexBridgeIngest).not.toHaveBeenCalled();
  });

  it('does not retire anything for a non-interrupt key', async () => {
    const h = harness('esc', 'pty', { id: 'doubao', interruptKey: 'esc' }, { doubao: true });
    h.queue.mark('om_turn', '正在运行的任务：只回复 X');
    await h.handle('enter');
    expect(h.queue.peek().map(t => t.turnId)).toEqual(['om_turn']);
  });

  it('leaves other CLIs untouched (the helper gates on cliId)', async () => {
    const h = harness('esc');
    h.queue.mark('om_turn', 'zcode turn');
    await h.handle('ctrlc');
    expect(h.queue.peek().map(t => t.turnId)).toEqual(['om_turn']);
    expect(h.state.codexBridgeIngest).not.toHaveBeenCalled();
  });

  it('retires a mark that is built but whose turn has not STARTED yet (stop within the first 1s poll)', async () => {
    // flushPending builds the queue mark BEFORE writeInput, and the first
    // assignment.md section is only read on the next 1s drain. A stop pressed
    // in that sub-second window must still remove the mark, even though
    // started === false; otherwise the later prompt starts a dead open turn
    // whose next fast answer misattributes forever.
    const h = harness('esc', 'pty', { id: 'doubao', interruptKey: 'esc' }, { doubao: true });
    h.queue.mark('om_turn', '刚提交就被停止的任务：只回复 X');
    expect(h.queue.peek().map(t => [t.turnId, t.started, t.finalText ?? null]))
      .toEqual([['om_turn', false, null]]);
    await h.handle('ctrlc');
    expect(h.queue.peek()).toEqual([]);
  });

  it('does not touch a turn that already carries its final answer', async () => {
    const h = harness('esc', 'pty', { id: 'doubao', interruptKey: 'esc' }, { doubao: true });
    h.queue.mark('om_turn', '已经答完的任务');
    h.queue.ingest([{ uuid: 'u1', timestampMs: Date.now(), kind: 'user', text: '已经答完的任务' } as any]);
    h.queue.peek()[0]!.finalText = 'ANSWER';
    await h.handle('ctrlc');
    expect(h.queue.peek().map(t => t.turnId)).toEqual(['om_turn']);
  });
});

// Cursor flushes its follow-ups queue only when a turn ends naturally. After a
// stop, an IM message typed ahead during the stopped turn stays parked at
// `enter steer` (cursor-agent 2026.09.23) while botmux believes it delivered
// it. One Enter on the idle, empty composer submits exactly that item; an Enter
// while the turn still runs would steer into it, and one on a non-empty
// composer would submit something else.
describe('handleTermAction for Cursor with a parked follow-up', () => {
  // Rows of real `tmux capture-pane -e` output (box and padding runs shortened).
  // The cursor block splits the placeholder (`→ A` + `dd a follow-up`), so
  // the screen must be matched without its SGR codes.
  const panel = [
    '\u001b[0m\u001b[39m\u001b[49m \u001b[33m┌─ follow-ups ────┐',
    '\u001b[39m \u001b[33m│ \u001b[2m\u001b[39m○ Reply with exactly: PINEAPPLE    \u001b[0m\u001b[33m\u001b[49m │',
    '\u001b[39m \u001b[33m│ \u001b[2m\u001b[39menter steer · ↑ select/edit · esc cancel    \u001b[0m\u001b[33m\u001b[49m │',
    '\u001b[39m \u001b[33m└────┘',
  ].join('\n');
  const composer = '\u001b[49m \u001b[48;5;233m \u001b[2m→ \u001b[0;7m\u001b[39m\u001b[48;5;233mA\u001b[0;2m\u001b[39m\u001b[48;5;233mdd a follow-up\u001b[0m\u001b[39m\u001b[48;5;233m';
  const running = `${panel}\n${composer}    \u001b[2mctrl+c to stop\u001b[0m\u001b[39m\u001b[48;5;233m`;
  const stopped = `${panel}\n${composer}\n\u001b[49m  \u001b[2mPress Ctrl+C again to exit`;
  const cursor = { id: 'cursor' };

  afterEach(() => { vi.useRealTimers(); });

  for (const backendType of ['pty', 'tmux'] as const) {
    it(`submits the parked item once the stopped turn has ended (${backendType})`, async () => {
      vi.useFakeTimers();
      const h = harness(undefined, backendType, cursor);
      h.state.screen = running;
      await h.handle('ctrlc');
      await vi.advanceTimersByTimeAsync(1_000);
      const keys = () => (backendType === 'tmux' ? h.specialKeys : h.written);
      expect(keys()).toEqual([backendType === 'tmux' ? 'C-c' : '\x03']);
      h.state.screen = stopped;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(keys()).toEqual(backendType === 'tmux' ? ['C-c', 'Enter'] : ['\x03', '\r']);
    });
  }

  it('does not press Enter when the composer holds text', async () => {
    vi.useFakeTimers();
    const h = harness(undefined, 'tmux', cursor);
    h.state.screen = stopped.replace(composer, '\u001b[49m \u001b[48;5;233m \u001b[2m→ \u001b[0mhalf-typed reply');
    await h.handle('ctrlc');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.specialKeys).toEqual(['C-c']);
  });

  it('does not press Enter when nothing is parked', async () => {
    vi.useFakeTimers();
    const h = harness(undefined, 'tmux', cursor);
    h.state.screen = stopped.replace(panel, '');
    await h.handle('ctrlc');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.specialKeys).toEqual(['C-c']);
  });

  it('waits for an in-flight IM write before pressing Enter', async () => {
    vi.useFakeTimers();
    const h = harness(undefined, 'tmux', cursor);
    h.state.screen = stopped;
    h.state.isFlushing = true;
    await h.handle('ctrlc');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.specialKeys).toEqual(['C-c']);
    h.state.isFlushing = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.specialKeys).toEqual(['C-c', 'Enter']);
  });

  it('only an explicit stop submits it, not a bare Escape', async () => {
    vi.useFakeTimers();
    const h = harness(undefined, 'tmux', cursor);
    h.state.screen = stopped;
    await h.handle('esc');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.specialKeys).toEqual(['Escape']);
  });

  it('waits for an in-flight session rename before pressing Enter', async () => {
    vi.useFakeTimers();
    const h = harness(undefined, 'tmux', cursor);
    h.state.screen = stopped;
    let renameInFlight = true;
    h.state.sessionRenameInFlight = () => renameInFlight;
    await h.handle('ctrlc');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.specialKeys).toEqual(['C-c']);
    renameInFlight = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.specialKeys).toEqual(['C-c', 'Enter']);
  });

  // The submitter runs in a timer callback outside handleTermAction's
  // try/catch: an Orca relay rejecting Enter (adopted terminal gone) must be
  // logged and swallowed, not thrown into the worker uncaughtException exit.
  it('swallows a backend rejecting Enter instead of throwing out of the timer', async () => {
    vi.useFakeTimers();
    const h = harness(undefined, 'tmux', cursor);
    h.state.screen = stopped;
    const realSend = h.state.backend.sendSpecialKeys;
    h.state.backend.sendSpecialKeys = (key: string) => {
      if (key === 'Enter') throw new Error('Orca terminal rejected input');
      return realSend(key);
    };
    await h.handle('ctrlc');
    // A throw escaping the timer callback would make this await reject.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.specialKeys).toEqual(['C-c']);
    expect(h.state.log).toHaveBeenCalledWith(
      expect.stringContaining('submitting the parked follow-up failed'),
    );
    // The matched branch returns without rescheduling: no retry storm later.
    h.state.backend.sendSpecialKeys = realSend;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.specialKeys).toEqual(['C-c']);
  });
});
