import { describe, it, expect } from 'vitest';
import {
  BRIDGE_NOTHING_TO_SEND_SENTINEL,
  BRIDGE_NO_REPLY_SENTINEL_LEGACY,
  buildBridgeSendMarkerContent,
  buildBridgeSendPreviewText,
  bridgePostText,
  isBridgeNothingToSendFinal,
  looksLikeLeakedToolCall,
  shouldEmitEmptyCompletedBridgeFallback,
  shouldEmitFailedBridgeFallback,
  shouldSuppressBridgeEmit,
  stripTrailingBridgeSentinelLine,
  type BridgeSendMarker,
} from '../src/services/bridge-fallback-gate.js';

const turn = (markTimeMs: number | undefined, isLocal: boolean | undefined = false) =>
  ({ markTimeMs, isLocal });

const normalise = (text: string) => text.replace(/\s+/g, ' ').trim();
const markerForContent = (sentAtMs: number, content: string): BridgeSendMarker => {
  return {
    sentAtMs,
    ...buildBridgeSendMarkerContent(content),
  } as BridgeSendMarker;
};

describe('stripTrailingBridgeSentinelLine', () => {
  it('bare sentinel strips to empty (genuine silence)', () => {
    expect(stripTrailingBridgeSentinelLine(BRIDGE_NOTHING_TO_SEND_SENTINEL)).toBe('');
    expect(stripTrailingBridgeSentinelLine(`  ${BRIDGE_NOTHING_TO_SEND_SENTINEL}\n`)).toBe('');
    // legacy token too
    expect(stripTrailingBridgeSentinelLine(BRIDGE_NO_REPLY_SENTINEL_LEGACY)).toBe('');
  });

  it('prose + trailing sentinel line strips to just the prose (the real answer)', () => {
    expect(stripTrailingBridgeSentinelLine(`Here is the answer.\n\n${BRIDGE_NOTHING_TO_SEND_SENTINEL}`))
      .toBe('Here is the answer.');
    // legacy token, single blank line before it
    expect(stripTrailingBridgeSentinelLine(`Line one\nLine two\n${BRIDGE_NO_REPLY_SENTINEL_LEGACY}`))
      .toBe('Line one\nLine two');
  });

  it('leaves finals whose last non-empty line is NOT a bare sentinel untouched', () => {
    // token inline in a sentence
    const inline = `I will stay quiet. ${BRIDGE_NOTHING_TO_SEND_SENTINEL}`;
    expect(stripTrailingBridgeSentinelLine(inline)).toBe(inline);
    // token followed by more prose (not trailing)
    const notTrailing = `${BRIDGE_NOTHING_TO_SEND_SENTINEL}\n\nActually here is more.`;
    expect(stripTrailingBridgeSentinelLine(notTrailing)).toBe(notTrailing);
    // ordinary answer, no sentinel at all
    expect(stripTrailingBridgeSentinelLine('just a normal reply')).toBe('just a normal reply');
  });

  it('preserves interior blank lines but trims those orphaned before the stripped sentinel', () => {
    expect(stripTrailingBridgeSentinelLine(`para one\n\npara two\n\n${BRIDGE_NOTHING_TO_SEND_SENTINEL}`))
      .toBe('para one\n\npara two');
  });

  it('peels a trailing RUN of consecutive sentinels (codex #791 leak edge)', () => {
    const NEW = BRIDGE_NOTHING_TO_SEND_SENTINEL;
    const OLD = BRIDGE_NO_REPLY_SENTINEL_LEGACY;
    // pure repeated token → empty (old gate suppressed the whole turn; a
    // one-line strip would have left a literal token to leak)
    expect(stripTrailingBridgeSentinelLine(`${NEW}\n${NEW}`)).toBe('');
    expect(stripTrailingBridgeSentinelLine(`${NEW}\n\n${NEW}`)).toBe('');
    // new + legacy mixed in the run → empty
    expect(stripTrailingBridgeSentinelLine(`${NEW}\n${OLD}`)).toBe('');
    expect(stripTrailingBridgeSentinelLine(`${OLD}\n\n${NEW}\n${NEW}`)).toBe('');
    // prose + repeated / mixed tokens → just the prose (all tokens peeled)
    expect(stripTrailingBridgeSentinelLine(`answer\n${NEW}\n${OLD}`)).toBe('answer');
    expect(stripTrailingBridgeSentinelLine(`answer\n\n${NEW}\n${NEW}`)).toBe('answer');
  });
});

