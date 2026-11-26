/**
 * prompt-context-store.ts
 *
 * Per-turn sidecar for UserPromptSubmit hook 注入（#794 P1 方向 B）。
 *
 * daemon 在把 user turn 写入 PTY **之前**，把该轮的 envelope（reminder/whiteboard）
 * 写到这里；`botmux user-prompt-hook` 子进程被 Claude Code 唤起时，经 daemon IPC
 * claim/pop 对应 envelope，以 additionalContext 注入为该轮 system-reminder。
 *
 * 为什么 claim/pop 在宿主侧 + turnId 权威绑定（review HIGH-1/HIGH-2 根治）：
 * - HIGH-1（同正文丢轮/串轮）：旧实现用 (fingerprint, nonce) FIFO，某轮 hook 没 claim
 *   时，下一轮的唯一一次 claim 会按 FIFO 拿到**上一轮的旧 envelope**，后续同正文轮
 *   全体错位。现改为 (sessionId, turnId, fingerprint) 权威绑定：每条 sidecar 带
 *   turnId，claim 时按 daemon 的权威 turnId（managedTurnOrigin.turnId）精确取，
 *   漏 claim 只孤儿化自己那条，不污染后续轮。
 * - HIGH-2（沙箱消费 no-op）：`prompt-ctx/<sid>` 在沙箱里是 read-only bind，hook
 *   子进程在沙箱内 unlink 必失败。消费（unlink）改到宿主 daemon 执行，沙箱内只读
 *   不写；也绝不把目录改可写（那会给沙箱里的模型伪造 sidecar 的能力）。
 * - paste 污染：全量 hash 失配时，前缀兜底**按 turnId 定域**扫描——每轮至多一条
 *   sidecar，不存在"多条同前缀碰撞"，0 或 1 条，确定。
 * - inline 检测：有权威 turnId 后不再需要脆弱的文本形状启发式。daemon 只返回
 *   当前 turnId 的 envelope，上一轮的 stale sidecar 永远不会被返回，天然无双注入。
 *
 * 为什么用文件而不是纯内存：daemon 重启后未消费的 sidecar 不丢（24h TTL 兜底）。
 * claim 走 daemon IPC，任何读失败/未命中 → undefined（调用方空输出，fail-open）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { CLAUDE_STRIPPED_INVISIBLE_RE, normaliseForFingerprint } from './claude-transcript.js';

/** sidecar 保留上限：超出按 mtime 淘汰最旧的。 */
const SIDECAR_MAX_FILES = 100;
/** sidecar 最长保留 24h（resume 后旧轮的 hook 不会重放，只有新轮才触发）。 */
const SIDECAR_TTL_MS = 24 * 60 * 60 * 1000;
/** 前缀兜底匹配长度：与 makeSubmitFingerprint 一致，足以覆盖 paste 污染前的完好区。 */
const PREFIX_FALLBACK_LEN = 30;

function normalisePromptKeyText(text: string): string {
  return normaliseForFingerprint(text.replace(CLAUDE_STRIPPED_INVISIBLE_RE, ''));
}

function sessionDir(sessionId: string, dataDir = config.session.dataDir): string {
  return join(dataDir, 'prompt-ctx', sessionId);
}

/** 全量指纹：去除 Claude PTY 会剥离的不可见字符并 normalise 后 sha256（hex）。主键，无前缀碰撞。 */
export function fingerprintPromptText(text: string): string {
  return createHash('sha256').update(normalisePromptKeyText(text), 'utf8').digest('hex');
}

/** 前缀指纹：与全量指纹同口径归一化后取前 N 字符。仅用于 paste 污染时的兜底匹配。 */
export function prefixOf(text: string): string {
  return normalisePromptKeyText(text).slice(0, PREFIX_FALLBACK_LEN);
}

/** turnId 文件名键：全量 sha256(turnId) hex。
 * 不用 lossy sanitize（非字母数字转 _）：两个近似 turnId（如 `turn/a` 与 `turn?a`）
 * 会撞同一文件名，后写覆盖前写，exact pop 又不回校验 payload → 跨轮串投。
 * 全量 hash 使碰撞密码学不可行；payload 另存 raw turnId 供回校验（defense-in-depth）。 */
function turnIdKey(turnId: string): string {
  return createHash('sha256').update(turnId, 'utf8').digest('hex');
}

