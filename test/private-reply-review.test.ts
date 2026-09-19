import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

let botState: any = {
  config: {
    ownerOpenId: 'ou_owner',
    privateReplyReview: { enabled: true, audience: 'requester', fallback: 'dm', expireHours: 24 },
  },
  resolvedAllowedUsers: ['ou_owner', 'ou_coowner'],
};

vi.mock('../src/bot-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bot-registry.js')>();
  return {
    ...actual,
    getBot: vi.fn(() => botState),
  };
});

const flushBackground = () => new Promise(resolve => setTimeout(resolve, 0));

describe('private reply review service', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-private-reply-review-'));
    botState = {
      config: {
        ownerOpenId: 'ou_owner',
        privateReplyReview: { enabled: true, audience: 'requester', fallback: 'dm', expireHours: 24 },
      },
      resolvedAllowedUsers: ['ou_owner', 'ou_coowner'],
    };
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('stages a flat group final reply as an ephemeral review card and publishes once', async () => {
    const { stagePrivateReplyForReview, publishPrivateReply } = await import('../src/services/private-reply-review.js');
    const sendEphemeralCard = vi.fn(async () => 'om_ephemeral');
    const sendMessage = vi.fn(async () => 'om_public');
    const deleteEphemeralCard = vi.fn(async () => true);
    const deleteMessage = vi.fn(async () => true);

    const staged = await stagePrivateReplyForReview({
      larkAppId: 'app',
      chatId: 'oc_group',
      chatType: 'group',
      sessionId: 'sess',
      turnId: 'turn',
      requesterOpenId: 'ou_requester',
      placement: { mode: 'plain', chatId: 'oc_group' },
      msgType: 'interactive',
      content: JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'answer' }] } }),
      idempotencySeed: 'seed',
      locale: 'zh',
    }, { dataDir, sendEphemeralCard });

    expect(staged.staged).toBe(true);
    if (!staged.staged) throw new Error('expected staged');
    expect(sendEphemeralCard).toHaveBeenCalledWith('app', 'oc_group', 'ou_requester', expect.stringContaining('private_reply_publish'));
    const recordPath = join(dataDir, 'private-reply-publications', 'app', `${staged.publishId}.json`);
    const record = JSON.parse(readFileSync(recordPath, 'utf-8'));
    expect(record.nonceHash).toMatch(/^sha256:/);
    expect(JSON.stringify(record)).not.toContain('"nonce":"');

    const card = JSON.parse(sendEphemeralCard.mock.calls[0][3]);
    const buttonRow = card.body.elements.find((element: any) => element.tag === 'column_set');
    const publishButton = buttonRow.columns[0].elements[0];
    const nonce = publishButton.behaviors[0].value.nonce;

    const published = await publishPrivateReply({
      larkAppId: 'app',
      publishId: staged.publishId,
      nonce,
      operatorOpenId: 'ou_requester',
    }, { dataDir, sendMessage, deleteEphemeralCard, deleteMessage });

    expect(published).toEqual({ ok: true, messageId: 'om_public' });
    expect(sendMessage).toHaveBeenCalledWith('app', 'oc_group', record.content, 'interactive', record.publicUuid);
    expect(deleteEphemeralCard).not.toHaveBeenCalled();
    await flushBackground();
    expect(deleteEphemeralCard).toHaveBeenCalledWith('app', 'om_ephemeral');
    expect(deleteMessage).not.toHaveBeenCalled();

    const repeated = await publishPrivateReply({
      larkAppId: 'app',
      publishId: staged.publishId,
      nonce,
      operatorOpenId: 'ou_requester',
    }, { dataDir, sendMessage, deleteEphemeralCard, deleteMessage });
    expect(repeated).toEqual({ ok: true, messageId: 'om_public', already: true });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('falls back to owner audience when requester is missing', async () => {
    const { stagePrivateReplyForReview } = await import('../src/services/private-reply-review.js');
    const sendUserMessage = vi.fn(async () => 'dm_owner');
    const staged = await stagePrivateReplyForReview({
      larkAppId: 'app',
      chatId: 'oc_group',
      chatType: 'group',
      sessionId: 'sess',
      placement: { mode: 'thread', rootMessageId: 'om_root', replyInThread: true },
      msgType: 'interactive',
      content: JSON.stringify({ schema: '2.0', body: { elements: [] } }),
      idempotencySeed: 'seed-owner',
    }, { dataDir, sendUserMessage });
    expect(staged.staged).toBe(true);
    expect(sendUserMessage).toHaveBeenCalledWith('app', 'ou_owner', expect.stringContaining('private_reply_publish'), 'interactive');
    const recordPath = join(dataDir, 'private-reply-publications', 'app', `${staged.staged ? staged.publishId : ''}.json`);
    const record = JSON.parse(readFileSync(recordPath, 'utf-8'));
    expect(record.dmMessageIds).toEqual(['dm_owner']);
    expect(record.ephemeralMessageIds).toEqual([]);
  });

  it('fails closed when no reviewer can be resolved with dm fallback', async () => {
    const { stagePrivateReplyForReview } = await import('../src/services/private-reply-review.js');
    botState = {
      config: {
        privateReplyReview: { enabled: true, audience: 'requester', fallback: 'dm', expireHours: 24 },
      },
      resolvedAllowedUsers: [],
    };
    const staged = await stagePrivateReplyForReview({
      larkAppId: 'app',
      chatId: 'oc_group',
      chatType: 'group',
      sessionId: 'sess',
      placement: { mode: 'plain', chatId: 'oc_group' },
      msgType: 'interactive',
      content: JSON.stringify({ schema: '2.0', body: { elements: [] } }),
      idempotencySeed: 'seed-no-audience',
    }, { dataDir });

    expect(staged).toEqual({ staged: false, reason: 'no_audience' });
  });

  it('sends owners audience to owner and co-owners, including the explicit ownerOpenId', async () => {
    const { stagePrivateReplyForReview } = await import('../src/services/private-reply-review.js');
    botState.config.privateReplyReview = { enabled: true, audience: 'owners', fallback: 'dm', expireHours: 24 };
    const ownerSend = vi.fn(async () => 'dm_owner');
    await stagePrivateReplyForReview({
      larkAppId: 'app',
      chatId: 'oc_group',
      chatType: 'group',
      sessionId: 'sess',
      placement: { mode: 'thread', rootMessageId: 'om_root', replyInThread: true },
      msgType: 'interactive',
      content: JSON.stringify({ schema: '2.0', body: { elements: [] } }),
      idempotencySeed: 'seed-owners',
    }, { dataDir, sendUserMessage: ownerSend });
    expect(ownerSend.mock.calls.map(call => call[1])).toEqual(['ou_owner', 'ou_coowner']);

    botState.config.privateReplyReview = { enabled: true, audience: 'allowedUsers', fallback: 'dm', expireHours: 24 };
    const allowedSend = vi.fn(async (_app, openId) => `dm_${openId}`);
    await stagePrivateReplyForReview({
      larkAppId: 'app',
      chatId: 'oc_group',
      chatType: 'group',
      sessionId: 'sess',
      placement: { mode: 'thread', rootMessageId: 'om_root', replyInThread: true },
      msgType: 'interactive',
      content: JSON.stringify({ schema: '2.0', body: { elements: [] } }),
      idempotencySeed: 'seed-allowed',
    }, { dataDir, sendUserMessage: allowedSend as any });
    expect(allowedSend.mock.calls.map(call => call[1])).toEqual(['ou_owner', 'ou_coowner']);
  });

  it('fails closed when all private deliveries fail with dm fallback', async () => {
    const { stagePrivateReplyForReview } = await import('../src/services/private-reply-review.js');
    const sendEphemeralCard = vi.fn(async () => { throw new Error('ephemeral down'); });
    const sendUserMessage = vi.fn(async () => { throw new Error('dm down'); });

    const staged = await stagePrivateReplyForReview({
      larkAppId: 'app',
      chatId: 'oc_group',
      chatType: 'group',
      sessionId: 'sess',
      requesterOpenId: 'ou_requester',
      placement: { mode: 'plain', chatId: 'oc_group' },
      msgType: 'interactive',
      content: JSON.stringify({ schema: '2.0', body: { elements: [] } }),
      idempotencySeed: 'seed-delivery-failed',
    }, { dataDir, sendEphemeralCard, sendUserMessage });

    expect(staged).toEqual({ staged: false, reason: 'delivery_failed' });
    const appDir = join(dataDir, 'private-reply-publications', 'app');
    expect(existsSync(appDir) ? readdirSync(appDir).filter(name => name.endsWith('.json')) : []).toEqual([]);
  });

  it('uses public fallback instead of staging when private delivery fails and fallback is public', async () => {
    const { stagePrivateReplyForReview } = await import('../src/services/private-reply-review.js');
    botState.config.privateReplyReview = { enabled: true, audience: 'requester', fallback: 'public', expireHours: 24 };
    const sendEphemeralCard = vi.fn(async () => { throw new Error('ephemeral down'); });

    const staged = await stagePrivateReplyForReview({
      larkAppId: 'app',
      chatId: 'oc_group',
      chatType: 'group',
      sessionId: 'sess',
      requesterOpenId: 'ou_requester',
      placement: { mode: 'plain', chatId: 'oc_group' },
      msgType: 'interactive',
      content: JSON.stringify({ schema: '2.0', body: { elements: [] } }),
      idempotencySeed: 'seed-public-fallback',
    }, { dataDir, sendEphemeralCard });

    expect(staged).toEqual({ staged: false, reason: 'public_fallback' });
  });

  it('reuses an existing pending review for the same stable idempotency seed', async () => {
    const { stagePrivateReplyForReview } = await import('../src/services/private-reply-review.js');
    const sendEphemeralCard = vi.fn(async () => `om_ephemeral_${sendEphemeralCard.mock.calls.length}`);
    const input = {
      larkAppId: 'app',
      chatId: 'oc_group',
      chatType: 'group' as const,
      sessionId: 'sess',
      turnId: 'turn',
      requesterOpenId: 'ou_requester',
      placement: { mode: 'plain' as const, chatId: 'oc_group' },
      msgType: 'interactive' as const,
      content: JSON.stringify({ schema: '2.0', body: { elements: [] } }),
      idempotencySeed: 'stable-seed',
    };

    const first = await stagePrivateReplyForReview(input, { dataDir, sendEphemeralCard });
    const second = await stagePrivateReplyForReview(input, { dataDir, sendEphemeralCard });

    expect(first.staged).toBe(true);
    expect(second.staged).toBe(true);
    if (!first.staged || !second.staged) throw new Error('expected staged');
    expect(second.publishId).toBe(first.publishId);
    expect(sendEphemeralCard).toHaveBeenCalledTimes(1);
  });

  it('re-sends a stale empty pending record left by an interrupted staging attempt', async () => {
    const { stagePrivateReplyForReview } = await import('../src/services/private-reply-review.js');
    const sendEphemeralCard = vi.fn(async () => `om_ephemeral_${sendEphemeralCard.mock.calls.length}`);
    const input = {
      larkAppId: 'app',
      chatId: 'oc_group',
      chatType: 'group' as const,
      sessionId: 'sess',
      turnId: 'turn',
      requesterOpenId: 'ou_requester',
      placement: { mode: 'plain' as const, chatId: 'oc_group' },
      msgType: 'interactive' as const,
      content: JSON.stringify({ schema: '2.0', body: { elements: [] } }),
      idempotencySeed: 'interrupted-seed',
    };

    const first = await stagePrivateReplyForReview(input, { dataDir, sendEphemeralCard });
    if (!first.staged) throw new Error('expected staged');
    const recordPath = join(dataDir, 'private-reply-publications', 'app', `${first.publishId}.json`);
    const record = JSON.parse(readFileSync(recordPath, 'utf-8'));
    record.ephemeralMessageIds = [];
    record.dmMessageIds = [];
    record.createdAt = Date.now() - 31_000;
    record.expiresAt = Date.now() - 1_000;
    record.nonceHash = 'sha256:stale';
    writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');

    const second = await stagePrivateReplyForReview(input, { dataDir, sendEphemeralCard });

    expect(second.staged).toBe(true);
    if (!second.staged) throw new Error('expected staged');
    expect(second.publishId).toBe(first.publishId);
    expect(second.privateMessageIds).toEqual(['om_ephemeral_2']);
    expect(sendEphemeralCard).toHaveBeenCalledTimes(2);
    const nextRecord = JSON.parse(readFileSync(recordPath, 'utf-8'));
    expect(nextRecord.ephemeralMessageIds).toEqual(['om_ephemeral_2']);
    expect(nextRecord.nonceHash).toMatch(/^sha256:/);
    expect(nextRecord.nonceHash).not.toBe('sha256:stale');
  });

  it('rejects non-audience publish attempts', async () => {
    const { stagePrivateReplyForReview, publishPrivateReply } = await import('../src/services/private-reply-review.js');
    const sendEphemeralCard = vi.fn(async () => 'om_ephemeral');
    const staged = await stagePrivateReplyForReview({
      larkAppId: 'app',
      chatId: 'oc_group',
      chatType: 'group',
      sessionId: 'sess',
      requesterOpenId: 'ou_requester',
      placement: { mode: 'plain', chatId: 'oc_group' },
      msgType: 'interactive',
      content: JSON.stringify({ schema: '2.0', body: { elements: [] } }),
      idempotencySeed: 'seed-forbidden',
    }, { dataDir, sendEphemeralCard });
    if (!staged.staged) throw new Error('expected staged');
    const card = JSON.parse(sendEphemeralCard.mock.calls[0][3]);
    const nonce = card.body.elements.find((element: any) => element.tag === 'column_set').columns[0].elements[0].behaviors[0].value.nonce;

    const sendMessage = vi.fn(async () => 'om_public') as any;
    const result = await publishPrivateReply({
      larkAppId: 'app',
      publishId: staged.publishId,
      nonce,
      operatorOpenId: 'ou_stranger',
    }, { dataDir, sendMessage });
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('returns discard success before best-effort private-message cleanup finishes', async () => {
    const { stagePrivateReplyForReview, discardPrivateReply } = await import('../src/services/private-reply-review.js');
    const sendEphemeralCard = vi.fn(async () => 'om_ephemeral');
    let releaseDelete: (() => void) | undefined;
    const deleteEphemeralCard = vi.fn(async () => new Promise<boolean>(resolve => {
      releaseDelete = () => resolve(true);
    }));

    const staged = await stagePrivateReplyForReview({
      larkAppId: 'app',
      chatId: 'oc_group',
      chatType: 'group',
      sessionId: 'sess',
      requesterOpenId: 'ou_requester',
      placement: { mode: 'plain', chatId: 'oc_group' },
      msgType: 'interactive',
      content: JSON.stringify({ schema: '2.0', body: { elements: [] } }),
      idempotencySeed: 'seed-discard',
    }, { dataDir, sendEphemeralCard });
    if (!staged.staged) throw new Error('expected staged');
    const card = JSON.parse(sendEphemeralCard.mock.calls[0][3]);
    const nonce = card.body.elements.find((element: any) => element.tag === 'column_set').columns[1].elements[0].behaviors[0].value.nonce;

    const result = await discardPrivateReply({
      larkAppId: 'app',
      publishId: staged.publishId,
      nonce,
      operatorOpenId: 'ou_requester',
    }, { dataDir, deleteEphemeralCard });

    expect(result).toEqual({ ok: true });
    expect(deleteEphemeralCard).not.toHaveBeenCalled();
    await flushBackground();
    expect(deleteEphemeralCard).toHaveBeenCalledWith('app', 'om_ephemeral');
    releaseDelete?.();
  });
});