describe('bridgePostText (adopt contract — codex #791 blocker)', () => {
  it('non-adopt strips a trailing sentinel line (posts the prose)', () => {
    expect(bridgePostText(`Here is the answer.\n\n${BRIDGE_NOTHING_TO_SEND_SENTINEL}`, false))
      .toBe('Here is the answer.');
    // bare sentinel → empty (caller skips on !adopt empty-guard)
    expect(bridgePostText(BRIDGE_NOTHING_TO_SEND_SENTINEL, false)).toBe('');
  });

  it('ADOPT returns text VERBATIM — never strips the sentinel', () => {
    // The adopted CLI is botmux-unaware; transcript drain is its only channel and
    // it may output the literal token as content. Stripping here would truncate a
    // real answer / drop a verbatim-token reply. shouldSuppressBridgeEmit(adopt)
    // already refuses to interpret the sentinel; this keeps the two consistent.
    const prose = `Here is the answer.\n\n${BRIDGE_NOTHING_TO_SEND_SENTINEL}`;
    expect(bridgePostText(prose, true)).toBe(prose);
    // a pure-token adopt final is returned as-is (NOT emptied)
    expect(bridgePostText(BRIDGE_NOTHING_TO_SEND_SENTINEL, true)).toBe(BRIDGE_NOTHING_TO_SEND_SENTINEL);
    // legacy token, verbatim under adopt too
    expect(bridgePostText(BRIDGE_NO_REPLY_SENTINEL_LEGACY, true)).toBe(BRIDGE_NO_REPLY_SENTINEL_LEGACY);
  });

  it('leaves ordinary answers untouched in both modes', () => {
    expect(bridgePostText('a normal reply', false)).toBe('a normal reply');
    expect(bridgePostText('a normal reply', true)).toBe('a normal reply');
  });
});

describe('isBridgeNothingToSendFinal', () => {
  it('true only when the final is empty after stripping a trailing sentinel', () => {
    expect(isBridgeNothingToSendFinal(BRIDGE_NOTHING_TO_SEND_SENTINEL)).toBe(true);
    expect(isBridgeNothingToSendFinal(`\n  ${BRIDGE_NO_REPLY_SENTINEL_LEGACY}\n`)).toBe(true);
    // repeated / mixed tokens with no prose is still pure silence (codex #791)
    expect(isBridgeNothingToSendFinal(`${BRIDGE_NOTHING_TO_SEND_SENTINEL}\n${BRIDGE_NOTHING_TO_SEND_SENTINEL}`)).toBe(true);
    expect(isBridgeNothingToSendFinal(`${BRIDGE_NO_REPLY_SENTINEL_LEGACY}\n\n${BRIDGE_NOTHING_TO_SEND_SENTINEL}`)).toBe(true);
  });

  it('false for prose + sentinel (there is a real answer to forward)', () => {
    expect(isBridgeNothingToSendFinal(`Here is the answer.\n\n${BRIDGE_NOTHING_TO_SEND_SENTINEL}`)).toBe(false);
  });

  it('false for finals with no trailing sentinel at all', () => {
    expect(isBridgeNothingToSendFinal('a normal reply')).toBe(false);
    expect(isBridgeNothingToSendFinal(undefined)).toBe(false);
    expect(isBridgeNothingToSendFinal('')).toBe(false);
  });
});

