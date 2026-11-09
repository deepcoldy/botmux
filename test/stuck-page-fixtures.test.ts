/**
 * Blocking pages captured from real CLI builds (test/fixtures/stuck-pages,
 * `tmux capture-pane -p`; `*.ansi.txt` are `capture-pane -e -p` of the same
 * screen — what the default tmux backend hands the worker). Names are
 * `<cli>-<version>-<page>.txt`; local user names and scratch paths scrubbed.
 *
 *  - Codex 0.162.0 / 0.164.0: hook review startup menu, hooks browser (L1),
 *    per-event detail (L2) for PreToolUse and SessionStart hooks, and the
 *    screens one key later (Esc / t / "Continue without trusting").
 *  - traecli 0.213.1 (traex / CoCo): the same flow in TRAE's wording, the
 *    legacy-data migration picker, the 0.213.1 sign-in page, folder trust and
 *    the plain composer.
 *  - traecli 0.213.1 / 0.214.1: the session writer-lock page (0.214.1 added a
 *    "←/esc dashboard" hint to its footer) and the composer after R.
 *
 * Every positive screen here was missed by the base classifier (footers,
 * "<Event> hooks" titles and the singular state line of these builds), so a
 * held message was typed into the menu and the submit diagnosis said
 * "unknown".
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyStuckPage, shouldHoldInputForStuckPage } from '../src/utils/stuck-detector.js';
import { diagnoseBackendSubmitFailure } from '../src/services/submit-failure-diagnosis.js';
import { detectCliStartupBlocker, screenMayShowCredential } from '../src/core/cli-startup-blocker.js';

const DIR = join(process.cwd(), 'test/fixtures/stuck-pages');
const fixture = (name: string) => readFileSync(join(DIR, name), 'utf-8');

/** Sign-in / API-key screens laid out from the shipped binaries' strings
 *  (Claude Code 2.1.318, Codex 0.164.0); links, codes and keys are fake. */
function CREDENTIAL_PAGES(): string[] {
  return readdirSync(DIR).filter(name => name.startsWith('credential-') && name.endsWith('.txt')).sort();
}

const PAGES: Record<string, ReturnType<typeof classifyStuckPage>> = {
  'codex-0.162.0-pretooluse-startup-menu.txt': 'hook review startup',
  'codex-0.162.0-pretooluse-browser-l1.txt': 'hook review level 1',
  'codex-0.162.0-pretooluse-detail-l2.txt': 'hook review level 2',
  'codex-0.162.0-sessionstart-startup-menu.txt': 'hook review startup',
  'codex-0.162.0-sessionstart-browser-l1.txt': 'hook review level 1',
  'codex-0.162.0-sessionstart-detail-l2.txt': 'hook review level 2',
  'codex-0.164.0-two-hooks-startup-menu.txt': 'hook review startup',
  'codex-0.164.0-startup-menu-after-digit2.txt': 'hook review startup',
  'codex-0.164.0-two-hooks-browser-l1.txt': 'hook review level 1',
  'codex-0.164.0-two-hooks-browser-l1-after-one-trusted.txt': 'hook review level 1',
  'codex-0.164.0-two-hooks-pretooluse-detail-l2.txt': 'hook review level 2',
  'codex-0.164.0-two-hooks-sessionstart-detail-l2.txt': 'hook review level 2',
  'codex-0.164.0-sessionstart-startup-menu.txt': 'hook review startup',
  'codex-0.164.0-sessionstart-browser-l1.txt': 'hook review level 1',
  'codex-0.164.0-sessionstart-detail-l2.txt': 'hook review level 2',
  'traex-0.213.1-hooks-startup-menu.txt': 'hook review startup',
  'traex-0.213.1-hooks-startup-menu-after-l1-esc.txt': 'hook review startup',
  'traex-0.213.1-hooks-browser-l1.txt': 'hook review level 1',
  'traex-0.213.1-hooks-browser-l1-scrolled.txt': 'hook review level 1',
  'traex-0.213.1-pretooluse-detail-l2.txt': 'hook review level 2',
  'traex-0.213.1-sessionstart-detail-l2.txt': 'hook review level 2',
  'traex-0.213.1-migration-menu.txt': 'cli migration menu',
  'traex-0.213.1-migration-menu-after-paste-enter.txt': 'cli migration menu',
  'traex-0.213.1-session-lock.txt': 'session lock',
  'traex-0.214.1-session-lock.txt': 'session lock',
};

