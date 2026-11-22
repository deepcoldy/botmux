/**
 * Reporting the terminal unfocused after a turn so that Claude Code writes its
 * away summary, and reporting focus back as soon as anything else happens.
 * The terminal is a fake that records the bytes written to it; the clock is
 * vitest's fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AWAY_SUMMARY_BLUR_MAX_MS,
  AWAY_SUMMARY_GIVE_UP_MS,
  AWAY_SUMMARY_RETRY_MS,
  AWAY_SUMMARY_SUGGESTION_WAIT_MS,
  AwaySummaryFocus,
  awaySummaryFocusRefusal,
  FOCUS_IN,
  FOCUS_OUT,
} from '../src/services/away-summary-focus.js';
import type { PromptCacheKeepaliveRefusal } from '../src/core/unattended-input-refusal.js';

function terminal() {
  const written: string[] = [];
  const logs: string[] = [];
  const state = {
    refusal: undefined as PromptCacheKeepaliveRefusal | undefined,
    currentTurnId: 'om_turn1' as string | undefined,
    writable: true,
    watched: false,
  };
  const focus = new AwaySummaryFocus({
    now: () => Date.now(),
    setTimer: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    refusal: () => state.refusal,
    currentTurnId: () => state.currentTurnId,
    watched: () => state.watched,
    write: bytes => {
      if (!state.writable) return false;
      written.push(bytes);
      return true;
    },
    log: message => { logs.push(message); },
  });
  return { focus, written, logs, state };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-23T03:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('reporting the terminal unfocused', () => {
  it('waits for the turn\'s next-input suggestion, then reports it once', () => {
    const t = terminal();
    t.focus.request('om_turn1');
    vi.advanceTimersByTime(1_500);
    expect(t.written).toEqual([]);
    t.focus.noteSuggestion('om_turn1');
    expect(t.written).toEqual([FOCUS_OUT]);
    expect(t.focus.isBlurred).toBe(true);
    // The same request again (a replayed terminal) changes nothing.
    t.focus.request('om_turn1');
    vi.advanceTimersByTime(AWAY_SUMMARY_SUGGESTION_WAIT_MS);
    expect(t.written).toEqual([FOCUS_OUT]);
  });

  it('goes ahead once the suggestion window passes without one', () => {
    const t = terminal();
    t.focus.request('om_turn1');
    vi.advanceTimersByTime(AWAY_SUMMARY_SUGGESTION_WAIT_MS - 1);
    expect(t.written).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.written).toEqual([FOCUS_OUT]);
  });

  it('goes ahead at once when the suggestion was already reported before the request', () => {
    const t = terminal();
    t.focus.noteSuggestion('om_turn1');
    t.focus.request('om_turn1');
    expect(t.written).toEqual([FOCUS_OUT]);
  });

  it('retries while the CLI is not yet quietly idle at its input box', () => {
    const t = terminal();
    t.state.refusal = 'prompt_not_ready';
    t.focus.noteSuggestion('om_turn1');
    t.focus.request('om_turn1');
    vi.advanceTimersByTime(AWAY_SUMMARY_RETRY_MS * 5);
    expect(t.written).toEqual([]);
    t.state.refusal = undefined;
    vi.advanceTimersByTime(AWAY_SUMMARY_RETRY_MS);
    expect(t.written).toEqual([FOCUS_OUT]);
  });

  it.each(['composer_not_empty', 'action_prompt_open', 'tui_prompt_open'] as const)(
    'gives up for the turn on %s', refusal => {
      const t = terminal();
      t.state.refusal = refusal;
      t.focus.noteSuggestion('om_turn1');
      t.focus.request('om_turn1');
      t.state.refusal = undefined;
      vi.advanceTimersByTime(AWAY_SUMMARY_GIVE_UP_MS);
      expect(t.written).toEqual([]);
      expect(t.logs.join('\n')).toContain(refusal);
    },
  );

  it('waits while someone has the web terminal open', () => {
    const t = terminal();
    t.state.watched = true;
    t.focus.noteSuggestion('om_turn1');
    t.focus.request('om_turn1');
    vi.advanceTimersByTime(AWAY_SUMMARY_RETRY_MS * 10);
    expect(t.written).toEqual([]);
    t.state.watched = false;
    vi.advanceTimersByTime(AWAY_SUMMARY_RETRY_MS);
    expect(t.written).toEqual([FOCUS_OUT]);
  });

  it('gives up when the CLI never gets there in time', () => {
    const t = terminal();
    t.state.refusal = 'input_pending';
    t.focus.request('om_turn1');
    vi.advanceTimersByTime(AWAY_SUMMARY_GIVE_UP_MS + AWAY_SUMMARY_RETRY_MS);
    t.state.refusal = undefined;
    vi.advanceTimersByTime(AWAY_SUMMARY_GIVE_UP_MS);
    expect(t.written).toEqual([]);
  });

  it('drops the request when a newer turn has the CLI', () => {
    const t = terminal();
    t.focus.request('om_turn1');
    t.state.currentTurnId = 'om_turn2';
    vi.advanceTimersByTime(AWAY_SUMMARY_SUGGESTION_WAIT_MS);
    expect(t.written).toEqual([]);
  });
});

describe('reporting focus back', () => {
  function blurred() {
    const t = terminal();
    t.focus.noteSuggestion('om_turn1');
    t.focus.request('om_turn1');
    expect(t.written).toEqual([FOCUS_OUT]);
    return t;
  }

  it.each(['message', 'raw_input', 'tui_keys', 'tui_text_input', 'inject_command', 'prompt_cache_keepalive', 'term_action', 'interrupt_turn', 'rename_session'])(
    'before %s input is handled', type => {
      const t = blurred();
      t.focus.beforeDaemonMessage(type);
      expect(t.written).toEqual([FOCUS_OUT, FOCUS_IN]);
      expect(t.focus.isBlurred).toBe(false);
      // Once only.
      t.focus.beforeDaemonMessage(type);
      expect(t.written).toEqual([FOCUS_OUT, FOCUS_IN]);
    },
  );

  it('not for messages that put nothing into the CLI', () => {
    const t = blurred();
    for (const type of ['set_locale', 'refresh_screen', 'final_output_settled', 'away_summary_focus']) t.focus.beforeDaemonMessage(type);
    expect(t.written).toEqual([FOCUS_OUT]);
  });

  it('once the summary is written, or when the CLI starts a turn of its own', () => {
    const summary = blurred();
    summary.focus.observeTranscript([{ type: 'file-history-snapshot' }, { type: 'system', subtype: 'turn_duration' }]);
    expect(summary.written).toEqual([FOCUS_OUT]);
    summary.focus.observeTranscript([{ type: 'system', subtype: 'away_summary', content: 'You were …' }]);
    expect(summary.written).toEqual([FOCUS_OUT, FOCUS_IN]);

    const ownTurn = blurred();
    ownTurn.focus.observeTranscript([{ type: 'user', isMeta: true, message: { content: '<local-command-caveat>' } }, { type: 'assistant', isSidechain: true }]);
    expect(ownTurn.written).toEqual([FOCUS_OUT]);
    ownTurn.focus.observeTranscript([{ type: 'attachment', attachment: { type: 'queued_command' } }]);
    expect(ownTurn.written).toEqual([FOCUS_OUT, FOCUS_IN]);
  });

  it('when someone opens the web terminal', () => {
    const t = blurred();
    t.focus.restore('web terminal opened');
    expect(t.written).toEqual([FOCUS_OUT, FOCUS_IN]);
  });

  it('when no summary came within the window', () => {
    const t = blurred();
    vi.advanceTimersByTime(AWAY_SUMMARY_BLUR_MAX_MS - 1);
    expect(t.written).toEqual([FOCUS_OUT]);
    vi.advanceTimersByTime(1);
    expect(t.written).toEqual([FOCUS_OUT, FOCUS_IN]);
  });

  it('input before the focus-out cancels it, and writes nothing back', () => {
    const t = terminal();
    t.focus.request('om_turn1');
    t.focus.beforeDaemonMessage('message');
    vi.advanceTimersByTime(AWAY_SUMMARY_GIVE_UP_MS);
    expect(t.written).toEqual([]);
  });

  it('a replaced CLI starts over without anything written to it', () => {
    const t = blurred();
    t.focus.reset();
    t.focus.beforeDaemonMessage('message');
    vi.advanceTimersByTime(AWAY_SUMMARY_BLUR_MAX_MS);
    expect(t.written).toEqual([FOCUS_OUT]);
    expect(t.focus.isBlurred).toBe(false);
  });

  it('a failed focus-out leaves nothing to report back', () => {
    const t = terminal();
    t.state.writable = false;
    t.focus.noteSuggestion('om_turn1');
    t.focus.request('om_turn1');
    t.state.writable = true;
    t.focus.beforeDaemonMessage('message');
    expect(t.written).toEqual([]);
    expect(t.focus.isBlurred).toBe(false);
  });
});

describe('which sessions take focus reports', () => {
  const claude = { cliId: 'claude-code', cliVersion: '2.1.330 (Claude Code)', adoptMode: false, backendType: 'tmux' };

  it('Claude Code from 2.1.325 in a tmux or pty pane botmux launched', () => {
    expect(awaySummaryFocusRefusal(claude)).toBeUndefined();
    expect(awaySummaryFocusRefusal({ ...claude, backendType: 'pty' })).toBeUndefined();
    expect(awaySummaryFocusRefusal({ ...claude, cliVersion: '2.1.325 (Claude Code)' })).toBeUndefined();
  });

  it('nothing else', () => {
    for (const launch of [
      { ...claude, cliId: 'relay', cliVersion: '3.28.0 (Relay)' },
      { ...claude, cliId: 'codex', cliVersion: 'codex-cli 0.167.0' },
      { ...claude, adoptMode: true },
      { ...claude, backendType: 'zellij' },
      { ...claude, backendType: 'remote-runner' },
      { ...claude, cliVersion: '2.1.324 (Claude Code)' },
      { ...claude, cliVersion: undefined },
    ]) expect(awaySummaryFocusRefusal(launch), JSON.stringify(launch)).toBeDefined();
  });
});
