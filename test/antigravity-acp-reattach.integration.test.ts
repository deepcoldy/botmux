/** Regression: a warm tmux reattach before the first native session id must stay usable. */
import { type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnNodeTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import { ensureGatewayEntry } from '../src/core/plugins/mcp/gateway-installer.js';
import { refreshSessionMcpRuntimeManifest } from '../src/core/plugins/mcp/session-runtime.js';
import { createAntigravityAcpAdapter } from '../src/adapters/cli/antigravity-acp.js';

const workers: ChildProcess[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const child of workers.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.send({ type: 'close' } satisfies DaemonToWorker, () => {});
    });
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** Start an isolated ACP worker; resume=true mirrors a daemon-driven reattach. */
function startWorker(opts: {
  root: string; dataDir: string; sessionId: string; executable: string; log: string; resume: boolean;
  extraEnv?: Record<string, string>;
  mcpConfig?: string;
}) {
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, HOME: opts.root, SESSION_DATA_DIR: opts.dataDir, NODE_ENV: 'test',
      BOTMUX_TEST_ANTIGRAVITY_RUNNER_PATH: resolve('dist/antigravity-runner.js'),
      AGY_TEST_LOG: opts.log, AGY_TEST_MCP_CONFIG: opts.mcpConfig, BOTMUX_TIME_SCALE: '0.05',
      LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'secret' },
  });
  workers.push(child);
  child.on('message', raw => messages.push(raw as WorkerToDaemon));
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.send({ type: 'init', sessionId: opts.sessionId, chatId: 'oc_test', rootMessageId: 'om_root',
    workingDir: opts.root, cliId: 'antigravity', cliPathOverride: opts.executable, backendType: 'tmux',
    prompt: '', turnId: 'om_initial', resume: opts.resume,
    env: { AGY_BOTMUX_TRANSPORT: 'acp', ...opts.extraEnv },
    larkAppId: 'app_test', larkAppSecret: 'secret',
  } satisfies DaemonToWorker);
  return { child, messages, logs };
}

