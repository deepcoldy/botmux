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
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
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

  function stage(messageId: string, rootId?: string, content = 'Original message') {
    stageSessionTurnInbound(dataDir, sessionId, messageId, projectLarkTurnInbound({
      messageId,
      rootId: rootId ?? messageId,
      parentId: 'fixture-quote',
      senderId: 'fixture-sender',
      senderType: 'user',
      createTime: '0',
      msgType: 'text',
      content,
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

  it('persists the store in WAL mode so concurrent readers never block writers', () => {
    stage('message-wal');
    const db = openDatabaseSyncOrThrow(join(dataDir, 'session-turns', 'turns.sqlite'), { readOnly: true });
    try {
      expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    } finally {
      db.close();
    }
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

  it('prunes completed turns over the per-session cap while keeping active turns and monotonic cursors', () => {
    const retention = { maxEventsPerSession: 8, eventTtlMs: 60_000 };
    const t0 = 100_000;

    stage('turn-1');
    recordSessionTurnInput({ dataDir, sessionId, turnId: 'turn-1', input: 'one', cliId: 'codex', at: t0, retention });
    recordSessionTurnReply(dataDir, sessionId, 'turn-1', { messageId: 'r-1', responseKind: 'final', at: t0 + 10 }, retention);
    const afterT1 = readSessionTurns(dataDir, sessionId, 0, 50);
    expect(afterT1.turns.map(t => t.turnId)).toEqual(['turn-1']);

    // turn-2 仅收到 progress 回执，尚未收到 final，属于活跃/未完成轮次
    stage('turn-2');
    recordSessionTurnInput({ dataDir, sessionId, turnId: 'turn-2', input: 'two', cliId: 'codex', at: t0 + 20, retention });
    recordSessionTurnReply(dataDir, sessionId, 'turn-2', { messageId: 'r-2p', responseKind: 'progress', at: t0 + 30 }, retention);

    // turn-3 完成后总事件数达到 9 > 8，应淘汰最旧的已完成轮次 turn-1，保留活跃轮次 turn-2 与最新轮次 turn-3
    stage('turn-3');
    recordSessionTurnInput({ dataDir, sessionId, turnId: 'turn-3', input: 'three', cliId: 'codex', at: t0 + 40, retention });
    recordSessionTurnReply(dataDir, sessionId, 'turn-3', { messageId: 'r-3', responseKind: 'final', at: t0 + 50 }, retention);

    const afterT3 = readSessionTurns(dataDir, sessionId, 0, 50);
    expect(afterT3.turns.map(t => t.turnId)).toEqual(['turn-2', 'turn-3']);
    // 持有已被裁剪轮次的旧游标分页不报错且单调前进
    const fromStaleCursor = readSessionTurns(dataDir, sessionId, Number(afterT1.next), 50);
    expect(fromStaleCursor.turns.map(t => t.turnId)).toEqual(['turn-2', 'turn-3']);
    expect(Number(fromStaleCursor.next)).toBeGreaterThan(Number(afterT1.next));

    // turn-4 完成后再次超上限，应优先淘汰已完成的 turn-3，仍保留活跃轮次 turn-2 与最新轮次 turn-4
    stage('turn-4');
    recordSessionTurnInput({ dataDir, sessionId, turnId: 'turn-4', input: 'four', cliId: 'codex', at: t0 + 60, retention });
    recordSessionTurnReply(dataDir, sessionId, 'turn-4', { messageId: 'r-4', responseKind: 'final', at: t0 + 70 }, retention);

    const afterT4 = readSessionTurns(dataDir, sessionId, 0, 50);
    expect(afterT4.turns.map(t => t.turnId)).toEqual(['turn-2', 'turn-4']);
    const deltaAfterT3 = readSessionTurns(dataDir, sessionId, Number(afterT3.next), 50);
    expect(deltaAfterT3.turns.map(t => t.turnId)).toEqual(['turn-4']);
    expect(Number(deltaAfterT3.next)).toBeGreaterThan(Number(afterT3.next));

    // 已裁剪轮次的迟到回执被忽略，不产生孤立事件
    recordSessionTurnReply(dataDir, sessionId, 'turn-1', { messageId: 'r-1-late', responseKind: 'auxiliary', at: t0 + 80 }, retention);
    expect(readSessionTurns(dataDir, sessionId, Number(afterT4.next), 50)).toMatchObject({ turns: [], next: afterT4.next });

    // 活跃轮次 turn-2 最终完成时仍可正常追加回执并推进游标
    recordSessionTurnReply(dataDir, sessionId, 'turn-2', { messageId: 'r-2f', responseKind: 'final', at: t0 + 90 }, retention);
    const completedActive = readSessionTurns(dataDir, sessionId, Number(afterT4.next), 50);
    expect(completedActive.turns.map(t => [t.turnId, t.replies.map(r => r.responseKind)])).toEqual([
      ['turn-2', ['progress', 'final']],
    ]);
    expect(Number(completedActive.next)).toBeGreaterThan(Number(afterT4.next));
  });

  it('trims inside a single long-running turn so the hard cap still binds', () => {
    const retention = { maxEventsPerSession: 4, eventTtlMs: 10 ** 12 };
    stage('solo-turn');
    recordSessionTurnInput({ dataDir, sessionId, turnId: 'solo-turn', input: 'one', cliId: 'codex', at: 1000, retention });
    for (const i of [1, 2, 3, 4, 5, 6]) {
      recordSessionTurnReply(dataDir, sessionId, 'solo-turn',
        { messageId: `p-${i}`, responseKind: 'progress', at: 1000 + i }, retention);
    }
    // A later native anchor supersedes the first one; only the newest survives.
    updateSessionTurnNativeAnchor(dataDir, sessionId, 'solo-turn', 'native-s2', 'entry-2', retention);

    const page = readSessionTurns(dataDir, sessionId, 0, 50);
    expect(page.turns).toHaveLength(1);
    const turn = page.turns[0]!;
    // 1 input + the newest anchor + the 2 newest replies = exactly the cap.
    expect(turn.inbound).toHaveLength(1);
    expect(turn.anchor).toMatchObject({ cliSessionId: 'native-s2', cliEntryId: 'entry-2' });
    expect(turn.replies.map(r => r.messageId)).toEqual(['p-5', 'p-6']);
    expect(turn.inbound.length + 1 + turn.replies.length).toBe(4);
  });

  it('prunes expired turns by TTL, bounds all-incomplete sessions, and preserves cursor monotonicity across close/reopen', () => {
    const retention = { maxEventsPerSession: 4, eventTtlMs: 10_000 };

    stage('old-done');
    recordSessionTurnInput({ dataDir, sessionId, turnId: 'old-done', input: 'a', cliId: 'codex', at: 1_000, retention });
    recordSessionTurnReply(dataDir, sessionId, 'old-done', { messageId: 'r-old', responseKind: 'final', at: 1_500 }, retention);

    stage('old-stale-incomplete');
    recordSessionTurnInput({ dataDir, sessionId, turnId: 'old-stale-incomplete', input: 'b', cliId: 'codex', at: 2_000, retention });
    const beforeTtl = readSessionTurns(dataDir, sessionId, 0, 50);

    // 超过 TTL 后写入新轮次，两个过期轮次均被裁剪，最新轮次保留
    stage('fresh-turn');
    recordSessionTurnInput({ dataDir, sessionId, turnId: 'fresh-turn', input: 'c', cliId: 'codex', at: 15_000, retention });
    const afterTtl = readSessionTurns(dataDir, sessionId, 0, 50);
    expect(afterTtl.turns.map(t => t.turnId)).toEqual(['fresh-turn']);
    expect(Number(afterTtl.next)).toBeGreaterThan(Number(beforeTtl.next));

    // 全为未完成轮次时仍受单会话上限约束，仅保留最新的不超上限轮次
    for (let i = 1; i <= 4; i++) {
      const id = `incomplete-${i}`;
      stage(id);
      recordSessionTurnInput({ dataDir, sessionId, turnId: id, input: id, cliId: 'codex', at: 15_000 + i * 100, retention });
    }
    const afterIncompleteBurst = readSessionTurns(dataDir, sessionId, 0, 50);
    expect(afterIncompleteBurst.turns.map(t => t.turnId)).toEqual(['incomplete-3', 'incomplete-4']);

    const db = openDatabaseSyncOrThrow(join(dataDir, 'session-turns', 'turns.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT COUNT(*) AS count FROM events WHERE session_id = ?').get(sessionId) as { count: number };
      expect(row.count).toBeLessThanOrEqual(4);
    } finally {
      db.close();
    }

    // 关闭再重开后游标仍严格单调递增
    cleanupSessionTurns(dataDir, sessionId);
    expect(readSessionTurns(dataDir, sessionId, Number(afterIncompleteBurst.next), 50)).toMatchObject({
      turns: [],
      next: afterIncompleteBurst.next,
    });
    resumeSessionTurns(dataDir, sessionId);
    stage('reopened-turn');
    recordSessionTurnInput({ dataDir, sessionId, turnId: 'reopened-turn', input: 'reopened', cliId: 'codex', at: 20_000, retention });
    const afterReopen = readSessionTurns(dataDir, sessionId, Number(afterIncompleteBurst.next), 50);
    expect(afterReopen.turns.map(t => t.turnId)).toEqual(['reopened-turn']);
    expect(Number(afterReopen.next)).toBeGreaterThan(Number(afterIncompleteBurst.next));
  });

  it('redacts local paths after non-whitespace delimiters without mangling URLs', () => {
    const inboundText = [
      '路径：/Users/alice/secret/a.ts，谢谢',
      '文件:/home/bob/app.ts',
      'PATH=/workspace/repo/secret.env',
      '(/tmp/debug.log) [/var/log/app.log]',
      '「~/private/key.pem」 【/Users/alice/secret/b.ts】',
      '"/home/bob/quoted.ts" \'~/private/single.pem\'',
      '路径：C:\\Users\\alice\\a.txt 【C:\\Users\\alice\\b.txt】',
      '路径：file:///Users/alice/secret/c.ts',
      '参考链接：https://example.com/Users/alice/profile',
      'http://localhost:3000/home/dashboard',
      'url=https://example.com/tmp/item',
      'ssh://git@github.com/workspace/repo',
      's3://bucket/data00/file.parquet',
    ].join('\n');

    stage('redact-turn', undefined, inboundText);
    recordSessionTurnInput({ dataDir, sessionId, turnId: 'redact-turn', input: inboundText, cliId: 'codex' });
    recordSessionTurnReply(dataDir, sessionId, 'redact-turn', {
      messageId: 'reply-redact',
      responseKind: 'final',
      at: 100,
      text: '结果：/Users/alice/out.txt，详情见 https://example.com/home/docs',
    });

    const page = readSessionTurns(dataDir, sessionId, 0, 50);
    const storedInbound = page.turns[0]?.inbound[0]?.text;
    const storedReply = page.turns[0]?.replies[0]?.text;

    expect(storedInbound).toBe([
      '路径：<redacted>，谢谢',
      '文件:<redacted>',
      'PATH=<redacted>',
      '(<redacted>) [<redacted>]',
      '「<redacted>」 【<redacted>】',
      '"<redacted>" \'<redacted>\'',
      '路径：<redacted> 【<redacted>】',
      '路径：<redacted>',
      '参考链接：https://example.com/Users/alice/profile',
      'http://localhost:3000/home/dashboard',
      'url=https://example.com/tmp/item',
      'ssh://git@github.com/workspace/repo',
      's3://bucket/data00/file.parquet',
    ].join('\n'));
    expect(storedReply).toBe('结果：<redacted>，详情见 https://example.com/home/docs');
  });
});
