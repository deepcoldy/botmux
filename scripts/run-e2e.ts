#!/usr/bin/env tsx
/**
 * Run the migrated Feishu scenarios with Midscene Test. Each invocation gets
 * an isolated result directory so the report dashboard can group historical
 * runs without mixing logs, screenshots, or HTML reports.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { sweepOrphanSchedTasks } from '../test/e2e-browser/schedule-cleanup.js';

const groupUrl = process.env.FEISHU_TEST_GROUP_URL;
if (groupUrl) {
  const url = new URL(groupUrl);
  if (/^\/next\/messenger\/?$/.test(url.pathname)) {
    throw new Error(
      'FEISHU_TEST_GROUP_URL points to Messenger home. Configure a direct link to the real Botmux test group containing the Feishu bots.',
    );
  }
}

const ts = new Date()
  .toISOString()
  .replace('T', '_')
  .replace(/\..+$/, '')
  .replace(/:/g, '-');

const runDir = `midscene_run/runs/${ts}`;
process.env.MIDSCENE_RUN_DIR = runDir;

console.log(`[run-e2e] MIDSCENE_RUN_DIR=${runDir}`);

try {
  const removed = await sweepOrphanSchedTasks(1);
  if (removed.length > 0) {
    console.warn(
      `[run-e2e] swept ${removed.length} orphan schedule task(s): ${removed.join(', ')}`,
    );
  }
} catch (error) {
  console.warn(`[run-e2e] schedule sweep skipped: ${(error as Error).message}`);
}

let mockServer: import('../test/helpers/mock-llm-server/index.js').MockLlmServer | null = null;
const useMockLlm = process.argv.includes('--mock-llm') || process.env.BOTMUX_MOCK_LLM === 'true' || process.env.BOTMUX_MOCK_LLM === '1';

if (useMockLlm) {
  const { MockLlmServer } = await import('../test/helpers/mock-llm-server/index.js');
  const port = Number(process.env.MOCK_LLM_PORT ?? 9999);
  const mode = (process.env.MOCK_LLM_MODE ?? 'synthetic') as any;
  mockServer = new MockLlmServer({ port, mode, verbose: true });
  const { baseUrl } = await mockServer.start();
  console.log(`[run-e2e] Mock LLM Server started at ${baseUrl} (mode=${mode})`);
  process.env.ANTHROPIC_BASE_URL = baseUrl;
  process.env.ANTHROPIC_API_KEY = 'mock-key';
  process.env.OPENAI_BASE_URL = `${baseUrl}/v1`;
  process.env.OPENAI_API_KEY = 'mock-key';
}

const daemonChildren: import('node:child_process').ChildProcess[] = [];
const startDaemon =
  process.argv.includes('--start-daemon') ||
  process.env.BOTMUX_START_DAEMON === 'true' ||
  process.env.BOTMUX_START_DAEMON === '1';

if (startDaemon) {
  const botsConfig =
    process.env.BOTS_CONFIG ||
    (existsSync('test-bots.json') ? 'test-bots.json' : undefined);
  if (botsConfig) {
    process.env.BOTS_CONFIG = botsConfig;
    const { loadBotConfigs } = await import('../src/bot-registry.js');
    const { resolveBunExecutable } = await import('../test/helpers/ts-runner.js');
    const bunBin = resolveBunExecutable() ?? 'bun';
    const bots = loadBotConfigs();
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const dataDir =
      process.env.BOTMUX_DATA_DIR ?? join(homedir(), '.botmux', 'data');
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    console.log(
      `[run-e2e] Spawning test daemon(s) for ${bots.length} bot(s) from ${botsConfig} using ${bunBin}...`,
    );
    for (let i = 0; i < bots.length; i++) {
      const proc = spawn(bunBin, ['src/index-daemon.ts'], {
        env: {
          ...process.env,
          BOTMUX_BOT_INDEX: String(i),
          BOTMUX_DAEMON_IPC_BASE_PORT:
            process.env.BOTMUX_DAEMON_IPC_BASE_PORT ?? '17950',
          BOTMUX_WEB_PROXY_BASE_PORT:
            process.env.BOTMUX_WEB_PROXY_BASE_PORT ?? '18800',
        },
        stdio: 'inherit',
      });
      daemonChildren.push(proc);
    }
    // Allow daemons to connect to Feishu WebSocket gateway
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

const forwardedArgs = process.argv
  .slice(2)
  .filter((arg) => arg !== '--mock-llm' && arg !== '--start-daemon');

const child = spawn(
  'midscene-test',
  ['test/e2e-browser', '--result-dir', runDir, ...forwardedArgs],
  { stdio: 'inherit', env: process.env, shell: false },
);

const cleanup = async () => {
  for (const dc of daemonChildren) {
    try {
      dc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const dc of daemonChildren) {
    try {
      if (!dc.killed) dc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  if (mockServer) {
    await mockServer.stop();
  }
};

child.on('exit', async (code, signal) => {
  await cleanup();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

process.on('SIGINT', async () => {
  await cleanup();
  process.exit(130);
});
process.on('SIGTERM', async () => {
  await cleanup();
  process.exit(143);
});

