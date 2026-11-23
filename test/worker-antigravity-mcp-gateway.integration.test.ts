import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnNodeTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import { ensureGatewayEntry } from '../src/core/plugins/mcp/gateway-installer.js';
import {
  readSessionMcpRuntimeManifest,
  refreshSessionMcpRuntimeManifest,
} from '../src/core/plugins/mcp/session-runtime.js';
import { createAntigravityAdapter } from '../src/adapters/cli/antigravity.js';

const children: ChildProcess[] = [];
const fakePids = new Set<number>();
const roots: string[] = [];
const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
  await new Promise<void>(done => child.once('exit', () => done()));
  clearTimeout(timer);
}

afterEach(async () => {
  for (const child of children.splice(0)) await stopChild(child);
  for (const pid of fakePids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  }
  fakePids.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('worker Antigravity relocated MCP config on first spawn', () => {
  it.each([
    { name: 'absent', preseedEmpty: false },
    { name: 'empty', preseedEmpty: true },
  ])('installs before agy launches when the previous manifest is $name', async ({ preseedEmpty }) => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-agy-gateway-'));
    roots.push(root);
    const daemonHome = join(root, 'daemon-home');
    const relocatedHome = join(root, 'relocated-home');
    const dataDir = join(root, 'data');
    const workDir = join(root, 'work');
    const sessionId = `agy-first-${preseedEmpty ? 'empty' : 'absent'}`;
    const pluginId = 'plugin-a';
    for (const dir of [daemonHome, relocatedHome, dataDir, workDir]) mkdirSync(dir, { recursive: true });
    vi.stubEnv('HOME', daemonHome);
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
    vi.stubEnv('BOTMUX_SESSION_ID', sessionId);
    vi.stubEnv('BOTMUX_BIN_PATH', join(daemonHome, '.botmux', 'bin', 'botmux'));

    const source = join(root, 'plugin-source');
    mkdirSync(join(source, 'dist', 'mcp'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: '@botmux-ai/plugin-plugin-a', version: '0.1.0', type: 'module',
      keywords: ['botmux-plugin'], botmux: { schemaVersion: 1, id: pluginId },
    }));
    writeFileSync(join(source, 'dist', 'mcp', 'index.json'), JSON.stringify({
      transport: 'stdio',
      command: [process.execPath, resolve('test/fixtures/plugin-mcp-server.mjs'), 'alpha'],
    }));
    installLocalPlugin(source);
    mkdirSync(join(daemonHome, '.botmux'), { recursive: true });
    writeFileSync(join(daemonHome, '.botmux', 'config.json'), JSON.stringify({ plugins: [pluginId] }));
    if (preseedEmpty) refreshSessionMcpRuntimeManifest({ sessionId, pluginIds: [], dataDir });

    const launchRecord = join(root, 'agy-launch.json');
    const relocatedConfig = join(relocatedHome, '.gemini', 'config', 'mcp_config.json');
    const fake = join(root, 'fake-agy');
    writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
    writeFileSync(fake, `#!${tsRunnerPrefix().command}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('1.5.12'); process.exit(0); }
const args = process.argv.slice(2);
const logIndex = args.indexOf('--log-file');
if (logIndex >= 0) {
  const logFile = args[logIndex + 1];
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, 'I1103 12:00:00.000001 100 server.go:1] Streaming conversation 11111111-1111-1111-1111-111111111111\\n');
}
fs.writeFileSync(${JSON.stringify(launchRecord)}, JSON.stringify({
  pid: process.pid,
  home: process.env.HOME,
  gatewaySocketPresent: !!process.env.BOTMUX_MCP_GATEWAY_SOCKET,
  gatewayRequired: process.env.BOTMUX_MCP_GATEWAY_REQUIRED,
  configExists: fs.existsSync(${JSON.stringify(relocatedConfig)}),
}));
process.stdin.on('data', () => {});
setTimeout(() => process.stdout.write('\\x1b[2J\\x1b[HNative agy fixture\\r\\n>\\r\\n? for shortcuts\\r\\n'), 100);
setInterval(() => {}, 1000);
`);
    chmodSync(fake, 0o755);
    expect(ensureGatewayEntry(createAntigravityAdapter(fake)).state).toBe('installed');

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const worker = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: daemonHome,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: sessionId,
        BOTMUX_TIME_SCALE: '0.05',
        LARK_APP_ID: 'app_test',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(worker);
    worker.on('message', raw => messages.push(raw as WorkerToDaemon));
    worker.stdout?.on('data', chunk => logs.push(chunk.toString()));
    worker.stderr?.on('data', chunk => logs.push(chunk.toString()));
    worker.send({
      type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root', workingDir: workDir,
      cliId: 'antigravity', cliPathOverride: fake, backendType: 'pty', promptInjection: 'none',
      pluginBindings: [pluginId], env: { HOME: relocatedHome }, sandbox: false,
      prompt: '', larkAppId: 'app_test', larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    const deadline = Date.now() + 30_000;
    while ((!existsSync(launchRecord) || !readSessionMcpRuntimeManifest(sessionId, dataDir)?.entries.length)
      && Date.now() < deadline) {
      if (worker.exitCode !== null || worker.signalCode !== null) {
        throw new Error(`worker exited before agy launch\n${logs.join('')}`);
      }
      await sleep(50);
    }
    if (!existsSync(launchRecord)) {
      throw new Error(`agy did not launch\n${logs.join('')}\n${JSON.stringify(messages.filter(m => m.type === 'error'))}`);
    }
    const launch = JSON.parse(readFileSync(launchRecord, 'utf8'));
    fakePids.add(launch.pid);
    expect(readSessionMcpRuntimeManifest(sessionId, dataDir)?.entries).toHaveLength(1);
    expect(launch.home).toBe(relocatedHome);
    expect(launch.gatewaySocketPresent).toBe(true);
    expect(launch.gatewayRequired).toBe('1');
    // Captured by the CLI itself at process entry: a later repair cannot make this pass.
    expect(launch.configExists).toBe(true);
    const installed = JSON.parse(readFileSync(relocatedConfig, 'utf8'));
    expect(installed.mcpServers.botmux.command).toBe(process.env.BOTMUX_BIN_PATH);
    expect(installed.mcpServers.botmux.disabled).toBe(false);
  }, 60_000);
});
