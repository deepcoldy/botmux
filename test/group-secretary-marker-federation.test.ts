import { describe, it, expect, vi } from 'vitest';
import { buildSecretaryDescription, parseSecretaryMarker } from '../src/services/group-secretary-marker.js';
import { fetchRemoteSecretarySessions, fetchRemoteSecretaryTranscript } from '../src/services/group-secretary-federation.js';

describe('group description secretary marker', () => {
  it('parses, replaces and clears only its own line, keeping human text and the manager marker', () => {
    const desc = '项目讨论群\n[botmux:manager=cli_m]';
    const withSec = buildSecretaryDescription(desc, 'cli_a');
    expect(withSec).toBe('项目讨论群\n[botmux:manager=cli_m]\n[botmux:secretary=cli_a]');
    expect(parseSecretaryMarker(withSec).appId).toBe('cli_a');
    const switched = buildSecretaryDescription(withSec, 'cli_b');
    expect(switched).toBe('项目讨论群\n[botmux:manager=cli_m]\n[botmux:secretary=cli_b]');
    expect(buildSecretaryDescription(switched, null)).toBe('项目讨论群\n[botmux:manager=cli_m]');
    expect(buildSecretaryDescription('', 'cli_a')).toBe('[botmux:secretary=cli_a]');
    expect(parseSecretaryMarker('随便写写').appId).toBeUndefined();
  });
});

describe('federation secretary client', () => {
  const peer = { name: 'maxsvr', baseUrl: 'http://peer:7891', token: 'tok' };
  it('pulls remote sessions with the bearer token, keeps only the asked chat, maps app → peer', async () => {
    const fetcher = vi.fn(async (url: string, init: any) => {
      expect(init.headers.authorization).toBe('Bearer tok');
      expect(url).toContain('/api/federation/secretary/sessions?chatId=oc_1');
      return new Response(JSON.stringify({ ok: true, sessions: [
        { sessionId: 's1', chatId: 'oc_1', larkAppId: 'cli_fox', botName: 'fox', scope: 'thread', rootMessageId: 'om_t', liveness: 'alive', turn: 'working' },
        { sessionId: 's2', chatId: 'oc_other', larkAppId: 'cli_fox', liveness: 'alive', turn: 'idle' },
        { bogus: true },
      ] }), { status: 200 });
    });
    const r = await fetchRemoteSecretarySessions([peer], ['oc_1'], { fetcher: fetcher as any });
    expect(r.views.map(v => [v.sessionId, v.peer, v.turn])).toEqual([['s1', 'maxsvr', 'working']]);
    expect(r.appPeer.get('cli_fox')).toBe(peer);
  });
  it('an unreachable or rejecting peer yields nothing instead of throwing', async () => {
    const down = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    expect((await fetchRemoteSecretarySessions([peer], ['oc_1'], { fetcher: down as any })).views).toEqual([]);
    const denied = vi.fn(async () => new Response('{"ok":false}', { status: 403 }));
    expect((await fetchRemoteSecretarySessions([peer], ['oc_1'], { fetcher: denied as any })).views).toEqual([]);
    expect(await fetchRemoteSecretaryTranscript(peer, 'cli_fox', 's1', { fetcher: denied as any })).toBeUndefined();
  });
});