/** Screens one key past a page, the composer, and other dialogs: no card,
 *  no hold. After `t` the detail/browser footer becomes "space/enter toggle"
 *  — Enter there would DISABLE a hook, so it must never be offered. */
const NOT_PAGES = [
  'codex-0.164.0-startup-menu-after-esc.txt',
  'codex-0.164.0-after-continue-without-trusting.txt',
  'codex-0.164.0-after-esc-close.txt',
  'codex-0.164.0-browser-l1-after-t.txt',
  'codex-0.164.0-detail-l2-after-t.txt',
  'traex-0.213.1-composer.txt',
  'traex-0.213.1-composer-after-hooks-esc.txt',
  'traex-0.213.1-composer-after-migration-skip.txt',
  'traex-0.213.1-after-hooks-close.txt',
  'traex-0.213.1-detail-l2-after-t.txt',
  'traex-0.213.1-folder-trust.txt',
  'traex-0.213.1-sign-in.txt',
  'traex-0.214.1-composer-after-lock-retry.txt',
  ...CREDENTIAL_PAGES(),
];

describe('classifyStuckPage over real captures', () => {
  it('covers every plain-text fixture in the directory exactly once', () => {
    const plain = readdirSync(DIR).filter(name => name.endsWith('.txt') && !name.endsWith('.ansi.txt')).sort();
    expect([...Object.keys(PAGES), ...NOT_PAGES].sort()).toEqual(plain);
  });

  it.each(Object.entries(PAGES))('%s → %s, and holds queued input', (name, page) => {
    const screen = fixture(name);
    expect(classifyStuckPage(screen)).toBe(page);
    expect(shouldHoldInputForStuckPage(screen)).toBe(true);
  });

  it.each(NOT_PAGES)('%s is not a stuck page', name => {
    const screen = fixture(name);
    expect(classifyStuckPage(screen)).toBeUndefined();
    expect(shouldHoldInputForStuckPage(screen)).toBe(false);
  });

  it.each(
    readdirSync(DIR).filter(name => name.endsWith('.ansi.txt')).sort(),
  )('%s (capture-pane -e) classifies like its plain capture', name => {
    const plain = name.replace(/\.ansi\.txt$/, '.txt');
    expect(classifyStuckPage(fixture(name))).toBe(classifyStuckPage(fixture(plain)));
    // The pair must be a real page or a real non-page, never an unlisted one.
    expect(plain in PAGES || NOT_PAGES.includes(plain)).toBe(true);
  });
});

describe('session writer-lock page', () => {
  const locked = () => fixture('traex-0.213.1-session-lock.txt');

  it.each(['pty', 'tmux', 'tmux-pipe'])('reports the concrete gate before recent activity on %s', backendType => {
    expect(diagnoseBackendSubmitFailure({
      backendType,
      capturedScreenText: locked(),
      cliId: 'traex',
      nowMs: 1000,
      lastActivityAtMs: 999,
    })).toEqual({ reason: 'session_locked', evidence: 'screen', matched: 'session_locked:writer_lock' });
  });

  it('does not use a ZMX history snapshot as lock evidence', () => {
    expect(diagnoseBackendSubmitFailure({
      backendType: 'zmx', capturedScreenText: locked(), cliId: 'traex', lastActivityAtMs: 0,
    })).toEqual({ reason: 'unknown', evidence: 'none' });
  });

  it('recognises ANSI and trailing blank viewport rows', () => {
    expect(classifyStuckPage(`\x1b[33m${locked()}\x1b[0m${'\n'.repeat(80)}`)).toBe('session lock');
  });

  it.each([
    (screen: string) => `${screen}\n❯ Explain this codebase\nmodel · Context 100% left\n`,
    (screen: string) => screen.split('\n').map(row => `> ${row}`).join('\n'),
    (screen: string) => screen.replace('Owner: PID 91565', 'Owner: PID unknown'),
    (screen: string) => screen.replace('Close it there and press R to continue here.', 'This example shows the session lock screen.'),
    (screen: string) => screen.replace('r retry  |  esc/ctrl+c/q exit  |  ctrl+o transcript', 'Press enter to submit'),
    (screen: string) => screen.replace('This conversation is open in another app', 'The guide says: This conversation is open in another app'),
  ])('does not offer keys for quoted, stale or incomplete lock text %#', change => {
    expect(classifyStuckPage(change(locked()))).toBeUndefined();
    expect(shouldHoldInputForStuckPage(change(locked()))).toBe(false);
  });

  it.each(['traex-0.213.1-session-lock.txt', 'traex-0.214.1-session-lock.txt'])('%s: a footer with a hint added or dropped is not the lock page', name => {
    const screen = fixture(name);
    const footer = screen.trimEnd().split('\n').at(-1)!;
    for (const changed of [`${footer}  |  enter submit`, footer.replace(/\s*\|\s*ctrl\+o transcript$/, '')]) {
      expect(changed).not.toBe(footer);
      expect(classifyStuckPage(screen.replace(footer, changed))).toBeUndefined();
    }
  });
});

