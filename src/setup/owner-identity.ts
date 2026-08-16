/**
 * Shared owner-identity boundary for every Bot onboarding path.
 *
 * An `ou_` open_id is meaningful only to the app that issued/observed it; even
 * `BOTMUX_OWNER_OPEN_ID` belongs to the source `BOTMUX_LARK_APP_ID`. Never copy
 * it into another/new app. Normalize an authenticated source owner before app
 * creation, then validate owner entries through the target app before
 * persisting them. Reject unknown `ou_` values before app creation; target-app
 * network/scope failures remain inconclusive unless the identity is definitively
 * unusable.
 *
 * Keep new Dashboard, interactive, scripted, and Agent-driven onboarding paths
 * on these helpers. A format-only sister path can otherwise reintroduce the
 * same lockout while every existing onboarding regression test remains green.
 */
import { type Brand, sdkDomain } from '../im/lark/lark-hosts.js';
import { isMobileEntry, normalizeMobileEntry } from './bot-config-editor.js';

/** open_id belongs to another app. Retrying with the same app can never fix it. */
const CROSS_APP_OPEN_ID_CODE = 99992361;
const DEFINITIVE_USER_ID_CODES = new Set([CROSS_APP_OPEN_ID_CODE, 41012, 40001]);

function larkErrorCode(err: unknown): number | undefined {
  const value = err as {
    code?: unknown;
    response?: { data?: { code?: unknown } };
    data?: { code?: unknown };
  };
  for (const candidate of [value?.response?.data?.code, value?.data?.code, value?.code]) {
    if (typeof candidate === 'number') return candidate;
    if (typeof candidate === 'string' && /^\d+$/.test(candidate)) return Number(candidate);
  }
  return undefined;
}

/**
 * Validate an open_id with the app that is supposed to own it. Prefer the
 * cross-app-stable union_id; never preserve an open_id the app cannot prove.
 */
export async function resolveScannerAllowedUser(
  appId: string,
  appSecret: string,
  openId: string,
  brand: Brand = 'feishu',
): Promise<string | undefined> {
  try {
    const { Client } = await import('@larksuiteoapi/node-sdk');
    const client = new Client({ appId, appSecret, domain: sdkDomain(brand), disableTokenCache: false });
    const res = await (client as any).contact.v3.user.get({
      path: { user_id: openId },
      params: { user_id_type: 'open_id' },
    });
    if (res.code === 0 && res.data?.user) return res.data.user.union_id ?? openId;
  } catch { /* do not trust an open_id that this app could not validate */ }
  return undefined;
}

/**
 * Resolve the verified Open Platform session email into a stable owner entry.
 * An inconclusive request keeps the verified email for runtime retry; a clean
 * empty response proves the account is not addressable in this tenant.
 */
export async function resolveSessionEmailAllowedUser(
  appId: string,
  appSecret: string,
  email: string,
  brand: Brand = 'feishu',
): Promise<string | undefined> {
  try {
    const { Client } = await import('@larksuiteoapi/node-sdk');
    const client = new Client({ appId, appSecret, domain: sdkDomain(brand), disableTokenCache: false });
    const res = await (client as any).contact.v3.user.batchGetId({
      params: { user_id_type: 'union_id' },
      data: { emails: [email], include_resigned: false },
    });
    if (res?.code === 0) {
      const list: any[] = res.data?.user_list ?? [];
      const hit = list.find(user => typeof user?.user_id === 'string' && user.user_id);
      return hit ? hit.user_id : undefined;
    }
  } catch { /* unable to disprove the verified session email */ }
  return email;
}

/**
 * Best-effort detection of owner entries that are definitively unusable by the
 * target app. Transient/scope errors remain inconclusive and are not rejected.
 */
