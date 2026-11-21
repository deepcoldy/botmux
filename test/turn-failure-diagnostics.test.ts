/**
 * A failed turn's raw error and screen tail (services/turn-failure-diagnostics):
 * no credential reaches the draft's failure panel or its draft.json in the
 * shapes a terminal leaves one — wrapped onto an indented row, inside a TUI
 * box, a quoted value with blanks, a full-width colon, a command-line flag;
 * a whole-session screen (riff/mojo's output stream, zmx's history, a remote
 * runner's snapshot) is read from its end only; and masking takes linear
 * time on regex-hostile text.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProductionDraftClarifier } from '../src/core/workflow-draft-daemon.js';
import { draftFailureOf } from '../src/dashboard/web/workflow-draft-model.js';
import { resolveAsyncTriggerState } from '../src/services/async-trigger-state.js';
import {
  TURN_FAILURE_SCAN_MAX_CHARS,
  TURN_FAILURE_SCREEN_MAX_LINES,
  turnFailureDiagnostics,
  turnFailureErrorDetail,
  turnFailureScreenTail,
} from '../src/services/turn-failure-diagnostics.js';
import { maskFailureText } from '../src/workflows/v3/draft-failure.js';
import { PATHOLOGICAL_BOUND_MS, PATHOLOGICAL_TEXTS, bestOfTwoMs } from './helpers/pathological-text.js';
import { PROVIDER_ERROR_TEXTS } from './helpers/provider-error-texts.js';
import { makeService, OWNER } from './helpers/workflow-draft-fakes.js';

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'botmux-turn-failure-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

/** The provider's text (and a screen showing it) from the worker's failed
 *  terminal to the draft: every hop the two fields take. */
async function toTheDraft(raw: string) {
  // The worker masks both before the IPC (emitTurnTerminal) …
  const sent = JSON.parse(JSON.stringify(turnFailureDiagnostics({ errorDetail: raw, screen: raw })));
  // … the daemon masks them again into the in-memory async result (worker-pool) …
  const kept = turnFailureDiagnostics({ errorDetail: sent.errorDetail, screen: sent.screenTail });
  // … the draft's in-process lookup reads them …
  const lookup = resolveAsyncTriggerState({
    sessionId: 'sid', liveActive: true, chatId: 'headless_x', memTriggerId: 'trg', includeFailureDiagnostics: true,
    memResult: {
      status: 'failed', failedAt: 1, errorCode: 'trigger_failed', terminalErrorCode: 'provider_server_error',
      terminalErrorDetail: kept.errorDetail, terminalScreenTail: kept.screenTail,
    },
  });
  const clarifier = createProductionDraftClarifier({
    activeSessions: () => new Map(),
    createHeadlessSession: async () => ({ ok: false, error: 'unused' }),
    triggerSessionTurn: async () => ({ ok: false }),
    lookupTriggerResult: () => lookup,
    sessionStatus: () => 'active',
    suspendWorker: () => true,
    isSuspendable: () => false,
    canRetireWorker: () => false,
    killWorker: () => {},
    lifecycleInFlight: () => false,
    closeSession: async () => ({ ok: true }),
    deleteHeadlessRecord: () => {},
  });
  // … and the draft records the failure, shown on the page.
  const h = makeService(base);
  const { runId } = await h.service.create(OWNER, { goal: 'g' });
  h.clarify.settle(clarifier.result('sid', 'trg'));
  const failure = draftFailureOf(await h.service.view(runId));
  return { sent, lookup, failure, disk: readFileSync(join(base, runId, 'draft.json'), 'utf8') };
}

