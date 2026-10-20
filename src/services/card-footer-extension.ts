/**
 * card-footer-extension.ts — bots.json `cardFooterExtension`：卡片用量段末尾追加
 * 外部命令给出的自定义文本段。
 *
 * botmux 只负责「定时跑命令、取输出、接到用量段后面」，不理解内容：额度、构建状态、
 * 值班人……都由命令自己决定。命令在 daemon 进程里按 bot 跑（同一 bot 的所有会话共用
 * 一份结果），所以对所有 CLI 都生效，也不依赖 Claude Code 的 statusline。
 *
 * 读取永不阻塞卡片：`getCardFooterExtensionSegments` 只返回缓存，过期时在后台发起一次
 * 刷新；失败 / 超时沿用上次成功的结果，上次成功早于 STALE_MS 就不显示（宁缺勿错）。
 *
 * 输出约定（stdout，UTF-8）：
 *   - JSON：`{"segments": ["a", "b"]}`
 *   - 否则按行，一行一段（空行忽略）
 * 每段收成单行、去控制字符、截断到 MAX_SEGMENT_CHARS；最多 MAX_SEGMENTS 段。
 * markdown 转义在渲染端做（md-card），这里只保证是短的纯文本。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export interface CardFooterExtensionConfig {
  /** 交给 `/bin/sh -c` 执行的命令。 */
  command: string;
  /** 刷新间隔（秒），默认 DEFAULT_REFRESH_SECONDS，限制在 [MIN, MAX]。 */
  refreshSeconds?: number;
}

export const DEFAULT_REFRESH_SECONDS = 60;
export const MIN_REFRESH_SECONDS = 10;
export const MAX_REFRESH_SECONDS = 3600;
export const MAX_COMMAND_LENGTH = 1024;
export const MAX_SEGMENTS = 4;
export const MAX_SEGMENT_CHARS = 40;
export const COMMAND_TIMEOUT_MS = 3_000;
export const MAX_OUTPUT_BYTES = 16 * 1024;
/** 上次成功超过这么久就不再显示。 */
export const STALE_MS = 10 * 60_000;

/** bots.json 宽松校验：command 缺失 / 非字符串 / 过长 ⇒ undefined（等同未配置）。 */
export function normalizeCardFooterExtension(raw: unknown): CardFooterExtensionConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const command = typeof o.command === 'string' ? o.command.trim() : '';
  if (!command || command.length > MAX_COMMAND_LENGTH) return undefined;
  const out: CardFooterExtensionConfig = { command };
  if (typeof o.refreshSeconds === 'number' && Number.isFinite(o.refreshSeconds)) {
    out.refreshSeconds = Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, Math.round(o.refreshSeconds)));
  }
  return out;
}

function cleanSegment(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const chars = [...text];
  return chars.length > MAX_SEGMENT_CHARS ? `${chars.slice(0, MAX_SEGMENT_CHARS - 1).join('')}\u2026` : text;
}

/** 命令输出 → 文本段。没有可用段 ⇒ 空数组（表示「命令成功，但这次没有要显示的」）。 */
export function parseCardFooterExtensionOutput(stdout: string): string[] {
  const trimmed = stdout.trim();
  let items: unknown[] | undefined;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { segments?: unknown };
      if (Array.isArray(parsed.segments)) items = parsed.segments;
    } catch { /* 不是 JSON，按行处理 */ }
  }
  items ??= trimmed.split(/\r?\n/);
  const out: string[] = [];
  for (const item of items) {
    const segment = cleanSegment(item);
    if (segment) out.push(segment);
    if (out.length === MAX_SEGMENTS) break;
  }
  return out;
}

export type CardFooterExtensionRunner = (
  command: string,
  env: NodeJS.ProcessEnv,
) => Promise<string>;

/** stdio 管道运行时是 Socket：解引用读端，避免在跑的命令吊住进程正常退出。
 * 类型层面是 Readable（无 unref），按可选方法调用即可。 */
function unrefStream(stream: Readable | Writable | null): void {
  try {
    (stream as ((Readable | Writable) & { unref?: () => void }) | null)?.unref?.();
  } catch { /* 非 Socket 形态：无需处理 */ }
}

/**
 * 默认执行器：`/bin/sh -c`，关 stdin、限时、限输出；非 0 退出视为失败。
 *
 * 必须用 spawn（不是 execFile）起独立进程组：execFile 的 timeout / maxBuffer
 * 只把信号发给直接子进程 sh，sh fork 出去的命令（查网关时挂起的 curl 等）会
 * 成孤儿常驻——已在 node 与 bun 下用真实函数实证三种命令形态都残留。
 *
 * 超时 / 超限杀整个进程组，且**立即结算**、destroy 自己的管道读端，不等
 * stdio `'close'`：命令若 setsid / 双 fork 逃出进程组，组 kill 打不到它，
 * 而它仍继承着管道写端，等 close 会让这次刷新永久挂起。范式见
 * core/update-check.ts 的 spawnNpmConfigRegistry。
 */
