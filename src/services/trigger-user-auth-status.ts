/**
 * Per-person trigger-user credential status.
 *
 * A device sharing one machine needs to ask, per open_id, what this machine
 * has stored — without opening token files itself. `coverage` is always
 * `local-stores`: platform-issued credentials (`credentialSource` `platform`
 * or `auto`) are not consulted and are not in `tools`. `needs-login` here
 * does not mean a platform-backed turn would be refused.
 *
 * Each entry's `basis` says how `state` was decided:
 *
 *   - `bytedcli` / `provider-probe` — live `bytedcli auth status`. Expiry is
 *     included only when that payload reports one.
 *   - `lark-cli` / `file-present` — a per-person device-login file exists.
 *     The ciphertext is not read, so expiry is unknown. This does not poll a
 *     pending device challenge and does not start a login.
 *   - `lark-cli` / `expiry-check` — no device-login file, but this person's
 *     legacy bot-app user token is still usable (access valid, or refreshable).
 *     That is the same back-compat decision `resolveIdentityFor` makes for
 *     lark-cli, without refreshing the token on this read.
 *   - `user-token` / `expiry-check` — that legacy file alone, strict per person.
 *     An unattributed per-app file is not claimed.
 *
 * `unknown` means the probe could not tell; an existing login is not cleared.
 * Token, JWT, and refresh-token contents are never copied onto the result.
 */
import type { Brand } from '../im/lark/lark-hosts.js';
import { describeBytedcliAuth } from './bytedcli-auth.js';
import { describeLarkCliAuth } from './lark-cli-auth.js';
import { userTokenAuthState } from '../utils/user-token.js';

export type TriggerUserToolAuthState = 'authorized' | 'needs-login' | 'unknown';

/** How `state` was decided. See the file header. */
export type TriggerUserAuthBasis = 'provider-probe' | 'file-present' | 'expiry-check';

export interface TriggerUserToolStatus {
  state: TriggerUserToolAuthState;
  basis: TriggerUserAuthBasis;
  /** Present only when this store records an expiry. */
  expiresAt?: string;
  /** Legacy user-token refresh expiry. Absent for a device-login file. */
  refreshExpiresAt?: string;
}

export interface TriggerUserAuthUserStatus {
  openId: string;
  /**
   * This object describes on-disk / local-CLI state only. Platform grants are
   * outside it; see the file header.
   */
  coverage: 'local-stores';
  tools: {
    bytedcli: TriggerUserToolStatus;
    'lark-cli': TriggerUserToolStatus;
    'user-token': TriggerUserToolStatus;
  };
}

const STATES = new Set<TriggerUserToolAuthState>(['authorized', 'needs-login', 'unknown']);
const BASES = new Set<TriggerUserAuthBasis>(['provider-probe', 'file-present', 'expiry-check']);

function toolStatus(raw: {
  state: string;
  basis: string;
  expiresAt?: string;
  refreshExpiresAt?: string;
}): TriggerUserToolStatus {
  const state = STATES.has(raw.state as TriggerUserToolAuthState)
    ? raw.state as TriggerUserToolAuthState
    : 'unknown';
  const basis = BASES.has(raw.basis as TriggerUserAuthBasis)
    ? raw.basis as TriggerUserAuthBasis
    : 'file-present';
  const out: TriggerUserToolStatus = { state, basis };
  if (typeof raw.expiresAt === 'string' && raw.expiresAt) out.expiresAt = raw.expiresAt;
  if (typeof raw.refreshExpiresAt === 'string' && raw.refreshExpiresAt) out.refreshExpiresAt = raw.refreshExpiresAt;
  return out;
}

/**
 * lark-cli on a turn uses the device-login HOME, otherwise this person's
 * usable legacy user token. A status read must report the same two, and must
 * not poll or refresh while doing so.
 */
function larkCliStatus(
  home: { state: string },
  token: { state: string; expiresAt?: string; refreshExpiresAt?: string },
): { state: string; basis: TriggerUserAuthBasis; expiresAt?: string; refreshExpiresAt?: string } {
  if (home.state === 'authorized') return { state: 'authorized', basis: 'file-present' };
  if (home.state === 'unknown') return { state: 'unknown', basis: 'file-present' };
  if (token.state === 'authorized') {
    return {
      state: 'authorized',
      basis: 'expiry-check',
      ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
      ...(token.refreshExpiresAt ? { refreshExpiresAt: token.refreshExpiresAt } : {}),
    };
  }
  if (token.state === 'unknown') return { state: 'unknown', basis: 'expiry-check' };
  return { state: 'needs-login', basis: 'file-present' };
}

/**
 * Status for one open_id. Does not start a login, create a HOME, or read
 * token contents into the returned object.
 */
export async function queryTriggerUserAuthStatus(input: {
  appId: string;
  brand: Brand;
  openId: string;
}): Promise<TriggerUserAuthUserStatus> {
  const [bytedcli, larkHome, userToken] = await Promise.all([
    describeBytedcliAuth(input.openId),
    Promise.resolve(describeLarkCliAuth(input.openId)),
    Promise.resolve(userTokenAuthState(input.appId, input.brand, input.openId)),
  ]);
  return {
    openId: input.openId,
    coverage: 'local-stores',
    tools: {
      bytedcli: toolStatus({ ...bytedcli, basis: 'provider-probe' }),
      'lark-cli': toolStatus(larkCliStatus(larkHome, userToken)),
      'user-token': toolStatus({ ...userToken, basis: 'expiry-check' }),
    },
  };
}
