#!/usr/bin/env node
// CI 安装类命令的网络重试包装：`node scripts/ci-net-retry.mjs <command> [args...]`。
//
// GitHub 网关 / npm registry 偶发 504、连接被重置时，各工具自带的重试都在几秒到半分钟内打完：
// bun install 约 1 秒内连发 6 次，electron 的 postinstall 一次都不重试，setup-bun 的下载是
// 10s/18s 三次。扛不住持续一两分钟的抖动，整个 job 就红了（#3193）。本脚本在命令外面再包一层
// 有界重试：
//   - 次数与间隔写死：最多 5 次，间隔 10s/20s/40s/80s，最坏多等 150 秒。不读环境变量、不收参数，
//     要改只能改下面的常量并过评审。
//   - 只重试网络/网关类失败：按命令输出（stdout+stderr）里的特征判定，见 TRANSIENT。
//   - 确定性失败第一次就红：lockfile 与 package.json 不符、依赖解析失败、包/版本/文件不存在、
//     无权限、完整性校验失败，见 DETERMINISTIC。输出里同时带网络特征也不重试。
//   - 两边都不像的失败同样不重试：宁可红一次让人看，也不把真错误重试掉。
//   - DNS 只认 EAI_AGAIN（解析器临时失败）；ENOTFOUND / curl (6) 也可能是主机名写错，不重试。
//
// 子进程 stdout/stderr 原样转发，退出码原样传出（被信号杀掉按 128+信号值；起不来按 127）。
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';

/** 第 n 次失败后等待 RETRY_DELAYS_MS[n-1] 再试；长度 + 1 = 总尝试次数。 */
export const RETRY_DELAYS_MS = Object.freeze([10_000, 20_000, 40_000, 80_000]);

const OUTPUT_TAIL_CHARS = 256 * 1024;
const STATUS = '(?:5\\d\\d|408|429)';

export const TRANSIENT = Object.freeze([
  // bun：error: GET https://registry.npmjs.org/x/-/x-1.0.0.tgz - 504
  new RegExp(`\\bGET \\S+ - ${STATUS}\\b`),
  // bun：error: ConnectionClosed downloading tarball x@1.0.0
  /\b(?:Connection\w+|E(?:CONNRESET|CONNREFUSED|TIMEDOUT|PIPE)|\w*Timeout|UnexpectedEOF)\s+downloading\b/,
  // npm：npm error code E504
  new RegExp(`\\bcode E${STATUS}\\b`),
  // pnpm：ERR_PNPM_FETCH_504  GET …: Gateway Time-out - 504
  new RegExp(`\\bERR_PNPM_FETCH_${STATUS}\\b`),
  // electron postinstall：HTTPError: Response code 504 (Gateway Time-out)
  new RegExp(`\\bResponse code ${STATUS}\\b`),
  // @actions/tool-cache（setup-bun 的下载）：Unexpected HTTP response: 504
  new RegExp(`\\bUnexpected HTTP response: ${STATUS}\\b`),
  // curl --fail：curl: (22) The requested URL returned error: 504
  new RegExp(`\\breturned error: ${STATUS}\\b`),
  // curl 连接类：(7) 连不上 (18) 传输中断 (28) 超时 (35) TLS 握手 (52) 空响应 (55)(56) 收发失败 (92) HTTP/2 流
  /\bcurl: \((?:7|18|28|35|52|55|56|92)\)/,
  // Node 系（npm / pnpm / electron）套接字层
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)\b/,
  /\bsocket hang up\b/,
]);

