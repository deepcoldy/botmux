#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConnection } from './client.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const HELP = `Explicitly attach shared OpenViking memory (default off)
  node setup-shared.mjs agent-bind --config FILE --skills-dir DIR
  node setup-shared.mjs agent-unbind --skills-dir DIR
  node setup-shared.mjs plugin-install --config FILE --bot-index N --botmux-root ROOT
  node setup-shared.mjs plugin-bind --bot-index N --botmux-root ROOT
  node setup-shared.mjs plugin-unbind --bot-index N --botmux-root ROOT
Optional: --bots-config FILE. Bot indexes are zero-based.
These commands manage shared reads/explicit writes. Optional host capture is managed separately by pilot.py.`;

function parse(args) {
  const [action, ...rest] = args;
  if (!action || action === '--help') return { action: 'help' };
  if (!['agent-bind', 'agent-unbind', 'plugin-install', 'plugin-bind', 'plugin-unbind'].includes(action)) throw new Error(HELP);
  const out = { action };
  const names = { '--config': 'config', '--skills-dir': 'skillsDir', '--bot-index': 'botIndex', '--botmux-root': 'botmuxRoot', '--bots-config': 'botsConfig' };
  for (let i = 0; i < rest.length; i += 2) {
    if (!names[rest[i]] || !rest[i + 1]) throw new Error(HELP);
    out[names[rest[i]]] = rest[i + 1];
  }
  return out;
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const shellQuote = text => "'" + text.replace(/'/g, "'\\''") + "'";

function runtimeHashes(dir, prefix = '') {
  const hashes = {};
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(hashes, runtimeHashes(dir, name));
    else if (entry.isFile()) hashes[name] = hash(join(dir, name));
    else throw new Error('Inspect links or special files before replacing the plugin runtime.');
  }
  return hashes;
}

function checkManagedSkill(target) {
  const marker = join(target, '.openviking-binding.json');
  if (!existsSync(marker)) throw new Error('A different skill already owns this path; inspect it before binding.');
  const binding = JSON.parse(readFileSync(marker, 'utf8'));
  if (binding.schemaVersion !== 1 || binding.kind !== 'openviking-memory') throw new Error('Invalid skill binding record.');
  if (Object.entries(binding.files).some(([name, digest]) => hash(join(target, name)) !== digest)
      || readdirSync(target).some(name => !['SKILL.md', 'scripts', '.openviking-binding.json'].includes(name))
      || readdirSync(join(target, 'scripts')).some(name => !['client.mjs', 'memory.mjs'].includes(name))) {
    throw new Error('The installed skill has local edits; reconcile them before replacement or removal.');
  }
}

function agentBinding(opts) {
  if (!opts.skillsDir) throw new Error('--skills-dir selects one Agent skill root explicitly.');
  const target = join(resolve(opts.skillsDir), 'openviking-memory');
  if (opts.action === 'agent-unbind') {
    if (existsSync(target)) { checkManagedSkill(target); rmSync(target, { recursive: true }); }
    return { enabled: false, skill: target, existingSessionsRequireRestart: true };
  }
  if (!opts.config) throw new Error('--config must identify the shared OpenViking client file.');
  const connection = loadConnection(resolve(opts.config));
  if (existsSync(target)) checkManagedSkill(target);
  mkdirSync(join(target, 'scripts'), { recursive: true });
  for (const name of ['client.mjs', 'memory.mjs']) cpSync(join(root, name), join(target, 'scripts', name));
  const command = `node ${shellQuote(join(target, 'scripts/memory.mjs'))} --config ${shellQuote(connection.configPath)}`;
  const skill = readFileSync(join(root, 'skills/openviking-memory/SKILL.md'), 'utf8')
    .replace('在已启用此插件的 Botmux 会话中执行：', '在此 Agent 中执行：')
    .replaceAll('botmux openviking', command);
  writeFileSync(join(target, 'SKILL.md'), skill);
  const files = Object.fromEntries(['SKILL.md', 'scripts/client.mjs', 'scripts/memory.mjs'].map(name => [name, hash(join(target, name))]));
  atomicJson(join(target, '.openviking-binding.json'), { schemaVersion: 1, kind: 'openviking-memory', files });
  return { enabled: true, skill: target, sharedUser: connection.user, automaticCapture: false, existingSessionsRequireRestart: true };
}

async function pluginBinding(opts) {
  if (!opts.botmuxRoot || opts.botIndex === undefined) throw new Error('--botmux-root and --bot-index are required.');
  const botmuxRoot = resolve(opts.botmuxRoot);
  const modulePath = join(botmuxRoot, 'dist/core/plugins/install.js');
  if (!existsSync(modulePath)) throw new Error('This Botmux build lacks the shared plugin API. Use a built current checkout; older daemons can use the standalone Skill/CLI.');
  const index = Number(opts.botIndex);
  const botsPath = resolve(opts.botsConfig || process.env.BOTS_CONFIG || join(homedir(), '.botmux/bots.json'));
  const raw = readFileSync(botsPath, 'utf8');
  const bots = JSON.parse(raw);
  const bot = bots[index];
  if (!Number.isInteger(index) || index < 0 || !bot || !bot.cliId || bot.allowedUsers?.length !== 1) {
    throw new Error('Select one existing coding-agent Bot with exactly one allowed user.');
  }
  const load = path => import(pathToFileURL(join(botmuxRoot, 'dist', path)).href);
  const { readGlobalConfig } = await load('global-config.js');
  if (readGlobalConfig().plugins?.includes('openviking')) throw new Error('OpenViking is globally enabled; reconcile that before scoped binding.');
  const { createConfigApi } = await load('core/plugins/runtime.js');
  const api = createConfigApi('openviking');
  if (opts.action === 'plugin-install') {
    if (!opts.config) throw new Error('--config must identify the shared client file.');
    const connection = loadConnection(resolve(opts.config));
    const previous = api.get() || {};
    const { readPluginRegistry } = await load('services/plugin-registry-store.js');
    const installed = readPluginRegistry().plugins.openviking;
    if (installed) {
      if (installed.packageName !== 'botmux-plugin-openviking-memory-example' || !previous.exampleRuntimeFiles) {
        throw new Error('An existing openviking plugin has a different owner; reconcile it before installation.');
      }
      const { pluginRuntimeDir } = await load('core/plugins/paths.js');
      const current = runtimeHashes(pluginRuntimeDir('openviking'));
      if (JSON.stringify(current) !== JSON.stringify(previous.exampleRuntimeFiles)) {
        throw new Error('The installed OpenViking plugin has local edits; reconcile them before updating.');
      }
    }
    execFileSync(process.execPath, [join(root, 'build-plugin.mjs')], { stdio: 'pipe' });
    const { installLocalPlugin } = await load('core/plugins/install.js');
    const result = installLocalPlugin(join(root, 'plugin'));
    api.replace({ ...previous, exampleRuntimeFiles: runtimeHashes(result.runtimeDir),
      bots: { ...previous.bots, [bot.larkAppId]: { ...previous.bots?.[bot.larkAppId], clientConfig: connection.configPath } } });
    return { installed: true, enabled: bot.plugins?.includes('openviking') || false, botIndex: index, sharedUser: connection.user };
  }
  if (!api.get()?.bots?.[bot.larkAppId]?.clientConfig) throw new Error('Run plugin-install for this Bot first.');
  const { updateBotPluginOverride } = await load('core/plugins/effective.js');
  const { materializePlugin } = await load('core/plugins/materializer.js');
  const enable = opts.action === 'plugin-bind';
  if (enable) materializePlugin('openviking');
  const plugins = updateBotPluginOverride(bot.plugins, 'openviking', enable);
  if (plugins.length) bot.plugins = plugins;
  else delete bot.plugins;
  if (readFileSync(botsPath, 'utf8') !== raw) throw new Error('bots.json changed concurrently; inspect and retry.');
  atomicJson(botsPath, bots);
  return { enabled: enable, botIndex: index, cliId: bot.cliId, automaticCaptureChanged: false, existingSessionsRequireRestart: true };
}

export async function setupShared(args) {
  const opts = parse(args);
  if (opts.action === 'help') return HELP;
  return opts.action.startsWith('agent-') ? agentBinding(opts) : pluginBinding(opts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await setupShared(process.argv.slice(2));
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
