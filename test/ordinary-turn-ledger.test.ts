import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetOrdinaryTurnLedgerCacheForTest,
  compactOrdinaryTurnLedger,
  limitOrdinaryTurnRecoveryPlanToClaimedBefore,
  markOrdinaryTurnAccepted,
  markOrdinaryTurnAttention,
  markOrdinaryTurnAttentionNotified,
  markOrdinaryTurnCommitted,
  markOrdinaryTurnIgnored,
  markOrdinaryTurnOutputDelivered,
  markOrdinaryTurnReplayScheduled,
  markOrdinaryTurnRouted,
  markOrdinaryTurnRunning,
  markOrdinaryTurnTerminal,
  ordinaryTurnRecoveryUuid,
  planOrdinaryTurnRecovery,
  prepareOrdinaryTurnClaim,
  prepareOrdinaryTurnOutput,
  readOrdinaryTurnRecord,
  selectOrdinaryTurnAttentionForDelivery,
  selectOrdinaryTurnPendingOutputForDelivery,
  ORDINARY_TURN_LEDGER_RETENTION_MS,
  ORDINARY_TURN_PROVIDER_DEDUPE_MS,
} from '../src/services/ordinary-turn-ledger.js';

const APP = 'cli_ordinary_ledger';
const T0 = Date.parse('2026-09-01T00:00:00.000Z');
let dataDir: string;

function prepare(messageId: string, now = T0): void {
  expect(prepareOrdinaryTurnClaim({
    dataDir,
    larkAppId: APP,
    messageId,
    payload: {
      message: {
        message_id: messageId,
        chat_id: 'oc_chat',
        chat_type: 'group',
        content: JSON.stringify({ text: 'do the thing' }),
      },
      sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
    },
    now,
  })).toBe('created');
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-ordinary-ledger-'));
  _resetOrdinaryTurnLedgerCacheForTest();
});

