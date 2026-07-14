#!/usr/bin/env node
/**
 * Live, opt-in A2A release probe against two already-running deployments.
 *
 * Required environment:
 *   A2A_PROBE_ALLOW_LIVE=1
 *   A2A_PROBE_CHAT_ID=oc_xxx
 *   A2A_PROBE_SUPERVISOR_SESSION_ID=<local supervisor session>
 *   A2A_PROBE_HIT_BOT='ou_xxx:relay-loopy:执行者'
 *   A2A_PROBE_MISS_BOT='ou_yyy:seed-loopy:执行者'
 *   A2A_PROBE_REPO='https://github.com/org/repo.git'
 *
 * Optional:
 *   A2A_PROBE_MISSING_REPO='https://example.invalid/botmux/not-installed.git'
 *   A2A_PROBE_TIMEOUT_MS=300000
 *   A2A_PROBE_SKIP_READINESS_CHECK=1
 *
 * This script never embeds credentials and never chooses a production group.
 * It drives the real CLI/Lark path, then polls the supervisor ledger for one
 * successful report and one structured missing-repo help request.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(here, '..', 'dist', 'cli.js');

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function runCli(args, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = result.stdout?.trim() ?? '';
  const stderr = result.stderr?.trim() ?? '';
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`botmux ${args[0]} failed (${result.status}): ${stderr || stdout}`);
  }
  let json;
  try { json = stdout ? JSON.parse(stdout) : undefined; } catch { /* diagnostics stay in raw */ }
  return { status: result.status ?? 1, stdout, stderr, json };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTask(taskId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    const shown = runCli(['delivery', 'show', '--task', taskId], { allowFailure: true });
    latest = shown.json?.task;
    if (latest && predicate(latest)) return latest;
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${taskId}; latest=${JSON.stringify(latest)}`);
}

async function main() {
  if (process.env.A2A_PROBE_ALLOW_LIVE !== '1') {
    throw new Error('refusing live probe without A2A_PROBE_ALLOW_LIVE=1');
  }
  const chatId = required('A2A_PROBE_CHAT_ID');
  const sessionId = required('A2A_PROBE_SUPERVISOR_SESSION_ID');
  const hitBot = required('A2A_PROBE_HIT_BOT');
  const missBot = required('A2A_PROBE_MISS_BOT');
  const repo = required('A2A_PROBE_REPO');
  const missingRepo = process.env.A2A_PROBE_MISSING_REPO?.trim()
    || 'https://example.invalid/botmux/not-installed.git';
  const timeoutMs = Number(process.env.A2A_PROBE_TIMEOUT_MS) || 300_000;
  const suffix = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const hitTask = `a2a-live-hit-${suffix}`;
  const missTask = `a2a-live-miss-${suffix}`;
  const readinessOverride = process.env.A2A_PROBE_SKIP_READINESS_CHECK === '1'
    ? ['--skip-readiness-check']
    : [];

  console.log(`A2A live probe chat=${chatId} hit=${hitTask} miss=${missTask}`);
  runCli([
    'dispatch', '--session-id', sessionId, '--chat-id', chatId,
    '--task-id', hitTask, '--title', 'A2A 自动探针：项目命中',
    '--bot', hitBot, '--needs-repo', repo,
    '--brief', `只读核验当前项目路径与 git origin，然后运行 botmux report --task ${hitTask} --artifact-text "A2A_LIVE_HIT=PASS" "项目命中探针完成"。`,
    ...readinessOverride,
  ]);
  runCli([
    'dispatch', '--session-id', sessionId, '--chat-id', chatId,
    '--task-id', missTask, '--title', 'A2A 自动探针：项目缺失',
    '--bot', missBot, '--needs-repo', missingRepo,
    '--brief', '该项目应不存在；接收端必须在创建会话前返回“缺少项目环境”求助。',
    ...readinessOverride,
  ]);

  const [hit, miss] = await Promise.all([
    waitForTask(hitTask, (task) => ['reported', 'accepted'].includes(task.status), timeoutMs),
    waitForTask(missTask, (task) => task.status === 'blocked' && task.help?.kind === 'access', timeoutMs),
  ]);
  if (!String(miss.help?.blocker ?? '').includes('缺少项目环境')) {
    throw new Error(`missing-repo task returned unexpected blocker: ${miss.help?.blocker ?? ''}`);
  }
  console.log(JSON.stringify({
    ok: true,
    chatId,
    hit: { taskId: hitTask, status: hit.status, reports: hit.reports?.length ?? 0 },
    miss: { taskId: missTask, status: miss.status, blocker: miss.help?.blocker },
  }, null, 2));
}

main().catch((error) => {
  console.error(`A2A live probe failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
