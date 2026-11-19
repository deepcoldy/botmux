import { describe, expect, it, vi } from 'vitest';
import { normalizeListenerContentPolicy } from '../src/services/message-listener-content-policy.js';
import { messageListenerConfigFromUpdate, sanitizeMessageListenerUpdate, validateMessageListenerUpdate } from '../src/services/message-listener-store.js';
import { buildListenerSavePayload, patchListenerContentPolicy } from '../src/dashboard/web/listener-draft.js';
import {
  evaluateMessageListener, evaluateMessageListenerWithDocumentTitles, matchesContentPolicy,
  previewMessageListenerMatches,
} from '../src/services/message-listener.js';

function message(text = 'ask @_user_1 question', mentions: any = [{ key: '@_user_1', name: 'Member', id: { open_id: 'ou_target' } }]) {
  return { message_id: 'om_test', message_type: 'text', chat_type: 'group', content: JSON.stringify({ text }), mentions };
}

const identity = { includeMentionedOpenIds: ['ou_target'] };
const combined = { includeKeywords: ['ask'], ...identity, matchMode: 'all' as const };
const rule = (contentPolicy: any = combined) => ({ enabled: true, prompt: 'triage', senderPolicy: { mode: 'all_except_excluded' as const }, contentPolicy });
const bot = (contentPolicy: any = combined): any => ({ botOpenId: 'ou_self', config: { larkAppId: 'cli_listener', globalMessageListener: rule(contentPolicy) } });
const input = (msg = message(), contentPolicy: any = combined) => ({
  bot: bot(contentPolicy), chatId: 'oc_one', message: msg, senderOpenId: 'ou_sender', senderTypeRaw: 'user', explicitlyMentionedThisBot: false,
});

describe('user identity keywords', () => {
  it('matches stable identity regardless of mention key, display name or group', () => {
    const state = bot();
    for (const [chatId, key] of [['oc_one', '@_user_1'], ['oc_two', '@_user_7']]) {
      const msg = message(`ask ${key} question`, [{ key, name: 'Renamed member', id: { open_id: 'ou_target' } }]);
      expect(evaluateMessageListener({ ...input(msg), bot: state, chatId })).toBeDefined();
    }
    expect(evaluateMessageListener(input(message(undefined, [{ key: '@_user_1', name: 'Member', id: { open_id: 'ou_other' } }])))).toBeUndefined();
  });

  it('does not infer an identity from text, the sender, or another ID namespace', () => {
    for (const mentions of [undefined, [], {}, [{ id: 'ou_target', id_type: 'user_id' }], [{ id: { union_id: 'ou_target' } }]]) {
      const msg = { ...message('ask @Member @_user_1 ou_target'), mentions };
      expect(evaluateMessageListener({ ...input(msg), senderOpenId: 'ou_target' })).toBeUndefined();
    }
  });

  it('accepts REST open_id mentions and rich posts with body.content', () => {
    const rest = { ...message(), message_type: undefined, msg_type: 'text', content: undefined, body: { content: JSON.stringify({ text: 'ask @_user_3' }) }, mentions: [{ key: '@_user_3', id: 'ou_target', id_type: 'open_id' }] };
    expect(evaluateMessageListener(input(rest as any))).toBeDefined();
    const post = { ...rest, msg_type: 'post', mentions: [], body: { content: JSON.stringify({ en_us: { content: [[{ tag: 'text', text: 'ask ' }, { tag: 'at', user_id: 'ou_target', user_name: 'Member' }]] } }) } };
    expect(evaluateMessageListener(input(post as any))).toBeDefined();
  });

  it.each(['zh_cn', 'en_us', 'ja_jp'])('matches identity-only rich posts in %s without a text projection', locale => {
    const post = { ...message(), message_type: 'post', mentions: [], content: JSON.stringify({ [locale]: { content: [[{ tag: 'at', user_id: 'ou_target' }]] } }) };
    expect(evaluateMessageListener(input(post, identity))).toBeDefined();
    expect(evaluateMessageListener(input(post))).toBeUndefined();
    expect(evaluateMessageListener(input({ ...post, content: JSON.stringify({ [locale]: { content: [[{ tag: 'at', user_id: 'ou_other' }]] } }) }, identity))).toBeUndefined();
  });

  it('shares any/all across every text and every selected identity', () => {
    const two = { includeKeywords: ['ask', 'question'], includeMentionedOpenIds: ['ou_target', 'ou_other'], matchMode: 'all' as const };
    expect(matchesContentPolicy('ask question', two, message())).toBe(false);
    expect(matchesContentPolicy('ask question', two, message(undefined, [{ id: 'ou_target' }, { id: 'ou_other' }]))).toBe(true);
    expect(matchesContentPolicy('ask', two, message(undefined, [{ id: 'ou_target' }, { id: 'ou_other' }]))).toBe(false);
    expect(matchesContentPolicy('unrelated', identity, message())).toBe(true);
    expect(matchesContentPolicy('unrelated', { ...combined, matchMode: 'any' }, message())).toBe(true);
    expect(matchesContentPolicy('ask', { ...combined, matchMode: 'any' }, message(undefined, []))).toBe(true);
    expect(matchesContentPolicy('unrelated', { ...combined, matchMode: 'any' }, message(undefined, []))).toBe(false);
  });

  it.each(['interactive', 'merge_forward', 'image'])('does not treat inherited mentions in %s as a native @', message_type => {
    const msg = { ...message(), message_type };
    expect(matchesContentPolicy('ask', identity, msg)).toBe(false);
    // Text-only / ANY behavior remains available for these message types.
    expect(matchesContentPolicy('ask', { ...combined, matchMode: 'any' }, msg)).toBe(true);
  });

  it('shares runtime identity matching with preview and honors disabled group overrides', () => {
    const state = bot();
    const messages = [
      { ...message(undefined, []), message_id: 'om_fake' },
      { ...message(undefined, [{ id: 'ou_other' }]), message_id: 'om_wrong' },
      { ...message(), message_id: 'om_real' },
    ];
    const preview = () => previewMessageListenerMatches({ bot: state, chatId: 'oc_one', messages, limit: 5, senderForMessage: () => ({ senderOpenId: 'ou_sender', senderTypeRaw: 'user' }) });
    expect(preview().map(match => match.messageId)).toEqual(['om_real']);
    state.config.groupMessageListenerOverrides = { oc_one: { mode: 'disabled' } };
    expect(preview()).toEqual([]);
  });
});

