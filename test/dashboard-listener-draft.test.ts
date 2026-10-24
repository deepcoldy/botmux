import { describe, expect, it } from 'vitest';
import {
  buildListenerSavePayload,
  describeListenerWidening,
  listenerDraftKey,
  patchListenerContentPolicy,
  patchListenerMessagePolicy,
  patchListenerSenderPolicy,
  toggleListenerMsgType,
  toggleListenerSenderType,
} from '../src/dashboard/web/listener-draft.js';
import type { MessageListenerData } from '../src/dashboard/web/roles.js';

function allowListListener(): MessageListenerData {
  return {
    enabled: true,
    prompt: 'triage',
    senderPolicy: { mode: 'include_only', includeSenderOpenIds: ['ou_alice'], includeSenderTypes: ['user'], excludeSelf: true },
    messagePolicy: { includeMsgTypes: ['text', 'post'], scope: 'top_level' },
    contentPolicy: { includeKeywords: ['bug'], matchMode: 'all', resolveDocumentTitles: true },
  };
}

describe('listener draft patches', () => {
  it('merges a partial sender patch instead of replacing the allow-list', () => {
    // Replacing senderPolicy with `{ excludeSelf }` used to drop mode, the
    // allow-list and sender types — the backend then saved "listen to everyone".
    const next = patchListenerSenderPolicy(allowListListener(), { excludeSelf: false });
    expect(next.senderPolicy).toEqual({ mode: 'include_only', includeSenderOpenIds: ['ou_alice'], includeSenderTypes: ['user'], excludeSelf: false });
  });

  it('keeps keywords when only the match mode changes, and vice versa', () => {
    const byMode = patchListenerContentPolicy(allowListListener(), { matchMode: 'any' });
    expect(byMode.contentPolicy).toEqual({ includeKeywords: ['bug'], matchMode: 'any', resolveDocumentTitles: true });
    const byKeywords = patchListenerContentPolicy(allowListListener(), { includeKeywords: ['bug', 'crash'] });
    expect(byKeywords.contentPolicy).toEqual({ includeKeywords: ['bug', 'crash'], matchMode: 'all', resolveDocumentTitles: true });
  });

  it('pins message scope to top_level while merging', () => {
    const next = patchListenerMessagePolicy(allowListListener(), { includeMsgTypes: ['text'] });
    expect(next.messagePolicy).toEqual({ includeMsgTypes: ['text'], scope: 'top_level' });
  });

  it('refuses to uncheck the last sender / message type (empty means "all types")', () => {
    const listener = allowListListener();
    expect(toggleListenerSenderType(listener, 'user', false)).toBe(listener);
    expect(toggleListenerSenderType(listener, 'bot', true).senderPolicy?.includeSenderTypes).toEqual(['user', 'bot']);
    const textOnly = toggleListenerMsgType(listener, 'post', false);
    expect(textOnly.messagePolicy?.includeMsgTypes).toEqual(['text']);
    expect(toggleListenerMsgType(textOnly, 'text', false)).toBe(textOnly);
  });
});

describe('buildListenerSavePayload', () => {
  it('persists only the list of the active sender mode', () => {
    const listener = patchListenerSenderPolicy(allowListListener(), { excludeSenderOpenIds: ['ou_stale'] });
    const payload = buildListenerSavePayload(listener, () => undefined);
    expect(payload.senderPolicy).toEqual({ mode: 'include_only', includeSenderOpenIds: ['ou_alice'], includeSenderTypes: ['user'], excludeSelf: true });
  });

  it('carries the auto-close opt-in, and only when it is on', () => {
    expect(buildListenerSavePayload({ ...allowListListener(), autoCloseAfterCompletion: true }, () => undefined).autoCloseAfterCompletion).toBe(true);
    expect(buildListenerSavePayload(allowListListener(), () => undefined).autoCloseAfterCompletion).toBeUndefined();
  });

  it('round-trips sender types excluded outside the dashboard', () => {
    const listener = patchListenerSenderPolicy(allowListListener(), { excludeSenderTypes: ['bot'] });
    expect(buildListenerSavePayload(listener, () => undefined).senderPolicy?.excludeSenderTypes).toEqual(['bot']);
  });

  it('records the kind of each excluded sender, live roster first, then persisted', () => {
    const listener: MessageListenerData = {
      enabled: true,
      prompt: 'p',
      senderPolicy: {
        mode: 'all_except_excluded',
        excludeSenderOpenIds: ['ou_human', 'ou_known_bot', 'ou_never_seen'],
        excludeSenderKinds: { ou_known_bot: 'bot' },
      },
    };
    const live: Record<string, 'user' | 'bot' | 'unknown'> = { ou_human: 'user', ou_known_bot: 'unknown' };
    const payload = buildListenerSavePayload(listener, openId => live[openId]);
    expect(payload.senderPolicy?.excludeSenderOpenIds).toEqual(['ou_human', 'ou_known_bot', 'ou_never_seen']);
    // A never-identified id stays absent so the runtime keeps failing closed on it.
    expect(payload.senderPolicy?.excludeSenderKinds).toEqual({ ou_human: 'user', ou_known_bot: 'bot' });
  });

  it('trims keywords and drops an emptied keyword list together with its match mode', () => {
    const trimmed = buildListenerSavePayload(patchListenerContentPolicy(allowListListener(), { includeKeywords: [' bug ', 'bug', ''] }), () => undefined);
    expect(trimmed.contentPolicy).toEqual({ includeKeywords: ['bug'], matchMode: 'all', resolveDocumentTitles: true });
    const emptied = buildListenerSavePayload(patchListenerContentPolicy(allowListListener(), { includeKeywords: [] }), () => undefined);
    expect(emptied.contentPolicy).toBeUndefined();
  });
});

