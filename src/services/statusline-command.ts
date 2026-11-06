/**
 * statusline-command.ts — `botmux statusline` 的实现（Claude Code `statusLine.command` 客户端）。
 *
 * Claude 在每条 assistant 消息后 / compact 后 / 到达 resets_at / 每 refreshInterval 秒
 * （300ms 防抖）把 JSON（context_window、rate_limits、model …）喂到 stdin。本命令做两件
 * 互不影响的事，各自 try/catch：
 *   1. 落盘：BOTMUX_SESSION_ID 非空且 payload 可解析 ⇒ 写
 *      `<DATA_DIR>/statusline/<sid>/latest.json`（daemon 合并进卡片用量段）。
 *      与盘上快照内容相同且不足 STATUSLINE_DEDUPE_MS ⇒ 跳过这次写（去重）。
 *   2. 转发：BOTMUX_STATUSLINE_CHAIN 非空（worker 找回的、被 --settings 遮蔽的用户
 *      statusLine 命令）⇒ `/bin/sh -c <chain>`，把**原始 stdin 字节**原样喂给它，
 *      stdout/stderr 直接继承（Claude 读的是本进程的 stdout），正常退出透传其退出码；
 *      10s 看门狗 SIGTERM → 1s 后 SIGKILL → exit 0；被信号杀 / spawn 失败 → exit 0。
 * 无 chain ⇒ stdout 空、exit 0（与用户没配 statusline 时一致：状态栏空）。
 * 诊断只走 stderr（stdout 是状态栏内容）；顶层兜底 exit 0——statusline 失败对 Claude
 * 只是「状态栏空」，绝不能让它挂住或刷错误。
 *
 * 为什么单独成模块、并且有自己的入口（src/statusline-entry.ts）：每个运行中的 Claude
 * 会话都会反复拉起这条命令。走完整 cli.js 时每次要加载整张 CLI 模块图（实测单次约
 * 0.7s 墙钟 / 1.5s CPU / 近百个线程），195 个会话忙起来时同时活着几十份，是整机高负载
 * 的来源之一。本模块**只允许依赖 node:* 与叶子模块**（statusline-snapshot、data-dir、
 * atomic-write），`test/statusline-entry-imports.test.ts` 守着这条边界。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import {
  parseStatuslinePayload,
  statuslineFilePath,
  writeStatuslineSnapshot,
  type StatuslineSnapshot,
} from './statusline-snapshot.js';

const STATUSLINE_STDIN_TIMEOUT_MS = 5000;
const STATUSLINE_CHAIN_TIMEOUT_MS = 10_000;
const STATUSLINE_CHAIN_KILL_GRACE_MS = 1000;
/**
 * 内容不变时的最短重写间隔。Claude 每条 assistant 消息都会调一次，大多数调用与上一份
 * 快照完全相同；跳过重写省掉 mkdir + tmp/fsync/rename。必须远小于读端的
 * STATUSLINE_STALE_MS（10 min），否则空闲会话的快照会被误判陈旧。
 */
export const STATUSLINE_DEDUPE_MS = 30_000;

/**
 * statusline 命令前缀里注入的 Bun/JSC 线程限制（见 hook-command.ts statuslineHookCommand）。
 * 转发给用户自己的 statusline 命令前要删掉——那是用户的进程，不该被我们限线程。
 */
export const STATUSLINE_BUN_THREAD_ENV: Readonly<Record<string, string>> = {
  BUN_JSC_numberOfGCMarkers: '1',
  BUN_JSC_useConcurrentJIT: 'false',
};

function statuslineDiagnostic(message: string): void {
  try { process.stderr.write(`[botmux statusline] ${message}\n`); } catch { /* */ }
}

/** 自限时读完 stdin（原始字节）；超时 / 读不到 ⇒ 返回已收到的部分，从不抛错。 */
async function readStdinWithTimeout(ms: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  try {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.stdin.destroy(); } catch { /* */ } }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    for await (const chunk of process.stdin) {
      if (timedOut) break;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    clearTimeout(timer);
  } catch { /* stdin 读不到 → 返回已收到的部分 */ }
  return Buffer.concat(chunks);
}

function contentKey(snap: Partial<StatuslineSnapshot>): string {
  const { ts: _ts, ...rest } = snap;
  return JSON.stringify(Object.keys(rest).sort().map(k => [k, (rest as Record<string, unknown>)[k]]));
}

