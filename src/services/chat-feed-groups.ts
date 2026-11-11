/** Replace one operator's manageable personal feed-group associations for one chat. */
import { getBot } from '../bot-registry.js';
import { canOperate } from '../im/lark/event-dispatcher.js';
import { larkHosts, normalizeBrand } from '../im/lark/lark-hosts.js';
import { resolveUserToken } from '../utils/user-token.js';
import { AsyncSerialQueue } from '../utils/async-serial-queue.js';

const writes = new AsyncSerialQueue();
const LABELS = new Set(['p0', 'p1', 'pending', 'watching']);
type FeedGroup = { id: string; name: string };

/** Dependencies separate the group operation from credentials and real network requests. */
export interface ChatFeedGroupApi {
  request(path: string, body?: unknown): Promise<Record<string, unknown>>;
}

/** Read the complete manageable directory before mutating; never silently truncate it. */
async function groups(api: ChatFeedGroupApi): Promise<FeedGroup[]> {
  const result: FeedGroup[] = [];
  const seen = new Set<string>();
  let token = '';
  for (let page = 0; page < 20; page++) {
    // Feishu rejects a first page without page_token (9499); send it empty.
    const query = new URLSearchParams({ page_size: '50', page_token: token });
    const data = await api.request(`/open-apis/im/v1/groups?${query}`);
    if (!Array.isArray(data.groups)) throw new Error('invalid_feed_group_directory');
    for (const raw of data.groups) {
      if (!raw || typeof raw !== 'object') throw new Error('invalid_feed_group_directory');
      const row = raw as Record<string, unknown>;
      if (row.type !== undefined && row.type !== 'normal') continue;
      if (typeof row.group_id !== 'string' || !row.group_id || typeof row.name !== 'string') throw new Error('invalid_feed_group_directory');
      if (!seen.has(row.group_id)) result.push({ id: row.group_id, name: row.name });
      seen.add(row.group_id);
    }
    if (data.has_more !== true) return result;
    if (typeof data.page_token !== 'string' || !data.page_token || token === data.page_token) break;
    token = data.page_token;
  }
  throw new Error('incomplete_feed_group_directory');
}

/** Add the target first, then remove this chat from every other manageable label. */
export async function replaceChatFeedGroups(api: ChatFeedGroupApi, chatId: string, label: string | null): Promise<void> {
  if (!/^oc_[a-zA-Z0-9_-]+$/.test(chatId) || (label !== null && !LABELS.has(label))) throw new Error('invalid_chat_label');
  const directory = await groups(api);
  let target = directory.find(group => group.name === label)?.id;
  if (directory.filter(group => group.name === label).length > 1) throw new Error('ambiguous_feed_group');
  if (label !== null && !target) {
    const created = await api.request('/open-apis/im/v1/groups', { feed_group_creator: { type: 'normal', name: label } });
    if (typeof created.group_id !== 'string' || !created.group_id) throw new Error('missing_feed_group_id');
    target = created.group_id;
  }
  const item = { items: [{ feed_id: chatId, feed_type: 'chat' }] };
  if (target) await api.request(`/open-apis/im/v1/groups/${encodeURIComponent(target)}/batch_add_item`, item);
  for (const group of directory) {
    if (group.id !== target) await api.request(`/open-apis/im/v1/groups/${encodeURIComponent(group.id)}/batch_remove_item`, item);
  }
}

/** Resolve only the command sender's app-scoped OAuth; never borrow the Bot owner's identity. */
export async function setChatFeedGroup(appId: string, chatId: string, actorOpenId: string, label: string | null, clientSignal?: AbortSignal) {
  if (!/^ou_[a-zA-Z0-9]+$/.test(actorOpenId) || !canOperate(appId, chatId, actorOpenId)) {
    return { ok: false as const, error: 'permission_denied' };
  }
  if (!/^oc_[a-zA-Z0-9_-]+$/.test(chatId) || (label !== null && !LABELS.has(label))) return { ok: false as const, error: 'invalid_chat_label' };
  return writes.run(async () => {
    try {
      const signal = clientSignal ? AbortSignal.any([clientSignal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000);
      signal.throwIfAborted();
      if (!canOperate(appId, chatId, actorOpenId)) return { ok: false as const, error: 'permission_denied' };
      const cfg = getBot(appId).config;
      const brand = normalizeBrand(cfg.brand);
      const token = await resolveUserToken(appId, cfg.larkAppSecret, brand, actorOpenId, signal);
      signal.throwIfAborted();
      if (!token) return { ok: false as const, error: 'user_login_required' };
      await replaceChatFeedGroups({
        async request(path, body) {
          const response = await fetch(`${larkHosts(brand).openApi}${path}`, {
            method: body === undefined ? 'GET' : 'POST', signal,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          const payload: unknown = await response.json();
          if (!payload || typeof payload !== 'object') throw new Error('invalid_feed_group_response');
          const envelope = payload as Record<string, unknown>;
          if (!response.ok || envelope.code !== 0) throw new Error('feed_group_request_failed');
          const data = envelope.data ?? {};
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid_feed_group_response');
          const record = data as Record<string, unknown>;
          if (Array.isArray(record.failed_items) && record.failed_items.length) throw new Error('feed_group_item_failed');
          return record;
        },
      }, chatId, label);
      return { ok: true as const, chatId, label };
    } catch {
      // The request can have changed some associations before timing out.
      return { ok: false as const, error: 'feed_group_update_unconfirmed' };
    }
  });
}