export const DETERMINISTIC = Object.freeze([
  // lockfile 与 package.json 不符
  /lockfile had changes, but lockfile is frozen/, // bun
  /\bERR_PNPM_OUTDATED_LOCKFILE\b/,
  // 依赖解析失败：版本不存在 / peer 冲突
  /\bNo version matching\b/, // bun
  /\bcode E(?:TARGET|RESOLVE)\b/, // npm
  /\bERR_PNPM_(?:NO_MATCHING_VERSION|PEER_DEP_ISSUES)\b/,
  // 包 / 版本 / 文件不存在，或无权限
  /\bGET \S+ - 40[134]\b/, // bun
  /\bcode E40[134]\b/, // npm
  /\bERR_PNPM_FETCH_40[134]\b/,
  /\bResponse code 40[134]\b/, // electron postinstall
  /\breturned error: 40[134]\b/, // curl
  // 完整性校验失败
  /\bcode EINTEGRITY\b/, // npm
  /\bERR_PNPM_TARBALL_INTEGRITY\b/,
  /integrity check failed/i, // bun
]);

/** 判定一次失败的输出：kind 为 'deterministic' | 'transient' | 'unknown'，match 是命中的原文。 */
export function classifyFailure(output) {
  for (const [kind, patterns] of [['deterministic', DETERMINISTIC], ['transient', TRANSIENT]]) {
    for (const re of patterns) {
      const m = re.exec(output);
      if (m) return { kind, match: m[0] };
    }
  }
  return { kind: 'unknown', match: undefined };
}

function log(level, message) {
  const line = process.env.GITHUB_ACTIONS === 'true' && level !== 'info'
    ? `::${level}::${message}`
    : `[ci-net-retry] ${message}`;
  process.stderr.write(`${line}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 跑一次命令：输出原样转发并留尾巴供判定；收到 SIGINT/SIGTERM 转给子进程并标记 interrupted。 */
function spawnAttempt(command, args) {
  return new Promise((resolve) => {
    let tail = '';
    let interrupted = false;
    let settled = false;
    const keep = (chunk) => {
      tail = (tail + chunk.toString('utf8')).slice(-OUTPUT_TAIL_CHARS);
    };
    const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'] });
    const forward = (signal) => {
      interrupted = true;
      child.kill(signal);
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      resolve({ ...result, output: tail, interrupted });
    };
    child.stdout.on('data', (chunk) => { process.stdout.write(chunk); keep(chunk); });
    child.stderr.on('data', (chunk) => { process.stderr.write(chunk); keep(chunk); });
    child.on('error', (error) => {
      process.stderr.write(`[ci-net-retry] 无法启动 ${command}：${error.message}\n`);
      finish({ code: 127 });
    });
    child.on('close', (code, signal) => {
      finish({ code: code ?? 128 + (constants.signals[signal] ?? 0) });
    });
  });
}

/**
 * 跑 command，网络/网关类失败按 delays 退避重跑，返回最后一次的退出码。
 * 第三个参数只为测试注入假的 spawn / sleep / log，CLI 不暴露。
 */
export async function runWithRetry(command, args, deps = {}) {
  const { delays = RETRY_DELAYS_MS, spawn: run = spawnAttempt, sleep: wait = sleep, log: say = log } = deps;
  const label = [command, ...args].join(' ');
  const attempts = delays.length + 1;
  for (let attempt = 1; ; attempt += 1) {
    const { code, output, interrupted } = await run(command, args);
    if (code === 0) {
      if (attempt > 1) say('notice', `${label}：第 ${attempt} 次尝试成功`);
      return 0;
    }
    if (interrupted) return code;
    const { kind, match } = classifyFailure(output);
    if (kind !== 'transient') {
      const why = kind === 'deterministic' ? `确定性错误（${match}）` : '未识别为网络/网关类错误';
      say('info', `${label}：第 ${attempt} 次失败（退出码 ${code}），${why}，不重试`);
      return code;
    }
    if (attempt === attempts) {
      say('error', `${label}：连续 ${attempts} 次网络/网关类失败（${match}），放弃，退出码 ${code}`);
      return code;
    }
    const delay = delays[attempt - 1];
    say('warning', `${label}：第 ${attempt}/${attempts} 次失败（退出码 ${code}，${match}），${delay / 1000}s 后重试`);
    await wait(delay);
  }
}

function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    process.stderr.write('usage: node scripts/ci-net-retry.mjs <command> [args...]\n');
    process.exit(2);
  }
  process.exitCode = await runWithRetry(command, args);
}
