import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _getPending, _resetForTest, invalidateAll, registerAsk, registerHostAsk,
  restorePersistedAsks, setAskOwnerResolver, setAskPersistStore, setCanTalkChecker,
  setCardDispatcher, submitAsk, submitCustomReply, tryResolveAsk,
} from '../src/core/ask-broker.js';
import { createAskOwnerResolver } from '../src/core/ask-owner-answer.js';
import { createAskPersistStore } from '../src/core/ask-persist-store.js';
import { parseAskBody } from '../src/core/ask-api.js';
import type { CreateAskInput, PendingAsk } from '../src/core/ask-types.js';
import { buildAskCard, handleAskCardAction } from '../src/im/lark/ask-card.js';
import { buildTurnReplyAskElements } from '../src/im/lark/turn-reply-ask-elements.js';
import { t } from '../src/i18n/index.js';

const base: CreateAskInput = {
  larkAppId: 'cli_app', chatId: 'oc_chat', rootMessageId: 'om_root', sessionId: 'session',
  requestId: 'delegated', originKind: 'host_explicit', answererOpenId: 'ou_collaborator',
  timeoutMs: 60_000,
  questions: [{ prompt: 'Which review thread?', options: [], multiSelect: false, input: { type: 'text' } }],
};
let card: PendingAsk;
let session: { larkAppId: string; chatId: string; rootMessageId: string | null; ownerOpenId?: string } | undefined;
let admins: Set<string>;
let talkers: Set<string>;
let tempDir: string | undefined;

