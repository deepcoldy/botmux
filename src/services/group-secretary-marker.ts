/**
 * 群秘书的全群唯一登记：写在群描述里的一行标记 `[botmux:secretary=<larkAppId>]`。
 *
 * 所有机器上的 bot 都读同一个群描述，因此跨机器也只有一个秘书；`takeover` 改写这一行，
 * 原秘书的 daemon 下次刷新标记（≤60s）就会停手。与群负责人标记（[botmux:manager=…]）
 * 互不影响：只增删本标记这一行，其它内容原样保留。飞书没有 CAS，并发改写以后写者为准，
 * 写后回读确认。
 */
import { getBotClient } from '../bot-registry.js';
import { larkGet } from '../im/lark/client.js';

const MARKER_RE = /^\[botmux:secretary=([A-Za-z0-9_-]+)\]$/;
/** 与群负责人一致的描述长度上限，超出时拒绝而不是截断用户写的说明。 */
const MAX_DESCRIPTION_CHARS = 100;

export function parseSecretaryMarker(description: string): { humanText: string; appId?: string } {
  const lines = description.split('\n');
  const hits = lines.map((line, i) => ({ i, m: MARKER_RE.exec(line.trim()) })).filter(h => h.m);
  if (hits.length === 0) return { humanText: description };
  // 多行标记（人为复制等）：以最后一行为准，写回时全部清掉再写一行。
  const appId = hits[hits.length - 1]!.m![1];
  const keep = lines.filter((_, i) => !hits.some(h => h.i === i));
  return { humanText: keep.join('\n'), appId };
}

export function buildSecretaryDescription(description: string, appId: string | null): string {
  const { humanText } = parseSecretaryMarker(description);
  const base = humanText.replace(/\n+$/, '');
  if (!appId) return base;
  return `${base}${base ? '\n' : ''}[botmux:secretary=${appId}]`;
}

async function readChatDescription(app: string, chat: string): Promise<string> {
  const res = await larkGet(getBotClient(app), `/open-apis/im/v1/chats/${encodeURIComponent(chat)}`, {}, { timeoutMs: 5_000 });
  if (res.code !== 0) throw new Error('chat_read_failed');
  return typeof res.data?.description === 'string' ? res.data.description : '';
}

export async function readSecretaryMarker(app: string, chat: string): Promise<string | undefined> {
  return parseSecretaryMarker(await readChatDescription(app, chat)).appId;
}

export type MarkerWriteResult = { ok: true; previous?: string } | { ok: false; reason: string; previous?: string };

/** 把群秘书标记设为 appId（null = 清除）。
 *  传 `expect` 时是条件写：写前回读到的标记必须仍是调用方之前读到的那个（null = 没有标记），
 *  否则不写、返回 marker_changed。飞书没有 CAS，这只把「读到再写」之间的竞争窗口缩到一次回读，
 *  写后仍回读确认。用于不该覆盖别人新写入标记的场景（旧登记迁移、迁移回滚）。 */
export async function writeSecretaryMarker(
  app: string, chat: string, appId: string | null, opts?: { expect?: string | null },
): Promise<MarkerWriteResult> {
  try {
    const current = await readChatDescription(app, chat);
    const previous = parseSecretaryMarker(current).appId;
    if (opts && 'expect' in opts && (previous ?? null) !== (opts.expect ?? null)) {
      return { ok: false, reason: 'marker_changed', ...(previous ? { previous } : {}) };
    }
    const next = buildSecretaryDescription(current, appId);
    if (next === current) return { ok: true, ...(previous ? { previous } : {}) };
    if (Array.from(next).length > MAX_DESCRIPTION_CHARS) return { ok: false, reason: 'description_too_long' };
    const res = await getBotClient(app).im.v1.chat.update({ path: { chat_id: chat }, data: { description: next } });
    if (res.code !== 0) return { ok: false, reason: `chat_update_failed(${res.code})` };
    const confirmed = parseSecretaryMarker(await readChatDescription(app, chat)).appId;
    if ((confirmed ?? null) !== appId) return { ok: false, reason: 'chat_update_unconfirmed' };
    return { ok: true, ...(previous ? { previous } : {}) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error && /^chat_/.test(err.message) ? err.message : 'marker_operation_failed' };
  }
}
