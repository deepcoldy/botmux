import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CurrentTurnProvenanceError,
  resolveCurrentTurnProvenance,
} from '../src/core/current-turn-provenance.js';
import { readProcessStartIdentity } from '../src/core/session-marker.js';

describe('resolveCurrentTurnProvenance', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-provenance-'));
    mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
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
    writeFileSync(
      join(dataDir, 'sessions-cli_real.json'),
      JSON.stringify({ [session.sessionId]: session }),
    );
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
    })).toThrow(/缺少 sessionId\/turnId\/procStart/);
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
});