function wire() {
  setCardDispatcher({ async send(ask) { card = ask; return { messageId: 'om_card' }; } });
  setCanTalkChecker((_app, _chat, by) => talkers.has(by));
  setAskOwnerResolver(createAskOwnerResolver({
    session: id => id === base.sessionId ? session : undefined,
    botOwner: app => app === base.larkAppId ? 'ou_owner' : undefined,
    canOperate: (_app, _chat, id) => admins.has(id),
    isPeerBot: (_app, id) => id === 'ou_bot',
  }));
}
beforeEach(() => {
  vi.useFakeTimers(); _resetForTest();
  session = { larkAppId: base.larkAppId, chatId: base.chatId, rootMessageId: base.rootMessageId, ownerOpenId: 'ou_owner' };
  admins = new Set(['ou_owner', 'ou_other_admin', 'ou_bot']);
  talkers = new Set(['ou_owner', 'ou_collaborator', 'ou_bystander', 'ou_other_admin', 'ou_bot']);
  wire();
});
afterEach(() => {
  invalidateAll('test cleanup'); _resetForTest(); vi.useRealTimers();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('ordinary delegated Ask owner answers', () => {
  it.each(['form', 'text', 'choice'] as const)('accepts the verified task owner via %s and preserves actual attribution', async mode => {
    const waiting = registerHostAsk(mode === 'choice' ? { ...base,
      questions: [{ prompt: 'Choose?', multiSelect: false,
        options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }] }] } : base);
    await vi.advanceTimersByTimeAsync(0);
    expect(card.ownerAnswererOpenId).toBe('ou_owner');
    expect(submitCustomReply({ askId: card.askId, by: 'ou_bystander', text: 'wrong' })).toBe('unauthorized');
    // Another bot admin is not the owner of this task.
    expect(submitCustomReply({ askId: card.askId, by: 'ou_other_admin', text: 'wrong' })).toBe('unauthorized');
    if (mode === 'form') {
      await handleAskCardAction({ operator: { open_id: 'ou_owner' }, action: {
        value: { action: 'ask_form_submit', ask_id: card.askId, nonce: card.nonce }, form_value: { q0: 'review-thread' },
      } });
    } else if (mode === 'text') {
      expect(submitCustomReply({ askId: card.askId, by: 'ou_owner', text: 'review-thread' })).toBe('accepted');
    } else {
      expect(tryResolveAsk({ askId: card.askId, nonce: card.nonce, selected: 'yes', by: 'ou_owner' })).toBe('accepted');
    }
    await expect(waiting).resolves.toMatchObject({ kind: 'answered', by: 'ou_owner',
      ...(mode === 'form' ? { inputs: ['review-thread'] } : mode === 'text' ? { comment: 'review-thread' } : { answers: [['yes']] }) });
    expect(submitCustomReply({ askId: card.askId, by: 'ou_collaborator', text: 'late' })).toBe('already_settled');
  });

  it('still accepts the designated collaborator and does not grant approval authority', async () => {
    const waiting = registerHostAsk(base);
    expect(submitCustomReply({ askId: card.askId, by: 'ou_collaborator', text: 'details' })).toBe('accepted');
    await expect(waiting).resolves.toMatchObject({ kind: 'answered', by: 'ou_collaborator' });
    expect(admins.has('ou_collaborator')).toBe(false);
  });

  it.each(['thread', 'chat'] as const)('allows the app permission owner to answer an ownerless bot task in %s scope', async scope => {
    delete session!.ownerOpenId;
    if (scope === 'chat') session!.rootMessageId = null;
    const waiting = registerHostAsk({ ...base, rootMessageId: session!.rootMessageId });
    expect(card.ownerAnswererOpenId).toBe('ou_owner');
    expect(submitCustomReply({ askId: card.askId, by: 'ou_owner', text: 'details' })).toBe('accepted');
    await expect(waiting).resolves.toMatchObject({ by: 'ou_owner' });
  });

  it.each(['revoked-admin', 'revoked-talk', 'closed', 'other-app', 'other-chat', 'other-root', 'bot-owner', 'changed-owner'] as const)
  ('rechecks live ownership and permissions after registration: %s', async change => {
    const waiting = registerHostAsk(base);
    if (change === 'revoked-admin') admins.delete('ou_owner');
    if (change === 'revoked-talk') talkers.delete('ou_owner');
    if (change === 'closed') session = undefined;
    if (change === 'other-app') session!.larkAppId = 'cli_other';
    if (change === 'other-chat') session!.chatId = 'oc_other';
    if (change === 'other-root') session!.rootMessageId = 'om_other';
    if (change === 'bot-owner') session!.ownerOpenId = 'ou_bot';
    if (change === 'changed-owner') session!.ownerOpenId = 'ou_other_admin';
    expect(submitCustomReply({ askId: card.askId, by: 'ou_owner', text: 'details' })).toBe('unauthorized');
    expect(_getPending(card.askId)?.settled).toBe(false);
    expect(submitCustomReply({ askId: card.askId, by: 'ou_collaborator', text: 'details' })).toBe('accepted');
    await expect(waiting).resolves.toMatchObject({ by: 'ou_collaborator' });
  });

  it('never uses bot-authored text as the owner exception', () => {
    registerHostAsk(base);
    expect(submitCustomReply({ askId: card.askId, by: 'ou_owner', text: 'approve', actor: { botSender: true } }))
      .toBe('unauthorized');
  });

  it.each(['hook', 'native-user-input', 'native-user-input-async', 'host_cross_principal_confirmation'] as const)
  ('keeps system confirmations exact even with a permissive injected owner resolver: %s', async originKind => {
    setAskOwnerResolver(() => 'ou_owner');
    const input = { ...base, originKind, questions: [{ prompt: 'Approve?', multiSelect: false,
      options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }] }] };
    const waiting = originKind.startsWith('host_') ? registerHostAsk(input) : registerAsk(input);
    expect(card.ownerAnswererOpenId).toBeUndefined();
    expect(submitAsk({ askId: card.askId, nonce: card.nonce, by: 'ou_owner', selections: [['yes']] })).toBe('unauthorized');
    expect(submitAsk({ askId: card.askId, nonce: card.nonce, by: 'ou_collaborator', selections: [['yes']] })).toBe('accepted');
    await expect(waiting).resolves.toMatchObject({ by: 'ou_collaborator' });
  });

  it('keeps explicit document-author confirmations private and exact', () => {
    setAskOwnerResolver(() => 'ou_owner');
    registerHostAsk({ ...base, deliveryTarget: { kind: 'document-author', openId: 'ou_collaborator',
      turnId: 'turn', fileToken: 'file', commentId: 'comment' } });
    expect(card.ownerAnswererOpenId).toBeUndefined();
    expect(submitCustomReply({ askId: card.askId, by: 'ou_owner', text: 'details' })).toBe('unauthorized');
  });

  it('does not accept an owner exception supplied by an IPC client', () => {
    expect(parseAskBody({ ...base, originKind: 'explicit', ownerAnswererOpenId: 'ou_bystander' }))
      .toEqual({ error: 'unsupported_fields' });
  });

  it('keeps timeout and cancellation authoritative while an owner is answering', async () => {
    const waiting = registerHostAsk(base);
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(waiting).resolves.toMatchObject({ kind: 'timedOut', by: null });
    expect(submitCustomReply({ askId: card.askId, by: 'ou_owner', text: 'late' })).toBe('already_settled');
    const cancelled = registerHostAsk({ ...base, requestId: 'cancelled' });
    invalidateAll('cancelled by user');
    expect(submitCustomReply({ askId: card.askId, by: 'ou_owner', text: 'late' })).toBe('already_settled');
    await expect(cancelled).resolves.toMatchObject({ kind: 'invalidated', by: null });
  });

  it('restores an existing designated Ask and revalidates the owner without persisting authority', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ask-owner-'));
    const store = createAskPersistStore(tempDir);
    setAskPersistStore(store);
    registerHostAsk(base);
    await vi.advanceTimersByTimeAsync(0);
    const askId = card.askId;
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).not.toHaveProperty('ownerAnswererOpenId');
    _resetForTest(); wire(); setAskPersistStore(store);
    expect(restorePersistedAsks(Date.now(), base.larkAppId)).toBe(1);
    expect(_getPending(askId)?.ownerAnswererOpenId).toBe('ou_owner');
    // While the daemon was down, management permission was revoked.
    admins.delete('ou_owner');
    expect(submitCustomReply({ askId, by: 'ou_owner', text: 'details' })).toBe('unauthorized');
    admins.add('ou_owner');
    const reattached = registerHostAsk(base);
    expect(submitCustomReply({ askId, by: 'ou_owner', text: 'details' })).toBe('accepted');
    await expect(reattached).resolves.toMatchObject({ kind: 'answered', by: 'ou_owner' });
  });

  it.each(['form', 'choices'] as const)('shows the same owner policy in standalone and embedded %s cards', async mode => {
    registerHostAsk(mode === 'form' ? base : { ...base, questions: [{ prompt: 'Choose?', multiSelect: false,
      options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }] }] });
    await vi.advanceTimersByTimeAsync(0);
    const policy = t('card.ask.footer.designated_or_owner', undefined, 'zh');
    expect(buildAskCard(card)).toContain(policy);
    expect(JSON.stringify(buildTurnReplyAskElements({ ask: card }, 'zh'))).toContain(policy);
  });
});
