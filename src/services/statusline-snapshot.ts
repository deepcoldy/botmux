/**
 * statusline-snapshot.ts — Claude Code statusline 数据的落盘与读取。
 *
 * Claude Code 会把一份 JSON（`context_window`、`rate_limits`、`model`、
 * `transcript_path` …）喂给 settings 里配置的 `statusLine.command`（stdin），
 * 触发时机：每条 assistant 消息后、/compact 后、到达 `resets_at` 时、以及可选的
 * `refreshInterval` 定时。botmux 用进程级 `--settings` 把该命令指向
 * `botmux statusline`，由它把快照写到 `<DATA_DIR>/statusline/<sessionId>/latest.json`；
 * daemon 在组装卡片用量段时按 mtime 缓存读回，渲染成 `ctx 23% · 5h 18% · 7d 5%`。
 *
 * 为什么是每会话一个目录而不是单文件：沙盒（bwrap / Seatbelt）对单文件只授
 * readWrite，父目录不可写，原子写的 tmp+rename 必败；目录粒度既保原子写又隔离会话。
 *
 * 为什么不塞进 SessionUsageSnapshot：5h/7d 是账号级配额，不是 session transcript
 * 的解析结果，职责边界不同；在卡片组装点合并即可。
 *
 * 本模块保持叶子：只依赖 node:fs 与 atomic-write，daemon 与 CLI 子进程都能用；
 * dataDir 由调用方传入（daemon 用 config.session.dataDir，CLI 用 resolveDataDir()）。
 */
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface StatuslineSnapshot {
  /** context_window.used_percentage，0–100。 */
  contextPercent?: number;
  /** context_window.context_window_size（token）。 */
  contextWindowTokens?: number;
  /** rate_limits.five_hour.used_percentage，0–100。 */
  fiveHourPercent?: number;
  /** rate_limits.five_hour.resets_at，已换算为毫秒。 */
  fiveHourResetsAtMs?: number;
  sevenDayPercent?: number;
  sevenDayResetsAtMs?: number;
  /** model.id，仅存档；卡片的 runtime 段另有来源。 */
  model?: string;
  transcriptPath?: string;
  /** Claude 自己的 session_id（≠ botmux sessionId）。 */
  claudeSessionId?: string;
  /** 写入时刻（ms）。 */
  ts: number;
}

/** 卡片用量段需要的子集（md-card 的 `CardUsageSnapshot.quota` 复用此类型）。 */
export interface StatuslineQuota {
  contextPercent?: number;
  contextWindowTokens?: number;
  fiveHourPercent?: number;
  fiveHourResetsAtMs?: number;
  sevenDayPercent?: number;
  sevenDayResetsAtMs?: number;
}

export const STATUSLINE_DIR_NAME = 'statusline';
export const STATUSLINE_FILE_BASENAME = 'latest.json';
/** 快照最长可信时长：Claude 退出 / --settings 被 wrapper 剥掉 / 旧版不认
 *  refreshInterval 时，陈旧值最多存活这么久就自动消失（卡片回到「无数据即省略」）。 */
export const STATUSLINE_STALE_MS = 10 * 60_000;

export function statuslineDir(dataDir: string, sessionId: string): string {
  return join(dataDir, STATUSLINE_DIR_NAME, sessionId);
}

