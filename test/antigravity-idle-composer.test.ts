import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  createAntigravityAdapter,
  annotateAntigravityUsageLimit,
  isAntigravityIdleComposerScreen,
} from '../src/adapters/cli/antigravity.js';

// Tail captured from a live agy 1.2.13 pane after /close + resume: the turn
// was killed mid tool call (Bash git status → "Interrupted"), the TUI is parked
// at an empty composer carrying the permission-mode placeholder, and queued
// botmux input had been stranded for minutes because the transcript tail
// (USER_INPUT + PLANNER_RESPONSE w/ tool_calls, no completion record) read as
// permanently busy.
const RESUMED_IDLE_SCREEN = [
  '▀▀▀▀▀▀▀▀      Gemini 3.8 Flash (High)',
  '────────────────────────',
  '> <session_id>5d4521c3-9daa-4e8e-8bd9-b7349f205505</session_id>',
  '  <user_message>',
  '  do the thing',
  '  </user_message>',
  '▸ Thought for 5s, 446 tokens',
  '● Bash(git status) (ctrl+o to expand)',
  '  ⎿  Interrupted · What should Antigravity CLI do instead?',
  '────────────────────────────────────────────────────────────────────────',
  '> Accept-edits mode: file edits auto-approved (shift+tab to cycle)',
  '────────────────────────────────────────────────────────────────────────',
  '? for shortcuts                                          accept-edits · Gemini 3.8 Flash · high',
  '',
].join('\n');

// Same conversation once the interruption notice has scrolled away: no
// "Interrupted" row, still an empty composer at the ready footer.
const PLAIN_IDLE_SCREEN = [
  '▸ Thought for 5s, 446 tokens',
  '● Bash(git status) (ctrl+o to expand)',
  '────────────────────────────────────────────────────────────────────────',
  '>',
  '────────────────────────────────────────────────────────────────────────',
  '? for shortcuts                                          accept-edits · Gemini 3.8 Flash · high',
  '',
].join('\n');

const NATIVE_ERROR_SCREEN = [
  '⚠ Request failed. Please try again.',
  'Error ID: native-error-fixture',
  '────────────────────────',
  '>',
  '────────────────────────',
  '',
].join('\n');

const QUOTA_ERROR_SCREEN = NATIVE_ERROR_SCREEN.replace(
  'Request failed. Please try again.',
  'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 124h24m15s.',
);

describe('Antigravity idle-composer viewport classifier', () => {
  it.each([
    '> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)',
    '> Accept-edits mode: file edits auto-approved (shift+tab to cycle)',
    '> Plan mode: research & plan only (shift+tab to cycle)',
    '> Best-of-N mode: fork into parallel arms and pick a winner (shift+tab to cycle)',
  ])('recognizes a native error at the %s composer', composer => {
    const screen = NATIVE_ERROR_SCREEN.replace('\n>\n', `\n${composer}\n`);
    expect(isAntigravityIdleComposerScreen(screen)).toBe(true);
    expect(createAntigravityAdapter().readyPattern!.test(screen)).toBe(true);
  });

  it('accepts native error layouts in ANSI-colored CRLF captures', () => {
    const screen = NATIVE_ERROR_SCREEN.split('\n').map(line => `\x1b[31m${line}\x1b[0m`).join('\r\n');
    expect(isAntigravityIdleComposerScreen(screen)).toBe(true);
  });

  it('retains native quota provenance only for the latest actual quota error composer', () => {
    const state = { limited: true as const, kind: 'usage' as const, retryAtMs: 1_000, retryLabel: '1m', retryReady: false };
    expect(annotateAntigravityUsageLimit(QUOTA_ERROR_SCREEN, state).source).toBe('antigravity-error-composer');
    expect(annotateAntigravityUsageLimit(QUOTA_ERROR_SCREEN + 'esc to cancel', state)).toBe(state);
    expect(annotateAntigravityUsageLimit(QUOTA_ERROR_SCREEN + NATIVE_ERROR_SCREEN, state)).toBe(state);
    expect(annotateAntigravityUsageLimit(QUOTA_ERROR_SCREEN.replace('⚠ Individual', '  ⚠ Individual'), state)).toBe(state);
  });
  it.each([NATIVE_ERROR_SCREEN, QUOTA_ERROR_SCREEN])('recognizes a native error parked at the footerless composer', screen => {
    expect(isAntigravityIdleComposerScreen(screen)).toBe(true);
    expect(createAntigravityAdapter().readyPattern!.test(screen)).toBe(true);
  });

  it.each([
    NATIVE_ERROR_SCREEN.replace('\n>\n', '\n> drafted request\n'),
    NATIVE_ERROR_SCREEN + 'esc to cancel · running task',
    NATIVE_ERROR_SCREEN + '● Bash(next command)',
    NATIVE_ERROR_SCREEN.replace('Error ID: native-error-fixture\n', ''),
  ])('does not infer idle from an incomplete, drafted or still-running error screen (%#)', screen => {
    expect(isAntigravityIdleComposerScreen(screen)).toBe(false);
  });

  it('keeps the live-command layout working while the empty input box is visible', () => {
    const screen = '● Bash(sleep 30)\n⣻ Running command...\n────────\n>\n────────\n● command running\n────────\nesc to cancel · 1 task(s)';
    expect(isAntigravityIdleComposerScreen(screen)).toBe(false);
  });
  it('accepts a bare empty composer at the ready footer', () => {
    expect(isAntigravityIdleComposerScreen(PLAIN_IDLE_SCREEN)).toBe(true);
  });

  it('accepts the production-shaped resumed-killed-turn screen (mode placeholder composer)', () => {
    expect(isAntigravityIdleComposerScreen(RESUMED_IDLE_SCREEN)).toBe(true);
  });

  it('accepts SGR-colored, CRLF-normalized tmux captures', () => {
    const colored = RESUMED_IDLE_SCREEN
      .split('\n')
      .map(line => `\x1b[38;2;99;102;241m${line}\x1b[0m`)
      .join('\r\n');
    expect(isAntigravityIdleComposerScreen(colored)).toBe(true);
  });

  it('rejects while a generation is running (esc to cancel marker present)', () => {
    expect(isAntigravityIdleComposerScreen(
      RESUMED_IDLE_SCREEN.replace('Accept-edits mode', 'esc to cancel'),
    )).toBe(false);
  });

  it.each([
    RESUMED_IDLE_SCREEN.replace('? for shortcuts', 'Allow this command?'),
    RESUMED_IDLE_SCREEN.replace(
      /\n> Accept-edits[^\n]*\n/,
      '\n> <user_message>drafted next instruction\n',
    ),
    RESUMED_IDLE_SCREEN + 'new output after footer',
    '',
  ])('rejects missing footer, a drafted composer or trailing output (%#)', screen => {
    expect(isAntigravityIdleComposerScreen(screen)).toBe(false);
  });
});

