import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TOKEN_FILE = join(homedir(), '.botmux', 'weixin-token.json');
const ILINK_BASE = 'https://ilinkai.weixin.qq.com';

export interface WeixinToken {
  bot_token: string;
  bot_id: string;
  created_at: string;
}

export function makeHeaders(token?: string): Record<string, string> {
  const uin = Buffer.from(String(Math.floor(Math.random() * 4294967295))).toString('base64');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': uin,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

export function loadToken(): WeixinToken | null {
  if (!existsSync(TOKEN_FILE)) return null;
  try { return JSON.parse(readFileSync(TOKEN_FILE, 'utf-8')); } catch { return null; }
}

export function saveToken(token: WeixinToken): void {
  const dir = join(homedir(), '.botmux');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2));
}

export async function validateToken(botToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${ILINK_BASE}/ilink/bot/getupdates`, {
      method: 'POST',
      headers: makeHeaders(botToken),
      body: JSON.stringify({ get_updates_buf: '', base_info: { channel_version: '1.0.2' } }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    return data.ret === 0;
  } catch { return false; }
}

export async function getQrCode(): Promise<{ qrcode: string; qrcode_img_content: string }> {
  const res = await fetch(`${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`, {
    headers: makeHeaders(),
  });
  return res.json();
}

export async function pollQrCodeStatus(qrcode: string): Promise<WeixinToken> {
  while (true) {
    const res = await fetch(
      `${ILINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      { headers: makeHeaders() },
    );
    const data = await res.json();
    if (data.status === 'confirmed') {
      return {
        bot_token: data.bot_token,
        bot_id: data.bot_id ?? '',
        created_at: new Date().toISOString(),
      };
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}