describe('a credential in a failed turn\'s text reaches neither the page nor draft.json', () => {
  it.each([
    ['wrapped onto an indented row that closes a paren',
      'ANTHROPIC_API_KEY=ABCDEFGHIJKLMNOPQRSTUVWXYZ012345\n  QWERTYUIOPASDFGHJKLZXCVBNM0123)',
      ['ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', 'QWERTYUIOPASDFGHJKLZXCVBNM0123'], ['ANTHROPIC_API_KEY=']],
    ['wrapped inside a TUI box',
      '│ > token=ABCDEFGHIJKLMNOPQRSTUV │\n│ ZXCVBNMASDFGHJKL98765          │',
      ['ABCDEFGHIJKLMNOPQRSTUV', 'ZXCVBNMASDFGHJKL98765'], ['token=']],
    ['a quoted value with blanks', '{"password": "correct horse battery staple"}',
      ['correct', 'horse battery staple'], ['"password"']],
    ['a full-width colon', 'App Secret：a1b2c3d4e5f6g7h8i9j0', ['a1b2c3d4e5f6g7h8i9j0'], ['App Secret：']],
    ['a command-line flag', 'run --app-secret f00dfacecafebabe1234 --verbose',
      ['f00dfacecafebabe1234'], ['--app-secret', '--verbose']],
  ])('%s', async (_name, raw, secrets, context) => {
    const { sent, lookup, failure, disk } = await toTheDraft(`API Error: 403 Access denied for model x\n${raw}`);
    for (const [hop, value] of Object.entries({ ipc: JSON.stringify(sent), lookup: JSON.stringify(lookup), page: JSON.stringify(failure), disk })) {
      for (const secret of secrets) expect({ hop, leaked: value.includes(secret) }).toEqual({ hop, leaked: false });
    }
    // Masked, not dropped: the reason and the credential's label are shown.
    for (const shown of [failure!.detail!, failure!.terminalTail!]) {
      expect(shown).toContain('Access denied for model x');
      for (const label of context) expect(shown).toContain(label);
    }
  });
});

describe('a provider\'s error reaches the page in its own words', () => {
  // The reason is what the panel is for: the worker's and the daemon's
  // masking, the draft's own and every clip leave it exactly as written —
  // the 403's "Access denied for model model_hub/es1_orange_o50" included.
  it.each(PROVIDER_ERROR_TEXTS)('%s', async (_name, text) => {
    const { failure, disk } = await toTheDraft(text);
    expect(failure).toMatchObject({ detail: text, terminalTail: text });
    expect(JSON.parse(disk).failure).toMatchObject({ detail: text, terminalTail: text });
  });
});