afterEach(() => {
  _resetOrdinaryTurnLedgerCacheForTest();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('ordinary turn durable ledger', () => {
  it('dedupes canonical-equivalent payloads and fails closed on a message-id payload conflict', () => {
    const messageId = 'om_payload_identity';
    expect(prepareOrdinaryTurnClaim({
      dataDir,
      larkAppId: APP,
      messageId,
      payload: {
        message: { message_id: messageId, content: '{"text":"first"}' },
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
      },
      now: T0,
    })).toBe('created');

    expect(prepareOrdinaryTurnClaim({
      dataDir,
      larkAppId: APP,
      messageId,
      payload: {
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
        message: { content: '{"text":"first"}', message_id: messageId },
      },
      now: T0 + 1,
    })).toBe('duplicate');

    expect(() => prepareOrdinaryTurnClaim({
      dataDir,
      larkAppId: APP,
      messageId,
      payload: {
        message: { message_id: messageId, content: '{"text":"changed"}' },
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
      },
      now: T0 + 2,
    })).toThrow(/payload conflict/i);
    expect(readOrdinaryTurnRecord(dataDir, APP, messageId)?.attention?.reason)
      .toBe('message_id_payload_conflict');
  });

  it('derives one stable provider UUID for ACK-lost attention retries', () => {
    const first = ordinaryTurnRecoveryUuid('attention', APP, 'om_attention_uuid');
    expect(ordinaryTurnRecoveryUuid('attention', APP, 'om_attention_uuid')).toBe(first);
    expect(first).toMatch(/^oa_[0-9a-f]{47}$/);
    expect(ordinaryTurnRecoveryUuid('attention', APP, 'om_other')).not.toBe(first);
    expect(ordinaryTurnRecoveryUuid('output', APP, 'om_attention_uuid')).not.toBe(first);
  });

  it('treats a notified attention as settled and never replays its original input', () => {
    prepare('om_attention_settled');
    markOrdinaryTurnAttention({
      dataDir,
      larkAppId: APP,
      messageId: 'om_attention_settled',
      reason: 'payload_or_execution_ambiguous',
      now: T0 + 1,
    });
    markOrdinaryTurnAttentionNotified({
      dataDir,
      larkAppId: APP,
      messageId: 'om_attention_settled',
      providerMessageId: 'om_attention_card',
      now: T0 + 2,
    });

    expect(planOrdinaryTurnRecovery(dataDir, APP, T0 + 3)).toEqual({
      replays: [],
      attentions: [],
      pendingOutputs: [],
    });
  });

  it('keeps boot replay, output, and attention work strictly before the dispatcher cutoff', () => {
    prepare('om_before_cutoff', T0);
    prepare('om_at_cutoff', T0 + 1);
    const before = readOrdinaryTurnRecord(dataDir, APP, 'om_before_cutoff')!;
    const equal = readOrdinaryTurnRecord(dataDir, APP, 'om_at_cutoff')!;
    const bounded = limitOrdinaryTurnRecoveryPlanToClaimedBefore({
      replays: [before, equal],
      attentions: [before, equal],
      pendingOutputs: [before, equal],
    }, T0 + 1);

    expect(bounded.replays.map(record => record.messageId)).toEqual(['om_before_cutoff']);
    expect(bounded.attentions.map(record => record.messageId)).toEqual(['om_before_cutoff']);
    expect(bounded.pendingOutputs.map(record => record.messageId)).toEqual(['om_before_cutoff']);
  });

  it('replays a received-only claim once, then fails closed if replay scheduling crashes', () => {
    prepare('om_received_only');
    _resetOrdinaryTurnLedgerCacheForTest(); // daemon crashed after claim, before work

    let plan = planOrdinaryTurnRecovery(dataDir, APP, T0 + 10);
    expect(plan.replays.map(record => record.messageId)).toEqual(['om_received_only']);
    expect(plan.attentions).toEqual([]);

    markOrdinaryTurnReplayScheduled({
      dataDir,
      larkAppId: APP,
      messageId: 'om_received_only',
      now: T0 + 1,
    });
    _resetOrdinaryTurnLedgerCacheForTest(); // second crash after scheduling

    plan = planOrdinaryTurnRecovery(dataDir, APP, T0 + 10);
    expect(plan.replays).toEqual([]);
    expect(plan.attentions.map(record => record.messageId)).toEqual(['om_received_only']);
  });

  it.each(['routed', 'accepted', 'committed', 'running'] as const)(
    'never blind-replays a %s turn whose side effects may have started',
    (stage) => {
      const messageId = `om_${stage}`;
      prepare(messageId);
      markOrdinaryTurnRouted({
        dataDir,
        larkAppId: APP,
        messageId,
        routing: { chatId: 'oc_chat', scope: 'thread', anchor: messageId },
        now: T0 + 1,
      });
      if (stage === 'accepted' || stage === 'committed' || stage === 'running') {
        markOrdinaryTurnAccepted({
          dataDir,
          larkAppId: APP,
          messageId,
          turnId: messageId,
          sessionId: 'session-1',
          now: T0 + 2,
        });
      }
      if (stage === 'committed' || stage === 'running') {
        markOrdinaryTurnCommitted({
          dataDir,
          larkAppId: APP,
          turnId: messageId,
          sessionId: 'session-1',
          workerGeneration: 4,
          now: T0 + 3,
        });
      }
      if (stage === 'running') {
        markOrdinaryTurnRunning({
          dataDir,
          larkAppId: APP,
          turnId: messageId,
          workerGeneration: 4,
          now: T0 + 4,
        });
      }

      _resetOrdinaryTurnLedgerCacheForTest();
      const plan = planOrdinaryTurnRecovery(dataDir, APP, T0 + 10);
      expect(plan.replays).toEqual([]);
      expect(plan.attentions.map(record => record.messageId)).toContain(messageId);
    },
  );

  it('keeps a failed final output as a durable outbox item with the original provider uuid', () => {
    prepare('om_outbox');
    markOrdinaryTurnRouted({
      dataDir,
      larkAppId: APP,
      messageId: 'om_outbox',
      routing: { chatId: 'oc_chat', scope: 'thread', anchor: 'om_outbox' },
      now: T0 + 1,
    });
    markOrdinaryTurnAccepted({
      dataDir,
      larkAppId: APP,
      messageId: 'om_outbox',
      turnId: 'om_outbox',
      sessionId: 'session-1',
      now: T0 + 2,
    });

    expect(prepareOrdinaryTurnOutput({
      dataDir,
      larkAppId: APP,
      turnId: 'om_outbox',
      delivery: {
        rootId: 'om_outbox',
        content: '{"schema":"2.0"}',
        msgType: 'interactive',
        turnId: 'om_outbox',
        options: {
          uuid: 'bf_original_uuid',
          replyTarget: { mode: 'thread', rootMessageId: 'om_outbox' },
        },
      },
      now: T0 + 3,
    })).toBe('pending');

    _resetOrdinaryTurnLedgerCacheForTest(); // retry after daemon restart
    let plan = planOrdinaryTurnRecovery(dataDir, APP, T0 + 10);
    expect(plan.pendingOutputs).toHaveLength(1);
    expect(plan.pendingOutputs[0].output?.delivery.options?.uuid).toBe('bf_original_uuid');

    markOrdinaryTurnOutputDelivered({
      dataDir,
      larkAppId: APP,
      turnId: 'om_outbox',
      providerMessageId: 'om_answer',
      now: T0 + 4,
    });
    _resetOrdinaryTurnLedgerCacheForTest();
    plan = planOrdinaryTurnRecovery(dataDir, APP, T0 + 10);
    expect(plan.pendingOutputs).toEqual([]);
    expect(plan.attentions).toEqual([]);
  });

  it('fails closed instead of retrying a pending output after the provider UUID dedupe window', () => {
    prepare('om_expired_outbox');
    markOrdinaryTurnAccepted({
      dataDir,
      larkAppId: APP,
      messageId: 'om_expired_outbox',
      turnId: 'om_expired_outbox',
      now: T0 + 1,
    });
    prepareOrdinaryTurnOutput({
      dataDir,
      larkAppId: APP,
      turnId: 'om_expired_outbox',
      delivery: {
        rootId: 'om_expired_outbox',
        content: 'possibly accepted already',
        turnId: 'om_expired_outbox',
        options: { uuid: 'bf_expiring_uuid' },
      },
      now: T0 + 2,
    });

    const withinWindow = planOrdinaryTurnRecovery(dataDir, APP, T0 + 59 * 60_000);
    expect(withinWindow.pendingOutputs.map(record => record.messageId))
      .toEqual(['om_expired_outbox']);

    const expired = planOrdinaryTurnRecovery(dataDir, APP, T0 + 60 * 60_000 + 3);
    expect(expired.pendingOutputs).toEqual([]);
    expect(expired.attentions).toHaveLength(1);
    expect(expired.attentions[0].attention?.reason)
      .toBe('pending_output_provider_dedupe_expired');
  });

  it('compacts a pending output after its expired-dedupe attention is durably notified', () => {
    prepare('om_expired_outbox_notified');
    markOrdinaryTurnAccepted({
      dataDir,
      larkAppId: APP,
      messageId: 'om_expired_outbox_notified',
      turnId: 'om_expired_outbox_notified',
      now: T0 + 1,
    });
    prepareOrdinaryTurnOutput({
      dataDir,
      larkAppId: APP,
      turnId: 'om_expired_outbox_notified',
      delivery: {
        rootId: 'om_expired_outbox_notified',
        content: 'possibly accepted already',
        turnId: 'om_expired_outbox_notified',
        options: { uuid: 'bf_expired_notified' },
      },
      now: T0 + 2,
    });
    markOrdinaryTurnAttention({
      dataDir,
      larkAppId: APP,
      messageId: 'om_expired_outbox_notified',
      reason: 'pending_output_provider_dedupe_expired',
      now: T0 + ORDINARY_TURN_PROVIDER_DEDUPE_MS + 3,
    });
    markOrdinaryTurnAttentionNotified({
      dataDir,
      larkAppId: APP,
      messageId: 'om_expired_outbox_notified',
      providerMessageId: 'om_attention_card',
      now: T0 + ORDINARY_TURN_PROVIDER_DEDUPE_MS + 4,
    });

    expect(compactOrdinaryTurnLedger({
      dataDir,
      larkAppId: APP,
      now: T0 + ORDINARY_TURN_PROVIDER_DEDUPE_MS + ORDINARY_TURN_LEDGER_RETENTION_MS + 5,
    })).toBe(1);
    expect(readOrdinaryTurnRecord(dataDir, APP, 'om_expired_outbox_notified'))
      .toBeUndefined();
  });

  it('revalidates a planned pending output before delivery and skips a live-settled row', () => {
    prepare('om_stale_output_plan');
    prepareOrdinaryTurnOutput({
      dataDir,
      larkAppId: APP,
      turnId: 'om_stale_output_plan',
      delivery: {
        rootId: 'om_stale_output_plan',
        content: 'answer',
        turnId: 'om_stale_output_plan',
        options: { uuid: 'bf_stale_output_plan' },
      },
      now: T0 + 1,
    });
    expect(planOrdinaryTurnRecovery(dataDir, APP, T0 + 2).pendingOutputs).toHaveLength(1);

    // The live final-output path wins after the drain took its plan snapshot.
    markOrdinaryTurnOutputDelivered({
      dataDir,
      larkAppId: APP,
      turnId: 'om_stale_output_plan',
      providerMessageId: 'om_live_answer',
      now: T0 + 3,
    });

    expect(selectOrdinaryTurnPendingOutputForDelivery({
      dataDir,
      larkAppId: APP,
      messageId: 'om_stale_output_plan',
      now: T0 + 4,
    })).toBeUndefined();
  });

  it('rechecks the provider dedupe window after planning instead of sending a delayed output', () => {
    prepare('om_delayed_output_plan');
    prepareOrdinaryTurnOutput({
      dataDir,
      larkAppId: APP,
      turnId: 'om_delayed_output_plan',
      delivery: {
        rootId: 'om_delayed_output_plan',
        content: 'possibly accepted',
        turnId: 'om_delayed_output_plan',
        options: { uuid: 'bf_delayed_output_plan' },
      },
      now: T0 + 1,
    });
    expect(planOrdinaryTurnRecovery(dataDir, APP, T0 + 2).pendingOutputs).toHaveLength(1);

    expect(selectOrdinaryTurnPendingOutputForDelivery({
      dataDir,
      larkAppId: APP,
      messageId: 'om_delayed_output_plan',
      now: T0 + 60 * 60_000 + 2,
    })).toBeUndefined();
    expect(selectOrdinaryTurnAttentionForDelivery({
      dataDir,
      larkAppId: APP,
      messageId: 'om_delayed_output_plan',
      allowInferred: false,
      now: T0 + 60 * 60_000 + 2,
    })?.attention?.reason).toBe('pending_output_provider_dedupe_expired');
  });

  it('skips a stale periodic attention plan after the live path notifies or clears it', () => {
    prepare('om_stale_attention_notified');
    markOrdinaryTurnAttention({
      dataDir,
      larkAppId: APP,
      messageId: 'om_stale_attention_notified',
      reason: 'fixture_attention',
      now: T0 + 1,
    });
    expect(planOrdinaryTurnRecovery(dataDir, APP, T0 + 2).attentions).toHaveLength(1);
    markOrdinaryTurnAttentionNotified({
      dataDir,
      larkAppId: APP,
      messageId: 'om_stale_attention_notified',
      providerMessageId: 'om_live_attention',
      now: T0 + 3,
    });
    expect(selectOrdinaryTurnAttentionForDelivery({
      dataDir,
      larkAppId: APP,
      messageId: 'om_stale_attention_notified',
      allowInferred: false,
      now: T0 + 4,
    })).toBeUndefined();

    prepare('om_stale_attention_cleared');
    markOrdinaryTurnAttention({
      dataDir,
      larkAppId: APP,
      messageId: 'om_stale_attention_cleared',
      reason: 'processing_failed_before_route',
      now: T0 + 1,
    });
    markOrdinaryTurnRouted({
      dataDir,
      larkAppId: APP,
      messageId: 'om_stale_attention_cleared',
      routing: { chatId: 'oc_chat', scope: 'thread', anchor: 'om_stale_attention_cleared' },
      now: T0 + 2,
    });
    expect(selectOrdinaryTurnAttentionForDelivery({
      dataDir,
      larkAppId: APP,
      messageId: 'om_stale_attention_cleared',
      allowInferred: false,
      now: T0 + 3,
    })).toBeUndefined();
    expect(selectOrdinaryTurnAttentionForDelivery({
      dataDir,
      larkAppId: APP,
      messageId: 'om_stale_attention_cleared',
      allowInferred: true,
      now: T0 + 3,
    })?.messageId).toBe('om_stale_attention_cleared');
  });

  it('does not regress a delivered output when turn_terminal arrives later', () => {
    prepare('om_output_before_terminal');
    prepareOrdinaryTurnOutput({
      dataDir,
      larkAppId: APP,
      turnId: 'om_output_before_terminal',
      delivery: {
        rootId: 'om_output_before_terminal',
        content: 'answer',
        msgType: 'text',
        turnId: 'om_output_before_terminal',
        options: { uuid: 'bf_ordering' },
      },
      now: T0 + 1,
    });
    markOrdinaryTurnOutputDelivered({
      dataDir,
      larkAppId: APP,
      turnId: 'om_output_before_terminal',
      providerMessageId: 'om_answer',
      now: T0 + 2,
    });
    markOrdinaryTurnTerminal({
      dataDir,
      larkAppId: APP,
      turnId: 'om_output_before_terminal',
      status: 'completed',
      now: T0 + 3,
    });

    expect(readOrdinaryTurnRecord(dataDir, APP, 'om_output_before_terminal')?.output).toMatchObject({
      status: 'delivered',
      providerMessageId: 'om_answer',
    });
    expect(planOrdinaryTurnRecovery(dataDir, APP, T0 + 10)).toMatchObject({
      replays: [],
      attentions: [],
      pendingOutputs: [],
    });
  });

  it('accepts positive nothing-to-send evidence as a terminal with no recovery action', () => {
    prepare('om_silent');
    markOrdinaryTurnRouted({
      dataDir,
      larkAppId: APP,
      messageId: 'om_silent',
      routing: { chatId: 'oc_chat', scope: 'thread', anchor: 'om_silent' },
      now: T0 + 1,
    });
    markOrdinaryTurnTerminal({
      dataDir,
      larkAppId: APP,
      turnId: 'om_silent',
      status: 'completed',
      outputDisposition: 'nothing_to_send',
      now: T0 + 2,
    });

    expect(planOrdinaryTurnRecovery(dataDir, APP, T0 + 10)).toMatchObject({
      replays: [],
      attentions: [],
      pendingOutputs: [],
    });
  });

  it('clears an earlier ignored settlement when authorization or a deferred flush later routes it', () => {
    prepare('om_deferred');
    markOrdinaryTurnIgnored({
      dataDir,
      larkAppId: APP,
      messageId: 'om_deferred',
      now: T0 + 1,
    });
    expect(planOrdinaryTurnRecovery(dataDir, APP, T0 + 2)).toMatchObject({
      replays: [],
      attentions: [],
      pendingOutputs: [],
    });

    markOrdinaryTurnRouted({
      dataDir,
      larkAppId: APP,
      messageId: 'om_deferred',
      routing: { chatId: 'oc_chat', scope: 'thread', anchor: 'om_deferred' },
      now: T0 + 3,
    });

    expect(readOrdinaryTurnRecord(dataDir, APP, 'om_deferred')?.terminal).toBeUndefined();
    expect(planOrdinaryTurnRecovery(dataDir, APP, T0 + 4).attentions.map(record => record.messageId))
      .toEqual(['om_deferred']);
  });

  it('updates the explicit turn owner before an exact message-id collision', () => {
    prepare('om_colliding_anchor', T0);
    prepare('om_actual_input', T0 + 1);
    markOrdinaryTurnAccepted({
      dataDir,
      larkAppId: APP,
      messageId: 'om_actual_input',
      turnId: 'om_colliding_anchor',
      sessionId: 'session-group-1',
      now: T0 + 2,
    });

    markOrdinaryTurnTerminal({
      dataDir,
      larkAppId: APP,
      turnId: 'om_colliding_anchor',
      status: 'failed',
      errorCode: 'fixture_failure',
      now: T0 + 3,
    });

    expect(readOrdinaryTurnRecord(dataDir, APP, 'om_colliding_anchor')?.terminal).toBeUndefined();
    expect(readOrdinaryTurnRecord(dataDir, APP, 'om_actual_input')?.terminal).toMatchObject({
      status: 'failed',
      errorCode: 'fixture_failure',
    });
  });

  it('fails closed when two ledger rows explicitly claim the same turn id', () => {
    prepare('om_owner_a', T0);
    prepare('om_owner_b', T0 + 1);
    markOrdinaryTurnAccepted({
      dataDir,
      larkAppId: APP,
      messageId: 'om_owner_a',
      turnId: 'om_shared_turn',
      now: T0 + 2,
    });
    markOrdinaryTurnAccepted({
      dataDir,
      larkAppId: APP,
      messageId: 'om_owner_b',
      turnId: 'om_shared_turn',
      now: T0 + 3,
    });

    expect(() => markOrdinaryTurnTerminal({
      dataDir,
      larkAppId: APP,
      turnId: 'om_shared_turn',
      status: 'failed',
      now: T0 + 4,
    })).toThrow(/ambiguous.*turn/i);
    expect(readOrdinaryTurnRecord(dataDir, APP, 'om_owner_a')?.terminal).toBeUndefined();
    expect(readOrdinaryTurnRecord(dataDir, APP, 'om_owner_b')?.terminal).toBeUndefined();
  });

  it('compacts only settled rows after retention and keeps every unresolved safety fence', () => {
    prepare('om_delivered', T0);
    prepareOrdinaryTurnOutput({
      dataDir,
      larkAppId: APP,
      turnId: 'om_delivered',
      delivery: { rootId: 'om_delivered', content: 'done', turnId: 'om_delivered' },
      now: T0 + 1,
    });
    markOrdinaryTurnOutputDelivered({
      dataDir,
      larkAppId: APP,
      turnId: 'om_delivered',
      providerMessageId: 'om_answer',
      now: T0 + 2,
    });

    prepare('om_attention_notified', T0);
    markOrdinaryTurnAttention({
      dataDir,
      larkAppId: APP,
      messageId: 'om_attention_notified',
      reason: 'fixture_attention',
      now: T0 + 1,
    });
    markOrdinaryTurnAttentionNotified({
      dataDir,
      larkAppId: APP,
      messageId: 'om_attention_notified',
      providerMessageId: 'om_attention_card',
      now: T0 + 2,
    });

    prepare('om_ignored', T0);
    markOrdinaryTurnIgnored({
      dataDir,
      larkAppId: APP,
      messageId: 'om_ignored',
      now: T0 + 2,
    });

    prepare('om_unresolved_route', T0);
    markOrdinaryTurnRouted({
      dataDir,
      larkAppId: APP,
      messageId: 'om_unresolved_route',
      routing: { chatId: 'oc_chat', scope: 'thread', anchor: 'om_unresolved_route' },
      now: T0 + 2,
    });
    prepare('om_attention_pending', T0);
    markOrdinaryTurnAttention({
      dataDir,
      larkAppId: APP,
      messageId: 'om_attention_pending',
      reason: 'must_not_evict',
      now: T0 + 2,
    });

    const compactAt = T0 + 2 + ORDINARY_TURN_LEDGER_RETENTION_MS;
    expect(compactOrdinaryTurnLedger({ dataDir, larkAppId: APP, now: compactAt })).toBe(3);
    _resetOrdinaryTurnLedgerCacheForTest();

    expect(readOrdinaryTurnRecord(dataDir, APP, 'om_delivered')).toBeUndefined();
    expect(readOrdinaryTurnRecord(dataDir, APP, 'om_attention_notified')).toBeUndefined();
    expect(readOrdinaryTurnRecord(dataDir, APP, 'om_ignored')).toBeUndefined();
    expect(readOrdinaryTurnRecord(dataDir, APP, 'om_unresolved_route')).toBeDefined();
    expect(readOrdinaryTurnRecord(dataDir, APP, 'om_attention_pending')).toBeDefined();

    // Once the matching seen-store TTL has elapsed, the same provider message
    // id can create a fresh lifecycle instead of being rejected forever.
    expect(prepareOrdinaryTurnClaim({
      dataDir,
      larkAppId: APP,
      messageId: 'om_ignored',
      payload: { message: { message_id: 'om_ignored' } },
      now: compactAt + 1,
    })).toBe('created');
  });
});