describe('identity keyword persistence', () => {
  it('round-trips identity-only drafts through browser save and API normalization', () => {
    const draft = rule({ includeMentionedOpenIds: [' ou_target ', 'ou_target'], matchMode: 'all', resolveDocumentTitles: true });
    const payload = buildListenerSavePayload(draft, () => undefined);
    const update = sanitizeMessageListenerUpdate(JSON.parse(JSON.stringify(payload)));
    expect(validateMessageListenerUpdate(update)).toEqual({ ok: true });
    const saved = messageListenerConfigFromUpdate(update!);
    expect(saved?.contentPolicy).toEqual({ ...identity, matchMode: 'all' });
    expect(evaluateMessageListener(input(message(), saved?.contentPolicy))).toBeDefined();
    expect(evaluateMessageListener(input(message(undefined, []), saved?.contentPolicy))).toBeUndefined();
  });

  it('retains identities when text, title resolution or matching mode is edited', () => {
    let draft = rule(combined);
    draft = patchListenerContentPolicy(draft, { includeKeywords: [] }) as typeof draft;
    draft = patchListenerContentPolicy(draft, { matchMode: 'any', resolveDocumentTitles: true }) as typeof draft;
    expect(buildListenerSavePayload(draft, () => undefined).contentPolicy).toEqual(identity);
    const removed = patchListenerContentPolicy(draft, { includeMentionedOpenIds: undefined });
    expect(buildListenerSavePayload(removed, () => undefined).contentPolicy).toBeUndefined();
  });

  it.each([[], null, 'ou_target', ['ou_target', 'bad'], ['ou_target', 7]].map(ids => ({ ids })))('fails closed on malformed or empty identity conditions: $ids', ({ ids: includeMentionedOpenIds }) => {
    const raw = { includeKeywords: ['ask'], includeMentionedOpenIds, matchMode: 'all' };
    const update = sanitizeMessageListenerUpdate({ ...rule(raw) });
    expect(validateMessageListenerUpdate(update)).toEqual({ ok: false, reason: 'keyword_identity_required' });
    const loaded = normalizeListenerContentPolicy(raw);
    expect(matchesContentPolicy('ask', loaded, message())).toBe(false);
    expect(matchesContentPolicy('ask', { ...loaded, matchMode: 'any' }, message())).toBe(false);
  });
});

describe('identity keywords with document titles', () => {
  const policy = { includeKeywords: ['meeting'], ...identity, matchMode: 'all', resolveDocumentTitles: true };

  it('fetches titles for ALL only after all identity terms match', async () => {
    const resolveDocumentTitles = vi.fn(async () => ['meeting notes']);
    await expect(evaluateMessageListenerWithDocumentTitles(input(message('link', []), policy), { resolveDocumentTitles })).resolves.toBeUndefined();
    expect(resolveDocumentTitles).not.toHaveBeenCalled();
    await expect(evaluateMessageListenerWithDocumentTitles(input(message('link'), policy), { resolveDocumentTitles })).resolves.toBeDefined();
    expect(resolveDocumentTitles).toHaveBeenCalledTimes(1);
  });

  it('does not fetch titles for an ANY identity hit, but can resolve text when the identity misses', async () => {
    const resolveDocumentTitles = vi.fn(async () => ['meeting notes']);
    const any = { ...policy, matchMode: 'any' };
    await expect(evaluateMessageListenerWithDocumentTitles(input(message('link'), any), { resolveDocumentTitles })).resolves.toBeDefined();
    expect(resolveDocumentTitles).not.toHaveBeenCalled();
    await expect(evaluateMessageListenerWithDocumentTitles(input(message('link', []), any), { resolveDocumentTitles })).resolves.toBeDefined();
    expect(resolveDocumentTitles).toHaveBeenCalledTimes(1);
  });
});