describe('a whole-session screen is read from its end', () => {
  /** The rows on screen when the turn failed: more than the tail keeps. */
  const lastScreen = [
    ...Array.from({ length: TURN_FAILURE_SCREEN_MAX_LINES + 20 }, (_, i) => `\x1b[32m●\x1b[0m step ${i}: ok`),
    '  ⎿  API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    '❯ ',
  ].join('\r\n');
  /** A session's output: `bytes` of earlier rows, then the last screen. */
  function session(bytes: number, unit = '\x1b[36m● \x1b[0mRead(src/a.ts) ⎿ Read 200 lines; token=AAAAAAAAAAAAAAAA\r\n'): string {
    return unit.repeat(Math.ceil(bytes / unit.length)) + lastScreen;
  }
  const MB = 1024 * 1024;

  it('the tail is the last screen\'s, however long the session ran', () => {
    const expected = turnFailureScreenTail(lastScreen);
    expect(expected).toContain('Overloaded');
    for (const bytes of [5 * MB, 20 * MB]) expect(turnFailureScreenTail(session(bytes))).toBe(expected);
  });

  it('in bounded time, however long the session ran', () => {
    for (const bytes of [5 * MB, 20 * MB]) {
      const screen = session(bytes);
      expect(bestOfTwoMs(() => turnFailureScreenTail(screen))).toBeLessThan(PATHOLOGICAL_BOUND_MS);
    }
    // Earlier output that is hostile to the masking rules, too.
    for (const unit of ['token-', '?', 'password: "a', '│ ', '\x1b[38;2;1;2;3mX']) {
      const screen = session(6 * MB, unit);
      expect(bestOfTwoMs(() => turnFailureScreenTail(screen))).toBeLessThan(PATHOLOGICAL_BOUND_MS);
    }
  });

  it('a value wrapped across the first kept row is masked: its label, above the kept rows, is still read', () => {
    const rows = [
      // Split so a secret scanner never reads the fixture as a live Stripe key.
      'export ANTHROPIC_API_KEY=sk_live' + '_FIRSTPARTFIRSTPARTFIRSTPART',
      'SECONDPARTSECONDPARTSECONDPART',
      'THIRDPARTTHIRDPART',
      ...Array.from({ length: TURN_FAILURE_SCREEN_MAX_LINES - 2 }, (_, i) => `row ${i}`),
    ];
    const tail = turnFailureScreenTail(session(6 * MB) + '\r\n' + rows.join('\r\n'))!;
    // The label's row is cut off the tail; the rows it wrapped onto are kept.
    expect(tail).not.toContain('ANTHROPIC_API_KEY');
    expect(tail.split('\n')).toHaveLength(TURN_FAILURE_SCREEN_MAX_LINES);
    expect(tail).not.toMatch(/SECONDPART|THIRDPART/);
    expect(tail.split('\n').slice(0, 2)).toEqual(['‹hidden›', '‹hidden›']);
  });

  it('a cut window drops its partial first row: a value whose label is before the cut never shows', () => {
    // A screen dense with escapes (true-colour half blocks): its last 128 KiB
    // hold so little text that the kept rows reach back to the window's first
    // row — which the cut made start mid-value, its label left behind.
    const cell = '\x1b[38;2;100;200;250;48;2;100;200;250m▀';
    const row = `${cell.repeat(150)}\x1b[0m\n`;
    const rows = row.repeat(Math.floor((TURN_FAILURE_SCAN_MAX_CHARS - 512) / row.length));
    const secret = 'Zr5Vx2Lp9Nt6Hb4Jd7Fg1Sc0Ya';
    const keptOfSecret = 12;
    // An OSC title (stripped like any escape) sizes the rest so that the
    // window starts `keptOfSecret` characters before the secret's end.
    const pad = TURN_FAILURE_SCAN_MAX_CHARS - keptOfSecret - 1 - rows.length - 5;
    const screen = `${'x'.repeat(4096)}\nexport token=${secret}\n\x1b]0;${'t'.repeat(pad)}\x07${rows}`;
    expect(screen.slice(-TURN_FAILURE_SCAN_MAX_CHARS).startsWith(secret.slice(-keptOfSecret))).toBe(true);
    const tail = turnFailureScreenTail(screen) ?? '';
    expect(tail).toContain('▀');
    expect(tail).not.toContain(secret.slice(-keptOfSecret));
  });

  it('a cut cursor-addressed stream with no newline keeps its tail; its partial first piece is dropped', () => {
    // A raw stream of title animations (escapes, stripped whole) after the
    // secret: the visible text after the cut is short, so the cut piece would
    // land in the kept tail.
    const secret = 'Zr5Vx2Lp9Nt6Hb4Jd7Fg1Sc0Ya';
    const keptOfSecret = 12;
    const title = '\x1b]0;✳ Working\x07';
    const last = '\x1b[1;1H\x1b[2K API Error: 403 Access denied for model demo-model-x';
    const fill = TURN_FAILURE_SCAN_MAX_CHARS - keptOfSecret - last.length;
    const filler = title.repeat(Math.floor(fill / title.length)) + ' '.repeat(fill % title.length);
    const screen = `${'x'.repeat(4096)} token=${secret}${filler}${last}`;
    expect(screen.includes('\n')).toBe(false);
    expect(screen.slice(-TURN_FAILURE_SCAN_MAX_CHARS).startsWith(secret.slice(-keptOfSecret))).toBe(true);
    const tail = turnFailureScreenTail(screen) ?? '';
    expect(tail).toContain('API Error: 403 Access denied for model demo-model-x');
    expect(tail).not.toContain(secret.slice(-keptOfSecret));
  });

  it('a private key whose BEGIN row the window cut: its body rows above the END row are masked', () => {
    // An OSC title animation (escapes, stripped whole) after the key: the
    // window's first row is the BEGIN row the cut made partial, and dropped.
    const body = Array.from({ length: 25 }, (_, i) => `KEYBODY${String(i).padStart(2, '0')}${'Qz7Xk9PL2mN4wV8rT3yB6hJ5aZ'.repeat(3)}`.slice(0, 64));
    const title = '\x1b]0;✳ Working\x07';
    const end = '\n-----END RSA PRIVATE KEY-----\n';
    const last = '\n⏺ API Error: 403 Access denied for model demo-model-x';
    const fixed = body.join('\n') + end + last;
    const need = TURN_FAILURE_SCAN_MAX_CHARS - 10 - fixed.length;
    const filler = title.repeat(Math.floor(need / title.length)) + ' '.repeat(need % title.length);
    const screen = `${'$ cat key.pem\n'.repeat(2000)}-----BEGIN RSA PRIVATE KEY-----\n${body.join('\n')}${end}${filler}${last}`;
    // The window starts inside the BEGIN row (a partial row, dropped).
    const firstRow = screen.slice(-TURN_FAILURE_SCAN_MAX_CHARS).split('\n')[0]!;
    expect(firstRow.endsWith('KEY-----') && !firstRow.includes('BEGIN')).toBe(true);
    const tail = turnFailureScreenTail(screen) ?? '';
    expect(tail).toContain('API Error: 403 Access denied for model demo-model-x');
    expect(tail).toContain('-----END RSA PRIVATE KEY-----');
    expect(body.filter((row) => tail.includes(row))).toEqual([]);
  });

  it('a long error is read from its start, in bounded time; a value the read cuts is masked to the cut', () => {
    const head = 'API Error: 403 Access denied for model x; token=ABCDEFGHIJKLMNOP\n';
    const text = `${head}${'retrying in 5s\n'.repeat(1.5 * MB)}`;
    expect(turnFailureErrorDetail(text)!.startsWith('API Error: 403 Access denied for model x; token=‹hidden›\nretrying in 5s\n')).toBe(true);
    expect(bestOfTwoMs(() => turnFailureErrorDetail(text))).toBeLessThan(PATHOLOGICAL_BOUND_MS);
    const cutValue = `token=${'s'.repeat(20 * MB)}`;
    expect(turnFailureErrorDetail(cutValue)).toBe('token=‹hidden›');
  });
});

