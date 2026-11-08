/**
 * Revoke one person's trigger-user credentials on this machine.
 *
 * CLI homes are per open_id, shared by every bot on the host. User tokens are
 * per (app, open_id), so this daemon clears only its own app's file. Platform
 * grants are fetched per turn and are not something this process can revoke;
 * the next platform-mode turn can still receive a new grant. Issuer app homes
 * (`lark-cli-issuer-*`, the shared bootstrap) are app material, not this
 * person's credentials, and are left in place. Legacy unattributed token files
 * are left in place too: their owner cannot be proved.
 */
import { existsSync } from 'node:fs';
import type { Brand } from '../im/lark/lark-hosts.js';
import { dropPublishedIdentitiesForOpenId } from '../core/cli-identity.js';
import { clearUserToken, isUsableOpenId } from '../utils/user-token.js';
import { bumpCliAuthEpoch } from './cli-auth-epoch.js';
import { bytedcliHomeFor, clearBytedcliAuth, logoutBytedcli } from './bytedcli-auth.js';
import { clearLarkCliAuth, larkCliHomeFor, logoutLarkCli } from './lark-cli-auth.js';

export type RemoteLogout = 'skipped' | 'ok' | 'failed';

export type RevokeTriggerUserAuthResult =
  | { ok: false; error: 'invalid_open_id' }
  | {
    ok: true;
    openId: string;
    removed: { larkCli: boolean; bytedcli: boolean; userToken: boolean };
    remoteLogout: { larkCli: RemoteLogout; bytedcli: RemoteLogout };
    identitiesDropped: number;
  };

async function remoteLogout(existed: boolean, logout: () => Promise<boolean>): Promise<RemoteLogout> {
  if (!existed) return 'skipped';
  try {
    return (await logout()) ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}

export async function revokeTriggerUserAuth(args: {
  openId: string;
  appId: string;
  brand: Brand;
  sessionDataDir: string;
}): Promise<RevokeTriggerUserAuthResult> {
  if (!isUsableOpenId(args.openId)) return { ok: false, error: 'invalid_open_id' };

  // Bump first so an in-flight mint or login observes the revocation even if
  // the CLI logout call hangs. Logout still runs while the HOME exists.
  // Required before logoutBytedcli AND clearBytedcliAuth: SDK children can
  // recreate deleted files, but cannot stamp the newly persisted epoch.
  bumpCliAuthEpoch(args.openId);

  const larkHome = larkCliHomeFor(args.openId);
  const bytedHome = bytedcliHomeFor(args.openId);
  const larkExisted = existsSync(larkHome);
  const bytedExisted = existsSync(bytedHome);

  const larkRemote = await remoteLogout(larkExisted, () => logoutLarkCli(args.openId));
  const bytedRemote = await remoteLogout(bytedExisted, () => logoutBytedcli(args.openId));

  if (larkExisted || existsSync(larkHome)) clearLarkCliAuth(args.openId);
  if (bytedExisted || existsSync(bytedHome)) clearBytedcliAuth(args.openId);

  const userToken = clearUserToken(args.appId, args.brand, args.openId);
  const identitiesDropped = dropPublishedIdentitiesForOpenId(args.sessionDataDir, args.openId);

  return {
    ok: true,
    openId: args.openId,
    removed: {
      larkCli: larkExisted && !existsSync(larkHome),
      bytedcli: bytedExisted && !existsSync(bytedHome),
      userToken,
    },
    remoteLogout: { larkCli: larkRemote, bytedcli: bytedRemote },
    identitiesDropped,
  };
}