describe('buildBridgeSendMarkerContent', () => {
  it('keeps normalized length semantics and a newline-preserving dashboard preview', () => {
    // contentLength stays fingerprint-normalized (gate compares against
    // normalise(final).length); previewText keeps line breaks AND leading
    // indentation for display (indented code / nested markdown).
    expect(buildBridgeSendMarkerContent('  hello\n  bot  ')).toEqual({
      contentLength: normalise('  hello\n  bot  ').length,
      previewText: '  hello\n  bot',
    });
  });

  it('bounds preview storage without changing the full normalized length', () => {
    const content = ` ${'x'.repeat(5_000)} `;
    const marker = buildBridgeSendMarkerContent(content)!;
    expect(marker.contentLength).toBe(5_000);
    expect(marker.previewText).toHaveLength(4_000);
    expect(marker.previewText?.endsWith('…')).toBe(true);
  });

  it('preserves paragraph / list / code-block structure for Markdown rendering', () => {
    const reply = 'intro line\n\n- item one\n- item two\n\n```bash\nls -la\n```\n\ndone';
    const preview = buildBridgeSendPreviewText(reply)!;
    // Blank-line paragraph breaks, list rows and fenced code all survive so the
    // dashboard overlay can render them; only fingerprint length is flattened.
    expect(preview).toContain('\n\n- item one\n- item two');
    expect(preview).toContain('```bash\nls -la\n```');
    expect(preview.split('\n').length).toBe(reply.split('\n').length);
  });

  it('trims trailing line whitespace and boundary blank lines but keeps FIRST-line indentation', () => {
    // Trailing spaces before a newline go, boundary blank lines collapse, but a
    // leading indent on the FIRST line survives (indented code / nested list) —
    // a plain .trim() used to eat it. A lone newline is kept (breaks:true → <br>).
    expect(buildBridgeSendPreviewText('  spoken   \nreply  ')).toBe('  spoken\nreply');
    expect(buildBridgeSendPreviewText('    indented code\n    line two')).toBe('    indented code\n    line two');
    expect(buildBridgeSendPreviewText('\n\n  body\n')).toBe('  body');
    expect(buildBridgeSendPreviewText('a\n\n\n\nb')).toBe('a\n\nb');
  });

});

