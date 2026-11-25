/**
 * statusline-snapshot.ts — Claude Code / Antigravity statusline 数据的落盘与读取。
 *
 * Claude Code / Antigravity (`agy`) 会把一份 JSON（`context_window`、`rate_limits` /
 * `quota`、`model`、`transcript_path` …）喂给 settings 里配置的 `statusLine.command`
 * （stdin）。botmux 用进程级 `--settings` 把该命令指向 `botmux statusline`，由它把
 * 快照写到 `<DATA_DIR>/statusline/<sessionId>/latest.json`；daemon 在组装卡片用量段时
 * 按 mtime 缓存读回，渲染成 `ctx 23% · 5h 18% · 7d 5%`。
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
  /** fiveHourResetsAtMs 由相对 reset_in_seconds（缺 reset_time）派生时为 true。 */
  fiveHourResetRelative?: boolean;
  sevenDayPercent?: number;
  sevenDayResetsAtMs?: number;
  /** sevenDayResetsAtMs 由相对 reset_in_seconds（缺 reset_time）派生时为 true。 */
  sevenDayResetRelative?: boolean;
  /** model.id，仅存档；卡片的 runtime 段另有来源。 */
  model?: string;
  /** Claude's effort.level: effective runtime effort, after model-specific clamping. */
  reasoningEffort?: ClaudeStatuslineEffort;
  transcriptPath?: string;
  /** Claude 自己的 session_id（≠ botmux sessionId）。 */
  claudeSessionId?: string;
  /** Worker 每次真正拉起 CLI 进程时分配的启动代际令牌（BOTMUX_STATUSLINE_GEN），
   *  用于隔离垂死旧进程的迟到写入与防止新代际被旧代际去重吞掉。 */
  launchGen?: string;
  /** 写入时刻（ms）。 */
  ts: number;
}

export type ClaudeStatuslineEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export function isClaudeStatuslineEffort(value: unknown): value is ClaudeStatuslineEffort {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max';
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
/** Identical statusline frames are written at most this often. Relative reset
 * deadlines get the same expiry grace so a deduped newer frame cannot make the
 * persisted percentage expire before the deadline it just reported. */
export const STATUSLINE_WRITE_DEDUPE_MS = 30_000;

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

/** resets_at / reset_time：支持 Unix 秒（< 1e12）、毫秒、或 ISO 8601 时间字符串。 */
function resetsAtMs(v: unknown): number | undefined {
  const n = finiteNumber(v);
  if (n !== undefined) {
    if (n <= 0) return undefined;
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
  }
  return undefined;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

interface ParsedQuotaWindow {
  usedPercent: number;
  resetsAtMs?: number;
  resetRelative?: boolean;
}

interface AntigravityQuotaEntry {
  key: string;
  usedPercent: number;
  resetsAtMs?: number;
  resetRelative?: boolean;
}

const GEMINI_CODENAME_VARIANTS = ['argon', 'neon', 'hydrogen', 'carbon'] as const;
const GEMINI_TIER_VARIANTS = ['flash', 'pro'] as const;
const EFFORT_SUFFIX_TOKENS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'thinking']);

