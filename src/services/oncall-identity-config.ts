import type { Brand } from '../im/lark/lark-hosts.js';

export const ONCALL_IDENTITY_ENV_KEYS = ['ONCALL_IDENTITY_APP_ID', 'ONCALL_IDENTITY_APP_SECRET', 'ONCALL_IDENTITY_BRAND'] as const;
export interface OncallIdentityApp { appId: string; appSecret: string; brand: Brand }

/** A saved application must never borrow another generation's inherited secret. */
export function readOncallIdentityEnv(saved: NodeJS.ProcessEnv, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const source = ONCALL_IDENTITY_ENV_KEYS.some(key => Object.hasOwn(saved, key)) ? saved : inherited;
  return Object.fromEntries(ONCALL_IDENTITY_ENV_KEYS.map(key => [key, source[key]]));
}

export function readOncallIdentityApp(env: NodeJS.ProcessEnv): OncallIdentityApp {
  return { appId: env.ONCALL_IDENTITY_APP_ID?.trim() ?? '', appSecret: env.ONCALL_IDENTITY_APP_SECRET?.trim() ?? '',
    brand: env.ONCALL_IDENTITY_BRAND === 'lark' ? 'lark' : 'feishu' };
}

/** An omitted password retains the credential only for the very same app. */
export function normalizeOncallIdentityApp(input: unknown, current: OncallIdentityApp): OncallIdentityApp {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请填写统一查询应用配置');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['appId', 'appSecret', 'brand'].includes(key))) throw new Error('统一查询应用配置包含未知字段');
  const appId = typeof value.appId === 'string' ? value.appId.trim() : '';
  const brand = value.brand ?? 'feishu';
  if (!/^cli_[a-zA-Z0-9]+$/.test(appId) || !['feishu', 'lark'].includes(brand as string)) throw new Error('请填写有效的 App ID 和平台');
  const appSecret = value.appSecret === undefined && appId === current.appId && brand === current.brand ? current.appSecret
    : typeof value.appSecret === 'string' ? value.appSecret.trim() : '';
  if (!appSecret || appSecret.length > 8192 || /[^\x21-\x7e]/.test(appSecret)) throw new Error('请填写统一查询应用的 App Secret；更换应用或平台时需重新填写');
  return { appId, appSecret, brand: brand as Brand };
}
