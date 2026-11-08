/**
 * test-concurrency.mjs — 本机测试的整机并发闸 + 默认 worker 数。
 *
 * 背景：这台开发机（64 核）上同时跑着上百个 agent 会话，常常有十几个会话在不同
 * worktree 里各自跑全量测试。vitest 默认按核数开 worker，18 份叠在一起就是上千个
 * 进程，整机负载被顶到 1000–3000，所有会话（含网页终端）都卡。
 *
 * 两件事：
 *   1. 闸：同一时间最多 `slots` 份「大批量」测试（vitest 选中的文件数 ≥ minFiles，或
 *      bun test 全量）。名额是 `<slotDir>/slot-<i>` 上的 flock，由一个
 *      `flock … cat` 子进程持有：它的 stdin 接在本进程上，本进程无论怎么退出（含
 *      SIGKILL），管道都会关，cat 读到 EOF 退出，锁随之释放，不会留下死名额。
 *   2. 默认 worker 数：`floor(cpus / slots)`，封顶 16。闸住的几份合起来约等于核数。
 *
 * CI（`CI` 环境变量为真）上什么都不做：CI 是独占机器，维持 vitest / runner 原有默认值。
 *
 * 环境变量：
 *   BOTMUX_TEST_GATE=0            关闭闸（worker 数仍按下面的规则算）
 *   BOTMUX_TEST_SLOTS=<n>         名额数，默认 max(1, floor(cpus / 16))
 *   BOTMUX_TEST_MAX_WORKERS=<n>   vitest maxWorkers，默认 min(16, floor(cpus / slots))
 *   BOTMUX_TEST_GATE_MIN_FILES=<n> vitest 选中多少个文件起算「大批量」，默认 50
 *   BOTMUX_TEST_SLOT_DIR=<dir>    名额锁文件目录，默认 /tmp/botmux-test-slots
 *
 * 显式传 `--maxWorkers` 时以命令行为准（vitest 自身的优先级）。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_SLOT_DIR = '/tmp/botmux-test-slots';
const CORES_PER_SLOT = 16;
const MAX_WORKERS_CAP = 16;
const DEFAULT_MIN_FILES = 50;
/** flock 拿不到锁时的退出码（-E），与 flock 自身的错误码区分开。 */
const FLOCK_BUSY_EXIT = 75;

function positiveInt(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function isCiEnv(env) {
  const v = env.CI;
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

/**
 * 纯函数：按环境算出本次测试的并发参数。
 * CI ⇒ `{ ci: true, gated: false, maxWorkers: undefined }`（交回各工具默认值）。
 */
export function resolveTestConcurrency({
  env = process.env,
  cpus = availableParallelism(),
  platform = process.platform,
} = {}) {
  if (isCiEnv(env)) {
    return { ci: true, gated: false, slots: undefined, maxWorkers: undefined, minFiles: undefined, slotDir: undefined };
  }
  const slots = positiveInt(env.BOTMUX_TEST_SLOTS) ?? Math.max(1, Math.floor(cpus / CORES_PER_SLOT));
  const maxWorkers = positiveInt(env.BOTMUX_TEST_MAX_WORKERS)
    ?? Math.max(1, Math.min(MAX_WORKERS_CAP, Math.floor(cpus / slots)));
  const minFiles = positiveInt(env.BOTMUX_TEST_GATE_MIN_FILES) ?? DEFAULT_MIN_FILES;
  // flock(1) 是 util-linux 的；macOS / Windows 没有，闸只在 Linux 上开。
  const gated = platform === 'linux' && env.BOTMUX_TEST_GATE !== '0';
  const slotDir = env.BOTMUX_TEST_SLOT_DIR?.trim() || DEFAULT_SLOT_DIR;
  return { ci: false, gated, slots, maxWorkers, minFiles, slotDir };
}

function unrefChild(child) {
  child.unref();
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (stream && typeof stream.unref === 'function') stream.unref();
  }
}

/**
 * 持锁脚本：sh 自己打开锁文件（fd 9），`flock -n 9` 只给这个 fd 上锁然后退出，sh 再
 * exec 成 cat。于是**自始至终只有一个进程**持有这把锁：杀掉它就放锁；本进程退出时
 * 它的 stdin 管道关闭，cat 读到 EOF 退出，同样放锁。
 * 不用 `flock <file> -c <cmd>`：那种形态由 flock fork 出 cmd、锁 fd 被子进程继承，
 * 杀掉 flock 本身并不放锁。
 */
const HOLD_SCRIPT = [
  'exec 9>>"$1" || exit 1',
  `flock -n -E ${FLOCK_BUSY_EXIT} 9; rc=$?; [ "$rc" -eq 0 ] || exit "$rc"`,
  'echo held',
  'exec cat >/dev/null',
].join('\n');

/**
 * 试拿一个名额：成功 ⇒ 持锁子进程；名额被占 ⇒ null；flock 不可用 ⇒ 抛错。
 * 子进程打印一行 `held` 才算拿到（避免把「还没开始抢」当成「拿到了」）。
 */
function tryHoldSlot(file, spawnImpl) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl('/bin/sh', ['-c', HOLD_SCRIPT, 'test-slot', file], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    child.once('error', error => settle(reject, error));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (chunk.includes('held')) {
        unrefChild(child);
        settle(resolve, child);
      }
    });
    child.once('exit', code => {
      if (code === FLOCK_BUSY_EXIT) settle(resolve, null);
      // 127：flock 不在 PATH 上（如 macOS）。
      else settle(reject, new Error(code === 127 ? 'flock: command not found' : `flock exited with ${code}`));
    });
  });
}

