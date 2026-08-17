import type { TrustedCaller } from '../types.js';

export const TRUSTED_IDENTITY_FIELDS = [
  'request_user_union_id',
  'request_user_open_id',
  'request_lark_app_id',
  'request_user_tchouse_account',
  'requestUserUnionId',
  'requestUserOpenId',
  'requestLarkAppId',
  'requestUserTchouseAccount',
  'union_id',
  'unionId',
  'open_id',
  'openId',
  'lark_app_id',
  'larkAppId',
  'request_app_id',
  'requestAppId',
  'app_id',
  'appId',
  'tchouse_account',
] as const;

export interface TrustedIdentityMergeResult {
  ok: boolean;
  args?: Record<string, unknown>;
  errorCode?: 'missing_trusted_union_id';
  errorMessage?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function mergeTrustedIdentityArgs(
  rawArgs: unknown,
  trustedCaller?: TrustedCaller,
): TrustedIdentityMergeResult {
  if (!trustedCaller?.requestUserUnionId) {
    return {
      ok: false,
      errorCode: 'missing_trusted_union_id',
      errorMessage: '当前 turn 缺少可信 union_id，拒绝执行 Data MCP 查询',
    };
  }

  const base = isPlainObject(rawArgs) ? { ...rawArgs } : {};
  for (const field of TRUSTED_IDENTITY_FIELDS) delete base[field];

  base.request_user_union_id = trustedCaller.requestUserUnionId;
  if (trustedCaller.requestUserOpenId) base.request_user_open_id = trustedCaller.requestUserOpenId;
  if (trustedCaller.requestLarkAppId) base.request_lark_app_id = trustedCaller.requestLarkAppId;

  return { ok: true, args: base };
}

export function redactTrustedIdentityFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => redactTrustedIdentityFields(item)) as T;
  if (!isPlainObject(value)) return value;

  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if ((TRUSTED_IDENTITY_FIELDS as readonly string[]).includes(key)) continue;
    next[key] = redactTrustedIdentityFields(nested);
  }

  if (Array.isArray((value as Record<string, unknown>).required)) {
    next.required = ((value as Record<string, unknown>).required as unknown[])
      .filter(item => typeof item !== 'string' || !(TRUSTED_IDENTITY_FIELDS as readonly string[]).includes(item));
  }

  return next as T;
}
