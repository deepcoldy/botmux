import { spawn, spawnSync } from 'node:child_process';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const root = dirname(fileURLToPath(import.meta.url));
const runtime = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'));
const source = process.argv.find(arg => arg.startsWith('--source='))?.slice('--source='.length);
if (!source) throw new Error('Pass --source=/absolute/path/to/a/reviewed/OpenViking/checkout.');
const trustHooks = process.argv.includes('--trust-hooks');
const plugin = runtime.plugin;

function runJson(args) {
  const result = spawnSync(runtime.codex, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Codex command failed: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

const child = spawn(runtime.codex, ['-c', `plugins.${plugin}.enabled=true`, 'app-server'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
let nextId = 1;
const waiting = new Map();
let diagnostic = '';
child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4000); });
createInterface({ input: child.stdout }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const entry = waiting.get(message.id);
  if (!entry) return;
  clearTimeout(entry.timer);
  waiting.delete(message.id);
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
  else entry.resolve(message.result);
});
child.on('exit', code => {
  for (const { reject, timer } of waiting.values()) {
    clearTimeout(timer);
    reject(new Error(`app-server exited ${code}: ${diagnostic}`));
  }
  waiting.clear();
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, 30000);
    waiting.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

try {
  await request('initialize', {
    clientInfo: { name: 'botmux-openviking-setup', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  await request('config/batchWrite', {
    edits: [{ keyPath: `plugins.${plugin}.enabled`, value: false, mergeStrategy: 'upsert' }],
    reloadUserConfig: true,
  });
  runJson(['plugin', 'marketplace', 'add', source, '--json']);
  runJson(['plugin', 'add', plugin, '--json']);
  await request('config/batchWrite', {
    edits: [{ keyPath: `plugins.${plugin}.enabled`, value: false, mergeStrategy: 'upsert' }],
    reloadUserConfig: true,
  });
  const listed = await request('hooks/list', { cwds: [runtime.working_dir] });
  const hooks = listed.data.flatMap(entry => entry.hooks).filter(hook => hook.pluginId === plugin);
  const expected = new Map([
    ['sessionStart', 'session-start-commit.mjs'], ['userPromptSubmit', 'auto-recall.mjs'],
    ['stop', 'auto-capture.mjs'], ['sessionEnd', 'session-end.mjs'],
    ['preCompact', 'pre-compact-capture.mjs'], ['preToolUse', 'uri-guard.mjs'],
  ]);
  if (hooks.length !== expected.size) throw new Error(`Expected six native plugin hooks, found ${hooks.length}.`);
  for (const hook of hooks) {
    const script = expected.get(hook.eventName);
    const pluginRoot = dirname(dirname(hook.sourcePath || ''));
    const command = `node "${join(pluginRoot, 'scripts', script || '')}"`;
    if (!script || hook.command !== command || !hook.currentHash) {
      throw new Error(`Unexpected hook definition: ${hook.eventName}`);
    }
  }
  const pluginRoots = new Set(hooks.map(hook => dirname(dirname(hook.sourcePath))));
  if (pluginRoots.size !== 1) throw new Error('Expected one installed OpenViking adapter root.');
  runtime.plugin_root = [...pluginRoots][0];
  const runtimeTemporary = join(root, `runtime.${process.pid}.json`);
  await writeFile(runtimeTemporary, JSON.stringify(runtime, null, 2) + '\n', { mode: 0o600 });
  await rename(runtimeTemporary, join(root, 'runtime.json'));
  if (trustHooks) {
    const state = Object.fromEntries(hooks.map(hook => [hook.key, { trusted_hash: hook.currentHash }]));
    await request('config/batchWrite', {
      edits: [{ keyPath: 'hooks.state', value: state, mergeStrategy: 'upsert' }],
      reloadUserConfig: true,
    });
  }
  await mkdir(join(root, 'evidence'), { recursive: true });
  const evidence = hooks.map(hook => ({
    event: hook.eventName, plugin: hook.pluginId, command: hook.command,
    sourcePath: hook.sourcePath, currentHash: hook.currentHash,
  }));
  await writeFile(join(root, 'evidence/hooks.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ installed: plugin, listedHooks: hooks.length, trustedHooks: trustHooks,
    globalEnabled: false, reviewFile: join(root, 'evidence/hooks.json') }));
} finally {
  await request('config/batchWrite', {
    edits: [{ keyPath: `plugins.${plugin}.enabled`, value: false, mergeStrategy: 'upsert' }],
    reloadUserConfig: true,
  }).catch(() => {});
  child.stdin.end();
  child.kill('SIGTERM');
}