describe('Antigravity adapter isSessionBusy screen reconciliation', () => {
  let tmpHome: string;
  let previousHome: string | undefined;
  const cliSessionId = 'a164f906-bf70-4b02-92c8-28f4dc8d7306';

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'bmx-agy-home-'));
    previousHome = process.env.HOME;
    process.env.HOME = tmpHome;
    const dir = join(tmpHome, '.gemini', 'antigravity-cli', 'brain', cliSessionId, '.system_generated', 'logs');
    mkdirSync(dir, { recursive: true });
    // Exactly the production wedge: dangling user prompt followed by a planner
    // tool call that never got a completion record (turn killed mid-flight).
    writeFileSync(join(dir, 'transcript.jsonl'), [
      JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'do work' }),
      JSON.stringify({
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"git status"' } }],
      }),
    ].join('\n') + '\n');
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  it('stays busy without an authoritative screen getter (conservative)', () => {
    const adapter = createAntigravityAdapter();
    expect(adapter.isSessionBusy!({ cliSessionId })).toBe(true);
  });

  it.each([NATIVE_ERROR_SCREEN, QUOTA_ERROR_SCREEN])('releases the stale transcript busy hold at a native error composer', screen => {
    expect(createAntigravityAdapter().isSessionBusy!({ cliSessionId, getCurrentScreen: () => screen })).toBe(false);
  });

  it('releases when the live TUI shows an empty composer at the ready footer', () => {
    const adapter = createAntigravityAdapter();
    expect(adapter.isSessionBusy!({
      cliSessionId,
      getCurrentScreen: () => RESUMED_IDLE_SCREEN,
    })).toBe(false);
  });

  it('releases when only a bare empty composer is visible (interruption notice scrolled away)', () => {
    const adapter = createAntigravityAdapter();
    expect(adapter.isSessionBusy!({
      cliSessionId,
      getCurrentScreen: () => PLAIN_IDLE_SCREEN,
    })).toBe(false);
  });

  it('stays busy when the live screen shows a running generation', () => {
    const adapter = createAntigravityAdapter();
    expect(adapter.isSessionBusy!({
      cliSessionId,
      getCurrentScreen: () => RESUMED_IDLE_SCREEN.replace('Accept-edits mode', 'esc to cancel'),
    })).toBe(true);
  });

  it('homedir() points at the sandboxed HOME so the transcript is actually read', () => {
    expect(homedir()).toBe(tmpHome);
  });
});
