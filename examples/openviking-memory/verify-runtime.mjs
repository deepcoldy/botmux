import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const runtime = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'));
process.env.BOTS_CONFIG = runtime.bots_config;
const { loadBotConfigs } = await import(pathToFileURL(join(runtime.botmux_installed, 'dist/bot-registry.js')));
const { createCodexAdapter } = await import(pathToFileURL(join(runtime.botmux_installed, 'dist/adapters/cli/codex.js')));
const bots = loadBotConfigs();
const index = bots.findIndex(bot => bot.larkAppId === runtime.bot_app_id);
if (index < 0) throw new Error('Selected Bot is missing.');
const bot = bots[index];
const wrapper = join(root, 'bin/codex-openviking');
if (bot.cliId !== 'codex' || bot.cliPathOverride !== wrapper || bot.allowedUsers?.length !== 1) {
  throw new Error('Selected Bot no longer matches the scoped pilot configuration.');
}
const adapter = createCodexAdapter(bot.cliPathOverride);
const version = spawnSync(adapter.resolvedBin, ['--version'], { encoding: 'utf8' });
if (version.status !== 0 || version.stdout.trim() !== runtime.codex_version) {
  throw new Error('The selected Codex executable changed.');
}
const descriptor = JSON.parse(await readFile(
  join(homedir(), '.botmux/data/dashboard-daemons', runtime.bot_app_id + '.json'), 'utf8',
));
const botHealth = await fetch(`http://127.0.0.1:${descriptor.ipcPort}/__health`, {
  signal: AbortSignal.timeout(5000),
}).then(response => response.json());
const ovHealth = await fetch('http://127.0.0.1:1933/health', {
  signal: AbortSignal.timeout(5000),
}).then(response => response.json());
if (!botHealth.ok || !ovHealth.healthy) throw new Error('A pilot service is unhealthy.');
const client = JSON.parse(await readFile(runtime.client_config, 'utf8'));
const settings = client.plugin?.codex;
if (settings?.autoRecall !== false || settings?.noAutoInject !== true || settings?.resumeArchiveInject !== false) {
  throw new Error('The pilot client still permits automatic memory injection.');
}
const result = {
  passed: true, botIndex: index, daemonPid: descriptor.pid, botHealthy: botHealth.ok,
  cliId: bot.cliId, cliPathOverride: bot.cliPathOverride, codexVersion: version.stdout.trim(),
  openvikingHealthy: ovHealth.healthy, openvikingVersion: ovHealth.version,
  selectedBotHasWrapper: true, existingSessionsRequireNewCodexProcess: true,
  readingMode: 'agent-directed-shared-cli', automaticMemoryInjection: false,
  automaticCaptureHost: 'codex',
  larkEndToEndVerified: false,
};
await mkdir(join(root, 'evidence'), { recursive: true });
await writeFile(join(root, 'evidence/runtime.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