describe('shouldSuppressBridgeEmit', () => {
  it('non-adopt: exact nothing-to-send sentinel suppresses without a send marker', () => {
    expect(shouldSuppressBridgeEmit(
      { ...turn(100), finalText: `  ${BRIDGE_NOTHING_TO_SEND_SENTINEL}\n` },
      undefined,
      [],
      false,
    )).toBe(true);
  });

  it('non-adopt: the legacy no-reply token is still recognized as a pure-silence sentinel', () => {
    // Rollout / restore safety: sessions spawned before the rename still carry
    // the old token in their captured system prompt. A BARE legacy token (empty
    // after stripping) is still genuine silence → suppress, so the literal token
    // never leaks into Lark. (Prose + legacy token is covered below as the
    // ghosting/strip-and-forward case.)
    expect(shouldSuppressBridgeEmit(
      { ...turn(100), finalText: `  ${BRIDGE_NO_REPLY_SENTINEL_LEGACY}\n` },
      undefined,
      [],
      false,
    )).toBe(true);
  });

  it('non-adopt: prose then a standalone sentinel line is NOT silence (strip-and-forward)', () => {
    // Behavior change (the ghosting fix): earlier this whole turn was dropped,
    // which lost the real answer of a model that did work, forgot to `botmux
    // send`, and ended with the sentinel. Now the prose is a real answer with no
    // send marker → NOT suppressed; callers strip the sentinel line and post the
    // prose. (Bare-sentinel silence stays suppressed — see the case above.)
    expect(shouldSuppressBridgeEmit(
      { ...turn(100), finalText: `Codex acknowledged and is reviewing. Here is the summary you asked for.\n\n${BRIDGE_NOTHING_TO_SEND_SENTINEL}` },
      undefined,
      [],
      false,
    )).toBe(false);
  });

  it('non-adopt: prose + sentinel IS suppressed when the model already sent the same content in-window', () => {
    // The strip-and-forward path must still honor send markers: if the prose was
    // already delivered via `botmux send`, forwarding it again would duplicate.
    // The gate compares the SENTINEL-STRIPPED final against the marker length.
    const prose = 'Here is the full answer to your question, delivered explicitly.';
    expect(shouldSuppressBridgeEmit(
      { ...turn(100), finalText: `${prose}\n\n${BRIDGE_NOTHING_TO_SEND_SENTINEL}` },
      500,
      [{ sentAtMs: 200, ...buildBridgeSendMarkerContent(prose) }],
      false,
    )).toBe(true);
  });

  it('non-adopt: trailing sentinel + ANY in-window send suppresses long narration (real-world leak)', () => {
    // The reported bug: the model `botmux send`s a short message, then writes a
    // long block of NARRATION/thinking it deliberately keeps out of chat, and
    // ends the final with the sentinel. The narration is materially LONGER than
    // the send, so the length heuristic (markerSetCoversFinal) alone judged it a
    // new substantive answer and RE-POSTED the narration. A trailing sentinel +
    // any in-window marker now suppresses unconditionally: the sentinel is the
    // model's explicit "nothing more to send" after it already sent.
    const shortSend = 'On it.';
    const longNarration =
      "The screenshot subagent is running. I'll wait for it to save the file(s), "
      + 'then send them via botmux send --images and stop the server. No message '
      + 'needed until I have the files.';
    expect(longNarration.length).toBeGreaterThan(shortSend.length * 2); // would trip material-longer
    expect(shouldSuppressBridgeEmit(
      { ...turn(100), finalText: `${longNarration}\n\n${BRIDGE_NOTHING_TO_SEND_SENTINEL}` },
      500,
      [{ sentAtMs: 200, ...buildBridgeSendMarkerContent(shortSend) }],
      false,
    )).toBe(true);
  });

  it('non-adopt: NO trailing sentinel + long final still posts even with a short prior send (unchanged)', () => {
    // Guard the narrowing: the sentinel is what flips a longer-than-send final to
    // suppressed. WITHOUT a trailing sentinel, a materially longer final is still
    // treated as a genuine follow-up answer and posts (preserves the pre-existing
    // "short progress update then a substantive final" behavior).
    const shortSend = 'Working on it.';
    const longFinal = 'Here is the complete, substantive answer that is materially '
      + 'longer than the short progress note I sent earlier, with real content '
      + 'that clearly exceeds the material-longer threshold by a wide margin here.';
    // sanity: this final IS materially longer than the send (would post on its own)
    expect(shouldSuppressBridgeEmit(
      { ...turn(100), finalText: longFinal },
      500,
      [{ sentAtMs: 200, ...buildBridgeSendMarkerContent(shortSend) }],
      false,
    )).toBe(false);
  });

  it('non-adopt: token inline in a prose sentence is not guessed away', () => {
    // Last non-empty line is a full sentence (token mid-line), not a bare
    // sentinel — a normal answer that merely mentions the token.
    expect(shouldSuppressBridgeEmit(
      { ...turn(100), finalText: `I will stay silent instead of replying. ${BRIDGE_NOTHING_TO_SEND_SENTINEL}` },
      undefined,
      [],
      false,
    )).toBe(false);
  });

  it('non-adopt: sentinel followed by more prose still posts (not a terminator)', () => {
    expect(shouldSuppressBridgeEmit(
      { ...turn(100), finalText: `${BRIDGE_NOTHING_TO_SEND_SENTINEL}\n\nActually, here is the answer you asked for.` },
      undefined,
      [],
      false,
    )).toBe(false);
  });

  it('adopt mode does not interpret the nothing-to-send sentinel', () => {
    expect(shouldSuppressBridgeEmit(
      { ...turn(100), finalText: BRIDGE_NOTHING_TO_SEND_SENTINEL },
      undefined,
      [],
      true,
    )).toBe(false);
  });

  it('adopt mode never suppresses, even with markers in window', () => {
    const markers: BridgeSendMarker[] = [{ sentAtMs: 150 }];
    expect(shouldSuppressBridgeEmit(turn(100), 200, markers, true)).toBe(false);
    expect(shouldSuppressBridgeEmit(turn(100, true), undefined, markers, true)).toBe(false);
  });

  it('non-adopt: isLocal turn always suppressed (skip web-terminal echo to Lark)', () => {
    expect(shouldSuppressBridgeEmit(turn(100, true), 200, [], false)).toBe(true);
  });

  it('non-adopt: emits when no marker landed in window', () => {
    const markers: BridgeSendMarker[] = [{ sentAtMs: 50 }, { sentAtMs: 250 }];
    // window is [100, 200); both markers fall outside
    expect(shouldSuppressBridgeEmit(turn(100), 200, markers, false)).toBe(false);
  });

  it('non-adopt: suppresses when a marker is inside [markTimeMs, nextBoundaryMs)', () => {
    const markers: BridgeSendMarker[] = [{ sentAtMs: 150 }];
    expect(shouldSuppressBridgeEmit(turn(100), 200, markers, false)).toBe(true);
  });

  it('non-adopt: structured marker suppresses when sent content matches the transcript final', () => {
    const markers: BridgeSendMarker[] = [markerForContent(150, 'final answer body with extra formatting')];
    expect(shouldSuppressBridgeEmit(
      { ...turn(100), finalText: 'final answer body with extra formatting' },
      200,
      markers,
      false,
    )).toBe(true);
  });

  it('non-adopt: short progress marker does not suppress a materially longer transcript final', () => {
    const markers: BridgeSendMarker[] = [markerForContent(150, 'checking repository state')];
    expect(shouldSuppressBridgeEmit(
      { ...turn(100), finalText: 'The final answer contains a full implementation plan that was never explicitly sent through botmux send. It includes the deployment boundary, validation commands, rollout order, rollback criteria, and the remaining operational risks.' },
      200,
      markers,
      false,
    )).toBe(false);
  });

  it('non-adopt: short prefix marker does not suppress the missing material final', () => {
    const finalText = 'Plan: keep repository-owned scripts, install them through a setup skill, let a user-level systemd timer own the runtime synchronization loop, document rollback clearly, and validate the service with both a dry-run and a real one-shot sync before enabling the timer.';
    const markers: BridgeSendMarker[] = [markerForContent(150, 'Plan: keep repository-owned scripts')];
    expect(shouldSuppressBridgeEmit(
      { ...turn(100), finalText },
      200,
      markers,
      false,
    )).toBe(false);
  });

  it('non-adopt: near-complete send suppresses a same-size rewritten final', () => {
    const finalText = 'Plan: keep repository-owned scripts, install them through a setup skill, let a user-level systemd timer own the runtime synchronization loop, and document rollback clearly.';
    const markers: BridgeSendMarker[] = [markerForContent(150, 'Plan: keep repository-owned scripts, install them through a setup skill, let a user-level timer own synchronization, and document rollback clearly.')];
    expect(shouldSuppressBridgeEmit(
      { ...turn(100), finalText },
      200,
      markers,
      false,
    )).toBe(true);
  });

  it('non-adopt: multiple short progress markers do not suppress just because their total length is large', () => {
    const finalText = 'The final answer contains the actual migration plan, validation commands, rollout boundary, and the follow-up risk assessment. It also records the final commit, the exact checks that passed, the deployment switch order, and the rollback condition if the worker stops forwarding replies.';
    const markers: BridgeSendMarker[] = [
      markerForContent(130, 'I am checking the current repository state and reading the relevant files before making a narrow change.'),
      markerForContent(150, 'I found the existing scripts and will compare them before proposing the final plan and validation commands.'),
    ];
    expect(shouldSuppressBridgeEmit(
      { ...turn(100), finalText },
      200,
      markers,
      false,
    )).toBe(false);
  });

  it('non-adopt: short transcript follow-up remains suppressed when a structured marker exists', () => {
    const markers: BridgeSendMarker[] = [markerForContent(150, 'full answer was sent through botmux send')];
    expect(shouldSuppressBridgeEmit(
      { ...turn(100), finalText: '已用 botmux send 发出。' },
      200,
      markers,
      false,
    )).toBe(true);
  });

  it('non-adopt: marker exactly at lower bound suppresses (>= boundary)', () => {
    const markers: BridgeSendMarker[] = [{ sentAtMs: 100 }];
    expect(shouldSuppressBridgeEmit(turn(100), 200, markers, false)).toBe(true);
  });

  it('non-adopt: marker exactly at upper bound does NOT suppress (< boundary)', () => {
    const markers: BridgeSendMarker[] = [{ sentAtMs: 200 }];
    expect(shouldSuppressBridgeEmit(turn(100), 200, markers, false)).toBe(false);
  });

  it('non-adopt: last ready turn with no next boundary uses +inf upper bound', () => {
    const markers: BridgeSendMarker[] = [{ sentAtMs: 5_000_000 }];
    expect(shouldSuppressBridgeEmit(turn(100), undefined, markers, false)).toBe(true);
  });

  it('non-adopt: marker BEFORE turn does not suppress (it belongs to a previous turn)', () => {
    // Concretely: turn1 mark=100 + send=150, then turn2 mark=200 + no send.
    // turn2 window is [200, +inf); send=150 falls outside; turn2 must emit.
    const markers: BridgeSendMarker[] = [{ sentAtMs: 150 }];
    expect(shouldSuppressBridgeEmit(turn(200), undefined, markers, false)).toBe(false);
  });

  it('non-adopt: type-ahead — a send inside turn2 window does NOT suppress turn1', () => {
    // turn1 mark=100 (no send for it), turn2 mark=200 + send=250.
    // turn1 is the first ready, nextBoundary=200 (turn2). markers in [100,200) is empty → emit turn1.
    const markers: BridgeSendMarker[] = [{ sentAtMs: 250 }];
    expect(shouldSuppressBridgeEmit(turn(100), 200, markers, false)).toBe(false);
  });

  it('non-adopt: turn without markTimeMs degrades to "never suppress"', () => {
    const markers: BridgeSendMarker[] = [{ sentAtMs: 999 }];
    expect(shouldSuppressBridgeEmit(turn(undefined), undefined, markers, false)).toBe(false);
  });

  it('non-adopt: empty marker list → no suppression (regardless of bounds)', () => {
    expect(shouldSuppressBridgeEmit(turn(100), 200, [], false)).toBe(false);
  });

  it('non-adopt: multiple markers — any one inside window triggers suppress', () => {
    const markers: BridgeSendMarker[] = [{ sentAtMs: 50 }, { sentAtMs: 175 }, { sentAtMs: 500 }];
    expect(shouldSuppressBridgeEmit(turn(100), 200, markers, false)).toBe(true);
  });
});