/** Resolve on a predicate, surfacing worker diagnostics instead of a bare timeout. */
async function waitFor(worker: { child: ChildProcess; logs: string[] }, check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (!check()) {
    if (worker.child.exitCode !== null || Date.now() > deadline) {
      throw new Error(`${label} failed\n${worker.logs.join('')}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

describe('Antigravity ACP warm reattach before the first native session', () => {
  it('reattaches without a native id and answers the next turn on a fresh session', async () => {
    const sessionId = randomUUID();
    const root = mkdtempSync(join(tmpdir(), 'botmux-agy-reattach-')); roots.push(root);
    const dataDir = join(root, 'data'); mkdirSync(dataDir);
    const log = join(root, 'calls.jsonl'); writeFileSync(log, '');
    const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
    const executable = join(root, 'agy');
    writeFileSync(executable, `#!/bin/sh\nexec ${[tsRunnerPrefix().command, resolve('test/fixtures/fake-antigravity-acp.mjs')].map(quote).join(' ')} "$@"\n`, { mode: 0o700 });

    // First worker: empty startup, no turn ever runs, so no native session id exists.
    const first = startWorker({ root, dataDir, sessionId, executable, log, resume: false });
    await waitFor(first, () => first.messages.some(message => message.type === 'prompt_ready'), 'first worker ready');

    // SIGKILL the worker while its tmux pane and the headless runner survive.
    first.child.kill('SIGKILL');
    await new Promise<void>(resolve => first.child.once('exit', () => resolve()));

    // Successor: daemon-style resume with no persisted cliSessionId.
    const successor = startWorker({ root, dataDir, sessionId, executable, log, resume: true });
    await waitFor(successor, () => successor.logs.some(line => line.includes('Re-attaching to existing tmux session')), 'successor reattach');
    await waitFor(successor, () => successor.messages.some(message => message.type === 'prompt_ready'), 'successor ready');
    expect(successor.messages.some(message => message.type === 'error')).toBe(false);

    // The surviving runner has no native id: the next turn must open a new session, not fail.
    successor.child.send({ type: 'message', content: 'first real prompt', turnId: 'om_followup' } satisfies DaemonToWorker);
    await waitFor(successor,
      () => successor.messages.some(message => message.type === 'final_output' && message.turnId === 'om_followup'),
      'follow-up final');
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) as Array<Record<string, unknown>>;
    expect(calls.some(call => call.method === 'session/load')).toBe(false);
    expect(calls.some(call => call.method === 'session/new')).toBe(true);
    expect(calls.filter(call => call.method === 'session/prompt')).toHaveLength(1);
  }, 90_000);

  it('repairs relocated MCP config before the next ACP child after a warm reattach', async () => {
    const sessionId = randomUUID();
    const root = mkdtempSync(join(tmpdir(), 'botmux-agy-reattach-mcp-')); roots.push(root);
    const dataDir = join(root, 'data'); mkdirSync(dataDir);
    const relocatedHome = join(root, 'relocated-home'); mkdirSync(relocatedHome);
    const log = join(root, 'calls.jsonl'); writeFileSync(log, '');
    const pluginId = 'plugin-a';
    vi.stubEnv('HOME', root);
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
    vi.stubEnv('BOTMUX_BIN_PATH', join(root, '.botmux', 'bin', 'botmux'));

    const source = join(root, 'plugin-source');
    mkdirSync(join(source, 'dist', 'mcp'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: '@botmux-ai/plugin-plugin-a', version: '0.1.0', type: 'module',
      keywords: ['botmux-plugin'], botmux: { schemaVersion: 1, id: pluginId },
    }));
    writeFileSync(join(source, 'dist', 'mcp', 'index.json'), JSON.stringify({
      transport: 'stdio', command: [process.execPath, resolve('test/fixtures/plugin-mcp-server.mjs'), 'alpha'],
    }));
    installLocalPlugin(source);
    mkdirSync(join(root, '.botmux'), { recursive: true });
    writeFileSync(join(root, '.botmux', 'config.json'), JSON.stringify({ plugins: [pluginId], mcpGatewayMaxToolTimeoutMs: 900_001 }));
    // Preseed independently of the first-spawn fix so this case isolates warm reattach.
    refreshSessionMcpRuntimeManifest({ sessionId, pluginIds: [pluginId], dataDir });

    const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
    const executable = join(root, 'agy');
    writeFileSync(executable, `#!/bin/sh\nexec ${[tsRunnerPrefix().command, resolve('test/fixtures/fake-antigravity-acp.mjs')].map(quote).join(' ')} "$@"\n`, { mode: 0o700 });
    expect(ensureGatewayEntry(createAntigravityAcpAdapter(executable)).state).toBe('installed');

    const relocatedConfig = join(relocatedHome, '.gemini', 'config', 'mcp_config.json');
    const first = startWorker({
      root, dataDir, sessionId, executable, log, resume: false, extraEnv: { HOME: relocatedHome }, mcpConfig: relocatedConfig,
    });
    await waitFor(first, () => first.messages.some(message => message.type === 'prompt_ready'), 'first worker ready');
    const disabled = JSON.parse(readFileSync(relocatedConfig, 'utf8'));
    disabled.mcpServers.botmux.disabled = true;
    writeFileSync(relocatedConfig, JSON.stringify(disabled));

    first.child.kill('SIGKILL');
    await new Promise<void>(resolve => first.child.once('exit', () => resolve()));
    const successor = startWorker({
      root, dataDir, sessionId, executable, log, resume: true, extraEnv: { HOME: relocatedHome }, mcpConfig: relocatedConfig,
    });
    await waitFor(successor, () => successor.logs.some(line => line.includes('Re-attaching to existing tmux session')), 'successor reattach');
    await waitFor(successor, () => successor.messages.some(message => message.type === 'prompt_ready'), 'successor ready');

    const repaired = JSON.parse(readFileSync(relocatedConfig, 'utf8'));
    expect(repaired.mcpServers.botmux.disabled).toBe(false);
    const mcpObservations = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { method?: string; pid?: number; mcp?: { exists: boolean; disabled?: boolean } })
      .filter(call => call.method === 'initialize' && call.mcp)
      .map(call => ({ pid: call.pid, ...call.mcp! }));
    successor.child.send({ type: 'message', content: 'turn after repair', turnId: 'om_after_repair' } satisfies DaemonToWorker);
    await waitFor(successor,
      () => successor.messages.some(message => message.type === 'final_output' && message.turnId === 'om_after_repair'),
      'post-reattach turn');
    expect(mcpObservations().map(call => call.disabled)).toEqual([false]);

    const disabledAgain = JSON.parse(readFileSync(relocatedConfig, 'utf8'));
    disabledAgain.mcpServers.botmux.disabled = true;
    writeFileSync(relocatedConfig, JSON.stringify(disabledAgain));
    successor.child.send({ type: 'message', content: 'turn after disable', turnId: 'om_after_disable' } satisfies DaemonToWorker);
    await waitFor(successor,
      () => successor.messages.some(message => message.type === 'final_output' && message.turnId === 'om_after_disable'),
      'turn after manual disable');
    expect(mcpObservations().map(call => call.disabled)).toEqual([false, false]);

    rmSync(relocatedConfig, { force: true });
    successor.child.send({ type: 'message', content: 'turn after delete', turnId: 'om_after_delete' } satisfies DaemonToWorker);
    await waitFor(successor,
      () => successor.messages.some(message => message.type === 'final_output' && message.turnId === 'om_after_delete'),
      'turn after config deletion');
    const observed = mcpObservations();
    expect(observed.map(call => [call.exists, call.disabled])).toEqual([[true, false], [true, false], [true, false]]);
    expect(new Set(observed.map(call => call.pid)).size).toBe(3);
    expect(JSON.parse(readFileSync(relocatedConfig, 'utf8')).mcpServers.botmux).toMatchObject({
      disabled: false,
      timeoutSeconds: 901,
    });
  }, 90_000);
});
