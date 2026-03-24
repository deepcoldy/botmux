const ILINK_BASE = 'https://ilinkai.weixin.qq.com';

function makeHeaders(token: string): Record<string, string> {
  const uin = Buffer.from(String(Math.floor(Math.random() * 4294967295))).toString('base64');
  return {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': uin,
    'Authorization': `Bearer ${token}`,
  };
}

export interface GetUpdatesResponse {
  // Success fields
  msgs?: any[];
  sync_buf?: string;
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
  // Error fields
  errcode?: number;
  errmsg?: string;
}

export async function getUpdates(token: string, cursor: string): Promise<GetUpdatesResponse> {
  const res = await fetch(`${ILINK_BASE}/ilink/bot/getupdates`, {
    method: 'POST',
    headers: makeHeaders(token),
    body: JSON.stringify({
      get_updates_buf: cursor,
      base_info: { channel_version: '1.0.2' },
    }),
    signal: AbortSignal.timeout(40000),
  });
  return res.json();
}

/** Check if a getUpdates response indicates an auth/session error */
export function isAuthError(data: GetUpdatesResponse): boolean {
  return data.errcode !== undefined && data.errcode !== 0;
}

/** Check if a getUpdates response is successful (has msgs array) */
export function isSuccess(data: GetUpdatesResponse): boolean {
  return Array.isArray(data.msgs);
}

function generateClientId(): string {
  return `botmux_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function sendMessage(
  token: string,
  toUserId: string,
  text: string,
  contextToken: string,
): Promise<string> {
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: generateClientId(),
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{ type: 1, text_item: { text } }],
    },
    base_info: { channel_version: '1.0.2' },
  };
  const res = await fetch(`${ILINK_BASE}/ilink/bot/sendmessage`, {
    method: 'POST',
    headers: makeHeaders(token),
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let data: any;
  try { data = JSON.parse(raw); } catch { data = {}; }
  return data.msg_id ?? data.message_id ?? '';
}

export async function sendTyping(
  token: string,
  toUserId: string,
  contextToken: string,
): Promise<void> {
  await fetch(`${ILINK_BASE}/ilink/bot/sendtyping`, {
    method: 'POST',
    headers: makeHeaders(token),
    body: JSON.stringify({
      to_user_id: toUserId,
      context_token: contextToken,
    }),
  });
}
