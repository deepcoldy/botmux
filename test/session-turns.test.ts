import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupSessionTurns,
  parseSessionTurnsPage,
  projectLarkTurnInbound,
  readSessionTurns,
  reconcileClosedSessionTurns,
  recordSessionTurnInput,
  recordSessionTurnReply,
  resumeSessionTurns,
  stageSessionTurnInbound,
  updateSessionTurnNativeAnchor,
} from '../src/services/session-turns.js';
import { resolveDashboardRequestGate } from '../src/dashboard/request-identity.js';
import { mergeQueuedCliInput, type PendingCliInput } from '../src/utils/pending-input-queue.js';

describe('structured session turns', () => {
  let dataDir: string;
  const sessionId = 'fixture-session';
  const principal = {
    requestLarkAppId: 'fixture-app',
    requestUserOpenId: 'fixture-sender',
    senderType: 'user' as const,
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-turns-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function stage(messageId: string, rootId?: string) {
    stageSessionTurnInbound(dataDir, sessionId, messageId, projectLarkTurnInbound({
      messageId,
      rootId: rootId ?? messageId,
      parentId: 'fixture-quote',
      senderId: 'fixture-sender',
      senderType: 'user',
      createTime: '0',
      msgType: 'text',
      content: 'Original message',
      mentions: [{ key: 'fixture-mention', name: 'Example bot', openId: 'fixture-mentioned' }],
    }, [{ type: 'image', path: join(dataDir, 'private.png'), name: 'example.png', mimeType: 'image/png' }],
    rootId, 'Example sender'));
  }

  it.each(['claude-code', 'codex'])('projects native anchors and attachment metadata for %s', cliId => {
    stage('message-first', 'message-root');
    expect(readSessionTurns(dataDir, sessionId, 0, 50).turns).toEqual([]);
    const input = '<user_message>Original message</user_message>\n\nComplete CLI envelope';
    recordSessionTurnInput({ dataDir, sessionId, turnId: 'message-first', input, cliId });
    updateSessionTurnNativeAnchor(dataDir, sessionId, 'message-first', 'native-session', 'native-entry');
    expect(readSessionTurns(dataDir, sessionId, 0, 50)).toMatchObject({
      schema: 'botmux.session-turns.v1',
      capabilities: ['ownerActor'],
      turns: [{
        anchor: {
          cliId, cliSessionId: 'native-session', cliEntryId: 'native-entry',
          inputSha256: createHash('sha256').update(input).digest('hex'),
        },
        inbound: [{
          messageId: 'message-first',
          text: 'Original message',
          sender: { type: 'user', name: 'Example sender', openId: 'fixture-sender' },
          quotedMessageId: 'fixture-quote',
          placement: { kind: 'thread', rootMessageId: 'message-root' },
          mentions: [{ openId: 'fixture-mentioned', name: 'Example bot' }],
          attachments: [{ kind: 'image', name: 'example.png', mimeType: 'image/png' }],
        }],
      }],
    });
    expect(JSON.stringify(readSessionTurns(dataDir, sessionId, 0, 50))).not.toContain(dataDir);
  });

  it('groups queued chat inputs and records a late final across database reopens', () => {
    stage('message-first');
    stage('message-second');
    const pending: PendingCliInput[] = [{ turnId: 'message-first', content: 'First', trustedCaller: principal }];
    expect(mergeQueuedCliInput(pending, { turnId: 'message-second', content: 'Second', trustedCaller: principal })).toBe(true);
    const merged = pending[0]!;
    const write = { dataDir, sessionId, turnId: merged.turnId!, input: merged.content,
      cliId: 'claude-code', sourceTurnIds: merged.structuredSourceTurnIds };
    recordSessionTurnInput(write);
    recordSessionTurnInput(write);
    const initial = readSessionTurns(dataDir, sessionId, 0, 1);
    expect(initial.turns.map(turn => turn.inbound.map(message => [message.messageId, message.placement.kind])))
      .toEqual([[['message-first', 'chat'], ['message-second', 'chat']]]);
    stage('message-third');
    recordSessionTurnInput({ dataDir, sessionId, turnId: 'message-third', input: 'Third', cliId: 'codex' });
    const reply = { messageId: 'reply-final', responseKind: 'final' as const, at: 42, text: 'Reply text' };
    recordSessionTurnReply(dataDir, sessionId, 'message-second', reply);
    recordSessionTurnReply(dataDir, sessionId, 'message-second', reply);
    const middle = readSessionTurns(dataDir, sessionId, Number(initial.next), 1);
    expect(middle.turns.map(turn => turn.turnId)).toEqual(['message-third']);
    const late = readSessionTurns(dataDir, sessionId, Number(middle.next), 1);
    expect(late.turns.map(turn => [turn.turnId, turn.replies])).toEqual([['message-second', [reply]]]);
    expect(readSessionTurns(dataDir, sessionId, Number(late.next), 1)).toMatchObject({ turns: [], next: late.next });
    cleanupSessionTurns(dataDir, sessionId);
    stage('message-first');
    recordSessionTurnInput(write);
    recordSessionTurnReply(dataDir, sessionId, 'message-second', reply);
    expect(readSessionTurns(dataDir, sessionId, 0, 50).turns).toEqual([]);
    resumeSessionTurns(dataDir, sessionId);
    stage('message-reopened');
    recordSessionTurnInput({ dataDir, sessionId, turnId: 'message-reopened', input: 'Reopened', cliId: 'codex' });
    expect(readSessionTurns(dataDir, sessionId, Number(late.next), 50).turns.map(turn => turn.turnId))
      .toEqual(['message-reopened']);
  });

  it('validates pagination inputs and requires the actual management token', () => {
    expect(parseSessionTurnsPage(new URLSearchParams('since=42&limit=1'))).toEqual({ since: 42, limit: 1 });
    for (const query of ['since=-1', 'since=2.5', 'since=9007199254740992', 'limit=0', 'limit=101']) {
      expect(parseSessionTurnsPage(new URLSearchParams(query))).toBeUndefined();
    }
    const gate = { method: 'GET', pathname: '/api/sessions/fixture-session/turns', hasTokenParam: false,
      publicReadOnly: true, activeToken: 'fixture-admin-token', identity: null, tokenFromRequest: undefined };
    expect(resolveDashboardRequestGate(gate).decision.kind).toBe('deny401');
    expect(resolveDashboardRequestGate({ ...gate, tokenFromRequest: 'fixture-read-token' }).decision.kind).toBe('deny401');
    expect(resolveDashboardRequestGate({ ...gate, tokenFromRequest: gate.activeToken }).decision.kind).toBe('allow');
    const identity = { userId: 'fixture-user', authSessionId: 'fixture-auth', expiresAt: 100,
      previewCapability: 'operate' as const, canManageHost: true };
    expect(resolveDashboardRequestGate({ ...gate,
      identity: { ...identity, kind: 'platform-dashboard' }, tokenFromRequest: gate.activeToken }).decision.kind).toBe('deny401');
    expect(resolveDashboardRequestGate({ ...gate,
      identity: { ...identity, kind: 'feishu-h5' } }).decision.kind).toBe('deny401');
  });

  it('fences close before the first input and reconciles interrupted cleanup', () => {
    cleanupSessionTurns(dataDir, sessionId);
    stage('message-closed');
    const write = { dataDir, sessionId, turnId: 'message-closed', input: 'Closed', cliId: 'codex' };
    recordSessionTurnInput(write);
    expect(readSessionTurns(dataDir, sessionId, 0, 50).turns).toEqual([]);

    resumeSessionTurns(dataDir, sessionId);
    stage('message-closed');
    recordSessionTurnInput(write);
    expect(readSessionTurns(dataDir, sessionId, 0, 50).turns).toHaveLength(1);
    reconcileClosedSessionTurns(dataDir, new Set([sessionId]));
    recordSessionTurnReply(dataDir, sessionId, 'message-closed', { messageId: 'reply-late', responseKind: 'final', at: 50 });
    expect(readSessionTurns(dataDir, sessionId, 0, 50).turns).toEqual([]);
  });

  it('keeps an early native receipt and can return to an earlier input hash', () => {
    stage('message-first');
    const write = { dataDir, sessionId, turnId: 'message-first', input: 'First', cliId: 'codex' };
    updateSessionTurnNativeAnchor(dataDir, sessionId, write.turnId, 'native-session', 'native-entry');
    recordSessionTurnReply(dataDir, sessionId, write.turnId, { messageId: 'reply-early', responseKind: 'final', at: 1 });
    recordSessionTurnInput(write);
    const first = readSessionTurns(dataDir, sessionId, 0, 50);
    expect(first.turns[0]?.anchor?.cliEntryId).toBe('native-entry');
    expect(first.turns[0]?.replies).toHaveLength(1);
    recordSessionTurnInput({ ...write, input: 'Second' });
    const second = readSessionTurns(dataDir, sessionId, Number(first.next), 50);
    recordSessionTurnInput(write);
    const third = readSessionTurns(dataDir, sessionId, Number(second.next), 50);
    expect(third.turns[0]?.anchor?.inputSha256).toBe(first.turns[0]?.anchor?.inputSha256);
    expect(Number(third.next)).toBeGreaterThan(Number(second.next));
  });
});
