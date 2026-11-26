import { describe, expect, it } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import { LarkApiError } from '../src/im/lark/lark-errors.js';
import { LarkCircuitOpenError } from '../src/im/lark/api-gate.js';
import { TopicSendError } from '../src/cli/topic-send-guard.js';
import {
  FEISHU_UUID_MAX_LEN,
  FEISHU_UUID_PATTERN,
  MAX_LEGACY_MIGRATION_SLOTS,
  MAX_TRACKED_UNKNOWN_BODY_HASHES,
  abortUnissuedStreamingCardPostAttempt,
  acquireLegacyMigrationStreamingCardPostSlot,
  acquireManualStreamingCardPostSlot,
  acquireResumeStreamingCardPostSlot,
  acquireTurnStreamingCardPostSlot,
  advancePendingStreamingCardTurn,
  classifyStreamingCardPostError,
  clearStreamingCardPostSlots,
  deriveReadyFallbackStreamingCardUuid,
  deriveStreamingCardUuid,
  hasDivergentUnknownOutcomeBody,
  hashStreamingCardBody,
  hasUnknownOutcomeHistory,
  invalidateTurnStreamingCardPostSlot,
  isMessageUpdateExpiredError,
  isStreamingCardTargetBlockedError,
  recordStreamingCardPostFailure,
  resolveCanonicalStreamingCardTurnId,
  restoreTurnStreamingCardPostSlotIfUnchanged,
  retireStreamingCardPostSlot,
  snapshotTurnStreamingCardPostSlot,
} from '../src/core/streaming-card-post-slot.js';
import { __testOnly_resetLarkGate, executeWithLarkGate } from '../src/im/lark/api-gate.js';

function makeSession(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    larkAppId: 'cli_slot_test',
    chatId: 'oc_chat_1',
    scope: 'thread',
    session: {
      sessionId: 'sess_1',
      larkAppId: 'cli_slot_test',
      chatId: 'oc_chat_1',
      scope: 'thread',
      rootMessageId: 'om_root_1',
      status: 'active',
    },
    ...overrides,
  } as unknown as DaemonSession;
}

