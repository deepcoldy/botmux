import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  CurrentTurnProvenanceError,
  resolveCurrentTurnProvenance,
} from '../src/core/current-turn-provenance.js';
import { readProcessStartIdentity } from '../src/core/session-marker.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const SCHED_TASK_ID = 'abcdef12';
const SCHED_TURN_ID = `schedule:${SCHED_TASK_ID}:12345678-1234-1234-1234-123456789abc`;

describe('resolveCurrentTurnProvenance', () => {
  let root: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-turn-provenance-'));
    // Mirror the real layout: sessions under `<root>/sessions`, so the per-bot
    // schedules.json resolves to `<root>/bots/<appId>/schedules.json` (cleaned
    // with root — never the shared /tmp/bots).
    dataDir = join(root, 'sessions');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeMarker(sessionId: string, turnId: string): void {
    const procStart = readProcessStartIdentity(process.pid);
    if (!procStart) throw new Error('test process start identity unavailable');
    writeFileSync(
      join(dataDir, '.botmux-cli-pids', String(process.pid)),
      JSON.stringify({ sessionId, turnId, procStart }),
    );
  }

  function writeSession(overrides: Record<string, unknown> = {}): void {
    const session = {
      sessionId: 'sess-1',
      status: 'active',
      scope: 'thread',
      larkAppId: 'cli_real',
      chatId: 'oc_real',
      chatType: 'p2p',
      rootMessageId: 'om_real_root',
      ownerOpenId: 'ou_owner_a',
      lastCallerOpenId: 'ou_caller_b',
      quoteTargetId: 'turn-current',
      ...overrides,
    };
    // The durable session record lives in the per-bot SQLite store; the frozen
    // `sessions-<appId>.json` is only an import source and is never read here.
    seedPersistedSessionRows(dataDir, 'cli_real', { [session.sessionId]: session });
  }

  function writeScheduledTask(overrides: Record<string, unknown> = {}): void {
    const dir = join(dirname(dataDir), 'bots', 'cli_real');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'schedules.json'), JSON.stringify({
      [SCHED_TASK_ID]: {
        id: SCHED_TASK_ID,
        name: 'nightly',
        chatId: 'oc_real',
        larkAppId: 'cli_real',
        ownerOpenId: 'ou_task_owner',
        enabled: true,
        ...overrides,
      },
    }));
  }

  it('authenticates the current caller, not the static session owner', () => {
    writeMarker('sess-1', 'turn-current');
    writeSession();

    expect(resolveCurrentTurnProvenance({
      dataDir,
      envSessionId: 'sess-1',
      startPid: process.pid,
    })).toEqual({
      sessionId: 'sess-1',
      turnId: 'turn-current',
      callerOpenId: 'ou_caller_b',
      larkAppId: 'cli_real',
      chatId: 'oc_real',
      chatType: 'p2p',
      rootMessageId: 'om_real_root',
    });
  });

  it('uses the matching chat-scope reply target as the real root', () => {
    writeMarker('sess-1', 'turn-current');
    writeSession({
      scope: 'chat',
      currentReplyTarget: { rootMessageId: 'om_alias_root', turnId: 'turn-current' },
    });

    expect(resolveCurrentTurnProvenance({ dataDir, startPid: process.pid })).toMatchObject({
      rootMessageId: 'om_alias_root',
      callerOpenId: 'ou_caller_b',
    });
  });

  it('fails closed when the process marker belongs to a stale turn', () => {
    writeMarker('sess-1', 'turn-stale');
    writeSession();

    expect(() => resolveCurrentTurnProvenance({
      dataDir,
      envSessionId: 'sess-1',
      startPid: process.pid,
    })).toThrow(/turn-stale.*turn-current/);
  });

  it('fails closed when marker procStart does not match the live ancestor', () => {
    writeFileSync(
      join(dataDir, '.botmux-cli-pids', String(process.pid)),
      JSON.stringify({ sessionId: 'sess-1', turnId: 'turn-current', procStart: 'stale-process' }),
    );
    writeSession();
    expect(() => resolveCurrentTurnProvenance({
      dataDir,
      envSessionId: 'sess-1',
      startPid: process.pid,
    })).toThrow(/已过期或 PID 被复用/);
  });

  it('rejects legacy markers without a process-birth identity for mutations', () => {
    writeFileSync(
      join(dataDir, '.botmux-cli-pids', String(process.pid)),
      JSON.stringify({ sessionId: 'sess-1', turnId: 'turn-current' }),
    );
    writeSession();
    expect(() => resolveCurrentTurnProvenance({
      dataDir,
      envSessionId: 'sess-1',
      startPid: process.pid,
    })).toThrow(/后台进程信息不完整/);
  });

  it('explains an idle marker without trusting the inherited session env', () => {
    const procStart = readProcessStartIdentity(process.pid);
    if (!procStart) throw new Error('test process start identity unavailable');
    writeFileSync(
      join(dataDir, '.botmux-cli-pids', String(process.pid)),
      JSON.stringify({ sessionId: 'sess-1', turnId: null, procStart }),
    );
    writeSession();
    expect(() => resolveCurrentTurnProvenance({
      dataDir,
      envSessionId: 'sess-1',
      startPid: process.pid,
    })).toThrow(/还没有绑定到这条消息.*重新发送一次/);
  });

  it('fails closed for a detached in-session invocation instead of trusting env', () => {
    expect(() => resolveCurrentTurnProvenance({
      dataDir,
      envSessionId: 'sess-1',
      startPid: process.pid,
    })).toThrow(CurrentTurnProvenanceError);
  });

  it('returns null only for a genuine standalone invocation', () => {
    expect(resolveCurrentTurnProvenance({ dataDir, startPid: process.pid })).toBeNull();
  });

  describe('scheduled turns (schedule: prefix)', () => {
    it('authenticates a scheduled turn as the task owner without human inbound fields', () => {
      writeMarker('sess-1', SCHED_TURN_ID);
      // A fresh scheduled session has NO quoteTargetId/lastCallerOpenId.
      writeSession({ quoteTargetId: undefined, lastCallerOpenId: undefined });
      writeScheduledTask();

      expect(resolveCurrentTurnProvenance({
        dataDir,
        envSessionId: 'sess-1',
        startPid: process.pid,
      })).toEqual({
        sessionId: 'sess-1',
        turnId: SCHED_TURN_ID,
        callerOpenId: 'ou_task_owner',
        larkAppId: 'cli_real',
        chatId: 'oc_real',
        chatType: 'p2p',
        rootMessageId: 'om_real_root',
      });
    });

    it('uses the chat-scope reply target root for a scheduled turn', () => {
      writeMarker('sess-1', SCHED_TURN_ID);
      writeSession({
        scope: 'chat',
        quoteTargetId: undefined,
        lastCallerOpenId: undefined,
        currentReplyTarget: { rootMessageId: 'om_shared_topic', turnId: 'some-other-turn' },
      });
      writeScheduledTask();

      expect(resolveCurrentTurnProvenance({ dataDir, startPid: process.pid })).toMatchObject({
        rootMessageId: 'om_shared_topic',
        callerOpenId: 'ou_task_owner',
      });
    });

    it('rejects a scheduled turn whose task is missing', () => {
      writeMarker('sess-1', SCHED_TURN_ID);
      writeSession({ quoteTargetId: undefined, lastCallerOpenId: undefined });

      expect(() => resolveCurrentTurnProvenance({
        dataDir,
        envSessionId: 'sess-1',
        startPid: process.pid,
      })).toThrow(/不存在或已被删除/);
    });

    it('rejects a scheduled turn whose task has no ownerOpenId (legacy task)', () => {
      writeMarker('sess-1', SCHED_TURN_ID);
      writeSession({ quoteTargetId: undefined, lastCallerOpenId: undefined });
      writeScheduledTask({ ownerOpenId: undefined });

      expect(() => resolveCurrentTurnProvenance({
        dataDir,
        envSessionId: 'sess-1',
        startPid: process.pid,
      })).toThrow(/缺少创建者身份/);
    });

    it('rejects a scheduled turn whose task is disabled', () => {
      writeMarker('sess-1', SCHED_TURN_ID);
      writeSession({ quoteTargetId: undefined, lastCallerOpenId: undefined });
      writeScheduledTask({ enabled: false });

      expect(() => resolveCurrentTurnProvenance({
        dataDir,
        envSessionId: 'sess-1',
        startPid: process.pid,
      })).toThrow(/已被禁用/);
    });

    it('authenticates the exact live turn after its one-shot task auto-completes', () => {
      writeMarker('sess-1', SCHED_TURN_ID);
      writeSession({ quoteTargetId: undefined, lastCallerOpenId: undefined });
      writeScheduledTask({
        enabled: false,
        disabledReason: 'once_completed',
        parsed: { kind: 'once', runAt: '2026-09-20T03:00:00.000Z', display: 'once' },
      });

      expect(resolveCurrentTurnProvenance({
        dataDir,
        envSessionId: 'sess-1',
        startPid: process.pid,
        isScheduledTurnLive: turnId => turnId === SCHED_TURN_ID,
      })).toMatchObject({
        turnId: SCHED_TURN_ID,
        callerOpenId: 'ou_task_owner',
      });
    });

    it('exposes task_disabled structurally when exact liveness is absent', () => {
      writeMarker('sess-1', SCHED_TURN_ID);
      writeSession({ quoteTargetId: undefined, lastCallerOpenId: undefined });
      writeScheduledTask({
        enabled: false,
        disabledReason: 'once_completed',
        parsed: { kind: 'once', runAt: '2026-09-20T03:00:00.000Z', display: 'once' },
      });

      try {
        resolveCurrentTurnProvenance({
          dataDir, envSessionId: 'sess-1', startPid: process.pid,
        });
        throw new Error('expected provenance rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(CurrentTurnProvenanceError);
        expect((error as CurrentTurnProvenanceError).scheduledTurnAuthError).toBe('task_disabled');
      }
    });

    it('rejects a scheduled turn bound to a different chat', () => {
      writeMarker('sess-1', SCHED_TURN_ID);
      writeSession({ quoteTargetId: undefined, lastCallerOpenId: undefined });
      writeScheduledTask({ chatId: 'oc_other' });

      expect(() => resolveCurrentTurnProvenance({
        dataDir,
        envSessionId: 'sess-1',
        startPid: process.pid,
      })).toThrow(CurrentTurnProvenanceError);
    });

    it('still requires the human generation join for non-scheduled turns', () => {
      // Regression guard: the exemption must not widen ordinary turns.
      writeMarker('sess-1', 'turn-stale');
      writeSession();

      expect(() => resolveCurrentTurnProvenance({
        dataDir,
        envSessionId: 'sess-1',
        startPid: process.pid,
      })).toThrow(/turn-stale.*turn-current/);
    });
  });

  describe('queued follow-up window (type-ahead)', () => {
    // submitQueuedMessage advances the single quote/reply slots to the queued
    // message as soon as it is accepted, while the running turn's marker still
    // points at this turn's anchor. The per-turn registry is the only record
    // that still names the running turn. This is the exact shape a
    // session-group (p2pMode=group) first turn takes: anchored on the bot's
    // in-group intro message while the user keeps messaging in the group.
    const humanEntry = (openId: string, extra: Record<string, unknown> = {}) => ({
      senderOpenId: openId,
      participants: [{ openId, isBot: false }],
      updatedAt: '2026-10-19T08:00:00.000Z',
      ...extra,
    });

    it('authenticates the running turn from the per-turn registry when quote slots moved on', () => {
      writeMarker('sess-1', 'om_intro_anchor');
      writeSession({
        scope: 'chat',
        chatType: 'group',
        rootMessageId: undefined,
        quoteTargetId: 'om_queued_followup',
        lastCallerOpenId: 'ou_followup_sender',
        currentReplyTarget: { turnId: 'om_queued_followup' },
        replyTargets: {
          om_intro_anchor: humanEntry('ou_caller_b'),
          om_queued_followup: humanEntry('ou_followup_sender'),
        },
      });

      expect(resolveCurrentTurnProvenance({
        dataDir,
        envSessionId: 'sess-1',
        startPid: process.pid,
      })).toEqual({
        sessionId: 'sess-1',
        turnId: 'om_intro_anchor',
        // THIS turn's recorded sender, not the queued follow-up's.
        callerOpenId: 'ou_caller_b',
        larkAppId: 'cli_real',
        chatId: 'oc_real',
        chatType: 'group',
      });
    });

    it('keeps the thread-scope root on the registry fallback', () => {
      writeMarker('sess-1', 'om_turn_current');
      writeSession({
        quoteTargetId: 'om_queued_followup',
        lastCallerOpenId: 'ou_followup_sender',
        replyTargets: {
          om_turn_current: humanEntry('ou_caller_b'),
        },
      });

      expect(resolveCurrentTurnProvenance({ dataDir, startPid: process.pid })).toMatchObject({
        callerOpenId: 'ou_caller_b',
        rootMessageId: 'om_real_root',
      });
    });

    it('uses the registry root for a chat-scope turn folded into a topic', () => {
      writeMarker('sess-1', 'om_turn_current');
      writeSession({
        scope: 'chat',
        chatType: 'group',
        quoteTargetId: 'om_queued_followup',
        currentReplyTarget: { turnId: 'om_queued_followup', rootMessageId: 'om_other_root' },
        replyTargets: {
          om_turn_current: humanEntry('ou_caller_b', { rootMessageId: 'om_alias_root' }),
        },
      });

      expect(resolveCurrentTurnProvenance({ dataDir, startPid: process.pid })).toMatchObject({
        callerOpenId: 'ou_caller_b',
        rootMessageId: 'om_alias_root',
      });
    });

    it('still fails closed when the registry has no record of the marker turn', () => {
      writeMarker('sess-1', 'om_turn_stale');
      writeSession({
        quoteTargetId: 'om_queued_followup',
        replyTargets: {
          om_queued_followup: humanEntry('ou_caller_b'),
        },
      });

      expect(() => resolveCurrentTurnProvenance({
        dataDir,
        envSessionId: 'sess-1',
        startPid: process.pid,
      })).toThrow(/om_turn_stale.*om_queued_followup/);
    });

    it('fails closed when the registry entry carries no human sender', () => {
      writeMarker('sess-1', 'om_turn_current');
      writeSession({
        quoteTargetId: 'om_queued_followup',
        replyTargets: {
          om_turn_current: { updatedAt: '2026-10-19T08:00:00.000Z' },
        },
      });

      expect(() => resolveCurrentTurnProvenance({
        dataDir,
        envSessionId: 'sess-1',
        startPid: process.pid,
      })).toThrow(/缺少 senderOpenId/);
    });

    it.each([
      ['participants missing', { senderOpenId: 'ou_caller_b', updatedAt: '2026-10-19T08:00:00.000Z' }],
      ['sender marked bot in the window', { senderOpenId: 'ou_caller_b', participants: [{ openId: 'ou_caller_b', isBot: true }], updatedAt: '2026-10-19T08:00:00.000Z' }],
    ])('fails closed when the human proof is absent: %s', (_label, entry) => {
      // Converged with dispatchCallerFromReply: sender alone is not enough.
      writeMarker('sess-1', 'om_turn_current');
      writeSession({
        quoteTargetId: 'om_queued_followup',
        replyTargets: { om_turn_current: entry },
      });

      expect(() => resolveCurrentTurnProvenance({
        dataDir,
        envSessionId: 'sess-1',
        startPid: process.pid,
      })).toThrow(/缺少 senderOpenId/);
    });

    it('authenticates an auto-start-on-join turn as the operator who added the bot', () => {
      // handleBotAdded's synthetic first turn: no inbound message at all, so
      // quoteTargetId is unset; the birth-time registry entry carries the
      // operator (see the joinTurnSenderOpts registration in daemon.ts).
      const joinTurnId = 'join_9f2b1caa-0000-4000-8000-000000000000';
      writeMarker('sess-1', joinTurnId);
      writeSession({
        scope: 'chat',
        chatType: 'group',
        rootMessageId: undefined,
        quoteTargetId: undefined,
        replyTargets: {
          [joinTurnId]: humanEntry('ou_owner_a'),
        },
      });

      expect(resolveCurrentTurnProvenance({
        dataDir,
        envSessionId: 'sess-1',
        startPid: process.pid,
      })).toEqual({
        sessionId: 'sess-1',
        turnId: joinTurnId,
        // The registry's operator, not the session's lastCallerOpenId slot.
        callerOpenId: 'ou_owner_a',
        larkAppId: 'cli_real',
        chatId: 'oc_real',
        chatType: 'group',
      });
    });

    it('rejects an ordinary-recovery continuation whose registry entry is a clone', () => {
      // ordinary-turn-recovery structuredClones the original entry onto the
      // continuation turn id — a copied identity is not a new human request.
      // The om_-shaped id is deliberate: with a bmx-* id the prefix gate alone
      // would reject, and the structural exclusion line could be deleted
      // without any test going red (R2 mutation finding).
      const recoveryTurnId = 'om_recovery_continuation';
      writeMarker('sess-1', recoveryTurnId);
      writeSession({
        scope: 'chat',
        chatType: 'group',
        quoteTargetId: 'om_queued_followup',
        replyTargets: {
          om_original_turn: humanEntry('ou_caller_b'),
          [recoveryTurnId]: humanEntry('ou_caller_b'),
        },
        ordinaryTurnRecovery: { logicalTurnId: 'om_original_turn', currentTurnId: recoveryTurnId },
      });

      expect(() => resolveCurrentTurnProvenance({
        dataDir,
        envSessionId: 'sess-1',
        startPid: process.pid,
      })).toThrow(/om_recovery_continuation.*om_queued_followup/);
    });

    it('rejects a failed-turn recovery redispatch, user-triggered retry included', () => {
      // failed-turn-recovery writes senderOpenId + isBot:false participants onto
      // the recovery entry. Fail closed regardless of retry vs fresh until a
      // maintainer decides explicit retry should re-authenticate. om_-shaped id
      // for the same mutation-visibility reason as the ordinary case above.
      const recoveryTurnId = 'om_recovery_redispatch';
      writeMarker('sess-1', recoveryTurnId);
      writeSession({
        scope: 'chat',
        chatType: 'group',
        quoteTargetId: 'om_queued_followup',
        replyTargets: {
          [recoveryTurnId]: humanEntry('ou_caller_b'),
        },
        failedTurnRecovery: { originalTurnId: 'om_original_turn', turnId: recoveryTurnId },
      });

      expect(() => resolveCurrentTurnProvenance({
        dataDir,
        envSessionId: 'sess-1',
        startPid: process.pid,
      })).toThrow(/om_recovery_redispatch.*om_queued_followup/);
    });

    it('still authenticates a normal om_ turn while its ordinary recovery is merely armed', () => {
      // Load-bearing: beginOrdinaryTurnRecovery arms EVERY ordinary om_ turn
      // with logicalTurnId === currentTurnId. Deleting the
      // `turnId !== ordinary.logicalTurnId` half would fail-close every live
      // claude-code session — this positive case goes red on that mutation.
      const liveTurnId = 'om_live_turn';
      writeMarker('sess-1', liveTurnId);
      writeSession({
        scope: 'chat',
        chatType: 'group',
        quoteTargetId: 'om_queued_followup',
        replyTargets: {
          [liveTurnId]: humanEntry('ou_caller_b'),
        },
        ordinaryTurnRecovery: { logicalTurnId: liveTurnId, currentTurnId: liveTurnId },
      });

      expect(resolveCurrentTurnProvenance({
        dataDir,
        envSessionId: 'sess-1',
        startPid: process.pid,
      })).toMatchObject({ turnId: liveTurnId, callerOpenId: 'ou_caller_b' });
    });

    it('rejects a readonly task continuation whose registry entry is a clone', () => {
      // readonly-task-continuation structuredClones the original entry (sender
      // + isBot:false participants) onto the continuation turn id, exactly like
      // ordinary recovery — the third recovery family in the predicate.
      const continuationTurnId = 'om_readonly_continuation';
      writeMarker('sess-1', continuationTurnId);
      writeSession({
        scope: 'chat',
        chatType: 'group',
        quoteTargetId: 'om_queued_followup',
        replyTargets: {
          om_original_turn: humanEntry('ou_caller_b'),
          [continuationTurnId]: humanEntry('ou_caller_b'),
        },
        readonlyTaskContinuation: { logicalTurnId: 'om_original_turn', currentTurnId: continuationTurnId },
      });

      expect(() => resolveCurrentTurnProvenance({
        dataDir,
        envSessionId: 'sess-1',
        startPid: process.pid,
      })).toThrow(/om_readonly_continuation.*om_queued_followup/);
    });

    it('still authenticates a normal readonly fire turn while its continuation is merely armed', () => {
      const liveTurnId = 'om_readonly_fire_turn';
      writeMarker('sess-1', liveTurnId);
      writeSession({
        scope: 'chat',
        chatType: 'group',
        quoteTargetId: 'om_queued_followup',
        replyTargets: {
          [liveTurnId]: humanEntry('ou_caller_b'),
        },
        readonlyTaskContinuation: { logicalTurnId: liveTurnId, currentTurnId: liveTurnId },
      });

      expect(resolveCurrentTurnProvenance({
        dataDir,
        envSessionId: 'sess-1',
        startPid: process.pid,
      })).toMatchObject({ turnId: liveTurnId, callerOpenId: 'ou_caller_b' });
    });

    it('rejects a join_ turn redispatched by failed-turn recovery', () => {
      // The structural failed-turn exclusion wins over the join_ allowance.
      const joinTurnId = 'join_9f2b1caa-0000-4000-8000-000000000000';
      writeMarker('sess-1', joinTurnId);
      writeSession({
        scope: 'chat',
        chatType: 'group',
        quoteTargetId: 'om_queued_followup',
        replyTargets: {
          [joinTurnId]: humanEntry('ou_owner_a'),
        },
        failedTurnRecovery: { originalTurnId: 'om_original_turn', turnId: joinTurnId },
      });

      expect(() => resolveCurrentTurnProvenance({
        dataDir,
        envSessionId: 'sess-1',
        startPid: process.pid,
      })).toThrow(CurrentTurnProvenanceError);
    });

    it('accepts a cascade-derived turn om_<msgId>#cN as its real passthrough sender', () => {
      // Accepted relaxation (see PR description): one message carrying several
      // passthrough commands derives om_<messageId>#c1..#cN-1 turns. The daemon
      // writes the registry entry under the derived id with the real sender —
      // not a clone — while the quote slot keeps the original message id.
      const derivedTurnId = 'om_real_msg#c1';
      writeMarker('sess-1', derivedTurnId);
      writeSession({
        scope: 'chat',
        chatType: 'group',
        quoteTargetId: 'om_real_msg',
        lastCallerOpenId: 'ou_followup_sender',
        replyTargets: {
          [derivedTurnId]: humanEntry('ou_caller_b'),
        },
      });

      expect(resolveCurrentTurnProvenance({
        dataDir,
        envSessionId: 'sess-1',
        startPid: process.pid,
      })).toMatchObject({ turnId: derivedTurnId, callerOpenId: 'ou_caller_b' });
    });

    it('accepts a completion-proposal continuation om_<32hex> as the accepting requester', () => {
      // Accepted relaxation (see PR description): proposal continuation mints
      // an om_-shaped id from cp_<32hex>; the continuation deliberately leaves
      // the quote slot unset, and the registry entry carries the requester whose
      // accept click was server-side verified (requester === operator).
      const proposalTurnId = 'om_0123456789abcdef0123456789abcdef';
      writeMarker('sess-1', proposalTurnId);
      writeSession({
        scope: 'chat',
        chatType: 'group',
        quoteTargetId: undefined,
        lastCallerOpenId: undefined,
        replyTargets: {
          [proposalTurnId]: humanEntry('ou_requester'),
        },
      });

      expect(resolveCurrentTurnProvenance({
        dataDir,
        envSessionId: 'sess-1',
        startPid: process.pid,
      })).toMatchObject({ turnId: proposalTurnId, callerOpenId: 'ou_requester' });
    });

    it('rejects other synthetic turn ids even with a sender-ful registry entry', () => {
      const triggerTurnId = 'trg_9f2b1caa-0000-4000-8000-000000000000';
      writeMarker('sess-1', triggerTurnId);
      writeSession({
        scope: 'chat',
        chatType: 'group',
        quoteTargetId: 'om_queued_followup',
        replyTargets: {
          [triggerTurnId]: humanEntry('ou_caller_b'),
        },
      });

      expect(() => resolveCurrentTurnProvenance({
        dataDir,
        envSessionId: 'sess-1',
        startPid: process.pid,
      })).toThrow(CurrentTurnProvenanceError);
    });
  });
});