/**
 * daemon 侧：写 per-turn sidecar。best-effort——写失败只意味着该轮 hook no-op
 * （reminder 丢失），不允许影响消息主路径。原子写（tmp + rename）。
 *
 * 文件名带 turnId：(fingerprint, turnId) 唯一确定一条，claim 按权威 turnId 精确取。
 */
export function writePromptContext(sessionId: string, turnId: string, ptyText: string, envelope: string): void {
  try {
    const dir = sessionDir(sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const key = turnIdKey(turnId);
    const suffix = `.${key}.json`;
    const file = join(dir, `${fingerprintPromptText(ptyText)}${suffix}`);
    const payload = JSON.stringify({
      version: 3,
      envelope,
      prefix: prefixOf(ptyText),
      fingerprint: fingerprintPromptText(ptyText),
      turnId,
      createdAt: Date.now(),
    }) + '\n';
    atomicWriteFileSync(file, payload, { mode: 0o600, followTargetSymlink: false });
    // Maintain the single-sidecar-per-turn invariant: remove any earlier file
    // for the same turnId (e.g. rebuild/retry with different text) after the
    // new sidecar has landed atomically.
    for (const existing of readdirSync(dir)) {
      if (!existing.endsWith(suffix)) continue;
      const existingFull = join(dir, existing);
      if (existingFull === file) continue;
      try { unlinkSync(existingFull); } catch { /* best-effort */ }
    }
    pruneSidecars(dir, file);
  } catch { /* best-effort */ }
}

/**
 * daemon 侧：投递前正文被改写（共享背景在真正出队时按已覆盖来源做了减法）后，
 * 把该轮 sidecar 重新按最终 PTY 文本定键，否则 hook 按新文本的 hash/prefix
 * claim 为空，reminder/sender 随之丢失。精确命中旧指纹就改它；没有旧指纹时按
 * turnId 定域找到该轮唯一一条也改它。best-effort，不影响主路径。
 */
export function rekeyPromptContext(
  sessionId: string,
  turnId: string,
  previousPtyText: string,
  nextPtyText: string,
  dataDir?: string,
): boolean {
  try {
    if (previousPtyText === nextPtyText) return false;
    const dir = sessionDir(sessionId, dataDir);
    if (!existsSync(dir)) return false;
    const key = turnIdKey(turnId);
    const exact = join(dir, `${fingerprintPromptText(previousPtyText)}.${key}.json`);
    const candidates = existsSync(exact) ? [exact]
      : readdirSync(dir).filter((f) => f.endsWith(`.${key}.json`)).map((f) => join(dir, f));
    if (candidates.length !== 1) return false;
    const parsed = JSON.parse(readFileSync(candidates[0], 'utf8'));
    if (typeof parsed?.envelope !== 'string' || parsed.turnId !== turnId) return false;
    const next = join(dir, `${fingerprintPromptText(nextPtyText)}.${key}.json`);
    atomicWriteFileSync(next, JSON.stringify({
      ...parsed,
      prefix: prefixOf(nextPtyText),
      fingerprint: fingerprintPromptText(nextPtyText),
    }) + '\n', { mode: 0o600, followTargetSymlink: false });
    if (candidates[0] !== next) unlinkSync(candidates[0]);
    return true;
  } catch {
    return false;
  }
}

/** 单轮领取保留给普通调用方；多轮 type-ahead 必须使用候选集 API。 */
export function claimPromptContext(
  sessionId: string,
  turnId: string,
  fingerprint: string,
  prefix?: string,
): string | undefined {
  return claimPromptContextAmongTurns(sessionId, [turnId], fingerprint, prefix)?.envelope;
}

export interface ClaimedPromptContext {
  turnId: string;
  envelope: string;
}

/**
 * 在「当前轮 + 全部排队轮」候选集里原子领取唯一匹配：
 * 1. 全部 turnId 的精确 `<fingerprint>.<turnId>.json` 合计只能命中一条。
 * 2. 精确为 0 时才做前缀兜底，全部候选文件合计也只能命中一条。
 * 3. 任何歧义都 fail-open，且不消费任何 sidecar。扫描阶段绝不 pop，避免
 *    前序漏 claim 的旧轮被后续同正文 hook 错领（HIGH-1）。
 *
 * 匹配成功仍由 popSidecar 先 unlink 再返回；未命中/损坏/不可读均不抛错。
 */
export function claimPromptContextAmongTurns(
  sessionId: string,
  turnIds: readonly string[],
  fingerprint: string,
  prefix?: string,
): ClaimedPromptContext | undefined {
  try {
    const candidates = [...new Set(turnIds.filter(turnId => typeof turnId === 'string' && turnId.length > 0))];
    if (candidates.length === 0) return undefined;
    const dir = sessionDir(sessionId);
    if (!existsSync(dir)) return undefined;

    const exactMatches: Array<{ full: string; turnId: string; envelope: string }> = [];
    for (const turnId of candidates) {
      const full = join(dir, `${fingerprint}.${turnIdKey(turnId)}.json`);
      if (!existsSync(full)) continue;
      try {
        const parsed = JSON.parse(readFileSync(full, 'utf8'));
        if (typeof parsed?.envelope === 'string'
          && parsed.turnId === turnId
          && parsed.fingerprint === fingerprint) {
          exactMatches.push({ full, turnId, envelope: parsed.envelope });
        }
      } catch { /* 损坏/不符 → 与旧实现一样落到前缀兜底或 miss */ }
    }
    if (exactMatches.length > 1) return undefined;
    if (exactMatches.length === 1) {
      const match = exactMatches[0]!;
      const envelope = popSidecar(match.full, match.envelope);
      return envelope === undefined ? undefined : { turnId: match.turnId, envelope };
    }
    if (!prefix) return undefined;

    const candidateSet = new Set(candidates);
    const matches = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const full = join(dir, f);
        try {
          const parsed = JSON.parse(readFileSync(full, 'utf8'));
          return typeof parsed?.envelope === 'string'
            && typeof parsed?.turnId === 'string'
            && candidateSet.has(parsed.turnId)
            && typeof parsed?.prefix === 'string'
            && parsed.prefix === prefix
            ? { full, turnId: parsed.turnId, envelope: parsed.envelope as string }
            : undefined;
        } catch { return undefined; }
      })
      .filter((m): m is { full: string; turnId: string; envelope: string } => !!m);
    if (matches.length !== 1) return undefined;
    const match = matches[0]!;
    const envelope = popSidecar(match.full, match.envelope);
    return envelope === undefined ? undefined : { turnId: match.turnId, envelope };
  } catch {
    return undefined;
  }
}

