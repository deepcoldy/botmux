import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { getBot, type BotConfig } from '../../bot-registry.js';
import { createCliAdapterSync } from '../../adapters/cli/registry.js';
import { deviceCredentialIsolationMarkerPath } from '../../adapters/cli/read-isolation.js';
import { botInjectedEnv, buildSessionChildEnv } from '../env-policy.js';
import { scrubSessionTurnMarkerEnv } from '../../utils/child-env.js';
import { traeHomeFor } from '../../services/traex-paths.js';
import { traeLoginManager, type TraeLoginManager, type TraeLoginTarget } from '../../services/trae-login.js';
import { sendUserMessage as defaultSendUserMessage } from '../../im/lark/client.js';
import { localeForBot, t } from '../../i18n/index.js';
import type { LarkMessage } from '../../types.js';
import type { CommandHandlerDeps } from '../command-handler.js';

export interface TraeLoginCommandDeps {
  manager?: TraeLoginManager;
  getConfig?: (appId: string) => BotConfig;
  resolveBin?: (config: BotConfig) => string;
  deviceIsolated?: () => boolean;
  sendUserMessage?: typeof defaultSendUserMessage;
  authorized?: () => Promise<boolean>;
  platform?: NodeJS.Platform;
}

/** v1 targets native local TRAE. Isolated/remote/wrapper launches have separate
 * credential domains and must never silently update the host's global login. */
export function resolveTraeLoginTarget(cfg: BotConfig, opts: TraeLoginCommandDeps = {}): TraeLoginTarget | undefined {
  if ((opts.platform ?? process.platform) !== 'linux' || cfg.cliId !== 'traex' || cfg.wrapperCli || cfg.cliLaunchMode
    || cfg.readIsolation || (cfg.sandbox && cfg.sandbox !== 'off')
    || !['pty', 'tmux', 'zellij', 'zmx', 'herdr'].includes(cfg.backendType ?? 'pty')
    || (opts.deviceIsolated ?? (() => existsSync(deviceCredentialIsolationMarkerPath(homedir()))))()) return;
  const env = { ...buildSessionChildEnv(process.env, cfg.envPolicy, cfg.envUnset), ...botInjectedEnv(cfg.env, cfg.envPolicy) };
  scrubSessionTurnMarkerEnv(env);
  delete env.TRAECLI_PERSONAL_ACCESS_TOKEN;
  delete env.TRAECLI_ACCESS_TOKEN;
  // No browser is required on the daemon host. The URL is delivered privately.
  if (process.platform !== 'win32') env.BROWSER = '/bin/false';
  const root = traeHomeFor(env);
  if (!isAbsolute(root)) return;
  env.TRAE_HOME = root;
  const bin = (opts.resolveBin ?? (c => createCliAdapterSync('traex', c.cliPathOverride).resolvedBin))(cfg);
  return { bin, root, env };
}

/** Called only after the shared /dashboard administrator gate. */
export async function handleTraeLoginCommand(
  message: LarkMessage, args: string, rootId: string, deps: CommandHandlerDeps,
  appId: string, adminOpenId: string, seams: TraeLoginCommandDeps = {},
): Promise<void> {
  const loc = localeForBot(appId);
  const reply = (key: string) => deps.sessionReply(rootId, t(key, undefined, loc), undefined, appId);
  if (message.senderType !== 'user') { await reply('card.dashboard.owner_only'); return; }
  const manager = seams.manager ?? traeLoginManager;
  const owner = { appId, openId: adminOpenId };
  const [verb = '', id = '', ...rest] = args.trim().split(/\s+/);
  if (!['', 'status', 'cancel', 'complete'].includes(verb)) { await reply('trae_login.usage'); return; }
  // Callback URLs contain credentials. A public group is never a submission
  // channel, even if the sender is an administrator.
  if (verb === 'complete' && message.chatType !== 'p2p') { await reply('trae_login.private_only'); return; }
  if (verb === 'cancel') {
    if (rest.length) { await reply('trae_login.usage'); return; }
    await manager.cancelRequest(owner, id || undefined);
    await reply('trae_login.cancelled'); return;
  }
  let target: TraeLoginTarget | undefined;
  let configSnapshot = '';
  const getConfig = seams.getConfig ?? (a => getBot(a).config);
  const snapshot = (c: BotConfig) => JSON.stringify([c.cliId, c.cliPathOverride, c.cliRuntime, c.wrapperCli,
    c.cliLaunchMode, c.backendType, c.sandbox, c.readIsolation, c.env, c.envPolicy, c.envUnset]);
  try {
    const cfg = getConfig(appId); configSnapshot = snapshot(cfg);
    target = resolveTraeLoginTarget(cfg, seams);
  } catch { await reply('trae_login.failed'); return; }
  if (!target) { await reply('trae_login.unsupported'); return; }
  const valid = async () => {
    if (seams.authorized && !await seams.authorized()) return false;
    const cfg = getConfig(appId);
    return snapshot(cfg) === configSnapshot && !!resolveTraeLoginTarget(cfg, { ...seams, resolveBin: () => target!.bin });
  };
  try {
    if (verb === 'complete') {
      if (!id || rest.length !== 1) { await reply('trae_login.usage'); return; }
      await manager.complete(target, owner, id, rest[0]!);
      await reply('trae_login.verifying'); return;
    }
    const view = verb === 'status' ? manager.status(target, owner) : await manager.begin(target, owner, valid);
    if (!view) { await reply('trae_login.missing'); return; }
    if (view.state !== 'pending' || !view.url) { await reply('trae_login.' + view.state); return; }
    if (!await valid()) {
      await manager.cancelRequest(owner, view.id); await reply('trae_login.cancelled'); return;
    }
    const body = t('trae_login.challenge', { url: view.url, id: view.id }, loc);
    // Direct messages are the only challenge delivery channel. Delivery failure
    // cancels this attempt; no URL/error body ever falls back to the group.
    try {
      await (seams.sendUserMessage ?? defaultSendUserMessage)(appId, adminOpenId, body);
    } catch {
      await manager.cancelRequest(owner, view.id); await reply('trae_login.delivery_failed'); return;
    }
    if (!await valid()) await manager.cancelRequest(owner, view.id);
    await reply('trae_login.sent');
  } catch {
    await reply('trae_login.failed');
  }
}
