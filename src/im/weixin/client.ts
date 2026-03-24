import { createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

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

/** Download and decrypt an AES-128-ECB encrypted image from iLink CDN */
export async function downloadImage(cdnUrl: string, aesKeyBase64: string, savePath: string): Promise<string> {
  const res = await fetch(cdnUrl);
  if (!res.ok) throw new Error(`CDN download failed: ${res.status}`);
  const encrypted = Buffer.from(await res.arrayBuffer());
  const key = Buffer.from(aesKeyBase64, 'base64');
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const dir = dirname(savePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(savePath, decrypted);
  return savePath;
}

/** Encrypt a local file with AES-128-ECB and upload to iLink CDN */
export async function uploadImage(
  token: string,
  localPath: string,
): Promise<{ cdnUrl: string; aesKey: string; fileSize: number }> {
  const raw = readFileSync(localPath);

  // Generate random AES key
  const key = randomBytes(16);
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(raw), cipher.final()]);

  // Get presigned upload URL
  const uploadRes = await fetch(`${ILINK_BASE}/ilink/bot/getuploadurl`, {
    method: 'POST',
    headers: makeHeaders(token),
    body: JSON.stringify({
      file_name: basename(localPath),
      file_size: encrypted.length,
      file_type: 'image/jpeg',
    }),
  });
  const uploadData = await uploadRes.json() as any;
  const presignedUrl = uploadData.url;
  if (!presignedUrl) throw new Error(`getuploadurl failed: ${JSON.stringify(uploadData)}`);

  // Upload encrypted file
  const putRes = await fetch(presignedUrl, {
    method: 'PUT',
    body: encrypted,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!putRes.ok) throw new Error(`CDN upload failed: ${putRes.status}`);

  return {
    cdnUrl: uploadData.download_url || presignedUrl.split('?')[0],
    aesKey: key.toString('base64'),
    fileSize: encrypted.length,
  };
}

/** Send an image message via iLink */
export async function sendImage(
  token: string,
  toUserId: string,
  contextToken: string,
  cdnUrl: string,
  aesKey: string,
  fileSize: number,
): Promise<string> {
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: generateClientId(),
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{
        type: 2,
        image_item: { url: cdnUrl, aes_key: aesKey, file_size: fileSize },
      }],
    },
    base_info: { channel_version: '1.0.2' },
  };
  const res = await fetch(`${ILINK_BASE}/ilink/bot/sendmessage`, {
    method: 'POST',
    headers: makeHeaders(token),
    body: JSON.stringify(body),
  });
  const data = await res.json() as any;
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
