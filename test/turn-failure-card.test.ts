/**
 * Unit tests for the turn-failure notice policy and the failure card it drives.
 *
 * Two things are being pinned here, and they are different in kind:
 *
 *  1. `turn-failure-notice.ts` — the POLICY. Which terminals deserve a notice,
 *     and which of those may offer retry. This is where the user-visible
 *     tradeoffs live (don't nag on a user's own Esc; don't silently invite a
 *     re-run of work that may already have shipped a commit).
 *  2. `buildTurnFailedCard` — the RENDER. Crucially, it must never advertise an
 *     affordance the policy denied: a button that renders is a button the
 *     handler will honour, so builder and handler read the same predicate.
 *
 * Run: npx vitest run test/turn-failure-card.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildTurnFailedCard, type TurnFailedCardOpts } from '../src/im/lark/card-builder.js';
import {
  shouldNotifyTurnFailure,
  turnRetryOffer,
  mayOfferTurnRetry,
  userAbortErrorCodes,
  userAbortErrorCodePrefixes,
  supersededByNewerInputErrorCodes,
  preExecutionErrorCodes,
  buildTurnContinuePrompt,
} from '../src/services/turn-failure-notice.js';
import { globalConfigPath, invalidateGlobalConfigCache } from '../src/global-config.js';

let cardTestHome: string;
beforeEach(() => {
  cardTestHome = mkdtempSync(join(tmpdir(), 'botmux-turn-failed-'));
  vi.stubEnv('HOME', cardTestHome);
  mkdirSync(dirname(globalConfigPath()), { recursive: true });
  invalidateGlobalConfigCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  invalidateGlobalConfigCache();
  rmSync(cardTestHome, { recursive: true, force: true });
});

// ─── Policy: which failures get a notice ────────────────────────────────────

describe('shouldNotifyTurnFailure', () => {
  it('notifies on every failed terminal', () => {
    expect(shouldNotifyTurnFailure({ status: 'failed' })).toBe(true);
    expect(shouldNotifyTurnFailure({ status: 'failed', errorCode: 'pi_turn_error' })).toBe(true);
  });

  it('notifies on ambiguous terminals that the user cannot see', () => {
    // This is the gap the feature exists to close: today these post NOTHING,
    // so a dead CLI is indistinguishable from a clean finish.
    for (const errorCode of ['cli_exit', 'write_input_threw', 'adopt_write_input_threw',
      'raw_input_write_failed', 'zmx_recovery_blocked_before_write']) {
      expect(shouldNotifyTurnFailure({ status: 'ambiguous', errorCode })).toBe(true);
    }
  });

  it('stays silent on a user-initiated abort', () => {
    // The user pressed Esc (or the card's ⏹ stop button, which sends ^C). They
    // know. A card here would be pure noise — the thing this feature reduces.
    //
    // LITERALS, not `userAbortErrorCodes()`. Iterating the set under test only
    // proves its members are handled consistently; it cannot fail when a code
    // is MISSING from it. Each literal below is copied from the producing
    // adapter's own test, so this goes red if an adapter's real code stops
    // being matched. That is exactly the gap that shipped: the two `:`-suffixed
    // codes could never match an exact-match Set.
    for (const errorCode of [
      'pi_turn_aborted',                              // pi-transcript.test.ts
      'omp_turn_aborted',                             // omp-transcript.test.ts
      'rpc_turn_aborted',                             // vc-meeting-delivery-receiver.test.ts
      'codex_turn_aborted:user_interrupt',            // codex-transcript.test.ts:677
      'traex_turn_aborted:interrupted_by_user_unsafe', // traex-transcript.test.ts:430
    ]) {
      expect(shouldNotifyTurnFailure({ status: 'ambiguous', errorCode })).toBe(false);
      expect(turnRetryOffer({ status: 'ambiguous', errorCode })).toBe('none');
    }
  });

  it('matches a reason-suffixed abort on its prefix, not by startsWith', () => {
    // The reason is free text normalised into the code, so the suffix cannot be
    // enumerated — only the segment before `:` is stable. `startsWith` would be
    // too loose: it would also swallow a sibling code that merely shares the
    // stem, which is a different terminal we have no evidence about.
    for (const prefix of userAbortErrorCodePrefixes()) {
      expect(shouldNotifyTurnFailure({ status: 'ambiguous', errorCode: `${prefix}:anything` }))
        .toBe(false);
      expect(shouldNotifyTurnFailure({ status: 'ambiguous', errorCode: prefix })).toBe(false);
      // Same stem, different code ⟹ must still surface.
      expect(shouldNotifyTurnFailure({ status: 'ambiguous', errorCode: `${prefix}_by_policy` }))
        .toBe(true);
    }
  });

  it('stays silent when a newer input superseded the turn', () => {
    // grok `send_now`: the user's own follow-up aborted the previous turn and
    // the new turn owns delivery. grok-transcript.ts states the intent — this
    // maps to ambiguous "instead of a user-visible failed card".
    expect(shouldNotifyTurnFailure({ status: 'ambiguous', errorCode: 'grok_turn_cancelled' }))
      .toBe(false);
    // But Grok reuses the SAME code for other cancellations as `failed`, and a
    // failed terminal always notifies. Suppressing that would delete a real
    // alert, so the two arms must not collapse.
    expect(shouldNotifyTurnFailure({ status: 'failed', errorCode: 'grok_turn_cancelled' }))
      .toBe(true);
  });

  it('surfaces an unattributable abort rather than guessing', () => {
    // `structured_turn_aborted` is codex-bridge-queue's `??` fallback for an
    // abort carrying no code of its own ⟹ it means "cannot attribute", not
    // "the user did it". Same rule as a missing code: surface, do not swallow.
    expect(shouldNotifyTurnFailure({ status: 'ambiguous', errorCode: 'structured_turn_aborted' }))
      .toBe(true);
    // And it must not have been quietly filed under either silent bucket.
    expect(userAbortErrorCodes()).not.toContain('structured_turn_aborted');
    expect(supersededByNewerInputErrorCodes()).not.toContain('structured_turn_aborted');
  });

  it('notifies on an ambiguous terminal with no error code', () => {
    // Unattributable: cannot prove the user did it, so surface rather than swallow.
    expect(shouldNotifyTurnFailure({ status: 'ambiguous' })).toBe(true);
  });

  it('never notifies on completed or cancelled', () => {
    expect(shouldNotifyTurnFailure({ status: 'completed' })).toBe(false);
    expect(shouldNotifyTurnFailure({ status: 'cancelled' })).toBe(false);
  });
});

// ─── Policy: when may we offer retry, and how loudly ────────────────────────

describe('turnRetryOffer', () => {
  it('offers a plain retry when the input never reached the CLI', () => {
    for (const errorCode of preExecutionErrorCodes()) {
      expect(turnRetryOffer({ status: 'ambiguous', errorCode })).toBe('safe');
    }
  });

  it('THE LIE: `retryable: true` must NOT be read as "nothing executed"', () => {
    // REGRESSION for a card that told users a falsehood. `turnRetryOffer` used to
    // short-circuit `retryable === true` to `safe`, and `safe` renders
    //「这一轮的输入没有送达 CLI，没有任何已执行的操作，可以安全重试」.
    //
    // But the CLI's `retryable` answers "would retrying possibly help?", NOT "did
    // anything run?". `provider_server_error` is raised for HTTP 5xx AND for
    // `closed mid-response` / `connection reset` signatures (claude-transcript.ts),
    // i.e. the connection dying AFTER the model has been running and calling
    // tools. OBSERVED in production: a turn that had already read state and sent
    // several Lark messages died with `provider_server_error`, and the card
    // claimed nothing had executed — then offered a verbatim replay that would
    // redo those side effects.
    //
    // Only WHERE the failure happened proves nothing ran, so these must caveat.
    for (const errorCode of ['provider_server_error', 'provider_unexpected_eof']) {
      expect(turnRetryOffer({ status: 'failed', errorCode, retryable: true }), errorCode)
        .toBe('caveated');
    }
  });

  it('a pre-execution code still yields `safe` — the fix must not caveat everything', () => {
    // The counterweight: over-caveating would be its own regression (users get a
    // scary side-effect warning, and the button degrades from replay to
    // continue, for turns whose input demonstrably never reached the CLI).
    // These codes are emitted WITHOUT a `retryable` flag (see worker.ts), which
    // is why the refusal check above them cannot swallow them.
    for (const errorCode of ['write_input_threw', 'adopt_write_input_threw',
      'raw_input_write_failed', 'zmx_recovery_blocked_before_write',
      'terminal_bridge_unavailable']) {
      expect(turnRetryOffer({ status: 'failed', errorCode }), errorCode).toBe('safe');
    }
  });

  it('refuses retry when the CLI explicitly said it cannot help', () => {
    // Auth/permission/invalid-request: re-sending the same bytes cannot succeed.
    for (const errorCode of ['provider_authentication_failed', 'provider_permission_denied',
      'provider_invalid_request', 'provider_cancelled']) {
      expect(turnRetryOffer({ status: 'failed', errorCode, retryable: false })).toBe('none');
    }
  });

  it('caveats retry for a turn that may have already executed', () => {
    // cli_exit is the motivating case: the CLI may have pushed a commit before
    // dying. We still offer the button (hiding it strands the user), but the
    // card must warn AND the action switches to checkpoint-continue rather than
    // replaying the original input verbatim.
    expect(turnRetryOffer({ status: 'ambiguous', errorCode: 'cli_exit' })).toBe('caveated');
    expect(turnRetryOffer({ status: 'failed', errorCode: 'pi_turn_error' })).toBe('caveated');
  });

  it('keeps all three recovery-handoff failures caveated', () => {
    // None of these can be advertised as safe. They describe the fate of the
    // automatic CONTINUATION, but the button re-injects `lastFailedTurn`, and
    // that record is only written from `turn_terminal` — which the enqueue and
    // delivery failures never emit. So it still points at the ORIGINAL turn,
    // whose progress these codes say nothing about. The ladder only dispatches
    // a continuation for `failed && retryable === true`, so that original turn
    // is by construction a transient fault MID-WORK.
    for (const errorCode of [
      'recovery_enqueue_failed',
      'recovery_delivery_failed',
      'recovery_dispatch_interrupted',
    ]) {
      expect(turnRetryOffer({ status: 'failed', errorCode })).toBe('caveated');
    }
    // Belt and braces: none of them may sit in the pre-execution whitelist,
    // which is what made two of them `safe`.
    for (const errorCode of preExecutionErrorCodes()) {
      expect(errorCode.startsWith('recovery_')).toBe(false);
    }
  });

  it('never offers retry for something it would not even notify about', () => {
    expect(turnRetryOffer({ status: 'completed' })).toBe('none');
    // Literals again — see the abort test above for why iterating the set is
    // not enough on its own.
    for (const errorCode of [
      'pi_turn_aborted',
      'omp_turn_aborted',
      'rpc_turn_aborted',
      'codex_turn_aborted:user_interrupt',
      'traex_turn_aborted:interrupted_by_user_unsafe',
      'grok_turn_cancelled',
    ]) {
      expect(turnRetryOffer({ status: 'ambiguous', errorCode })).toBe('none');
    }
  });

  it('explicit refusal outranks the pre-execution heuristic', () => {
    // A code that looks pre-execution but whose CLI said "do not retry" must
    // not be upgraded to safe by the whitelist.
    expect(turnRetryOffer({
      status: 'failed', errorCode: 'terminal_bridge_unavailable', retryable: false,
    })).toBe('none');
  });

  it('mayOfferTurnRetry agrees with turnRetryOffer', () => {
    const cases = [
      { status: 'failed' as const, errorCode: 'cli_exit' },
      { status: 'ambiguous' as const, errorCode: 'write_input_threw' },
      { status: 'completed' as const },
      { status: 'ambiguous' as const, errorCode: 'pi_turn_aborted' },
    ];
    for (const c of cases) {
      expect(mayOfferTurnRetry(c)).toBe(turnRetryOffer(c) !== 'none');
    }
  });

  it('the policy whitelists do not overlap', () => {
    // A silenced code that also counted as pre-execution would make a silenced
    // failure sprout a retry button — contradictory. Pin the disjointness
    // across BOTH silent buckets, and across the prefix form too.
    const silent = new Set([...userAbortErrorCodes(), ...supersededByNewerInputErrorCodes()]);
    for (const code of preExecutionErrorCodes()) {
      expect(silent.has(code)).toBe(false);
      expect(userAbortErrorCodePrefixes()).not.toContain(code.split(':')[0]);
    }
    // The two silent buckets describe different causes and must stay distinct.
    for (const code of supersededByNewerInputErrorCodes()) {
      expect(userAbortErrorCodes()).not.toContain(code);
    }
  });
});

// ─── The continue prompt ────────────────────────────────────────────────────

describe('buildTurnContinuePrompt', () => {
  it('stays short: the resumed transcript already carries the task', () => {
    // The click forks with resume (`--resume <id>`), so the model can read the
    // original request and everything it did before dying. Restating those
    // would spend tokens re-teaching it what it can already see; verified in
    // practice that a bare "继续" suffices to make a CLI pick up where it
    // stopped. Keep a hard ceiling so this cannot quietly regrow.
    const p = buildTurnContinuePrompt();
    expect(p.length).toBeLessThan(80);
    expect(p.split('\n')).toHaveLength(1);
  });

  it('does not restate the original task', () => {
    // Redundant with the resumed transcript.
    expect(buildTurnContinuePrompt()).not.toContain('原任务');
  });

  it('says the previous turn was cut off', () => {
    // The transcript just ends; it cannot distinguish interrupted from
    // finished. This is one of the two things resume does NOT convey.
    expect(buildTurnContinuePrompt()).toContain('中断');
  });

  it('forbids repeating completed work', () => {
    // The other thing resume does not convey — and the entire reason this is a
    // continue rather than a verbatim replay. Worth its tokens.
    expect(buildTurnContinuePrompt()).toContain('不要重复已完成的操作');
  });

  it('tells the model to stop and ask a human when it cannot judge safely', () => {
    // The third thing resume cannot convey, and the one that bounds the risk:
    // without it the model's only options are to guess or to redo, and both can
    // duplicate an external side effect. This assertion exists because the
    // handler comment promised this clause while the prompt did not carry it —
    // a promise in a comment that nothing pins is not a behaviour.
    const p = buildTurnContinuePrompt();
    expect(p).toContain('人工决策');
    expect(p).toContain('无法安全判断');
  });

  it('does not claim a provider fault', () => {
    // The recovery ladder's prompt asserts a transient provider failure. That
    // is false for cli_exit (a dead process), and naming a wrong cause sends
    // the model looking in the wrong place.
    expect(buildTurnContinuePrompt()).not.toContain('provider');
  });

  it('carries a machine-recognisable marker', () => {
    expect(buildTurnContinuePrompt()).toContain('[BOTMUX_CONTINUE]');
  });
});

// ─── Render ─────────────────────────────────────────────────────────────────

const BASE: TurnFailedCardOpts = {
  rootId: 'om_root_fail',
  sessionId: 'sess-fail',
  cliId: 'claude-code',
  cliName: 'Claude',
  status: 'failed',
  retryOffer: 'safe',
  retryTurnId: 'turn-abc123',
};

function build(over: Partial<TurnFailedCardOpts> = {}): any {
  return JSON.parse(buildTurnFailedCard({ ...BASE, ...over }));
}

function actions(card: any): any[] {
  return card.elements.find((e: any) => e.tag === 'action')?.actions ?? [];
}

function bodyText(card: any): string {
  return card.elements.filter((e: any) => e.tag === 'markdown')
    .map((e: any) => e.content).join('\n');
}

describe('buildTurnFailedCard', () => {
  it('renders a retry button pinned to the failing turn', () => {
    const btn = actions(build()).find((a: any) => a.value?.action === 'retry_turn');
    expect(btn).toBeTruthy();
    // The turnId pin IS the one-shot credential: without it a stale card could
    // resubmit a turn the session has long moved past.
    expect(btn.value.turn_id).toBe('turn-abc123');
    expect(btn.value.session_id).toBe('sess-fail');
    expect(btn.value.root_id).toBe('om_root_fail');
  });

  it('omits the retry button when the policy denied retry', () => {
    const card = build({ retryOffer: 'none' });
    expect(actions(card).find((a: any) => a.value?.action === 'retry_turn')).toBeUndefined();
    expect(bodyText(card)).toContain('无法成功');
  });

  it('omits the retry button when there is no input to re-send', () => {
    // buildFailedTurnRecord returns undefined for a turn that died before its
    // prompt was wrapped — a button would 100% fail on click.
    const card = build({ retryTurnId: undefined });
    expect(actions(card).find((a: any) => a.value?.action === 'retry_turn')).toBeUndefined();
    expect(bodyText(card)).toContain('没有可重发的输入');
  });

  it('warns about duplicate side effects when the retry is caveated', () => {
    const card = build({ retryOffer: 'caveated', errorCode: 'cli_exit' });
    const btn = actions(card).find((a: any) => a.value?.action === 'retry_turn');
    expect(btn).toBeTruthy();
    // A possibly-destructive action must not be the visual default.
    expect(btn.type).toBe('default');
    expect(bodyText(card)).toContain('可能已经执行了一部分');
  });

  it('labels and tags the caveated button as continue, not retry', () => {
    // The button must promise what the handler will actually do: inspect state
    // and resume, NOT replay the original prompt verbatim.
    const btn = actions(build({ retryOffer: 'caveated' }))
      .find((a: any) => a.value?.action === 'retry_turn');
    expect(btn.value.mode).toBe('continue');
    expect(btn.text.content).toContain('继续');
    expect(btn.text.content).not.toContain('重试');
  });

  it('labels and tags the safe button as a resend', () => {
    const btn = actions(build({ retryOffer: 'safe' }))
      .find((a: any) => a.value?.action === 'retry_turn');
    expect(btn.value.mode).toBe('resend');
    expect(btn.text.content).toContain('重试');
  });

  it('does not promise a verbatim replay in the caveated body text', () => {
    // Earlier wording said retry "re-sends the original task verbatim"; that
    // became false once caveated switched to checkpoint-continue semantics.
    expect(bodyText(build({ retryOffer: 'caveated' }))).not.toContain('原样重发');
  });

  it('makes a provably-safe retry the primary action', () => {
    const btn = actions(build({ retryOffer: 'safe' }))
      .find((a: any) => a.value?.action === 'retry_turn');
    expect(btn.type).toBe('primary');
    expect(bodyText(build({ retryOffer: 'safe' }))).toContain('可以安全重试');
  });

  it('shows the raw error code', () => {
    // ordinary_recovery_non_retryable is an unconditional fallback branch, so a
    // daemon-restart reconciliation renders as "cannot retry safely" too. The
    // code is the only thing that distinguishes them — it must be visible.
    expect(bodyText(build({ errorCode: 'recovery_dispatch_interrupted' })))
      .toContain('recovery_dispatch_interrupted');
  });

  it('falls back to the status when no error code exists', () => {
    expect(bodyText(build({ errorCode: undefined, status: 'ambiguous' })))
      .toContain('ambiguous');
  });

  it('mentions the human in the markdown body, not the plain_text title', () => {
    const card = build({ mentionOpenId: 'ou_human' });
    // plainTitle() strips <at> markup, so a mention in the header is a no-op.
    expect(JSON.stringify(card.header)).not.toContain('ou_human');
    expect(bodyText(card)).toContain('<at id=ou_human></at>');
  });

  it('omits the mention entirely when there is nobody safe to mention', () => {
    expect(bodyText(build({ mentionOpenId: undefined }))).not.toContain('<at');
  });

  it('escapes a task string so it cannot forge a mention', () => {
    const card = build({ task: '<at id=ou_victim></at> pwned', mentionOpenId: undefined });
    expect(bodyText(card)).not.toContain('<at id=ou_victim></at>');
  });

  it('escapes the error code and reason too', () => {
    const card = build({ errorCode: '<at id=ou_x></at>', reason: '<at id=ou_y></at>' });
    const body = bodyText(card);
    expect(body).not.toContain('<at id=ou_x></at>');
    expect(body).not.toContain('<at id=ou_y></at>');
  });

  it('keeps underscores in an error code readable', () => {
    // Error codes are closed-set constants and almost all contain underscores.
    // Markdown-escaping them surfaced visible backslashes ("recovery\_dispatch\_…"),
    // which is why they render as inline code instead. Assert the raw code is
    // present verbatim — a regression to escapeMd() would break this.
    const body = bodyText(build({ errorCode: 'recovery_dispatch_interrupted' }));
    expect(body).toContain('recovery_dispatch_interrupted');
    expect(body).not.toContain('\\_');
  });

  it('strips mention markup from a CLI name in the header', () => {
    const card = build({ cliName: '<at id=ou_z></at>Claude' });
    expect(JSON.stringify(card.header)).not.toContain('ou_z');
  });

  it('softens the title for an ambiguous terminal', () => {
    // "failed" would overclaim: we genuinely do not know whether it ran.
    const amb = build({ status: 'ambiguous' }).header.title.content;
    const failed = build({ status: 'failed' }).header.title.content;
    expect(amb).not.toBe(failed);
    expect(amb).toContain('异常中断');
  });

  it('reports the auto-continuation count when a recovery ladder gave up', () => {
    expect(bodyText(build({ continuations: 2 }))).toContain('2');
  });

  it('omits the continuation line when no continuations ran', () => {
    expect(bodyText(build({ continuations: 0 }))).not.toContain('已自动续跑');
    expect(bodyText(build({ continuations: undefined }))).not.toContain('已自动续跑');
  });

  it('truncates a long task instead of pasting a whole prompt into the card', () => {
    const body = bodyText(build({ task: 'x'.repeat(400) }));
    expect(body).toContain('…');
    expect(body.length).toBeLessThan(400);
  });

  it('offers the terminal button only when a URL exists', () => {
    expect(actions(build({ terminalUrl: 'https://example.com/t' })).length).toBe(2);
    expect(actions(build({ terminalUrl: undefined })).length).toBe(1);
  });

  it('uses a red header so a failure is scannable in a busy chat', () => {
    expect(build().header.template).toBe('red');
  });

  it('renders valid English too', () => {
    const card = build({ locale: 'en', retryOffer: 'caveated' });
    const body = bodyText(card);
    // A missing en key silently falls back to Chinese — catch that here.
    expect(body).toMatch(/may have partially executed/i);
    expect(card.header.title.content).toMatch(/[A-Za-z]/);
    expect(card.header.title.content).not.toMatch(/[一-龥]/);
  });
});