describe('listenerDraftKey', () => {
  it('changes when the auto-close opt-in is toggled', () => {
    expect(listenerDraftKey({ ...allowListListener(), autoCloseAfterCompletion: true })).not.toBe(listenerDraftKey(allowListListener()));
    expect(listenerDraftKey({ ...allowListListener(), autoCloseAfterCompletion: false })).toBe(listenerDraftKey(allowListListener()));
  });

  it('ignores the sender kinds derived at save time', () => {
    const draft = patchListenerSenderPolicy(allowListListener(), { mode: 'all_except_excluded', excludeSenderOpenIds: ['ou_bob'] });
    const reloaded = patchListenerSenderPolicy(draft, { excludeSenderKinds: { ou_bob: 'user' } });
    expect(listenerDraftKey(reloaded)).toBe(listenerDraftKey(draft));
    expect(listenerDraftKey(patchListenerSenderPolicy(draft, { excludeSenderOpenIds: [] }))).not.toBe(listenerDraftKey(draft));
  });
});

describe('describeListenerWidening', () => {
  const MSG_TYPES = ['text', 'post', 'image', 'interactive'];
  const widen = (before: MessageListenerData, after: MessageListenerData) => describeListenerWidening(before, after, MSG_TYPES);
  const base = allowListListener();

  it('reports turning a rule on, and nothing for a rule that ends up off', () => {
    expect(widen({ ...base, enabled: false }, base)).toEqual(['enable']);
    expect(widen(base, { ...base, enabled: false })).toEqual([]);
  });

  it('reports wider sender coverage', () => {
    expect(widen(base, patchListenerSenderPolicy(base, { mode: 'all_except_excluded' }))).toEqual(['allSenders']);
    expect(widen(base, patchListenerSenderPolicy(base, { includeSenderOpenIds: ['ou_alice', 'ou_bob'] }))).toEqual(['moreSenders']);
    expect(widen(base, patchListenerSenderPolicy(base, { includeSenderOpenIds: [] }))).toEqual([]);
    const blacklist = patchListenerSenderPolicy(base, { mode: 'all_except_excluded', excludeSenderOpenIds: ['ou_bob'] });
    expect(widen(blacklist, patchListenerSenderPolicy(blacklist, { excludeSenderOpenIds: [] }))).toEqual(['moreSenders']);
    expect(widen(base, toggleListenerSenderType(base, 'bot', true))).toEqual(['senderTypes']);
    expect(widen(base, patchListenerSenderPolicy(base, { excludeSelf: false }))).toEqual(['includeSelf']);
  });

  it('reports added message types and a reply moved to the group chat', () => {
    expect(widen(base, toggleListenerMsgType(base, 'image', true))).toEqual(['msgTypes']);
    expect(widen(base, toggleListenerMsgType(base, 'post', false))).toEqual([]);
    expect(widen(base, { ...base, replyPolicy: { mode: 'chat', sessionMode: 'per_message' } })).toEqual(['replyChat']);
  });

  it('compares keyword filters as sets under their match mode', () => {
    const any = (...keywords: string[]) => ({ ...base, contentPolicy: { includeKeywords: keywords } });
    const all = (...keywords: string[]) => ({ ...base, contentPolicy: { includeKeywords: keywords, matchMode: 'all' as const } });
    expect(widen(any('bug'), any('bug', 'crash'))).toEqual(['keywords']);
    expect(widen(any('bug', 'crash'), any('bug'))).toEqual([]);
    expect(widen(all('bug', 'crash'), all('bug'))).toEqual(['keywords']);
    expect(widen(all('bug'), all('bug', 'crash'))).toEqual([]);
    expect(widen(all('bug'), any('bug'))).toEqual(['keywords']);
    // "any of bug/crash" → "all of bug": every match still contains bug.
    expect(widen(any('bug', 'crash'), all('BUG'))).toEqual([]);
    expect(widen(any('bug'), all('crash'))).toEqual(['keywords']);
    expect(widen(any('bug'), { ...base, contentPolicy: undefined })).toEqual(['keywords']);
    expect(widen({ ...base, contentPolicy: undefined }, any('bug'))).toEqual([]);
  });
});
