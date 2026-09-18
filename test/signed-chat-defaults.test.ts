import { createHmac } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { cfg, context } = vi.hoisted(() => ({
  cfg: { signedChatDefaults: true, signedChatDefaultsRegistryUrl: undefined as string | undefined, larkAppSecret: 'secret', regularGroupMentionMode: 'topic', chatMentionModes: {} as Record<string, string> },
  context: vi.fn(),
}));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => ({ config: cfg }) }));
vi.mock('../src/im/lark/client.js', () => ({ getChatContext: context }));
vi.mock('../src/services/config-store.js', () => ({ rmwBotEntry: vi.fn() }));
import { ensureSignedChatDefault, fetchRegisteredChatDefault, signedChatMentionDefault, verifySignedChatDefault } from '../src/services/signed-chat-defaults.js';
import { resolveGroupMentionMode, setChatMentionMode } from '../src/services/chat-reply-mode-store.js';
import { rmwBotEntry } from '../src/services/config-store.js';

function proof(chat: string, overrides: { app?: string; mention?: string } = {}, secret = 'secret') {
  return 'unrelated metadata\nBOTMUX1:' + createHmac('sha256', secret)
    .update(`botmux-chat-defaults-v1:${overrides.app ?? 'app'}:${chat}:${overrides.mention ?? 'ambient'}`).digest('base64url');
}
let n = 0;
describe('signed chat defaults', () => {
  beforeEach(() => { vi.clearAllMocks(); cfg.signedChatDefaults = true; cfg.signedChatDefaultsRegistryUrl = undefined; cfg.chatMentionModes = {}; n++; });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('authenticates registry requests and response bindings without sending the secret', async () => {
    cfg.signedChatDefaultsRegistryUrl = 'https://registry.example/lookup';
    const chat = 'oc_registry' + n;
    context.mockResolvedValue({ fetchStatus: 'ok', mode: 'group', description: 'Self-service group' });
    const mac = (s: string) => createHmac('sha256', 'secret').update('bca-registry-v1:' + s).digest('base64url');
    const fetcher = vi.fn(async (_url, init) => {
      expect(init.body).not.toContain('secret');
      expect(init.redirect).toBe('error');
      const b = JSON.parse(init.body), binding = `${b.app}:${b.chatId}:${b.ts}:${b.nonce}`;
      expect(b.mac).toBe(mac('request:' + binding));
      return new Response(JSON.stringify({ ok: true, ambient: true, mac: mac('response:' + binding + ':true') }));
    });
    vi.stubGlobal('fetch', fetcher);
    await ensureSignedChatDefault('app', chat, 'group');
    expect(resolveGroupMentionMode('app', chat)).toBe('ambient');
    cfg.chatMentionModes[chat] = 'topic';
    expect(resolveGroupMentionMode('app', chat)).toBe('topic');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects forged/replayed registry responses, outages, and unsafe endpoints', async () => {
    cfg.signedChatDefaultsRegistryUrl = 'https://registry.example/lookup';
    const chat = 'oc_denied' + n;
    context.mockResolvedValue({ fetchStatus: 'ok', mode: 'group', description: 'Self-service group' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ok:true,ambient:true,mac:'x'.repeat(43)}))));
    await expect(ensureSignedChatDefault('app', chat, 'group')).rejects.toThrow('Invalid chat registry response');
    expect(resolveGroupMentionMode('app', chat)).toBe('topic');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', {status:503})));
    await expect(ensureSignedChatDefault('app', chat + '-outage', 'group')).rejects.toThrow('unavailable');
    await expect(fetchRegisteredChatDefault('http://example.com', 'app', chat, 'secret')).rejects.toThrow('Invalid');
    expect(resolveGroupMentionMode('app', chat)).toBe('topic');
  });
  it('backs off failed context and registry lookups', async () => {
    const contextFailureChat = 'context-failure' + n;
    context.mockResolvedValue({ fetchStatus: 'unavailable' });
    await ensureSignedChatDefault('app', contextFailureChat, 'group');
    await ensureSignedChatDefault('app', contextFailureChat, 'group');
    expect(context).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    cfg.signedChatDefaultsRegistryUrl = 'https://registry.example/lookup';
    const registryFailureChat = 'registry-failure' + n;
    context.mockResolvedValue({ fetchStatus: 'ok', mode: 'group', description: null });
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(ensureSignedChatDefault('app', registryFailureChat, 'group')).rejects.toThrow('unavailable');
    await expect(ensureSignedChatDefault('app', registryFailureChat, 'group')).resolves.toBeUndefined();
    expect(context).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects a previously valid registry response on a new request', async () => {
    let previousBody = '';
    let previousBinding = '';
    const mac = (s: string) => createHmac('sha256', 'secret').update('bca-registry-v1:' + s).digest('base64url');
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      const binding = `${request.app}:${request.chatId}:${request.ts}:${request.nonce}`;
      if (!previousBody) {
        previousBinding = binding;
        previousBody = JSON.stringify({ ok: true, ambient: true, mac: mac(`response:${binding}:true`) });
      } else {
        expect(binding).not.toBe(previousBinding);
      }
      return new Response(previousBody);
    }));
    await expect(fetchRegisteredChatDefault('https://registry.example/lookup', 'app', 'chat', 'secret')).resolves.toBe(true);
    await expect(fetchRegisteredChatDefault('https://registry.example/lookup', 'app', 'chat', 'secret')).rejects.toThrow('Invalid chat registry response');
  });

  it('an authenticated negative response retains the global mention mode', async () => {
    cfg.signedChatDefaultsRegistryUrl = 'https://registry.example/lookup';
    const chat = 'negative' + n;
    context.mockResolvedValue({ fetchStatus: 'ok', mode: 'group', description: null });
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const b = JSON.parse(init.body);
      const binding = `${b.app}:${b.chatId}:${b.ts}:${b.nonce}`;
      const mac = createHmac('sha256', 'secret').update(`bca-registry-v1:response:${binding}:false`).digest('base64url');
      return new Response(JSON.stringify({ ok: true, ambient: false, mac }));
    }));
    await ensureSignedChatDefault('app', chat, 'group');
    expect(resolveGroupMentionMode('app', chat)).toBe('topic');
  });

  it('explicit overrides skip discovery and invalid endpoints never send a request', async () => {
    const chat = 'explicit' + n;
    cfg.chatMentionModes[chat] = 'topic';
    await ensureSignedChatDefault('app', chat, 'group');
    expect(context).not.toHaveBeenCalled();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    for (const endpoint of ['http://registry.example', 'https://user:password@registry.example']) {
      await expect(fetchRegisteredChatDefault(endpoint, 'app', chat, 'secret')).rejects.toThrow('Invalid');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('binds app, chat, mode and secret; plain descriptions have no authority', () => {
    expect(verifySignedChatDefault(proof('chat'), 'app', 'chat', 'secret')).toBe(true);
    for (const input of [null, 'ambient', 'BOTMUX1:x.x', proof('other'), proof('chat', { app: 'other' }), proof('chat', { mention: 'never' }), proof('chat', {}, 'wrong')]) {
      expect(verifySignedChatDefault(input, 'app', 'chat', 'secret')).toBe(false);
    }
  });
  it('disabled bots and DMs perform no lookups; no shared CLI/backend changes', async () => {
    cfg.signedChatDefaults = false;
    await ensureSignedChatDefault('app', 'off' + n, 'group');
    cfg.signedChatDefaults = true;
    await ensureSignedChatDefault('app', 'dm' + n, 'p2p');
    expect(context).not.toHaveBeenCalled();
  });
  it('hydrates before first unmentioned message; coalesces concurrent reads', async () => {
    const chat = 'hydrate' + n;
    context.mockResolvedValue({ fetchStatus: 'ok', mode: 'group', description: proof(chat) });
    await Promise.all([ensureSignedChatDefault('app', chat, 'group'), ensureSignedChatDefault('app', chat, 'group')]);
    expect(context).toHaveBeenCalledTimes(1);
    expect(resolveGroupMentionMode('app', chat)).toBe('ambient');
    expect(resolveGroupMentionMode('app', 'unrelated')).toBe('topic');
    cfg.chatMentionModes[chat] = 'always';
    expect(resolveGroupMentionMode('app', chat)).toBe('always');
    cfg.signedChatDefaults = false;
    delete cfg.chatMentionModes[chat];
    expect(resolveGroupMentionMode('app', chat)).toBe('topic');
  });
  it('topic groups, invalid proof and failed lookups do not relax gates', async () => {
    const chat = 'closed' + n;
    context.mockResolvedValue({ fetchStatus: 'unavailable' });
    await ensureSignedChatDefault('app', chat, 'group');
    expect(signedChatMentionDefault('app', chat)).toBeUndefined();
    context.mockResolvedValue({ fetchStatus: 'ok', mode: 'topic', description: proof(chat) });
    await ensureSignedChatDefault('app', chat, 'group');
    expect(signedChatMentionDefault('app', chat)).toBeUndefined();
  });
  it('revalidates proof and fails closed after TTL or description removal', async () => {
    vi.useFakeTimers();
    const chat = 'ttl' + n;
    context.mockResolvedValue({ fetchStatus: 'ok', mode: 'group', description: proof(chat) });
    await ensureSignedChatDefault('app', chat, 'group');
    vi.advanceTimersByTime(60_001);
    expect(resolveGroupMentionMode('app', chat)).toBe('topic');
    context.mockResolvedValue({ fetchStatus: 'ok', mode: 'group', description: 'ordinary room' });
    await ensureSignedChatDefault('app', chat, 'group');
    expect(resolveGroupMentionMode('app', chat)).toBe('topic');
  });
  it('explicit topic command persists even if it equals the bot-global default', async () => {
    const chat = 'override' + n;
    context.mockResolvedValue({ fetchStatus: 'ok', mode: 'group', description: proof(chat) });
    await ensureSignedChatDefault('app', chat, 'group');
    const entry: any = {};
    vi.mocked(rmwBotEntry).mockImplementation(async (_id, fn) => ({ ok: true, result: fn(entry).result }) as any);
    await setChatMentionMode('app', chat, 'topic');
    expect(entry.chatMentionModes[chat]).toBe('topic');
    expect(resolveGroupMentionMode('app', chat)).toBe('topic');
  });
});