describe('shouldEmitEmptyCompletedBridgeFallback', () => {
  it('emits a visible diagnostic when a completed turn has empty final text and no send marker', () => {
    expect(shouldEmitEmptyCompletedBridgeFallback(
      { ...turn(100), finalText: '', terminalStatus: 'completed' },
      undefined,
      [],
      false,
    )).toBe(true);
  });

  it('does not emit when the completed empty turn already has a botmux send marker', () => {
    expect(shouldEmitEmptyCompletedBridgeFallback(
      { ...turn(100), finalText: '', terminalStatus: 'completed' },
      200,
      [markerForContent(150, 'already sent visible result')],
      false,
    )).toBe(false);
  });

  it('does not emit for failed, ambiguous, local, adopt, or non-empty turns', () => {
    expect(shouldEmitEmptyCompletedBridgeFallback(
      { ...turn(100), finalText: '', terminalStatus: 'failed' },
      undefined,
      [],
      false,
    )).toBe(false);
    expect(shouldEmitEmptyCompletedBridgeFallback(
      { ...turn(100), finalText: '', terminalStatus: 'ambiguous' },
      undefined,
      [],
      false,
    )).toBe(false);
    expect(shouldEmitEmptyCompletedBridgeFallback(
      { ...turn(100, true), finalText: '', terminalStatus: 'completed' },
      undefined,
      [],
      false,
    )).toBe(false);
    expect(shouldEmitEmptyCompletedBridgeFallback(
      { ...turn(100), finalText: '', terminalStatus: 'completed' },
      undefined,
      [],
      true,
    )).toBe(false);
    expect(shouldEmitEmptyCompletedBridgeFallback(
      { ...turn(100), finalText: 'real answer', terminalStatus: 'completed' },
      undefined,
      [],
      false,
    )).toBe(false);
  });

  it('treats legacy empty assistant_final as completed for fallback purposes', () => {
    expect(shouldEmitEmptyCompletedBridgeFallback(
      { ...turn(100), finalText: '' },
      undefined,
      [],
      false,
    )).toBe(true);
  });

  // Cross-CLI coverage: the two shipping producers of an empty-final turn that
  // reach this shared gate. Traex -> empty task_complete with no terminalStatus
  // (undefined); Grok -> empty end_turn with terminalStatus 'completed'. Both
  // must surface the diagnostic when no send marker covers the window.
  it('emits for a Traex-shaped empty task_complete (terminalStatus undefined)', () => {
    expect(shouldEmitEmptyCompletedBridgeFallback(
      { ...turn(100), finalText: '' },
      undefined,
      [],
      false,
    )).toBe(true);
  });

  it('emits for a Grok-shaped empty end_turn (terminalStatus completed)', () => {
    expect(shouldEmitEmptyCompletedBridgeFallback(
      { ...turn(100), finalText: '', terminalStatus: 'completed' },
      undefined,
      [],
      false,
    )).toBe(true);
  });

  // Dependency guard: a Traex cancel is encoded as turn_aborted -> 'ambiguous',
  // which must NOT surface a "completed but empty" diagnostic.
  it('does not emit for a Traex-shaped abort (terminalStatus ambiguous)', () => {
    expect(shouldEmitEmptyCompletedBridgeFallback(
      { ...turn(100), finalText: '', terminalStatus: 'ambiguous' },
      undefined,
      [],
      false,
    )).toBe(false);
  });
});