function hasToken(text: string, token: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${token}(?:$|[^a-z0-9])`).test(text);
}

function hasKeySegment(key: string, token: string): boolean {
  return new RegExp(`(?:^|[-_])${token}(?:$|[-_])`).test(key);
}

function isCanonicalFamilyWindowKey(
  key: string,
  familyPattern: string,
  window: '5h' | 'weekly',
): boolean {
  const winPattern = window === '5h' ? '(?:5h|five[-_]?hour)' : '(?:weekly|7d|seven[-_]?day)';
  return new RegExp(`^(?:${familyPattern})[-_]${winPattern}$`).test(key);
}

function normalizeAntigravityModelKey(raw: string): string {
  const tokens = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  while (tokens.length > 1 && EFFORT_SUFFIX_TOKENS.has(tokens[tokens.length - 1]!)) {
    tokens.pop();
  }
  // `agy models` uses `gemini-pro-orchestrator-neon` / `gemini-pro-orchestrator-g1-pro`
  // while `agy` statusLine reports display names `Orchestrator (Neon)` / `Orchestrator (Argon)`.
  if (tokens[0] === 'gemini' && tokens[1] === 'pro' && tokens[2] === 'orchestrator') {
    tokens.splice(0, 2);
  } else if (tokens[0] === 'gemini' && tokens[1] === 'orchestrator') {
    tokens.splice(0, 1);
  }
  if (tokens.length === 3 && tokens[0] === 'orchestrator' && tokens[1] === 'g1' && tokens[2] === 'pro') {
    return 'orchestrator argon';
  }
  return tokens.join(' ');
}

function claudeModelFamily(raw: string): 'fable' | 'opus' | 'sonnet' | 'haiku' | undefined {
  const cleaned = raw.trim().replace(/\[[^\]]*\]$/, '').trim().toLowerCase();
  if (!cleaned || cleaned === 'default' || cleaned === 'auto' || cleaned === 'opusplan') return undefined;
  const matches = (['fable', 'opus', 'sonnet', 'haiku'] as const).filter(f => hasToken(cleaned, f));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * 校验盘上 statusline 快照里的模型是否与会话当前期望模型兼容：
 * - 任一侧缺失模型信息时放行（由时间戳/启动代际守卫兜底，保持未配模型会话兼容）；
 * - Antigravity：规范化 slug 与 display_name（如 `gemini-4-neon-xhigh` ↔ `Gemini 4 Neon (XHigh)`、
 *   `gemini-pro-orchestrator-g1-pro` ↔ `Orchestrator (Argon)`），跨族（Gemini ↔ 3P）或
 *   跨模型/跨 variant（Neon ↔ Argon / Flash / Hydrogen）均拒绝合并；
 * - Claude Code：两侧均识别出明确的单一 Claude 家族（fable/opus/sonnet/haiku）且不一致时拒绝；
 *   别名（`opus` ↔ `claude-opus-5[1m]`）、meta 别名（`default`/`opusplan`）及自定义代理名均放行。
 */
export function isStatuslineModelCompatible(
  cliId: 'claude-code' | 'antigravity',
  snapshotModel: string | undefined,
  expectedModel: string | undefined,
): boolean {
  const snap = snapshotModel?.trim();
  const expected = expectedModel?.trim();
  if (!snap || !expected) return true;
  if (snap.toLowerCase() === expected.toLowerCase()) return true;
  if (cliId === 'antigravity') {
    const a = normalizeAntigravityModelKey(snap);
    const b = normalizeAntigravityModelKey(expected);
    return a.length > 0 && a === b;
  }
  const snapFamily = claudeModelFamily(snap);
  const expectedFamily = claudeModelFamily(expected);
  if (snapFamily && expectedFamily) return snapFamily === expectedFamily;
  return true;
}

function usedPercentFromRemainingFraction(v: unknown): number | undefined {
  const n = finiteNumber(v);
  if (n === undefined) return undefined;
  const remaining = n < 0 ? 0 : n > 1 ? 1 : n;
  // 四位小数规整，避免 (1 - 0.9) * 100 = 9.999999999999998 这类 IEEE-754 尾差。
  return percent(Math.round((1 - remaining) * 1e6) / 1e4);
}

function isFiveHourBucketKey(key: string): boolean {
  return /(?:^|[-_])(5h|five[-_]?hour)(?:$|[-_])/.test(key);
}

function isWeeklyBucketKey(key: string): boolean {
  return /(?:^|[-_])(weekly|7d|seven[-_]?day)(?:$|[-_])/.test(key);
}

function isGenericWindowKey(key: string, window: '5h' | 'weekly'): boolean {
  return window === '5h'
    ? /^(?:5h|five[-_]?hour)$/.test(key)
    : /^(?:weekly|7d|seven[-_]?day)$/.test(key);
}

function pickMostConstrained(entries: AntigravityQuotaEntry[], now: number): AntigravityQuotaEntry | undefined {
  if (entries.length === 0) return undefined;
  const isActive = (e: AntigravityQuotaEntry) => e.resetsAtMs === undefined || e.resetsAtMs > now;
  return [...entries].sort((a, b) =>
    (Number(isActive(b)) - Number(isActive(a)))
    || (b.usedPercent - a.usedPercent)
    || a.key.localeCompare(b.key),
  )[0];
}

function pickAntigravityBucket(
  entries: AntigravityQuotaEntry[],
  window: '5h' | 'weekly',
  modelHint: string,
  now: number,
): ParsedQuotaWindow | undefined {
  const windowEntries = entries.filter(e =>
    window === '5h' ? isFiveHourBucketKey(e.key) : isWeeklyBucketKey(e.key),
  );
  if (windowEntries.length === 0) return undefined;

  const isClaude = /(?:^|[^a-z0-9])(claude|opus|sonnet|haiku|anthropic)(?:$|[^a-z0-9])/.test(modelHint);
  const isOpenAi = /(?:^|[^a-z0-9])(gpt|openai)(?:$|[^a-z0-9])/.test(modelHint);
  const isThirdParty = isClaude || isOpenAi;
  const isGemini = !isThirdParty && /(?:^|[^a-z0-9])(gemini|orchestrator)(?:$|[^a-z0-9])/.test(modelHint);

  const generic = windowEntries.filter(e => isGenericWindowKey(e.key, window));

  if (isThirdParty) {
    if (isClaude && !isOpenAi) {
      const claudeCanonical = windowEntries.filter(e =>
        isCanonicalFamilyWindowKey(e.key, 'claude|anthropic', window),
      );
      if (claudeCanonical.length > 0) return pickMostConstrained(claudeCanonical, now);
    } else if (isOpenAi && !isClaude) {
      const openAiCanonical = windowEntries.filter(e =>
        isCanonicalFamilyWindowKey(e.key, 'gpt|openai', window),
      );
      if (openAiCanonical.length > 0) return pickMostConstrained(openAiCanonical, now);
    }
    const canonical3p = windowEntries.filter(e => isCanonicalFamilyWindowKey(e.key, '3p', window));
    if (canonical3p.length > 0) return pickMostConstrained(canonical3p, now);
    if (generic.length > 0) return pickMostConstrained(generic, now);
    return undefined;
  }

  if (isGemini) {
    // Specific model codenames take precedence over generic tier tokens (`flash`/`pro`)
    // so e.g. `gemini-pro-orchestrator-g1-pro` + `Orchestrator (Argon)` selects `argon`
    // and never crosses into `gemini-pro-*` or another variant's sub-bucket.
    const matchedCodenames: string[] = GEMINI_CODENAME_VARIANTS.filter(v => hasToken(modelHint, v));
    // `gemini-pro-orchestrator-g1-pro` is `agy`'s slug for `Orchestrator (Argon)`;
    // recognize it even when `display_name` is absent.
    if (matchedCodenames.length === 0 && hasToken(modelHint, 'orchestrator') && /(?:^|[^a-z0-9])g1[-_]?pro(?:$|[^a-z0-9])/.test(modelHint)) {
      matchedCodenames.push('argon');
    }
    const variantsToCheck = matchedCodenames.length > 0
      ? matchedCodenames
      : GEMINI_TIER_VARIANTS.filter(v => hasToken(modelHint, v));
    for (const variant of variantsToCheck) {
      const variantMatches = windowEntries.filter(e =>
        /^gemini(?:[-_]|$)/.test(e.key) && hasKeySegment(e.key, variant),
      );
      if (variantMatches.length > 0) return pickMostConstrained(variantMatches, now);
    }
    const canonicalGemini = windowEntries.filter(e => isCanonicalFamilyWindowKey(e.key, 'gemini', window));
    if (canonicalGemini.length > 0) return pickMostConstrained(canonicalGemini, now);
    if (generic.length > 0) return pickMostConstrained(generic, now);
    // Fail-closed: never fall back across Gemini variants (e.g. Neon → Argon) or unknown sub-buckets.
    return undefined;
  }

  // Empty or unknown model: fail-closed on family-scoped buckets (`3p-*`, `gemini-*`),
  // only accept unscoped generic window buckets (`5h`, `weekly`, `7d`).
  if (generic.length > 0) return pickMostConstrained(generic, now);
  return undefined;
}

/**
 * 解析 Antigravity (`agy`) statusLine 的 `quota` 桶字典：
 *   { "gemini-5h": { remaining_fraction: 0.79, reset_time: "...Z", reset_in_seconds: 9121 }, ... }
 * 按当前活跃模型路由到对应族（Gemini / 3P）及子桶，并换算为与 Claude Code 一致的已用百分比。
 */
function parseAntigravityQuota(
  quotaRaw: unknown,
  modelRaw: unknown,
  now: number,
): { fiveHour?: ParsedQuotaWindow; sevenDay?: ParsedQuotaWindow } {
  if (!quotaRaw || typeof quotaRaw !== 'object' || Array.isArray(quotaRaw)) return {};
  const entries: AntigravityQuotaEntry[] = [];
  for (const [rawKey, value] of Object.entries(quotaRaw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const b = value as Record<string, unknown>;
    if (b.disabled === true) continue;
    const usedPercent = usedPercentFromRemainingFraction(b.remaining_fraction);
    if (usedPercent === undefined) continue;
    let resetMs = resetsAtMs(b.reset_time);
    let resetRelative = false;
    if (resetMs === undefined) {
      const resetInSec = finiteNumber(b.reset_in_seconds);
      if (resetInSec !== undefined) {
        const rawMs = Math.round(now + resetInSec * 1000);
        if (resetInSec <= 0) {
          // 缺 reset_time 且 reset_in_seconds <= 0：落一个 <= now 且 > 0 的过期标记，
          // 防止 100% 耗尽值因缺少 resetsAtMs 而持续可读；极端负溢出兜底为 1。
          if (now >= 1) {
            resetMs = Number.isFinite(rawMs) ? Math.max(1, Math.min(now, rawMs)) : 1;
          }
        } else if (Number.isFinite(rawMs) && rawMs > 0) {
          resetMs = rawMs;
        }
        if (resetMs !== undefined) resetRelative = true;
      }
    }
    entries.push({
      key: rawKey.trim().toLowerCase(),
      usedPercent,
      resetsAtMs: resetMs,
      ...(resetRelative ? { resetRelative: true } : {}),
    });
  }
  if (entries.length === 0) return {};
  const modelObj = modelRaw && typeof modelRaw === 'object' && !Array.isArray(modelRaw)
    ? modelRaw as Record<string, unknown>
    : undefined;
  const modelHint = `${nonEmptyString(modelObj?.id) ?? ''} ${nonEmptyString(modelObj?.display_name) ?? ''}`.toLowerCase();
  return {
    fiveHour: pickAntigravityBucket(entries, '5h', modelHint, now),
    sevenDay: pickAntigravityBucket(entries, 'weekly', modelHint, now),
  };
}

/**
 * 把 Claude / Antigravity 喂进 stdin 的原始 JSON 规范成快照：逐字段容错（缺失 / 非数值的字段
 * 丢弃，不影响其它字段）；整体不是对象 → null。写端与读端共用，口径一致。
 */
export function parseStatuslinePayload(raw: unknown, now: number = Date.now()): StatuslineSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, any>;
  const isAntigravity = o.product === 'antigravity';
  const cw = o.context_window && typeof o.context_window === 'object' ? o.context_window : undefined;
  const rl = o.rate_limits && typeof o.rate_limits === 'object' ? o.rate_limits : undefined;
  const five = rl?.five_hour && typeof rl.five_hour === 'object' ? rl.five_hour : undefined;
  const seven = rl?.seven_day && typeof rl.seven_day === 'object' ? rl.seven_day : undefined;
  const snap: StatuslineSnapshot = { ts: now };
  const set = <K extends keyof StatuslineSnapshot>(k: K, v: StatuslineSnapshot[K] | undefined) => {
    if (v !== undefined) (snap as any)[k] = v;
  };
  const windowTokens = finiteNumber(cw?.context_window_size);
  const validWindowTokens = windowTokens !== undefined && windowTokens > 0 ? Math.round(windowTokens) : undefined;
  // Antigravity 在启动/恢复早期模型窗口未就绪时会报 context_window_size=0, used_percentage=0；
  // 此时跳过占位 0%，让卡片继续沿用 conversation db 的准确上下文百分比。
  if (!isAntigravity || validWindowTokens !== undefined) {
    set('contextPercent', percent(cw?.used_percentage));
  }
  set('contextWindowTokens', validWindowTokens);
  set('fiveHourPercent', percent(five?.used_percentage));
  set('fiveHourResetsAtMs', resetsAtMs(five?.resets_at));
  set('sevenDayPercent', percent(seven?.used_percentage));
  set('sevenDayResetsAtMs', resetsAtMs(seven?.resets_at));
  if (!five && !seven && (isAntigravity || (o.quota && typeof o.quota === 'object' && !Array.isArray(o.quota)))) {
    const agyQuota = parseAntigravityQuota(o.quota, o.model, now);
    if (agyQuota.fiveHour) {
      set('fiveHourPercent', agyQuota.fiveHour.usedPercent);
      set('fiveHourResetsAtMs', agyQuota.fiveHour.resetsAtMs);
      if (agyQuota.fiveHour.resetRelative) set('fiveHourResetRelative', true);
    }
    if (agyQuota.sevenDay) {
      set('sevenDayPercent', agyQuota.sevenDay.usedPercent);
      set('sevenDayResetsAtMs', agyQuota.sevenDay.resetsAtMs);
      if (agyQuota.sevenDay.resetRelative) set('sevenDayResetRelative', true);
    }
  }
  set('model', nonEmptyString(o.model?.id));
  set('reasoningEffort', isClaudeStatuslineEffort(o.effort?.level) ? o.effort.level : undefined);
  set('transcriptPath', nonEmptyString(o.transcript_path));
  if (!isAntigravity) {
    set('claudeSessionId', nonEmptyString(o.session_id));
  }
  return snap;
}

/** CLI 侧写：mkdir -p（0700）+ 原子写（0600）。异常向上抛，由调用方决定是否吞掉。 */
export function writeStatuslineSnapshot(dataDir: string, sessionId: string, snap: StatuslineSnapshot): void {
  mkdirSync(statuslineDir(dataDir, sessionId), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(statuslineFilePath(dataDir, sessionId), JSON.stringify(snap), { mode: 0o600 });
}

interface CacheEntry { ino: bigint; mtimeNs: bigint; size: bigint; snap: StatuslineSnapshot | undefined }
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
  if (o.fiveHourResetRelative === true) snap.fiveHourResetRelative = true;
  if (p(o.sevenDayPercent) !== undefined) snap.sevenDayPercent = p(o.sevenDayPercent);
  if (ms(o.sevenDayResetsAtMs) !== undefined) snap.sevenDayResetsAtMs = ms(o.sevenDayResetsAtMs);
  if (o.sevenDayResetRelative === true) snap.sevenDayResetRelative = true;
  if (nonEmptyString(o.model)) snap.model = o.model as string;
  if (isClaudeStatuslineEffort(o.reasoningEffort)) snap.reasoningEffort = o.reasoningEffort;
  if (nonEmptyString(o.transcriptPath)) snap.transcriptPath = o.transcriptPath as string;
  if (nonEmptyString(o.claudeSessionId)) snap.claudeSessionId = o.claudeSessionId as string;
  if (nonEmptyString(o.launchGen)) snap.launchGen = o.launchGen as string;
  return snap;
}

/**
 * daemon / CLI 侧读：按 (ino, mtimeNs, size) 缓存，文件没变不重新 parse（含 inode 防止
 * 同粗时钟 tick 内原子替换同长文件命中旧缓存）。文件缺失 / 损坏 → undefined；`ts` 早于
 * `now - maxAgeMs` / 早于 `notBefore`、或 `launchGen` 不匹配 → undefined；某桶
 * `resetsAtMs <= max(now, snap.ts)` → 该桶百分比丢弃（防止窗口滚动或时钟微调回拨复活
 * 已过期百分比，但重置时间本身仍保留）。仅相对派生且写入时仍活跃的窗口额外保留一个
 * 去重周期的宽限，避免最新帧被去重跳写后按旧 deadline 提前隐藏；写入时已过期标记不宽限。
 */
export function readStatuslineSnapshot(
  dataDir: string,
  sessionId: string,
  opts?: { now?: number; maxAgeMs?: number; notBefore?: number; launchGen?: string },
): StatuslineSnapshot | undefined {
  const now = opts?.now ?? Date.now();
  const maxAgeMs = opts?.maxAgeMs ?? STATUSLINE_STALE_MS;
  const notBefore = opts?.notBefore;
  const launchGen = opts?.launchGen;
  const path = statuslineFilePath(dataDir, sessionId);
  let st: { ino: bigint; mtimeNs: bigint; size: bigint };
  try { st = statSync(path, { bigint: true }); } catch { cache.delete(path); return undefined; }
  let entry = cache.get(path);
  if (!entry || entry.ino !== st.ino || entry.mtimeNs !== st.mtimeNs || entry.size !== st.size) {
    entry = { ino: st.ino, mtimeNs: st.mtimeNs, size: st.size, snap: readSnapshotFile(path) };
    cache.set(path, entry);
  }
  const snap = entry.snap;
  if (!snap) return undefined;
  if (snap.ts < now - maxAgeMs) return undefined;
  if (notBefore !== undefined && snap.ts < notBefore) return undefined;
  if (launchGen !== undefined && snap.launchGen !== launchGen) return undefined;
  const out: StatuslineSnapshot = { ...snap };
  const effectiveNow = Math.max(now, snap.ts);
  const expired = (reset: number, relative: boolean | undefined): boolean => {
    const grace = relative && reset > snap.ts ? STATUSLINE_WRITE_DEDUPE_MS : 0;
    return reset <= effectiveNow - grace;
  };
  if (out.fiveHourResetsAtMs !== undefined && expired(out.fiveHourResetsAtMs, out.fiveHourResetRelative)) delete out.fiveHourPercent;
  if (out.sevenDayResetsAtMs !== undefined && expired(out.sevenDayResetsAtMs, out.sevenDayResetRelative)) delete out.sevenDayPercent;
  return out;
}

/** 仅清理快照文件但保留目录（沙盒 bwrap 按目录 bind-mount，删目录会换 inode）。
 *  用于模型切换 / CLI 重启等启动代际边界，防止旧快照在新帧到达前残留。任何错误吞掉。 */
export function clearStatuslineSnapshot(dataDir: string, sessionId: string): void {
  const path = statuslineFilePath(dataDir, sessionId);
  cache.delete(path);
  try { rmSync(path, { force: true }); } catch { /* best-effort */ }
}

/** 会话关闭清理（与 prompt-ctx 目录同时机）。任何错误吞掉。 */
export function removeStatuslineDir(dataDir: string, sessionId: string): void {
  const dir = statuslineDir(dataDir, sessionId);
  cache.delete(join(dir, STATUSLINE_FILE_BASENAME));
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** 快照 → 卡片用量段子集。百分比四舍五入到整数（statusline 给的是
 *  `14.000000000000002` 这类浮点）；一个字段都没有时返回 undefined，调用方不带 key。
 *  `includeRateLimits: false` 时仅省略 5h / 7d 周期额度，保留上下文占用与窗口大小。 */
export function toCardQuota(
  snap: StatuslineSnapshot | undefined,
  opts?: { includeRateLimits?: boolean },
): StatuslineQuota | undefined {
  if (!snap) return undefined;
  const includeRateLimits = opts?.includeRateLimits !== false;
  const q: StatuslineQuota = {};
  if (snap.contextPercent !== undefined) q.contextPercent = Math.round(snap.contextPercent);
  if (snap.contextWindowTokens !== undefined) q.contextWindowTokens = snap.contextWindowTokens;
  if (includeRateLimits) {
    if (snap.fiveHourPercent !== undefined) q.fiveHourPercent = Math.round(snap.fiveHourPercent);
    if (snap.fiveHourResetsAtMs !== undefined) q.fiveHourResetsAtMs = snap.fiveHourResetsAtMs;
    if (snap.sevenDayPercent !== undefined) q.sevenDayPercent = Math.round(snap.sevenDayPercent);
    if (snap.sevenDayResetsAtMs !== undefined) q.sevenDayResetsAtMs = snap.sevenDayResetsAtMs;
  }
  return Object.keys(q).length > 0 ? q : undefined;
}

/** 测试用：清空 mtime 缓存。 */
export function __testOnly_resetStatuslineCache(): void {
  cache.clear();
}
