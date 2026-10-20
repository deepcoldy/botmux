import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { loadBotConfigs } from '../bot-registry.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import { normalizeCodexInstancePool, validateCodexInstanceHome, codexInstanceEnv } from '../services/codex-instance-pool.js';
import { loadAllSessionsSnapshot } from '../services/session-store.js';
import { resolveCliRuntime, runtimePathOverride } from '../adapters/cli/runtime.js';

/** Explicit operator action only; never called by loading config or starting a worker. */
export async function runCodexInstancesCommand(args: string[]): Promise<void> {
  const [action = 'check'] = args;
  const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const selector = option('--bot');
  const bots = loadBotConfigs();
  const bot = selector ? bots.find(b => b.larkAppId === selector || b.name === selector) : bots.length === 1 ? bots[0] : undefined;
  if (!bot) throw new Error('Select one configured bot with --bot <appId or name>');
  const pool = normalizeCodexInstancePool(bot.codexInstancePool, bot);
  if (!pool) throw new Error('This bot has no codexInstancePool');
  const id = option('--instance');
  const instance = pool.instances.find(i => i.id === id);
  if (action === 'check') {
    const sessions = [...loadAllSessionsSnapshot().values()].filter(s => s.larkAppId === bot.larkAppId);
    const report = pool.instances.map(i => {
      let canonical: string | undefined;
      let error: string | undefined;
      try { canonical = validateCodexInstanceHome(i.codexHome); } catch (e) { error = (e as Error).message; }
      return { id: i.id, codexHome: i.codexHome, canonical, default: i.id === pool.defaultInstanceId,
        randomEligible: pool.enabled && i.enabled !== false && !error, weight: i.weight,
        credential: error ? 'not-ready' : 'local-credential-present', accountIdentity: 'unverified', error,
        sessions: sessions.filter(s => s.cliInstanceBinding?.instanceId === i.id).map(s => ({ sessionId: s.sessionId,
          frozenHome: s.cliInstanceBinding!.codexHome, source: s.cliInstanceBinding!.source,
          pathChanged: s.cliInstanceBinding!.codexHome !== canonical })) };
    });
    console.log(JSON.stringify({ bot: bot.larkAppId, instances: report,
      legacySessions: sessions.filter(s => !s.cliInstanceBinding || s.cliInstanceBinding.source === 'legacy').length }, null, 2));
    return;
  }
  if (!instance) throw new Error('Select an instance with --instance <id>');
  if (action === 'init') {
    if (existsSync(instance.codexHome)) {
      validateCodexInstanceHome(instance.codexHome, { requireAuth: false });
      console.log('Existing instance verified; no files changed.');
      return;
    }
    mkdirSync(instance.codexHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(instance.codexHome, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { flag: 'wx', mode: 0o600 });
    console.log(`Initialized ${instance.id}: ${instance.codexHome}; run login next.`);
    return;
  }
  if (action !== 'login') throw new Error('Usage: botmux codex-instances check|init|login --bot <appId> [--instance <id>]');
  const home = validateCodexInstanceHome(instance.codexHome, { requireAuth: false });
  if (existsSync(join(home, 'auth.json')) && !args.includes('--reauth')) throw new Error('Existing login: use --reauth only to reauthorize the SAME account; a different account requires a new instance directory');
  const env = codexInstanceEnv(process.env, { version: 1, source: 'legacy', instanceId: null, cliId: 'codex', codexHome: home, authMode: 'global' });
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete env[key];
  const runtime = resolveCliRuntime({ cliId: 'codex', cliRuntime: bot.cliRuntime, cliPathOverride: bot.cliPathOverride, context: 'Codex instance login' });
  const cli = createCliAdapterSync('codex', runtimePathOverride(runtime)).resolvedBin;
  console.log(`Logging in instance ${instance.id}: ${home}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cli, ['login', '--device-auth'], { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Codex login exited with ${code}`)));
  });
}