describe('shouldEmitFailedBridgeFallback', () => {
  it('emits for an empty failed turn with no explicit reply', () => {
    expect(shouldEmitFailedBridgeFallback(
      { ...turn(100), finalText: '', terminalStatus: 'failed' },
      undefined,
      [],
      false,
    )).toBe(true);
  });

  it('does not duplicate a send or affect completed, local, and adopt turns', () => {
    expect(shouldEmitFailedBridgeFallback(
      { ...turn(100), finalText: '', terminalStatus: 'failed' },
      200,
      [markerForContent(150, 'already reported')],
      false,
    )).toBe(false);
    expect(shouldEmitFailedBridgeFallback(
      { ...turn(100), finalText: '', terminalStatus: 'completed' },
      undefined,
      [],
      false,
    )).toBe(false);
    expect(shouldEmitFailedBridgeFallback(
      { ...turn(100, true), finalText: '', terminalStatus: 'failed' },
      undefined,
      [],
      false,
    )).toBe(false);
    expect(shouldEmitFailedBridgeFallback(
      { ...turn(100), finalText: '', terminalStatus: 'failed' },
      undefined,
      [],
      true,
    )).toBe(false);
  });

  it('keeps the failure visible when the provider also returned partial text', () => {
    expect(shouldEmitFailedBridgeFallback(
      { ...turn(100), finalText: 'partial answer', terminalStatus: 'failed' },
      undefined,
      [],
      false,
    )).toBe(true);
  });
});

