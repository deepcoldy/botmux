import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getBot } from '../bot-registry.js';
import { getChatContext } from '../im/lark/client.js';

// A self-service creator may supply a narrowly scoped default, never talk or
// operation grants. Bind both app and chat: copied descriptions confer nothing.
export function verifySignedChatDefault(description: string | null, appId: string, chatId: string, secret: string): boolean {
  const line = description?.split('\n').find(line => line.startsWith('BOTMUX1:'));
  if (!line || line.length > 1000 || !secret) return false;
  const match = /^BOTMUX1:([A-Za-z0-9_-]{43})$/.exec(line);
  if (!match) return false;
  const signature = match[1];
  const expected = createHmac('sha256', secret).update(`botmux-chat-defaults-v1:${appId}:${chatId}:ambient`).digest('base64url');
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/** Authenticated outbound lookup: no inbound tunnel, no credentials in URLs. */
export async function fetchRegisteredChatDefault(endpoint: string, appId: string, chatId: string, secret: string): Promise<boolean> {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || !secret) throw new Error('Invalid chat registry endpoint');
  const ts = Date.now(), nonce = randomBytes(16).toString('hex');
  const binding = `${appId}:${chatId}:${ts}:${nonce}`;
  const mac = (text: string) => createHmac('sha256', secret).update('bca-registry-v1:' + text).digest('base64url');
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: appId, chatId, ts, nonce, mac: mac('request:' + binding) }),
  });
  if (!response.ok) throw new Error('Chat registry unavailable');
  const body = await response.json() as { ok?: boolean; ambient?: boolean; mac?: string };
  const expected = mac(`response:${binding}:${body.ambient}`);
  if (body.ok !== true || typeof body.ambient !== 'boolean' || typeof body.mac !== 'string'
    || body.mac.length !== expected.length || !timingSafeEqual(Buffer.from(body.mac), Buffer.from(expected))) {
    throw new Error('Invalid chat registry response');
  }
  return body.ambient;
}

const cache = new Map<string, { until: number; ambient: boolean }>();
const pending = new Map<string, Promise<void>>();
export function signedChatMentionDefault(appId: string, chatId?: string): 'ambient' | undefined {
  const entry = cache.get(`${appId}:${chatId}`);
  return entry && entry.until > Date.now() && entry.ambient ? 'ambient' : undefined;
}

/** Rehydrate from legacy proof or cloud registry; explicit /mention-mode wins. */
export async function ensureSignedChatDefault(appId: string, chatId: string, chatType: string): Promise<void> {
  const cfg = getBot(appId).config;
  if (chatType !== 'group' || cfg.signedChatDefaults !== true || cfg.chatMentionModes?.[chatId]) return;
  const key = `${appId}:${chatId}`;
  if ((cache.get(key)?.until ?? 0) > Date.now()) return;
  if (pending.has(key)) return pending.get(key);
  const task = (async () => {
    const context = await getChatContext(appId, chatId);
    // Fail closed on lookup failure, but allow immediate retry next message.
    if (context.fetchStatus !== 'ok') { cache.delete(key); return; }
    let ambient = context.mode === 'group'
      && verifySignedChatDefault(context.description, appId, chatId, cfg.larkAppSecret);
    if (!ambient && context.mode === 'group' && cfg.signedChatDefaultsRegistryUrl) {
      // On outages retain the global mention gate, never infer trust from a name.
      ambient = await fetchRegisteredChatDefault(cfg.signedChatDefaultsRegistryUrl, appId, chatId, cfg.larkAppSecret);
    }
    if (cache.size >= 2000) cache.delete(cache.keys().next().value!);
    cache.set(key, { ambient, until: Date.now() + (ambient ? 60_000 : 2_000) });
  })();
  pending.set(key, task);
  try { await task; } finally { pending.delete(key); }
}