/**
 * 盘上已有快照与新快照内容（除 ts 外全部字段）一致，且盘上那份写于 dedupeMs 之内 ⇒
 * 不必重写。读不到 / 损坏 / 时钟回拨（prev.ts 在未来）⇒ 照写。
 */
export function shouldSkipStatuslineWrite(
  prevRaw: string | undefined,
  next: StatuslineSnapshot,
  dedupeMs: number = STATUSLINE_DEDUPE_MS,
): boolean {
  if (prevRaw === undefined) return false;
  let prev: unknown;
  try { prev = JSON.parse(prevRaw); } catch { return false; }
  if (!prev || typeof prev !== 'object' || Array.isArray(prev)) return false;
  const prevTs = (prev as { ts?: unknown }).ts;
  if (typeof prevTs !== 'number' || !Number.isFinite(prevTs)) return false;
  const age = next.ts - prevTs;
  if (age < 0 || age >= dedupeMs) return false;
  return contentKey(prev as StatuslineSnapshot) === contentKey(next);
}

function persistSnapshot(raw: Buffer, sessionId: string): void {
  const snap = parseStatuslinePayload(JSON.parse(raw.toString('utf-8')));
  if (!snap) return;
  const dataDir = resolveBotmuxDataDir();
  let prevRaw: string | undefined;
  try { prevRaw = readFileSync(statuslineFilePath(dataDir, sessionId), 'utf-8'); } catch { /* 首次 / 不可读 */ }
  if (shouldSkipStatuslineWrite(prevRaw, snap)) return;
  writeStatuslineSnapshot(dataDir, sessionId, snap);
}

/** 转发给用户 statusline 命令的 env：去掉我们为本进程注入的 Bun 线程限制。 */
export function chainEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(STATUSLINE_BUN_THREAD_ENV)) delete out[key];
  return out;
}

/** 把原始 payload 转发给用户自己的 statusline 命令；本函数负责最终 process.exit。 */
function forwardStatuslineChain(chain: string, raw: Buffer): void {
  let child: ReturnType<typeof spawn>;
  try {
    // detached：让 sh 及其子进程独占一个进程组，看门狗按组杀——用户脚本常是
    // `bash ~/.claude/statusline.sh`（内部再 spawn jq / git），只杀 sh 会留下握着
    // stdout 管道的孤儿，Claude 读不到 EOF 会一直等。
    child = spawn('/bin/sh', ['-c', chain], {
      stdio: ['pipe', 'inherit', 'inherit'],
      detached: true,
      env: chainEnv(),
    });
  } catch (error) {
    statuslineDiagnostic(`chain spawn failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(0);
  }
  const killGroup = (signal: NodeJS.Signals) => {
    if (child.pid) {
      try { process.kill(-child.pid, signal); return; } catch { /* 组已不在 → 退回单进程 */ }
    }
    try { child.kill(signal); } catch { /* */ }
  };
  let killTimer: NodeJS.Timeout | undefined;
  const watchdog = setTimeout(() => {
    killGroup('SIGTERM');
    killTimer = setTimeout(() => {
      killGroup('SIGKILL');
      process.exit(0);
    }, STATUSLINE_CHAIN_KILL_GRACE_MS);
  }, STATUSLINE_CHAIN_TIMEOUT_MS);
  const finish = (code: number) => {
    clearTimeout(watchdog);
    if (killTimer) clearTimeout(killTimer);
    process.exit(code);
  };
  child.once('error', (error) => {
    statuslineDiagnostic(`chain failed: ${error instanceof Error ? error.message : String(error)}`);
    finish(0);
  });
  // 被信号杀（含看门狗）⇒ 0；正常退出透传退出码。
  child.once('exit', (code, signal) => finish(signal ? 0 : (code ?? 0)));
  // 用户命令可能不读 stdin 就退出 → EPIPE，吞掉即可。
  child.stdin?.on('error', () => { /* */ });
  child.stdin?.end(raw);
}

export async function runStatusline(): Promise<void> {
  try {
    const raw = await readStdinWithTimeout(STATUSLINE_STDIN_TIMEOUT_MS);
    const sessionId = process.env.BOTMUX_SESSION_ID;
    // env 缺失 ⇒ 非 botmux 会话（用户手跑 / adopt），不落盘，只做转发。
    if (sessionId) {
      try {
        persistSnapshot(raw, sessionId);
      } catch (error) {
        statuslineDiagnostic(`snapshot not written: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const chain = process.env.BOTMUX_STATUSLINE_CHAIN;
    if (!chain) process.exit(0);
    forwardStatuslineChain(chain, raw);
  } catch {
    process.exit(0);
  }
}