describe('looksLikeLeakedToolCall', () => {
  it('fires on the real leak shape: <invoke name> + <parameter name>', () => {
    // The exact shape observed in production transcripts (stray "count" prefix,
    // opening invoke tag, a parameter child, unbalanced/truncated tail).
    const leaked = [
      'count',
      '<invoke name="Bash">',
      '<parameter name="command">echo hi</parameter>',
      '</invoke>',
    ].join('\n');
    expect(looksLikeLeakedToolCall(leaked)).toBe(true);
  });

  it('fires on invoke prose narration followed by the tool-call block', () => {
    const leaked = '补上 build symlink 再回归。\n\ncount\n<invoke name="Bash">\n<parameter name="command">ls -la</parameter>\n</invoke>';
    expect(looksLikeLeakedToolCall(leaked)).toBe(true);
  });

  it('fires on an opening invoke tag paired only with its closing tag', () => {
    expect(looksLikeLeakedToolCall('<invoke name="TaskUpdate"></invoke>')).toBe(true);
  });

  it('fires even when the parameter body is truncated (no closing tags)', () => {
    // Production leaks are often cut off mid-stream; the opening invoke tag plus
    // a parameter child is already high-confidence.
    const leaked = '<invoke name="Bash">\n<parameter name="command">botmux send --mention ou_x <<\'EOF\'\nhello';
    expect(looksLikeLeakedToolCall(leaked)).toBe(true);
  });

  // --- must NOT fire (false-positive guards) ---

  it('does not fire on empty / undefined input', () => {
    expect(looksLikeLeakedToolCall(undefined)).toBe(false);
    expect(looksLikeLeakedToolCall('')).toBe(false);
  });

  it('does not fire on ordinary prose that merely mentions "invoke"', () => {
    expect(looksLikeLeakedToolCall('You can invoke the Bash tool to run commands.')).toBe(false);
    expect(looksLikeLeakedToolCall('The <invoke> element is part of the tool protocol.')).toBe(false);
  });

  it('does not fire on a lone <invoke> tag with no name and no pairing', () => {
    expect(looksLikeLeakedToolCall('<invoke>')).toBe(false);
    expect(looksLikeLeakedToolCall('an <invoke name="Bash"> tag on its own')).toBe(false);
  });

  it('does not fire on code discussing invoke() calls', () => {
    const code = '```ts\nclient.invoke({ name: "Bash", input: { command: "ls" } });\n```';
    expect(looksLikeLeakedToolCall(code)).toBe(false);
  });

  it('does not fire on a user pasting a <parameter> tag without an invoke', () => {
    expect(looksLikeLeakedToolCall('why does <parameter name="command"> show up in my logs?')).toBe(false);
  });

  it('does not fire when a <parameter>/<\/invoke> terminator precedes the only opener', () => {
    // A terminator that appears BEFORE the first opener is not part of a pair —
    // the two-phase scan only accepts a terminator in the opener's suffix.
    expect(looksLikeLeakedToolCall('<parameter name="x"> then later <invoke name="a">')).toBe(false);
    expect(looksLikeLeakedToolCall('a stray </invoke> then <invoke name="a"> with no closer')).toBe(false);
  });

  it('fires when a later opener closes even if the first opener does not', () => {
    // Multi-opener: the earliest opener is followed (further along) by a
    // terminator belonging to a later opener — still the leak shape.
    expect(looksLikeLeakedToolCall('<invoke name="a"> no close here <invoke name="b"></invoke>')).toBe(true);
  });

  it('does not fire on multiple openers that never terminate', () => {
    expect(looksLikeLeakedToolCall('<invoke name="a"> gap <invoke name="b"> gap <invoke name="c"> end')).toBe(false);
  });

  it('stays linear-time on pathological unterminated openers (no ReDoS)', () => {
    // Regression for the O(n²) lazy-backtrack hazard: many `<invoke name="x">`
    // openers with NO terminator forced the old lazy-bridge regex to re-scan to
    // end-of-text from each opener. The two-phase scan is O(n) — this returns
    // effectively instantly; the old form took seconds at this size.
    const pathological = '<invoke name="x">'.repeat(50_000) + 'NOCLOSER';
    const start = Date.now();
    const hit = looksLikeLeakedToolCall(pathological);
    const elapsedMs = Date.now() - start;
    expect(hit).toBe(false);
    expect(elapsedMs).toBeLessThan(200);
  });
});