describe('masking time is linear in the text', () => {
  // Each about 50 000 characters shaped against one rule (helpers/pathological-text):
  // the masking itself, and the failure pipeline around it (the screen tail's
  // row trimming included).
  it.each(PATHOLOGICAL_TEXTS)('%s', (_name, text) => {
    expect(bestOfTwoMs(() => maskFailureText(text))).toBeLessThan(PATHOLOGICAL_BOUND_MS);
    expect(bestOfTwoMs(() => turnFailureDiagnostics({ errorDetail: text, screen: text }))).toBeLessThan(PATHOLOGICAL_BOUND_MS);
  });
});

describe('the draft clarifier asks for its session to carry failure diagnostics', () => {
  it('creates its headless session with failureDiagnostics: true (no other caller sets it)', async () => {
    const created: unknown[] = [];
    const clarifier = createProductionDraftClarifier({
      activeSessions: () => new Map(),
      createHeadlessSession: async (_active, args) => { created.push(args); return { ok: true, headlessId: 'hl_x', sessionId: 'sid_x' }; },
      triggerSessionTurn: async () => ({ ok: false }),
      lookupTriggerResult: () => ({ ok: false }),
      sessionStatus: () => 'active',
      suspendWorker: () => true,
      isSuspendable: () => false,
      canRetireWorker: () => false,
      killWorker: () => {},
      lifecycleInFlight: () => false,
      closeSession: async () => ({ ok: true }),
      deleteHeadlessRecord: () => {},
    });
    expect(await clarifier.create({ larkAppId: 'cli_main', title: '澄清：示例' })).toMatchObject({ ok: true, sessionId: 'sid_x' });
    expect(created).toEqual([{ larkAppId: 'cli_main', title: '澄清：示例', failureDiagnostics: true }]);
  });
});