describe('submit-failure diagnosis on the per-event detail page', () => {
  // L2 says "1 hook needs review before it can run." (singular); the browser
  // and startup menu say "hooks need review". All of them are a menu that
  // swallowed the submit — not "unknown".
  const hookPages = Object.entries(PAGES).filter(([, page]) => page?.startsWith('hook review')).map(([name]) => name);
  it.each(hookPages)('%s → interactive_menu:hooks_need_review', name => {
    const d = diagnoseBackendSubmitFailure({
      backendType: 'tmux',
      capturedScreenText: fixture(name),
      cliId: name.startsWith('codex') ? 'codex' : 'traex',
      lastActivityAtMs: 0,
    });
    expect(d).toMatchObject({ reason: 'interactive_menu', matched: 'interactive_menu:hooks_need_review' });
  });
});

describe('traecli 0.213.1 sign-in page is a startup blocker', () => {
  // Enter on this page starts a login (it signed the host in during capture),
  // so the first prompt must stay queued instead of being pasted + Entered.
  it.each(['traex-0.213.1-sign-in.txt', 'traex-0.213.1-sign-in.ansi.txt'])('%s → login', name => {
    expect(detectCliStartupBlocker(fixture(name))).toEqual({ kind: 'login', rule: 'traex-sign-in' });
  });

  it('still recognises the 0.211 wording', () => {
    expect(detectCliStartupBlocker([
      '  Welcome to TRAE CLI',
      '❯ 1. Sign in with a Personal Access Token',
    ].join('\n'))).toEqual({ kind: 'login', rule: 'traex-sign-in' });
  });

  it('does not treat a quoted sign-in sentence as the dialog', () => {
    expect(detectCliStartupBlocker([
      '  Welcome to TRAE CLI',
      'Tip: Sign in with email, a custom domain, or a PAT later.',
    ].join('\n'))).toBeNull();
  });
});

describe('credential screens never leave the terminal as text', () => {
  it('there are sign-in, device-code and API-key screens to check', () => {
    expect(CREDENTIAL_PAGES().length).toBeGreaterThanOrEqual(5);
  });

  it.each(CREDENTIAL_PAGES())('%s may show a credential', name => {
    expect(screenMayShowCredential(fixture(name))).toBe(true);
  });

  it.each(['traex-0.213.1-sign-in.txt', 'traex-0.213.1-sign-in.ansi.txt'])('%s (a recognised login dialog) may show a credential', name => {
    expect(screenMayShowCredential(fixture(name))).toBe(true);
  });

  // The matcher is broad on purpose, but the stuck pages themselves must keep
  // their screen tail — otherwise every card would lose the screen it is about.
  it.each([...Object.keys(PAGES), ...NOT_PAGES.filter(name => !name.startsWith('credential-') && !name.includes('sign-in'))])(
    '%s is not a credential screen',
    name => { expect(screenMayShowCredential(fixture(name))).toBe(false); },
  );

  it('flags credential-shaped values quoted on an otherwise ordinary page', () => {
    const l2 = fixture('codex-0.164.0-sessionstart-detail-l2.txt');
    for (const command of [
      'curl -H "x-api-key: 0000fake" https://example.invalid',
      'OPENAI_API_KEY=fake0000 ./notify.sh',
      'notify --token sk-FAKEfake00000000',
      'open "https://example.invalid/cb?state=FAKE0000"',
    ]) {
      expect(screenMayShowCredential(l2.replace('echo kiro-sessionstart', command)), command).toBe(true);
    }
  });
});
