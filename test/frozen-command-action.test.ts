import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bindFrozenCommandActionCard,
  claimFrozenCommandAction,
  createFrozenCommandAction,
  expirePendingFrozenCommandAction,
  expireInterruptedFrozenCommandActions,
  getFrozenCommandAction,
  settleFrozenCommandAction,
} from '../src/services/frozen-command-action.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-frozen-action-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function create(dataDir: string, now = new Date('2026-09-20T00:00:00.000Z')) {
  return createFrozenCommandAction(dataDir, {
    targetBotId: 'cli_app',
    chatId: 'oc_chat',
    chatType: 'group',
    rootMessageId: 'om_root',
    scope: 'thread',
    sessionId: 'session-1',
    turnId: 'om_source',
    dispatchAttempt: 7,
    workingDir: '/repo',
    sourceMessageId: 'om_source',
    sourceContentHash: 'a'.repeat(64),
    intentSchemaVersion: 'botmux.frozen-command-intent.v1',
    parserVersion: 'frozen-command-args.v1',
    actorOpenId: 'ou_actor',
    actorUnionId: 'on_actor',
    command: '日报',
    rawArgs: '7',
    normalizedArgs: [{ name: 'days', label: '天数', value: '7' }],
    datasource: 'warehouse',
    specHash: 'b'.repeat(64),
    revisionId: 'revision-1',
    ttlMs: 60_000,
    now,
  });
}

describe('FrozenCommandAction store', () => {
  it('binds every authority dimension and CAS-claims only once', () => {
    const dataDir = tempDir();
    const created = create(dataDir);
    expect(bindFrozenCommandActionCard(dataDir, created.record.id, 'om_card')).toBe(true);

    const wrongActor = claimFrozenCommandAction({
      dataDir,
      id: created.record.id,
      nonce: created.nonce,
      targetBotId: 'cli_app',
      cardMessageId: 'om_card',
      chatId: 'oc_chat',
      actorOpenId: 'ou_other',
      actorUnionId: 'on_other',
      now: new Date('2026-09-20T00:00:01.000Z'),
    });
    expect(wrongActor.kind).toBe('rejected');
    expect(getFrozenCommandAction(dataDir, created.record.id)?.status).toBe('pending');

    const claimed = claimFrozenCommandAction({
      dataDir,
      id: created.record.id,
      nonce: created.nonce,
      targetBotId: 'cli_app',
      cardMessageId: 'om_card',
      chatId: 'oc_chat',
      actorOpenId: 'ou_actor',
      actorUnionId: 'on_actor',
      callbackEventId: 'event-1',
      now: new Date('2026-09-20T00:00:01.000Z'),
    });
    expect(claimed.kind).toBe('claimed');
    expect(claimed.kind === 'claimed' && claimed.record.callbackEventId).toBe('event-1');

    const duplicate = claimFrozenCommandAction({
      dataDir,
      id: created.record.id,
      nonce: created.nonce,
      targetBotId: 'cli_app',
      cardMessageId: 'om_card',
      chatId: 'oc_chat',
      actorOpenId: 'ou_actor',
      actorUnionId: 'on_actor',
      callbackEventId: 'event-2',
      now: new Date('2026-09-20T00:00:02.000Z'),
    });
    expect(duplicate.kind).toBe('already');
    expect(settleFrozenCommandAction({
      dataDir,
      id: created.record.id,
      status: 'completed',
      queryId: 'q_123',
    })).toBe(true);
    expect(getFrozenCommandAction(dataDir, created.record.id)).toMatchObject({
      status: 'completed',
      queryId: 'q_123',
      callbackEventId: 'event-1',
      sourceContentHash: 'a'.repeat(64),
      parserVersion: 'frozen-command-args.v1',
    });
  });

  it('expires stale confirmations without entering executing', () => {
    const dataDir = tempDir();
    const created = create(dataDir);
    bindFrozenCommandActionCard(dataDir, created.record.id, 'om_card');
    const result = claimFrozenCommandAction({
      dataDir,
      id: created.record.id,
      nonce: created.nonce,
      targetBotId: 'cli_app',
      cardMessageId: 'om_card',
      chatId: 'oc_chat',
      actorOpenId: 'ou_actor',
      actorUnionId: 'on_actor',
      now: new Date('2026-09-20T00:02:00.000Z'),
    });
    expect(result.kind).toBe('expired');
    expect(getFrozenCommandAction(dataDir, created.record.id)?.status).toBe('expired');
  });

  it('terminalizes an unpresentable pending action without overwriting later states', () => {
    const dataDir = tempDir();
    const created = create(dataDir);
    expect(expirePendingFrozenCommandAction({
      dataDir,
      id: created.record.id,
      errorCode: 'card_post_failed',
      now: new Date('2026-09-20T00:00:01.000Z'),
    })).toBe(true);
    expect(getFrozenCommandAction(dataDir, created.record.id)).toMatchObject({
      status: 'expired',
      errorCode: 'card_post_failed',
    });
    expect(expirePendingFrozenCommandAction({
      dataDir,
      id: created.record.id,
      errorCode: 'card_binding_failed',
    })).toBe(false);
  });

  it('never replays an executing action after restart recovery', () => {
    const dataDir = tempDir();
    const created = create(dataDir);
    bindFrozenCommandActionCard(dataDir, created.record.id, 'om_card');
    expect(claimFrozenCommandAction({
      dataDir,
      id: created.record.id,
      nonce: created.nonce,
      targetBotId: 'cli_app',
      cardMessageId: 'om_card',
      chatId: 'oc_chat',
      actorOpenId: 'ou_actor',
      actorUnionId: 'on_actor',
      now: new Date('2026-09-20T00:00:01.000Z'),
    }).kind).toBe('claimed');
    expect(expireInterruptedFrozenCommandActions(dataDir, 'other_app')).toBe(0);
    expect(expireInterruptedFrozenCommandActions(dataDir, 'cli_app')).toBe(1);
    expect(getFrozenCommandAction(dataDir, created.record.id)).toMatchObject({
      status: 'failed',
      errorCode: 'execution_interrupted',
    });
    expect(expireInterruptedFrozenCommandActions(dataDir, 'cli_app')).toBe(0);
  });
});
