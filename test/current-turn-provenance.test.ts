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
});
