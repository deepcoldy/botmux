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
  ret: number;
  msgs: any[];
  get_updates_buf: string;
  longpolling_timeout_ms: number;
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

export async function sendMessage(
  token: string,
  toUserId: string,
  text: string,
  contextToken: string,
): Promise<string> {
  const res = await fetch(`${ILINK_BASE}/ilink/bot/sendmessage`, {
    method: 'POST',
    headers: makeHeaders(token),
    body: JSON.stringify({
      to_user_id: toUserId,
      context_token: contextToken,
      item_list: [{ type: 1, text_item: { text } }],
    }),
  });
  const data = await res.json();
  return data.msg_id ?? '';
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