describe('streaming-card-post-slot pure UUID & state machine', () => {
  it('derives <=50-char URL-safe UUIDs with strict domain separation and canonical framing', () => {
    const base = {
      kind: 'turn' as const,
      larkAppId: 'cli_app_a',
      sessionId: 'sess_a',
      anchorId: 'om_root_a',
      replyTargetKey: 'thread:om_root_a',
      turnGeneration: 1,
      canonicalTurnId: 'om_turn_1',
      retireMessageId: '',
      staleCardId: '',
      slotToken: '0123456789abcdef0123456789abcdef',
    };

    const uBase = deriveStreamingCardUuid(base);
    expect(uBase.length).toBe(37);
    expect(uBase.length).toBeLessThanOrEqual(FEISHU_UUID_MAX_LEN);
    expect(uBase).toMatch(FEISHU_UUID_PATTERN);
    expect(uBase).toMatch(/^sc_t_[0-9a-f]{32}$/);
    expect(deriveStreamingCardUuid(base)).toBe(uBase);

    const variants = [
      { ...base, kind: 'ready_fallback' as const },
      { ...base, kind: 'manual' as const },
      { ...base, kind: 'legacy_migration' as const },
      { ...base, kind: 'resume' as const },
      { ...base, larkAppId: 'cli_app_b' },
      { ...base, sessionId: 'sess_b' },
      { ...base, anchorId: 'om_root_b' },
      { ...base, replyTargetKey: 'thread:om_root_b' },
      { ...base, replyTargetKey: 'plain:oc_chat_1' },
      { ...base, turnGeneration: 2 },
      { ...base, canonicalTurnId: 'om_turn_2' },
      { ...base, retireMessageId: 'om_legacy_1' },
      { ...base, staleCardId: 'om_stale_1' },
      { ...base, slotToken: 'fedcba9876543210fedcba9876543210' },
    ];
    const seen = new Set<string>([uBase]);
    for (const variant of variants) {
      const u = deriveStreamingCardUuid(variant);
      expect(u.length).toBeLessThanOrEqual(FEISHU_UUID_MAX_LEN);
      expect(u).toMatch(FEISHU_UUID_PATTERN);
      expect(seen.has(u)).toBe(false);
      seen.add(u);
    }

    // Delimiter injection immunity: moving ':' across adjacent fields must produce different hashes.
    const left = deriveStreamingCardUuid({ ...base, sessionId: 'a:b', anchorId: 'c' });
    const right = deriveStreamingCardUuid({ ...base, sessionId: 'a', anchorId: 'b:c' });
    expect(left).not.toBe(right);
  });

  it('derives a domain-separated fallback UUID from an existing turn slot', () => {
    const ds = makeSession();
    const { slot } = acquireTurnStreamingCardPostSlot(ds, {
      sessionId: 'sess_1',
      larkAppId: 'cli_app',
      anchorId: 'om_root',
      replyTargetKey: 'thread:om_root',
      turnGeneration: 1,
      canonicalTurnId: 'om_turn_1',
    });
    const fallback = deriveReadyFallbackStreamingCardUuid(slot);
    expect(fallback).toMatch(/^sc_f_[0-9a-f]{32}$/);
    expect(fallback.length).toBeLessThanOrEqual(FEISHU_UUID_MAX_LEN);
    expect(fallback).not.toBe(slot.uuid);
    expect(deriveReadyFallbackStreamingCardUuid(slot)).toBe(fallback);
  });

  it('reuses turn slot uuid and nonce across same-turn retries, including untagged PTY retries, and rotates on boundary changes', () => {
    const ds = makeSession();
    let tokenSeq = 0;
    let nonceSeq = 0;
    const gen = {
      nextSlotToken: () => `tok_${++tokenSeq}`.padEnd(32, '0'),
      nextNonce: () => `non_${++nonceSeq}`.padEnd(8, '0'),
    };
    const baseInput = {
      sessionId: 'sess_1',
      larkAppId: 'cli_app',
      anchorId: 'om_root',
      replyTargetKey: 'thread:om_root',
      turnGeneration: 1,
      canonicalTurnId: 'om_turn_1',
    };

    const first = acquireTurnStreamingCardPostSlot(ds, baseInput, gen);
    expect(first.reused).toBe(false);
    expect(first.slot.attempts).toBe(1);

    // Exact same key -> reused with identical uuid & nonce
    const retry1 = acquireTurnStreamingCardPostSlot(ds, baseInput, gen);
    expect(retry1.reused).toBe(true);
    expect(retry1.slot).toBe(first.slot);
    expect(retry1.slot.uuid).toBe(first.slot.uuid);
    expect(retry1.slot.nonce).toBe(first.slot.nonce);
    expect(retry1.slot.attempts).toBe(2);

    // Untagged PTY retry (canonicalTurnId: undefined) converges onto open turn slot
    const retryUntagged = acquireTurnStreamingCardPostSlot(
      ds,
      { ...baseInput, canonicalTurnId: undefined },
      gen,
    );
    expect(retryUntagged.reused).toBe(true);
    expect(retryUntagged.slot.uuid).toBe(first.slot.uuid);
    expect(retryUntagged.slot.attempts).toBe(3);

    // Distinct explicit canonicalTurnId rotates
    const rotatedTurnId = acquireTurnStreamingCardPostSlot(
      ds,
      { ...baseInput, canonicalTurnId: 'om_turn_2' },
      gen,
    );
    expect(rotatedTurnId.reused).toBe(false);
    expect(rotatedTurnId.slot.uuid).not.toBe(first.slot.uuid);

    // Changing replyTargetKey rotates (guards Feishu cross-parent dedupe quirk)
    const rotatedReplyTarget = acquireTurnStreamingCardPostSlot(
      ds,
      { ...baseInput, canonicalTurnId: 'om_turn_2', replyTargetKey: 'thread:om_other' },
      gen,
    );
    expect(rotatedReplyTarget.reused).toBe(false);
    expect(rotatedReplyTarget.slot.uuid).not.toBe(rotatedTurnId.slot.uuid);

    // Changing turnGeneration rotates
    const rotatedGen = acquireTurnStreamingCardPostSlot(
      ds,
      { ...baseInput, canonicalTurnId: 'om_turn_2', replyTargetKey: 'thread:om_other', turnGeneration: 2 },
      gen,
    );
    expect(rotatedGen.reused).toBe(false);
    expect(rotatedGen.slot.uuid).not.toBe(rotatedReplyTarget.slot.uuid);

    // Changing sessionId (in-place repo switch) rotates
    const rotatedSession = acquireTurnStreamingCardPostSlot(
      ds,
      { ...baseInput, sessionId: 'sess_2', canonicalTurnId: 'om_turn_2', replyTargetKey: 'thread:om_other', turnGeneration: 2 },
      gen,
    );
    expect(rotatedSession.reused).toBe(false);
    expect(rotatedSession.slot.uuid).not.toBe(rotatedGen.slot.uuid);

    // Explicit retirement rotates
    retireStreamingCardPostSlot(ds, rotatedSession.slot);
    const afterRetire = acquireTurnStreamingCardPostSlot(
      ds,
      { ...baseInput, sessionId: 'sess_2', canonicalTurnId: 'om_turn_2', replyTargetKey: 'thread:om_other', turnGeneration: 2 },
      gen,
    );
    expect(afterRetire.reused).toBe(false);
    expect(afterRetire.slot.uuid).not.toBe(rotatedSession.slot.uuid);
  });

  it('avoids colliding with predecessor and frozen nonces on new slot allocation', () => {
    const ds = makeSession();
    const avoid = new Set(['deadbeef', 'cafebabe']);
    const drawn: string[] = [];
    const { slot } = acquireTurnStreamingCardPostSlot(
      ds,
      {
        sessionId: 'sess_1',
        larkAppId: 'cli_app',
        anchorId: 'om_root',
        replyTargetKey: 'thread:om_root',
        turnGeneration: 1,
        avoidNonces: avoid,
      },
      {
        nextNonce: avoided => {
          for (const candidate of ['deadbeef', 'cafebabe', '12345678']) {
            drawn.push(candidate);
            if (!avoided?.has(candidate)) return candidate;
          }
          return 'fallback';
        },
      },
    );
    expect(slot.nonce).toBe('12345678');
    expect(drawn).toEqual(['deadbeef', 'cafebabe', '12345678']);
  });

  it('rolls back unissued pre-POST attempts cleanly without erasing sticky commit-unknown history', () => {
    const ds = makeSession();
    const input = {
      sessionId: 'sess_1',
      larkAppId: 'cli_app',
      anchorId: 'om_root',
      replyTargetKey: 'thread:om_root',
      turnGeneration: 1,
    };

    // Unissued first attempt -> removed completely on abort
    const first = acquireTurnStreamingCardPostSlot(ds, input);
    abortUnissuedStreamingCardPostAttempt(ds, first.slot);
    const afterAbort = acquireTurnStreamingCardPostSlot(ds, input);
    expect(afterAbort.reused).toBe(false);
    expect(afterAbort.slot.uuid).not.toBe(first.slot.uuid);

    // After a commit-unknown failure, aborting attempt #2 keeps the slot open
    recordStreamingCardPostFailure(
      ds,
      afterAbort.slot,
      classifyStreamingCardPostError({ isAxiosError: true, response: { status: 500, data: { code: 2200 } } }),
      hashStreamingCardBody('{"body":"v1"}'),
      'starting',
    );
    const attempt2 = acquireTurnStreamingCardPostSlot(ds, input);
    expect(attempt2.reused).toBe(true);
    expect(attempt2.slot.attempts).toBe(2);
    abortUnissuedStreamingCardPostAttempt(ds, attempt2.slot);
    expect(attempt2.slot.attempts).toBe(1);
    const attempt3 = acquireTurnStreamingCardPostSlot(ds, input);
    expect(attempt3.reused).toBe(true);
    expect(attempt3.slot.uuid).toBe(afterAbort.slot.uuid);
  });

  it('isolates manual /card, legacy migration, and resume namespaces from turn slots', () => {
    const ds = makeSession();
    const turnInput = {
      sessionId: 'sess_1',
      larkAppId: 'cli_app',
      anchorId: 'om_root',
      replyTargetKey: 'thread:om_root',
      turnGeneration: 1,
      canonicalTurnId: 'om_turn_1',
    };
    const turn = acquireTurnStreamingCardPostSlot(ds, turnInput);
    const err500 = classifyStreamingCardPostError({ isAxiosError: true, response: { status: 500, data: { code: 2200 } } });
    const errCircuit = classifyStreamingCardPostError(new LarkCircuitOpenError('cli_app', 30_000));
    const errPlain = classifyStreamingCardPostError(new Error('deterministic failure'));

    // Manual /card: fresh after commit, fresh after non-retryable, reused after commit_unknown (sticky across circuit-open)
    const manual1 = acquireManualStreamingCardPostSlot(ds, turnInput);
    expect(manual1.slot.uuid).toMatch(/^sc_m_[0-9a-f]{32}$/);
    expect(manual1.slot.uuid).not.toBe(turn.slot.uuid);
    retireStreamingCardPostSlot(ds, manual1.slot);

    const manual2 = acquireManualStreamingCardPostSlot(ds, turnInput);
    expect(manual2.reused).toBe(false);
    expect(manual2.slot.uuid).not.toBe(manual1.slot.uuid);
    recordStreamingCardPostFailure(ds, manual2.slot, errPlain, hashStreamingCardBody('m2'), 'working');

    // Non-retryable retired manual2 -> manual3 gets fresh UUID
    const manual3 = acquireManualStreamingCardPostSlot(ds, turnInput);
    expect(manual3.reused).toBe(false);
    expect(manual3.slot.uuid).not.toBe(manual2.slot.uuid);
    recordStreamingCardPostFailure(ds, manual3.slot, err500, hashStreamingCardBody('m3-a'), 'working');

    // Retry after 500 reuses manual3; subsequent circuit-open keeps it sticky
    const manual3Retry1 = acquireManualStreamingCardPostSlot(ds, turnInput);
    expect(manual3Retry1.reused).toBe(true);
    expect(manual3Retry1.slot.uuid).toBe(manual3.slot.uuid);
    recordStreamingCardPostFailure(ds, manual3Retry1.slot, errCircuit, hashStreamingCardBody('m3-b'), 'working');

    const manual3Retry2 = acquireManualStreamingCardPostSlot(ds, turnInput);
    expect(manual3Retry2.reused).toBe(true);
    expect(manual3Retry2.slot.uuid).toBe(manual3.slot.uuid);

    // Legacy migration: per-retireMessageId slots, FIFO capped at MAX_LEGACY_MIGRATION_SLOTS
    const firstLegacy = acquireLegacyMigrationStreamingCardPostSlot(ds, {
      ...turnInput,
      retireMessageId: 'om_legacy_0',
    });
    expect(firstLegacy.slot.uuid).toMatch(/^sc_l_[0-9a-f]{32}$/);
    recordStreamingCardPostFailure(ds, firstLegacy.slot, err500, hashStreamingCardBody('l0'), 'idle');
    const firstLegacyRetry = acquireLegacyMigrationStreamingCardPostSlot(ds, {
      ...turnInput,
      retireMessageId: 'om_legacy_0',
    });
    expect(firstLegacyRetry.reused).toBe(true);
    expect(firstLegacyRetry.slot.uuid).toBe(firstLegacy.slot.uuid);

    for (let i = 1; i <= MAX_LEGACY_MIGRATION_SLOTS; i++) {
      const slot = acquireLegacyMigrationStreamingCardPostSlot(ds, {
        ...turnInput,
        retireMessageId: `om_legacy_${i}`,
      });
      recordStreamingCardPostFailure(ds, slot.slot, err500, hashStreamingCardBody(`l${i}`), 'idle');
    }
    // om_legacy_0 was evicted when slot #9 was inserted
    const evictedRetry = acquireLegacyMigrationStreamingCardPostSlot(ds, {
      ...turnInput,
      retireMessageId: 'om_legacy_0',
    });
    expect(evictedRetry.reused).toBe(false);

    // Resume slot: reuses after commit_unknown for same staleCardId
    const res1 = acquireResumeStreamingCardPostSlot(ds, {
      sessionId: 'sess_1',
      larkAppId: 'cli_app',
      anchorId: 'om_root',
      replyTargetKey: 'thread:om_root',
      staleCardId: 'om_closed_1',
    });
    expect(res1.slot.uuid).toMatch(/^sc_r_[0-9a-f]{32}$/);
    recordStreamingCardPostFailure(ds, res1.slot, err500, hashStreamingCardBody('r1'));
    const res1Retry = acquireResumeStreamingCardPostSlot(ds, {
      sessionId: 'sess_1',
      larkAppId: 'cli_app',
      anchorId: 'om_root',
      replyTargetKey: 'thread:om_root',
      staleCardId: 'om_closed_1',
    });
    expect(res1Retry.reused).toBe(true);
    expect(res1Retry.slot.uuid).toBe(res1.slot.uuid);

    // None of manual / legacy / resume disturbed the turn slot
    const turnCheck = acquireTurnStreamingCardPostSlot(ds, turnInput);
    expect(turnCheck.reused).toBe(true);
    expect(turnCheck.slot.uuid).toBe(turn.slot.uuid);

    // invalidateTurnStreamingCardPostSlot clears only turn, not manual/resume
    invalidateTurnStreamingCardPostSlot(ds);
    const turnAfterInvalidate = acquireTurnStreamingCardPostSlot(ds, turnInput);
    expect(turnAfterInvalidate.reused).toBe(false);
    expect(acquireResumeStreamingCardPostSlot(ds, {
      sessionId: 'sess_1',
      larkAppId: 'cli_app',
      anchorId: 'om_root',
      replyTargetKey: 'thread:om_root',
      staleCardId: 'om_closed_1',
    }).reused).toBe(true);

    // clearStreamingCardPostSlots clears all 4 namespaces
    clearStreamingCardPostSlots(ds);
    expect(acquireTurnStreamingCardPostSlot(ds, turnInput).reused).toBe(false);
    expect(acquireManualStreamingCardPostSlot(ds, turnInput).reused).toBe(false);
    expect(acquireResumeStreamingCardPostSlot(ds, {
      sessionId: 'sess_1',
      larkAppId: 'cli_app',
      anchorId: 'om_root',
      replyTargetKey: 'thread:om_root',
      staleCardId: 'om_closed_1',
    }).reused).toBe(false);
  });

  it('classifies all 6 error categories accurately and cross-realm safely', () => {
    const withdrawn = Object.assign(new Error('withdrawn'), { name: 'MessageWithdrawnError' });
    expect(classifyStreamingCardPostError(withdrawn)).toEqual({
      kind: 'withdrawn',
      mayHaveCommitted: false,
      suppressStaticFallback: true,
      isTargetUnavailable: true,
    });
    expect(isStreamingCardTargetBlockedError(withdrawn)).toBe(true);

    const blocked = new TopicSendError('TOPIC_SEND_BLOCKED', 'blocked');
    expect(classifyStreamingCardPostError(blocked)).toEqual({
      kind: 'topic_blocked',
      mayHaveCommitted: false,
      suppressStaticFallback: true,
      isTargetUnavailable: true,
    });
    expect(isStreamingCardTargetBlockedError(blocked)).toBe(true);

    const checkFailed = new TopicSendError('TOPIC_SEND_CHECK_FAILED', 'check failed');
    expect(classifyStreamingCardPostError(checkFailed)).toEqual({
      kind: 'topic_check_failed',
      mayHaveCommitted: false,
      suppressStaticFallback: true,
      isTargetUnavailable: false,
    });

    for (const err of [
      new LarkCircuitOpenError('cli_app', 30_000),
      Object.assign(new Error('getaddrinfo ENOTFOUND open.feishu.cn'), { code: 'ENOTFOUND' }),
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('dns temp'), { code: 'EAI_AGAIN' }),
    ]) {
      expect(classifyStreamingCardPostError(err)).toEqual({
        kind: 'never_landed',
        mayHaveCommitted: false,
        suppressStaticFallback: true,
        isTargetUnavailable: false,
      });
    }

    for (const err of [
      { isAxiosError: true, response: { status: 500, data: { code: 2200, msg: 'internal error' } } },
      new LarkApiError('reply message', 2200, 'internal error'),
      { isAxiosError: true, response: { status: 502 } },
      { isAxiosError: true, response: { status: 429 } },
      { status: 408, message: 'request timeout' },
      new LarkApiError('send message', 230020, 'rate limited'),
      new LarkApiError('send message', 230049, 'freq limited'),
      new LarkApiError('send message', 99991400, 'throttled'),
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }),
      Object.assign(new Error('undici socket'), { code: 'UND_ERR_SOCKET' }),
    ]) {
      expect(classifyStreamingCardPostError(err)).toEqual({
        kind: 'commit_unknown',
        mayHaveCommitted: true,
        suppressStaticFallback: true,
        isTargetUnavailable: false,
      });
    }

    for (const err of [
      new Error('streaming POST failed'),
      new Error('primary card failed'),
      new LarkApiError('send message', 230099, 'card build failed'),
      { isAxiosError: true, response: { status: 400, data: { code: 230025 } } },
    ]) {
      expect(classifyStreamingCardPostError(err)).toEqual({
        kind: 'non_retryable',
        mayHaveCommitted: false,
        suppressStaticFallback: false,
        isTargetUnavailable: false,
      });
    }
  });

  it('tracks divergent unknown-outcome bodies accurately including overflow past cap', () => {
    const ds = makeSession();
    const { slot } = acquireTurnStreamingCardPostSlot(ds, {
      sessionId: 'sess_1',
      larkAppId: 'cli_app',
      anchorId: 'om_root',
      replyTargetKey: 'thread:om_root',
      turnGeneration: 1,
    });
    const h1 = hashStreamingCardBody('{"status":"starting"}');
    const h2 = hashStreamingCardBody('{"status":"working"}');
    const errNever = classifyStreamingCardPostError(new LarkCircuitOpenError('cli_app', 1000));
    const err500 = classifyStreamingCardPostError({ isAxiosError: true, response: { status: 500, data: { code: 2200 } } });

    expect(hasUnknownOutcomeHistory(slot)).toBe(false);
    expect(hasDivergentUnknownOutcomeBody(slot, h1)).toBe(false);

    // Never-landed error must NOT poison unknownOutcomeBodyHashes
    recordStreamingCardPostFailure(ds, slot, errNever, h1, 'starting');
    expect(hasUnknownOutcomeHistory(slot)).toBe(false);
    expect(hasDivergentUnknownOutcomeBody(slot, h2)).toBe(false);

    // Commit-unknown records h1 & firstUnknownOutcomeStatus='starting'
    recordStreamingCardPostFailure(ds, slot, err500, h1, 'starting');
    expect(hasUnknownOutcomeHistory(slot)).toBe(true);
    expect(slot.firstUnknownOutcomeStatus).toBe('starting');
    expect(hasDivergentUnknownOutcomeBody(slot, h1)).toBe(false);
    expect(hasDivergentUnknownOutcomeBody(slot, h2)).toBe(true);

    // Recording h2 keeps firstUnknownOutcomeStatus='starting'; even retrying h1 now diverges vs h2
    recordStreamingCardPostFailure(ds, slot, err500, h2, 'working');
    expect(slot.firstUnknownOutcomeStatus).toBe('starting');
    expect(hasDivergentUnknownOutcomeBody(slot, h1)).toBe(true);

    // Overflow past MAX_TRACKED_UNKNOWN_BODY_HASHES flips overflow bit
    for (let i = 3; i <= MAX_TRACKED_UNKNOWN_BODY_HASHES + 2; i++) {
      recordStreamingCardPostFailure(ds, slot, err500, hashStreamingCardBody(`body-${i}`), 'working');
    }
    expect(slot.unknownOutcomeOverflow).toBe(true);
    expect(hasDivergentUnknownOutcomeBody(slot, h1)).toBe(true);
  });

  it('converges canonical turnId onto streamCardPendingTurnId when pending', () => {
    expect(resolveCanonicalStreamingCardTurnId(
      { streamCardPending: true, streamCardPendingTurnId: 'om_turn_2' },
      'om_turn_1',
    )).toBe('om_turn_2');
    expect(resolveCanonicalStreamingCardTurnId(
      { streamCardPending: true, streamCardPendingTurnId: 'om_turn_2' },
      undefined,
    )).toBe('om_turn_2');
    expect(resolveCanonicalStreamingCardTurnId(
      { streamCardPending: false, streamCardPendingTurnId: 'om_stale' },
      'om_turn_3',
    )).toBe('om_turn_3');
    expect(resolveCanonicalStreamingCardTurnId(
      { streamCardPending: true, streamCardPendingTurnId: undefined },
      'om_turn_3',
    )).toBe('om_turn_3');
  });

  it('reuses a commit-unknown turn slot across canonicalTurnId skew within the same turnGeneration, rotates legacy migration across turnGenerations, and supports advance/snapshot/restore', () => {
    const ds = makeSession({ streamCardTurnGeneration: 1 });
    const err500 = classifyStreamingCardPostError({ isAxiosError: true, response: { status: 500, data: { code: 2200 } } });
    const base = {
      sessionId: 'sess_1',
      larkAppId: 'cli_app',
      anchorId: 'om_root',
      replyTargetKey: 'thread:om_root',
      turnGeneration: 1,
      canonicalTurnId: 'om_t1',
    };

    // Commit-unknown turn slot survives canonicalTurnId skew within the same turnGeneration
    const t1 = acquireTurnStreamingCardPostSlot(ds, base);
    recordStreamingCardPostFailure(ds, t1.slot, err500, hashStreamingCardBody('body1'), 'starting');
    const skewedRetry = acquireTurnStreamingCardPostSlot(ds, { ...base, canonicalTurnId: 'om_t1_fallback' });
    expect(skewedRetry.reused).toBe(true);
    expect(skewedRetry.slot.uuid).toBe(t1.slot.uuid);

    // Snapshot before speculative advance, then restore if refused
    const savedSlot = snapshotTurnStreamingCardPostSlot(ds);
    const manual1 = acquireManualStreamingCardPostSlot(ds, base);
    recordStreamingCardPostFailure(ds, manual1.slot, err500, hashStreamingCardBody('m1'), 'working');

    const nextGen = advancePendingStreamingCardTurn(ds, undefined);
    expect(nextGen).toBe(2);
    expect(ds.streamCardTurnGeneration).toBe(2);
    expect(ds.streamCardPending).toBe(true);
    expect(ds.streamCardPendingTurnId).toBeUndefined();
    // Manual slot from Turn 1 was cleared by advancePendingStreamingCardTurn
    expect(acquireManualStreamingCardPostSlot(ds, { ...base, turnGeneration: 1 }).reused).toBe(false);

    // Restore Turn 1's commit-unknown turn slot cleanly
    restoreTurnStreamingCardPostSlotIfUnchanged(ds, savedSlot);
    expect(acquireTurnStreamingCardPostSlot(ds, base).slot.uuid).toBe(t1.slot.uuid);

    // Legacy migration slot must rotate across turnGeneration changes
    const leg1 = acquireLegacyMigrationStreamingCardPostSlot(ds, {
      ...base,
      turnGeneration: 1,
      retireMessageId: 'om_leg_1',
    });
    recordStreamingCardPostFailure(ds, leg1.slot, err500, hashStreamingCardBody('leg1'), 'idle');
    const legSameGen = acquireLegacyMigrationStreamingCardPostSlot(ds, {
      ...base,
      turnGeneration: 1,
      retireMessageId: 'om_leg_1',
    });
    expect(legSameGen.reused).toBe(true);
    const legNextGen = acquireLegacyMigrationStreamingCardPostSlot(ds, {
      ...base,
      turnGeneration: 2,
      retireMessageId: 'om_leg_1',
    });
    expect(legNextGen.reused).toBe(false);
    expect(legNextGen.slot.uuid).not.toBe(leg1.slot.uuid);
  });

  it('preserves commit_unknown classification when an executeWithLarkGate retry fails with TOPIC_SEND_CHECK_FAILED or non-retryable 400 after an earlier HTTP 500', async () => {
    __testOnly_resetLarkGate();
    const prevMax = process.env.BOTMUX_LARK_GATE_RETRY_MAX_ATTEMPTS;
    const prevQps = process.env.BOTMUX_LARK_QPS;
    process.env.BOTMUX_LARK_GATE_RETRY_MAX_ATTEMPTS = '1';
    process.env.BOTMUX_LARK_QPS = '100000';
    try {
      let attempt = 0;
      let caught: unknown;
      try {
        await executeWithLarkGate('cli_prior_err_test', 'replyMessage', async () => {
          attempt += 1;
          if (attempt === 1) {
            throw Object.assign(new Error('HTTP 500'), {
              isAxiosError: true,
              response: { status: 500, data: { code: 2200, msg: 'internal error' } },
            });
          }
          throw new TopicSendError('TOPIC_SEND_CHECK_FAILED', 'lookup failed');
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TopicSendError);
      expect(classifyStreamingCardPostError(caught)).toEqual({
        kind: 'commit_unknown',
        mayHaveCommitted: true,
        suppressStaticFallback: true,
        isTargetUnavailable: false,
      });

      // Expired-error detector works cross-realm without importing client.ts
      expect(isMessageUpdateExpiredError(Object.assign(new Error('expired'), { name: 'MessageUpdateExpiredError' }))).toBe(true);
      expect(isMessageUpdateExpiredError({ response: { status: 400, data: { code: 230031 } } })).toBe(true);
      expect(isMessageUpdateExpiredError(new Error('other'))).toBe(false);
    } finally {
      if (prevMax === undefined) delete process.env.BOTMUX_LARK_GATE_RETRY_MAX_ATTEMPTS;
      else process.env.BOTMUX_LARK_GATE_RETRY_MAX_ATTEMPTS = prevMax;
      if (prevQps === undefined) delete process.env.BOTMUX_LARK_QPS;
      else process.env.BOTMUX_LARK_QPS = prevQps;
      __testOnly_resetLarkGate();
    }
  });
});