export const runCardFooterExtensionCommand: CardFooterExtensionRunner = (command, env) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let child: ChildProcess;
    let timer: NodeJS.Timeout | undefined;

    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch { /* 已退出，或命令 setsid 逃出了本进程组 */ }
    };

    const finish = (error: Error | null, output?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // 释放读端：逃出进程组的孙进程可能仍持有写端，不 destroy 会吊住 event loop。
      try { child.stdout?.destroy(); } catch { /* already closed */ }
      try { child.stderr?.destroy(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve(output ?? '');
    };

    try {
      child = spawn('/bin/sh', ['-c', command], {
        env,
        // POSIX 下让 sh 当新进程组 leader，超时才能连它的后代一起杀。
        detached: process.platform !== 'win32',
        // stdin 直接 ignore：不主动 end 的话，读 stdin 的命令会一直挂到超时。
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    // 在跑的命令不吊住 daemon 正常退出：只 unref child 不够，piped 读端也要解引用。
    child.unref();
    unrefStream(child.stdout);
    unrefStream(child.stderr);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) {
        killGroup();
        finish(new Error('cardFooterExtension output exceeded the size limit'));
      }
    });
    child.stderr?.resume();
    child.on('error', (error) => finish(error));
    // 从 exit 结算（不等 close）：setsid 逃逸者持管时 close 可能永远不来。
    child.on('exit', (code, signal) => {
      if (code === 0) finish(null, stdout);
      else finish(new Error(`cardFooterExtension command exited with ${code ?? signal}`));
    });

    timer = setTimeout(() => {
      killGroup();
      finish(new Error('cardFooterExtension command timed out'));
    }, COMMAND_TIMEOUT_MS);
    timer.unref();
  });

interface CacheEntry {
  command: string;
  segments?: string[];
  okAt?: number;
  attemptAt?: number;
  running?: Promise<void>;
}

const cache = new Map<string, CacheEntry>();

export interface CardFooterExtensionContext {
  larkAppId: string;
  cliId?: string;
  botName?: string;
}

/**
 * 当前可显示的自定义段（只读缓存，不等命令）。到了刷新时间就在后台跑一次命令。
 * 未配置 / 还没成功过 / 已陈旧 ⇒ undefined。
 */
export function getCardFooterExtensionSegments(
  ctx: CardFooterExtensionContext,
  extension: CardFooterExtensionConfig | undefined,
  opts?: { now?: number; runner?: CardFooterExtensionRunner; env?: NodeJS.ProcessEnv },
): string[] | undefined {
  if (!extension) {
    cache.delete(ctx.larkAppId);
    return undefined;
  }
  const now = opts?.now ?? Date.now();
  let entry = cache.get(ctx.larkAppId);
  if (!entry || entry.command !== extension.command) {
    entry = { command: extension.command };
    cache.set(ctx.larkAppId, entry);
  }
  const refreshMs = (extension.refreshSeconds ?? DEFAULT_REFRESH_SECONDS) * 1000;
  if (!entry.running && (entry.attemptAt === undefined || now - entry.attemptAt >= refreshMs)) {
    const target = entry;
    target.attemptAt = now;
    const env: NodeJS.ProcessEnv = {
      ...(opts?.env ?? process.env),
      BOTMUX_LARK_APP_ID: ctx.larkAppId,
      ...(ctx.cliId ? { BOTMUX_CLI_ID: ctx.cliId } : {}),
      ...(ctx.botName ? { BOTMUX_BOT_NAME: ctx.botName } : {}),
    };
    target.running = (opts?.runner ?? runCardFooterExtensionCommand)(extension.command, env)
      .then((stdout) => {
        target.segments = parseCardFooterExtensionOutput(stdout);
        target.okAt = Date.now();
      })
      .catch(() => { /* 沿用上次结果 */ })
      .finally(() => { target.running = undefined; });
  }
  if (entry.okAt === undefined || now - entry.okAt > STALE_MS) return undefined;
  return entry.segments && entry.segments.length > 0 ? [...entry.segments] : undefined;
}

/** 测试用：清空缓存；返回进行中的刷新，便于 await。 */
export function __testOnly_cardFooterExtensionCache(): {
  reset: () => void;
  pending: (larkAppId: string) => Promise<void> | undefined;
} {
  return {
    reset: () => cache.clear(),
    pending: (larkAppId) => cache.get(larkAppId)?.running,
  };
}