function readOwner(slotDir, i) {
  try { return JSON.parse(readFileSync(join(slotDir, `slot-${i}.owner.json`), 'utf8')); } catch { return undefined; }
}

function describeOwners(slotDir, slots) {
  const lines = [];
  for (let i = 0; i < slots; i += 1) {
    const o = readOwner(slotDir, i);
    if (o) lines.push(`  名额 ${i}: pid ${o.pid}，${o.cwd}，${o.label}，始于 ${o.startedAt}`);
  }
  return lines.join('\n');
}

/**
 * 等到拿到一个名额。返回 `{ slot, release }`；`release()` 幂等。
 * flock 不可用（没装 util-linux 等）⇒ 打一行提示后放行（`slot: -1`），不挡测试。
 */
export async function acquireTestSlot({
  slots,
  slotDir = DEFAULT_SLOT_DIR,
  label = 'tests',
  pollMs = 2000,
  reportEveryMs = 60_000,
  log = message => process.stderr.write(`${message}\n`),
  spawnImpl = spawn,
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  mkdirSync(slotDir, { recursive: true, mode: 0o777 });
  const startedWaiting = now();
  let lastReport;
  for (;;) {
    for (let i = 0; i < slots; i += 1) {
      let holder;
      try {
        holder = await tryHoldSlot(join(slotDir, `slot-${i}`), spawnImpl);
      } catch (error) {
        log(`[test-gate] 无法使用 flock（${error instanceof Error ? error.message : String(error)}），不做并发限制`);
        return { slot: -1, release: () => {} };
      }
      if (!holder) continue;
      try {
        writeFileSync(join(slotDir, `slot-${i}.owner.json`), JSON.stringify({
          pid: process.pid, cwd: process.cwd(), label, startedAt: new Date(now()).toISOString(),
        }));
      } catch { /* 只是诊断信息 */ }
      if (lastReport !== undefined) {
        log(`[test-gate] 拿到测试名额 ${i}（等了 ${Math.round((now() - startedWaiting) / 1000)}s）`);
      }
      let released = false;
      return {
        slot: i,
        release: () => {
          if (released) return;
          released = true;
          try { holder.kill('SIGTERM'); } catch { /* 已退出 */ }
          try { holder.stdin?.destroy(); } catch { /* */ }
        },
      };
    }
    if (lastReport === undefined || now() - lastReport >= reportEveryMs) {
      log(`[test-gate] 本机同时最多 ${slots} 份大批量测试，名额已满，排队等待（BOTMUX_TEST_GATE=0 可跳过）：\n${describeOwners(slotDir, slots)}`);
      lastReport = now();
    }
    await sleep(pollMs);
  }
}

let pending;
/**
 * vitest 用：选中文件数达到门槛时拿名额（整个进程只拿一次，watch 模式重跑不重复拿）。
 * 名额随本进程退出释放。
 */
export function gateVitestRun(fileCount, concurrency = resolveTestConcurrency()) {
  if (!concurrency.gated || fileCount < concurrency.minFiles) return Promise.resolve();
  pending ??= acquireTestSlot({
    slots: concurrency.slots,
    slotDir: concurrency.slotDir,
    label: `vitest ${fileCount} files`,
  });
  return pending.then(() => undefined);
}
