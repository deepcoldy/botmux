import { loadBotConfigs } from '../bot-registry.js';
import { normalizeEnvPolicy, type EnvPolicy } from '../core/env-policy.js';
import { rmwBotEntry } from '../services/config-store.js';
import { listOnlineDaemons } from '../utils/daemon-discovery.js';
import { fetchDaemonIpc } from '../core/daemon-ipc-auth.js';

export function parseEnvPolicyArgs(args: string[]): { action: 'get' | 'set' | 'unset'; bot?: string; policy?: EnvPolicy } {
  const positional: string[] = [];
  let bot: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bot') {
      if (bot !== undefined || !args[i + 1]) throw new Error('env-policy requires one --bot selector');
      bot = args[++i];
    } else positional.push(args[i]!);
  }
  const action = positional[0] ?? 'get';
  if (!['get', 'set', 'unset'].includes(action) || positional.length !== (action === 'set' ? 2 : (positional.length ? 1 : 0))) {
    throw new Error('Usage: botmux env-policy get|set <JSON>|unset [--bot <name|appId>]');
  }
  if (action !== 'set') return { action: action as 'get' | 'unset', bot };
  let raw: unknown;
  try { raw = JSON.parse(positional[1]!); } catch { throw new Error('Invalid environment policy JSON'); }
  return { action: 'set', bot, policy: normalizeEnvPolicy(raw) };
}

export async function cmdEnvPolicy(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('botmux env-policy get|set <JSON>|unset [--bot <name|appId>]');
    return;
  }
  const parsed = parseEnvPolicyArgs(args);
  const bots = loadBotConfigs();
  const matches = parsed.bot
    ? bots.filter(bot => bot.larkAppId === parsed.bot || bot.name === parsed.bot)
    : bots.length === 1 ? bots : [];
  if (matches.length !== 1) throw new Error('Select exactly one configured bot with --bot');
  const bot = matches[0]!;
  if (parsed.action === 'get') {
    console.log(JSON.stringify(bot.envPolicy ?? { mode: 'inherit' }));
    return;
  }
  const policy = parsed.action === 'unset' ? null : parsed.policy!;
  const daemon = listOnlineDaemons().find(d => d.larkAppId === bot.larkAppId);
  if (daemon) {
    const result = await fetchDaemonIpc(daemon.ipcPort, '/api/bot-env-policy', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envPolicy: policy }), signal: AbortSignal.timeout(5000),
    });
    if (!result.ok) throw new Error('Daemon rejected environment policy update');
    console.log('Environment policy saved; applies on next worker cold start');
    return;
  }
  const result = await rmwBotEntry(bot.larkAppId, entry => {
    if (policy === null) delete entry.envPolicy;
    else entry.envPolicy = policy;
    return { write: true, result: null };
  });
  if (!result.ok) throw new Error('Could not save environment policy');
  console.log('Environment policy saved offline; daemon reads it on next startup');
}