export async function detectUnusableOwnerEntries(
  appId: string,
  appSecret: string,
  brand: Brand,
  entries: string[],
): Promise<string[]> {
  if (!appSecret) return [];
  let client: any;
  try {
    const { Client } = await import('@larksuiteoapi/node-sdk');
    client = new Client({ appId, appSecret, domain: sdkDomain(brand), disableTokenCache: false });
  } catch {
    return [];
  }

  const unusable: string[] = [];
  for (const entry of entries) {
    try {
      if (entry.startsWith('ou_') || entry.startsWith('on_')) {
        // ou_ and on_ share ONE definitive-miss test so the two id shapes can
        // never drift apart. A prior ou_-only `code === 99992361` check let a
        // target-app-invalid open_id (41012 / 40001) or a code:0-without-user
        // response slip through and be written as the sole owner — the same
        // lockout this module exists to prevent.
        const res = await client.contact.v3.user.get({
          path: { user_id: entry },
          params: { user_id_type: entry.startsWith('ou_') ? 'open_id' : 'union_id' },
        });
        // A clean response without a target-app open_id is a definitive miss
        // (cross-app open_id, or a union_id this app cannot resolve).
        // Permission/scope failures remain inconclusive so onboarding can
        // proceed while newly granted Contact scopes propagate.
        if ((res?.code === 0 && !res?.data?.user?.open_id)
          || DEFINITIVE_USER_ID_CODES.has(Number(res?.code))) {
          unusable.push(entry);
        }
      } else if (isMobileEntry(entry)) {
        const res = await client.contact.v3.user.batchGetId({
          params: { user_id_type: 'open_id' },
          data: { mobiles: [normalizeMobileEntry(entry)], include_resigned: false },
        });
        if (res?.code === 0) {
          const list: any[] = res.data?.user_list ?? [];
          if (!list.some(user => user?.user_id)) unusable.push(entry);
        }
      } else {
        const res = await client.contact.v3.user.batchGetId({
          params: { user_id_type: 'open_id' },
          data: { emails: [entry], include_resigned: false },
        });
        if (res?.code === 0) {
          const list: any[] = res.data?.user_list ?? [];
          if (!list.some(user => user?.user_id)) unusable.push(entry);
        }
      }
    } catch (err) {
      // The SDK often throws Axios errors for the same cross-app response that
      // mocks expose as a normal payload. Preserve the definitive verdict in
      // both transport shapes; every other throw remains inconclusive. ou_ and
      // on_ use the SAME definitive-code set here too — an ou_-only 99992361
      // check would drop 41012 / 40001 that arrive as a throw.
      const code = larkErrorCode(err);
      if ((entry.startsWith('ou_') || entry.startsWith('on_'))
        && code !== undefined && DEFINITIVE_USER_ID_CODES.has(code)) {
        unusable.push(entry);
      }
    }
  }
  return unusable;
}

export interface ManagedOwnerContext {
  sourceAppId?: string;
  sourceOwnerOpenId?: string;
  creatingApp: boolean;
  targetAppId?: string;
}

/**
 * A managed Agent sees the daemon-frozen session owner as an app-scoped
 * BOTMUX_OWNER_OPEN_ID. This is not the current-turn sender. When the Agent
 * creates/configures another bot, copying that ou_ verbatim locks the owner
 * out. Convert only that exact injected identity through the source app; leave
 * explicitly supplied co-owners untouched.
 */
export async function normalizeManagedOwnerEntries(
  rawAllowedUsers: string | undefined,
  context: ManagedOwnerContext,
  resolveStableOwner: (sourceAppId: string, sourceOwnerOpenId: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  if (!rawAllowedUsers) return rawAllowedUsers;

  const entries = rawAllowedUsers.split(',').map(entry => entry.trim()).filter(Boolean);
  const openIds = entries.filter(entry => entry.startsWith('ou_'));
  if (context.creatingApp && openIds.length === 0) return rawAllowedUsers;
  if (!context.creatingApp
    && context.targetAppId
    && context.targetAppId === context.sourceAppId) return rawAllowedUsers;

  const sourceOwner = context.sourceOwnerOpenId;
  const canResolveSourceOwner = !!context.sourceAppId
    && !!sourceOwner
    && entries.includes(sourceOwner);

  // No open_id can belong to an app that does not exist yet. Reject unknown
  // ou_ entries before the irreversible create-app side effect; only the exact
  // daemon-authenticated session owner may be converted through its source app.
  const unconvertible = context.creatingApp
    ? openIds.filter(entry => !canResolveSourceOwner || entry !== sourceOwner)
    : [];
  if (unconvertible.length > 0) {
    throw new Error(
      '--allowed-users 在创建新 Bot 时不能使用 app-scoped open_id：' +
      `${unconvertible.join(', ')}；请改用完整邮箱、手机号或 on_ union_id。`,
    );
  }
  if (!canResolveSourceOwner) return rawAllowedUsers;

  const stable = await resolveStableOwner(context.sourceAppId!, sourceOwner!);
  if (!stable?.startsWith('on_')) {
    throw new Error(
      '--allowed-users 不能把当前 Bot 的 app-scoped open_id 直接用于另一个 Bot；' +
      '无法解析跨应用 union_id，请改用完整邮箱、手机号或 on_ union_id。',
    );
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const next = entry === sourceOwner ? stable : entry;
    if (seen.has(next)) continue;
    seen.add(next);
    normalized.push(next);
  }
  return normalized.join(',');
}
