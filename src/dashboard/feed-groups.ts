import type { BotConfig } from '../bot-registry.js';
import { larkHosts, normalizeBrand } from '../im/lark/lark-hosts.js';
import { resolveOwnerUserToken } from '../utils/user-token.js';

export const FEED_GROUP_SCOPES = ['im:feed_group_v1:read', 'im:feed_group_v1:write'] as const;

export interface FeedGroup {
  groupId: string;
  name: string;
  type: string;
}

export class FeedGroupApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

type ApiEnvelope = {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
};

async function userApi(
  bot: Pick<BotConfig, 'larkAppId' | 'larkAppSecret' | 'brand' | 'ownerOpenId'>,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const brand = normalizeBrand(bot.brand);
  // 「消息分组」只存在于某个人的收件箱里 —— 始终用 owner 本人的 token。
  const token = await resolveOwnerUserToken(bot.larkAppId, bot.larkAppSecret, brand, bot.ownerOpenId);
  if (!token) throw new FeedGroupApiError('尚未获得飞书标签权限，请点击「立即授权」按钮进行授权。', 'user_login_required', 401);
  const response = await fetchImpl(`${larkHosts(brand).openApi}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
      ...init.headers,
    },
  });
  const envelope = await response.json().catch(() => ({})) as ApiEnvelope;
  if (!response.ok || (typeof envelope.code === 'number' && envelope.code !== 0)) {
    const code = envelope.code ? `feishu_${envelope.code}` : `http_${response.status}`;
    throw new FeedGroupApiError(envelope.msg || `飞书标签接口请求失败（${code}）`, code, response.status || 502);
  }
  return (envelope.data ?? envelope) as Record<string, unknown>;
}

/** List all live native Feishu/Lark conversation labels for the authorized user. */
export async function listFeedGroups(
  bot: Pick<BotConfig, 'larkAppId' | 'larkAppSecret' | 'brand'>,
  fetchImpl: typeof fetch = fetch,
): Promise<FeedGroup[]> {
  const groups: FeedGroup[] = [];
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ page_size: '50', page_token: pageToken });
    const data = await userApi(bot, `/open-apis/im/v1/groups?${query}`, { method: 'GET' }, fetchImpl);
    for (const raw of Array.isArray(data.groups) ? data.groups : []) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      if (typeof item.group_id !== 'string' || typeof item.name !== 'string') continue;
      groups.push({ groupId: item.group_id, name: item.name, type: String(item.type ?? 'normal') });
    }
    if (data.has_more !== true || typeof data.page_token !== 'string' || !data.page_token) break;
    pageToken = data.page_token;
  }
  return groups;
}

export async function createFeedGroup(
  bot: Pick<BotConfig, 'larkAppId' | 'larkAppSecret' | 'brand'>,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const data = await userApi(bot, '/open-apis/im/v1/groups', {
    method: 'POST',
    body: JSON.stringify({ feed_group_creator: { type: 'normal', name } }),
  }, fetchImpl);
  if (typeof data.group_id !== 'string' || !data.group_id) {
    throw new FeedGroupApiError('飞书创建标签成功，但响应中缺少标签 ID。', 'missing_group_id');
  }
  return data.group_id;
}

export async function addChatToFeedGroup(
  bot: Pick<BotConfig, 'larkAppId' | 'larkAppSecret' | 'brand'>,
  feedGroupId: string,
  chatId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const data = await userApi(bot, `/open-apis/im/v1/groups/${encodeURIComponent(feedGroupId)}/batch_add_item`, {
    method: 'POST',
    body: JSON.stringify({ items: [{ feed_id: chatId, feed_type: 'chat' }] }),
  }, fetchImpl);
  const failures = Array.isArray(data.failed_items) ? data.failed_items : [];
  if (failures.length > 0) {
    const first = failures[0] as Record<string, unknown>;
    throw new FeedGroupApiError(String(first.error_message ?? '飞书未能把群聊加入标签。'), 'feed_group_add_failed');
  }
}
