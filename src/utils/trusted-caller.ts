import type { TrustedCaller } from '../types.js';

export type UnionIdResolver = (larkAppId: string, openId: string) => Promise<string | null>;

export async function buildTrustedCallerWithUnionFallback(
  larkAppId: string,
  requestUserOpenId: string | undefined,
  requestUserUnionId: string | undefined,
  resolveUnionIdFromOpenId: UnionIdResolver,
): Promise<TrustedCaller | undefined> {
  if (!requestUserOpenId && !requestUserUnionId && !larkAppId) return undefined;

  const resolvedUnionId = requestUserUnionId
    ?? (requestUserOpenId ? await resolveUnionIdFromOpenId(larkAppId, requestUserOpenId) ?? undefined : undefined);

  return {
    requestUserOpenId,
    requestUserUnionId: resolvedUnionId,
    requestLarkAppId: larkAppId,
  };
}