/** 原子消费：先 unlink（宿主侧，沙箱外）再返回 envelope。unlink 失败则不返回
 * （避免同一 envelope 被多次 claim）。 */
function popSidecar(file: string, envelope?: string): string | undefined {
  try {
    const parsed = envelope ?? JSON.parse(readFileSync(file, 'utf8'))?.envelope;
    if (typeof parsed !== 'string') return undefined;
    unlinkSync(file);
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * 淘汰过期/超量 sidecar。best-effort，任何异常静默。
 * currentFile 显式保护：刚写的文件即使 mtime 相同也不淘汰（review 阻断 3）。
 * 同 mtime 按文件名稳定排序，消除淘汰不确定性。
 */
function pruneSidecars(dir: string, currentFile: string): void {
  try {
    const now = Date.now();
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const full = join(dir, f);
        return { f, full, mtime: statSync(full).mtimeMs };
      })
      .sort((a, b) => {
        // 新的在前；同 mtime 按文件名升序（确定性）
        if (b.mtime !== a.mtime) return b.mtime - a.mtime;
        return a.f < b.f ? -1 : a.f > b.f ? 1 : 0;
      });
    let kept = 0;
    for (const entry of files) {
      const isCurrent = entry.full === currentFile;
      const expired = now - entry.mtime > SIDECAR_TTL_MS;
      const overLimit = kept >= SIDECAR_MAX_FILES;
      if (!isCurrent && (expired || overLimit)) {
        try { unlinkSync(entry.full); } catch { /* */ }
      } else {
        kept++;
      }
    }
  } catch { /* best-effort */ }
}

/** 删除一个已失效 queued turn 的全部 sidecar；不影响其它轮次。 */
export function removePromptContextForTurn(sessionId: string, turnId: string): void {
  try {
    const dir = sessionDir(sessionId);
    if (!existsSync(dir)) return;
    const suffix = `.${turnIdKey(turnId)}.json`;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(suffix)) continue;
      try { unlinkSync(join(dir, file)); } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
}

/**
 * 会话关闭时删除整个 sidecar 目录（与 turn-sends marker 同生命周期）。
 * best-effort：目录不存在/权限问题都静默，避免影响关闭主路径。
 */
export function removePromptContextDir(sessionId: string): void {
  try {
    rmSync(sessionDir(sessionId), { recursive: true, force: true });
  } catch { /* best-effort */ }
}