export function statuslineFilePath(dataDir: string, sessionId: string): string {
  return join(statuslineDir(dataDir, sessionId), STATUSLINE_FILE_BASENAME);
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function percent(v: unknown): number | undefined {
  const n = finiteNumber(v);
  if (n === undefined) return undefined;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/** resets_at：文档为 Unix 秒；启发式兼容毫秒（< 1e12 视为秒）。 */
function resetsAtMs(v: unknown): number | undefined {
  const n = finiteNumber(v);
  if (n === undefined || n <= 0) return undefined;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * 把 Claude 喂进 stdin 的原始 JSON 规范成快照：逐字段容错（缺失 / 非数值的字段
 * 丢弃，不影响其它字段）；整体不是对象 → null。写端与读端共用，口径一致。
 */
export function parseStatuslinePayload(raw: unknown, now: number = Date.now()): StatuslineSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, any>;
  const cw = o.context_window && typeof o.context_window === 'object' ? o.context_window : undefined;
  const rl = o.rate_limits && typeof o.rate_limits === 'object' ? o.rate_limits : undefined;
  const five = rl?.five_hour && typeof rl.five_hour === 'object' ? rl.five_hour : undefined;
  const seven = rl?.seven_day && typeof rl.seven_day === 'object' ? rl.seven_day : undefined;
  const snap: StatuslineSnapshot = { ts: now };
  const set = <K extends keyof StatuslineSnapshot>(k: K, v: StatuslineSnapshot[K] | undefined) => {
    if (v !== undefined) (snap as any)[k] = v;
  };
  set('contextPercent', percent(cw?.used_percentage));
  const windowTokens = finiteNumber(cw?.context_window_size);
  set('contextWindowTokens', windowTokens !== undefined && windowTokens > 0 ? Math.round(windowTokens) : undefined);
  set('fiveHourPercent', percent(five?.used_percentage));
  set('fiveHourResetsAtMs', resetsAtMs(five?.resets_at));
  set('sevenDayPercent', percent(seven?.used_percentage));
  set('sevenDayResetsAtMs', resetsAtMs(seven?.resets_at));
  set('model', nonEmptyString(o.model?.id));
  set('transcriptPath', nonEmptyString(o.transcript_path));
  set('claudeSessionId', nonEmptyString(o.session_id));
  return snap;
}

/** CLI 侧写：mkdir -p（0700）+ 原子写（0600）。异常向上抛，由调用方决定是否吞掉。 */
export function writeStatuslineSnapshot(dataDir: string, sessionId: string, snap: StatuslineSnapshot): void {
  mkdirSync(statuslineDir(dataDir, sessionId), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(statuslineFilePath(dataDir, sessionId), JSON.stringify(snap), { mode: 0o600 });
}

interface CacheEntry { mtimeMs: number; size: number; snap: StatuslineSnapshot | undefined }
const cache = new Map<string, CacheEntry>();

function readSnapshotFile(path: string): StatuslineSnapshot | undefined {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf-8')); } catch { return undefined; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const ts = finiteNumber(o.ts);
  if (ts === undefined) return undefined;
  const snap: StatuslineSnapshot = { ts };
  const p = (v: unknown) => percent(v);
  const ms = (v: unknown) => { const n = finiteNumber(v); return n !== undefined && n > 0 ? n : undefined; };
  if (p(o.contextPercent) !== undefined) snap.contextPercent = p(o.contextPercent);
  const wt = finiteNumber(o.contextWindowTokens);
  if (wt !== undefined && wt > 0) snap.contextWindowTokens = wt;
  if (p(o.fiveHourPercent) !== undefined) snap.fiveHourPercent = p(o.fiveHourPercent);
  if (ms(o.fiveHourResetsAtMs) !== undefined) snap.fiveHourResetsAtMs = ms(o.fiveHourResetsAtMs);
  if (p(o.sevenDayPercent) !== undefined) snap.sevenDayPercent = p(o.sevenDayPercent);
  if (ms(o.sevenDayResetsAtMs) !== undefined) snap.sevenDayResetsAtMs = ms(o.sevenDayResetsAtMs);
  if (nonEmptyString(o.model)) snap.model = o.model as string;
  if (nonEmptyString(o.transcriptPath)) snap.transcriptPath = o.transcriptPath as string;
  if (nonEmptyString(o.claudeSessionId)) snap.claudeSessionId = o.claudeSessionId as string;
  return snap;
}

/**
 * daemon / CLI 侧读：按 (mtimeMs, size) 缓存，文件没变不重新 parse（一次 stat 比一次
 * parse 便宜得多，12s tick 可承受）。文件缺失 / 损坏 → undefined；`ts` 早于
 * `now - maxAgeMs` → undefined；某桶 `resetsAtMs <= now` → 该桶百分比丢弃
 * （窗口已滚动，旧百分比必错，但重置时间本身仍可能有用所以保留）。
 */
export function readStatuslineSnapshot(
  dataDir: string,
  sessionId: string,
  opts?: { now?: number; maxAgeMs?: number },
): StatuslineSnapshot | undefined {
  const now = opts?.now ?? Date.now();
  const maxAgeMs = opts?.maxAgeMs ?? STATUSLINE_STALE_MS;
  const path = statuslineFilePath(dataDir, sessionId);
  let st: { mtimeMs: number; size: number };
  try { st = statSync(path); } catch { cache.delete(path); return undefined; }
  let entry = cache.get(path);
  if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
    entry = { mtimeMs: st.mtimeMs, size: st.size, snap: readSnapshotFile(path) };
    cache.set(path, entry);
  }
  const snap = entry.snap;
  if (!snap) return undefined;
  if (snap.ts < now - maxAgeMs) return undefined;
  const out: StatuslineSnapshot = { ...snap };
  if (out.fiveHourResetsAtMs !== undefined && out.fiveHourResetsAtMs <= now) delete out.fiveHourPercent;
  if (out.sevenDayResetsAtMs !== undefined && out.sevenDayResetsAtMs <= now) delete out.sevenDayPercent;
  return out;
}

/** 会话关闭清理（与 prompt-ctx 目录同时机）。任何错误吞掉。 */
export function removeStatuslineDir(dataDir: string, sessionId: string): void {
  const dir = statuslineDir(dataDir, sessionId);
  cache.delete(join(dir, STATUSLINE_FILE_BASENAME));
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** 快照 → 卡片用量段子集。百分比四舍五入到整数（statusline 给的是
 *  `14.000000000000002` 这类浮点）；一个字段都没有时返回 undefined，调用方不带 key。 */
export function toCardQuota(snap: StatuslineSnapshot | undefined): StatuslineQuota | undefined {
  if (!snap) return undefined;
  const q: StatuslineQuota = {};
  if (snap.contextPercent !== undefined) q.contextPercent = Math.round(snap.contextPercent);
  if (snap.contextWindowTokens !== undefined) q.contextWindowTokens = snap.contextWindowTokens;
  if (snap.fiveHourPercent !== undefined) q.fiveHourPercent = Math.round(snap.fiveHourPercent);
  if (snap.fiveHourResetsAtMs !== undefined) q.fiveHourResetsAtMs = snap.fiveHourResetsAtMs;
  if (snap.sevenDayPercent !== undefined) q.sevenDayPercent = Math.round(snap.sevenDayPercent);
  if (snap.sevenDayResetsAtMs !== undefined) q.sevenDayResetsAtMs = snap.sevenDayResetsAtMs;
  return Object.keys(q).length > 0 ? q : undefined;
}

/** 测试用：清空 mtime 缓存。 */
export function __testOnly_resetStatuslineCache(): void {
  cache.clear();
}
