import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyRoleProfile,
  botInChatCount,
  botRoleCount,
  byteLength,
  entryForBot,
  filterRoleGroups,
  filterRoleProfiles,
  formatListenerPreviewTime,
  hashBotId,
  hashChatId,
  isValidProfileId,
  mergeListenerContentPolicy,
  previewMessageListener,
  runMessageListenerPreview,
  saveInjectMode,
  type GroupInfo,
} from '../src/dashboard/web/roles.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('message listener content policy helpers', () => {
  it('preserves keywords when the title-resolution checkbox is toggled', () => {
    const withKeywords = mergeListenerContentPolicy(undefined, { includeKeywords: ['智能纪要'] });
    expect(mergeListenerContentPolicy(withKeywords, {
      includeKeywords: [...(withKeywords.includeKeywords ?? [])],
      resolveDocumentTitles: true,
    })).toEqual({ includeKeywords: ['智能纪要'], resolveDocumentTitles: true });
  });
});

describe('roles helpers', () => {
  const groups: GroupInfo[] = [{
    chatId: 'oc_chat_a',
    name: 'Prod Review',
    memberBots: [
      { larkAppId: 'cli_a', botName: 'Alpha', inChat: true, hasRole: true, oncallChat: null },
      { larkAppId: 'cli_b', botName: 'Beta', inChat: false, hasRole: true, oncallChat: null },
      { larkAppId: 'cli_c', botName: 'Gamma', inChat: true, hasRole: false, oncallChat: null },
    ],
  }];

  it('validates profile ids and parses roles profile hash query state', () => {
    expect(isValidProfileId('collab-main_1.2')).toBe(true);
    expect(isValidProfileId('.')).toBe(false);
    expect(isValidProfileId('..')).toBe(false);
    expect(isValidProfileId('bad space')).toBe(false);
    expect(hashChatId('#/roles/profile?chatId=oc_chat_a')).toBe('oc_chat_a');
    expect(hashChatId('#/roles/profile?chatId=')).toBeNull();
    expect(hashBotId('#/roles?chatId=oc_chat_a&botId=cli_a')).toBe('cli_a');
    expect(hashBotId('#/roles?chatId=oc_chat_a')).toBeNull();
  });

  it('filters groups/profiles and counts only bots currently in chat', () => {
    expect(filterRoleGroups(groups, 'alpha')).toHaveLength(1);
    expect(filterRoleGroups(groups, 'missing')).toHaveLength(0);
    expect(botRoleCount(groups[0])).toBe(1);
    expect(botInChatCount(groups[0])).toBe(2);
    expect(filterRoleProfiles([
      { profileId: 'main', entryCount: 1, updatedAt: null },
      { profileId: 'ops', entryCount: 0, updatedAt: null },
    ], 'ma').map(profile => profile.profileId)).toEqual(['main']);
  });

  it('computes byte length and finds profile entries by bot id', () => {
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('你好')).toBe(6);
    expect(entryForBot([
      { profileId: 'main', larkAppId: 'cli_a', content: 'role', byteLength: 4, updatedAt: null },
    ], 'cli_a')?.content).toBe('role');
    expect(entryForBot([], 'cli_a')).toBeUndefined();
    expect(entryForBot([], null)).toBeUndefined();
  });

  it('formats listener preview create times as local timestamps', () => {
    const expected = (() => {
      const d = new Date(1785139176792);
      const pad = (value: number) => String(value).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    })();

    expect(formatListenerPreviewTime('1785139176792')).toBe(expected);
    expect(formatListenerPreviewTime('1785139176')).toBe(formatListenerPreviewTime('1785139176000'));
    expect(formatListenerPreviewTime(undefined)).toBe('');
    expect(formatListenerPreviewTime('not-a-time')).toBe('');
  });

  it('keeps role write APIs on the existing endpoints and request bodies', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(saveInjectMode('cli_a', 'oc_chat_a', 'once')).resolves.toBe(true);
    await expect(applyRoleProfile({
      profileId: 'main',
      chatId: 'oc_chat_a',
      larkAppId: 'cli_a',
      force: true,
      preview: false,
    })).resolves.toMatchObject({ larkAppId: 'cli_a', ok: true, status: 200 });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/roles/cli_a/oc_chat_a');
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ injectMode: 'once' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/role-profiles/main/apply');
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual({
      chatId: 'oc_chat_a',
      larkAppId: 'cli_a',
      force: true,
      preview: false,
    });
  });

  it('uses listener preview and run endpoints with a capped count', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      requestedLimit: 20,
      matches: [{ messageId: 'om_1', messageText: 'alert', msgType: 'text' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(previewMessageListener('cli_a', 'oc_chat_a', { enabled: true, prompt: 'listener' } as any, 50))
      .resolves.toMatchObject({ ok: true, requestedLimit: 20, matches: [{ messageId: 'om_1' }] });
    await expect(runMessageListenerPreview('cli_a', 'oc_chat_a', { enabled: true, prompt: 'listener' } as any, 3))
      .resolves.toMatchObject({ ok: true });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/message-listeners/cli_a/oc_chat_a/preview');
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({ limit: 20 });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/message-listeners/cli_a/oc_chat_a/run-preview');
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toMatchObject({ limit: 3 });
  });
});
