/**
 * artifact-ready 依赖引擎（PR-3a，§9）。
 *
 * afterAgentTurn 五条件判定（daemon 判，不信模型一句话）：
 *   1. terminal succeeded（ExecutionPhase='succeeded' / terminal.status='succeeded'）；
 *   2. OutputDeliveryJournal 结算为 delivered 且有 messageId；
 *   3. 已交付内容含 marker（DEFAULT_ARTIFACT_MARKER，config 可覆盖）；
 *   4. URL 合法 http(s)，hostname 精确（小写）命中该依赖配置的 artifact.hosts；
 *   5. contentHash 写入 satisfiedBy 持久回执。
 *
 * 缺一不启动；terminal succeeded 但无合法 marker / host 不匹配 → awaiting-input 三入口；
 * 默认 30min 无进展 → awaiting-input('KICKOFF_TIMEOUT')。
 */
import { DEFAULT_ARTIFACT_MARKER, type CollabArtifactSpec } from '../services/collab-group-config.js';

export interface CollabArtifactSatisfiedBy {
  receiptId: string;
  kickoffId: string;
  sessionId: string;
  turnId: string;
  messageId: string;
  artifactUrl: string;
  contentHash: string;
}

/** artifact-ready 判定所需的可观测事实（daemon 从 session-contract + output-journal 取）。 */
export interface ArtifactReadyFacts {
  /** 被依赖 kickoff 的 terminal status（succeeded 才满足条件1）。 */
  terminalStatus: 'succeeded' | 'failed' | 'cancelled' | 'reconciling' | 'waiting_input' | 'blocked';
  /** 最终输出是否 delivered 且有 messageId（条件2）。 */
  delivered: boolean;
  messageId?: string;
  /** 已交付的输出内容（条件3/4 从 content 里解析 marker + URL）。 */
  content: string;
}

export type ArtifactReadyResult =
  | { ready: true; satisfiedBy: CollabArtifactSatisfiedBy }
  | { ready: false; reason: 'NOT_SUCCEEDED' | 'NOT_DELIVERED' | 'NO_MARKER' | 'HOST_NOT_ALLOWED' | 'MISSING_URL' };

/** 解析 marker 后的 URL（`BOTMUX_ARTIFACT_READY <url>`）。返回合法 http(s) URL，否则 undefined。 */
export function parseArtifactUrl(content: string, marker: string): string | undefined {
  const idx = content.indexOf(marker);
  if (idx < 0) return undefined;
  const rest = content.slice(idx + marker.length).trim();
  const url = rest.split(/\s+/)[0];
  if (!/^https?:\/\//i.test(url)) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/** hostname 精确（小写）命中 hosts allowlist。 */
export function artifactUrlHostAllowed(url: string, hosts: string[]): boolean {
  try {
    const u = new URL(url);
    return hosts.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * 五条件判定。缺一不 ready；返回明确原因供 awaiting-input 三入口。
 * `contentHash` 由调用方按 artifact 内容哈希计算后传入 satisfiedBy（条件5）。
 */
export function evaluateArtifactReady(opts: {
  facts: ArtifactReadyFacts;
  artifact: CollabArtifactSpec;
  marker?: string;
  receiptId: string;
  kickoffId: string;
  sessionId: string;
  turnId: string;
  contentHash: string;
}): ArtifactReadyResult {
  const { facts, artifact } = opts;
  if (facts.terminalStatus !== 'succeeded') return { ready: false, reason: 'NOT_SUCCEEDED' };
  if (!facts.delivered || !facts.messageId) return { ready: false, reason: 'NOT_DELIVERED' };
  const marker = opts.marker ?? artifact.marker ?? DEFAULT_ARTIFACT_MARKER;
  const url = parseArtifactUrl(facts.content, marker);
  if (!url) return { ready: false, reason: 'NO_MARKER' };
  if (!artifactUrlHostAllowed(url, artifact.hosts)) return { ready: false, reason: 'HOST_NOT_ALLOWED' };
  return {
    ready: true,
    satisfiedBy: {
      receiptId: opts.receiptId,
      kickoffId: opts.kickoffId,
      sessionId: opts.sessionId,
      turnId: opts.turnId,
      messageId: facts.messageId,
      artifactUrl: url,
      contentHash: opts.contentHash,
    },
  };
}

/** KICKOFF_TIMEOUT 默认窗口（30min）。 */
export const KICKOFF_TIMEOUT_MS = 30 * 60 * 1000;

/** 是否超窗（以 kickoffPending 的 since 为准，假时钟可测）。 */
export function kickoffTimedOut(since: number, now: number, windowMs: number = KICKOFF_TIMEOUT_MS): boolean {
  return now - since > windowMs;
}
