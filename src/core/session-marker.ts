import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readManagedOriginCapability } from './managed-origin-capability.js';
import { isValidMarkerIdentityTurnId } from './turn-id-shape.js';
import {
  readProcessStartIdentity,
} from '../utils/process-identity.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { procStatFieldsAfterComm } from '../utils/proc-stat.js';
import type { TrustedCaller } from '../types.js';
import type { LinkRefMode } from '../services/link-ref-types.js';

export {
  readLinuxBootIdentity,
  readProcessStartIdentity,
} from '../utils/process-identity.js';

export interface AntigravityReconcileHint {
  textSha256: string;
  sampledTranscriptPath?: string;
  minByteOffset?: number;
  skipPriorMatches?: number;
}

export interface QueuedTypeAheadTurn {
  turnId: string;
  /** The CLI consumed this input; queue admission alone is insufficient. */
  inputConsumed?: true;
  /** Structural proof (Claude mid-turn `attachment(queued_command)`) that this
   *  input folded into `(absorbedIntoTurnId, absorbedIntoDispatchAttempt)`
   *  rather than starting an independent turn. Valid only with `inputConsumed: true`. */
  absorbedIntoTurnId?: string;
  absorbedIntoDispatchAttempt?: number;
  dispatchAttempt?: number;
  linkRefMode?: Exclude<LinkRefMode, 'disabled'>;
  trustedCaller?: TrustedCaller;
  trustedController?: TrustedCaller;
  antigravityReconcileHint?: AntigravityReconcileHint;
}

export interface SettledAbsorbedTurn {
  turnId: string;
  dispatchAttempt?: number;
  hostTurnId: string;
  hostDispatchAttempt?: number;
}

export interface AncestorSessionContext {
  sessionId: string;
  turnId?: string;
  dispatchAttempt?: number;
  linkRefMode?: Exclude<LinkRefMode, 'disabled'>;
  trustedCaller?: TrustedCaller;
  trustedController?: TrustedCaller;
  queuedTurnId?: string;
  queuedTurns?: QueuedTypeAheadTurn[];
  settledAbsorbedTurns?: SettledAbsorbedTurn[];
  steerPromotedTurn?: boolean;
  /** Set only when an absorbed-but-not-settled follow-up was promoted. This
   *  preserves exact replay identity for its previous host, never for ordinary
   *  unconsumed successor turns. */
  promotedAbsorbedTurn?: true;
  promotedFromTurnId?: string;
  promotedFromDispatchAttempt?: number;
  antigravityReconcileHint?: AntigravityReconcileHint;
}

interface IdentityBoundSessionMarker extends AncestorSessionContext {
  procStart?: string;
  capability?: string;
}

export interface AncestorSessionMarkerContext extends AncestorSessionContext {
  markerPid?: number;
}

export interface AuthenticatedAncestorSessionContext extends AncestorSessionContext {
  capability?: string;
  markerPid: number;
  procStart: string;
}

export class SessionMarkerAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionMarkerAuthenticationError';
  }
}

function systemPsBin(): string | undefined {
  for (const candidate of ['/usr/bin/ps', '/bin/ps']) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function readParentPid(pid: number): number | undefined {
  if (process.platform === 'linux') {
    try {
      const fields = procStatFieldsAfterComm(readFileSync(`/proc/${pid}/stat`, 'utf8'));
      if (!fields) return undefined;
      const parent = Number(fields[1]);
      return Number.isSafeInteger(parent) && parent > 0 ? parent : undefined;
    } catch { return undefined; }
  }
  const ps = systemPsBin();
  if (!ps) return undefined;
  try {
    const out = execFileSync(ps, ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    }).trim();
    const parent = Number(out);
    return Number.isSafeInteger(parent) && parent > 0 ? parent : undefined;
  } catch { return undefined; }
}

function parseDispatchAttempt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

/** Validate mid-turn absorption metadata on one queued type-ahead entry.
 *  Fail-closed: requires a valid `turnId`, `inputConsumed === true`, a valid
 *  distinct host turn id, valid (or absent/null) `dispatchAttempt`, and an
 *  atomic `absorbedIntoDispatchAttempt` when present. */
export function parseAbsorbedHostBinding(
  raw: Record<string, unknown> | null | undefined,
  turnId: string,
): { absorbedIntoTurnId: string; absorbedIntoDispatchAttempt?: number } | undefined {
  if (!raw || raw.inputConsumed !== true) return undefined;
  if (!isValidMarkerIdentityTurnId(turnId)) return undefined;
  if (!isValidMarkerIdentityTurnId(raw.absorbedIntoTurnId)) return undefined;
  if (raw.absorbedIntoTurnId === turnId) return undefined;
  if ('dispatchAttempt' in raw && raw.dispatchAttempt !== undefined && raw.dispatchAttempt !== null
    && parseDispatchAttempt(raw.dispatchAttempt) === undefined) {
    return undefined;
  }
  const hasAttemptField = 'absorbedIntoDispatchAttempt' in raw && raw.absorbedIntoDispatchAttempt !== undefined;
  const hostAttempt = parseDispatchAttempt(raw.absorbedIntoDispatchAttempt);
  if (hasAttemptField && hostAttempt === undefined) return undefined;
  return {
    absorbedIntoTurnId: raw.absorbedIntoTurnId,
    ...(hostAttempt !== undefined ? { absorbedIntoDispatchAttempt: hostAttempt } : {}),
  };
}

/** Parse and deduplicate settled absorbed turn records persisted on the PID marker. */
export function parseSettledAbsorbedTurns(value: unknown): SettledAbsorbedTurn[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const deduped = new Map<string, SettledAbsorbedTurn>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (!isValidMarkerIdentityTurnId(rec.turnId) || !isValidMarkerIdentityTurnId(rec.hostTurnId)) continue;
    if (rec.turnId === rec.hostTurnId) continue;
    const hasAttempt = 'dispatchAttempt' in rec && rec.dispatchAttempt !== undefined;
    const attempt = parseDispatchAttempt(rec.dispatchAttempt);
    if (hasAttempt && attempt === undefined) continue;
    const hasHostAttempt = 'hostDispatchAttempt' in rec && rec.hostDispatchAttempt !== undefined;
    const hostAttempt = parseDispatchAttempt(rec.hostDispatchAttempt);
    if (hasHostAttempt && hostAttempt === undefined) continue;
    const key = `${rec.turnId}\0${attempt ?? ''}`;
    deduped.delete(key);
    deduped.set(key, {
      turnId: rec.turnId,
      ...(attempt !== undefined ? { dispatchAttempt: attempt } : {}),
      hostTurnId: rec.hostTurnId,
      ...(hostAttempt !== undefined ? { hostDispatchAttempt: hostAttempt } : {}),
    });
  }
  if (deduped.size === 0) return undefined;
  // These are live tombstones, not merely historical diagnostics. Truncating
  // them before the worker has pruned its in-memory queue requeues the omitted
  // turns. Terminal cleanup, rather than a size cap, bounds their lifetime;
  // the settled set never exceeds the absorbed queue it replaces.
  return [...deduped.values()];
}

function mergeSettledAbsorbedTurns(
  existing: readonly SettledAbsorbedTurn[] | undefined,
  added: readonly SettledAbsorbedTurn[],
): SettledAbsorbedTurn[] | undefined {
  if ((!existing || existing.length === 0) && added.length === 0) return undefined;
  return parseSettledAbsorbedTurns([...(existing ?? []), ...added]);
}

function parseAntigravityReconcileHint(value: unknown): AntigravityReconcileHint | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const hint = value as Record<string, unknown>;
  if (typeof hint.textSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(hint.textSha256)) return undefined;
  const sampledTranscriptPath = typeof hint.sampledTranscriptPath === 'string'
    && hint.sampledTranscriptPath.length > 0 && hint.sampledTranscriptPath.length <= 4096
    ? hint.sampledTranscriptPath : undefined;
  const minByteOffset = typeof hint.minByteOffset === 'number'
    && Number.isSafeInteger(hint.minByteOffset) && hint.minByteOffset >= 0
    ? hint.minByteOffset : undefined;
  const skipPriorMatches = typeof hint.skipPriorMatches === 'number'
    && Number.isSafeInteger(hint.skipPriorMatches) && hint.skipPriorMatches >= 0
    ? hint.skipPriorMatches : undefined;
  // Optional fields are atomic with the hash: dropping an invalid offset but
  // retaining the hash would re-open matching from byte zero and could assign
  // an older identical USER_INPUT to a different scheduled turn.
  if ('sampledTranscriptPath' in hint && sampledTranscriptPath === undefined) return undefined;
  if ('minByteOffset' in hint && minByteOffset === undefined) return undefined;
  if ('skipPriorMatches' in hint && skipPriorMatches === undefined) return undefined;
  return {
    textSha256: hint.textSha256,
    ...(sampledTranscriptPath ? { sampledTranscriptPath } : {}),
    ...(minByteOffset !== undefined ? { minByteOffset } : {}),
    ...(skipPriorMatches !== undefined && skipPriorMatches > 0 ? { skipPriorMatches } : {}),
  };
}

function parseIdentityBoundSessionMarker(raw: string): IdentityBoundSessionMarker {
  const text = raw.trim();
  if (!text.startsWith('{')) return { sessionId: text };
  try {
    const parsed = JSON.parse(text) as {
      sessionId?: unknown;
      turnId?: unknown;
      dispatchAttempt?: unknown;
      linkRefMode?: unknown;
      trustedCaller?: unknown;
      trustedController?: unknown;
      procStart?: unknown;
      queuedTurnId?: unknown;
      queuedTurns?: unknown;
      settledAbsorbedTurns?: unknown;
      steerPromotedTurn?: unknown;
      promotedAbsorbedTurn?: unknown;
      promotedFromTurnId?: unknown;
      promotedFromDispatchAttempt?: unknown;
      capability?: unknown;
      antigravityReconcileHint?: unknown;
    };
    const dispatchAttempt = parseDispatchAttempt(parsed.dispatchAttempt);
    const linkRefMode = parsed.linkRefMode === 'observe' || parsed.linkRefMode === 'enabled'
      ? parsed.linkRefMode
      : undefined;
    const queuedTurns = Array.isArray(parsed.queuedTurns)
      ? parsed.queuedTurns
          .filter((t: any) => typeof t?.turnId === 'string' && t.turnId)
          .map((t: any) => {
            const turnId = String(t.turnId);
            const attempt = parseDispatchAttempt(t.dispatchAttempt);
            const reconcileHint = parseAntigravityReconcileHint(t.antigravityReconcileHint);
            const absorbed = parseAbsorbedHostBinding(t, turnId);
            return {
              turnId,
              ...(t.inputConsumed === true ? { inputConsumed: true as const } : {}),
              ...(absorbed ?? {}),
              ...(attempt !== undefined ? { dispatchAttempt: attempt } : {}),
              ...(t.linkRefMode === 'observe' || t.linkRefMode === 'enabled'
                ? { linkRefMode: t.linkRefMode }
                : {}),
              ...(t.trustedCaller && typeof t.trustedCaller === 'object' ? { trustedCaller: t.trustedCaller } : {}),
              ...(t.trustedController && typeof t.trustedController === 'object' ? { trustedController: t.trustedController } : {}),
              ...(reconcileHint ? { antigravityReconcileHint: reconcileHint } : {}),
            };
          })
      : undefined;
    const settledAbsorbedTurns = parseSettledAbsorbedTurns(parsed.settledAbsorbedTurns);
    const queuedTurnId = typeof parsed.queuedTurnId === 'string' && parsed.queuedTurnId
      ? parsed.queuedTurnId
      : (queuedTurns && queuedTurns.length > 0 ? queuedTurns[0].turnId : undefined);
    const reconcileHint = parseAntigravityReconcileHint(parsed.antigravityReconcileHint);
    const promotedFromTurnId = typeof parsed.promotedFromTurnId === 'string'
      && isValidMarkerIdentityTurnId(parsed.promotedFromTurnId)
      ? parsed.promotedFromTurnId
      : undefined;
    const promotedFromDispatchAttempt = parseDispatchAttempt(parsed.promotedFromDispatchAttempt);
    const promotedAbsorbed = parsed.promotedAbsorbedTurn === true && promotedFromTurnId
      && promotedFromTurnId !== parsed.turnId;
    return {
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : '',
      ...(typeof parsed.turnId === 'string' && parsed.turnId ? { turnId: parsed.turnId } : {}),
      ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
      ...(linkRefMode ? { linkRefMode } : {}),
      ...(parsed.trustedCaller && typeof parsed.trustedCaller === 'object' ? { trustedCaller: parsed.trustedCaller } : {}),
      ...(parsed.trustedController && typeof parsed.trustedController === 'object' ? { trustedController: parsed.trustedController } : {}),
      ...(typeof parsed.procStart === 'string' ? { procStart: parsed.procStart } : {}),
      ...(queuedTurnId ? { queuedTurnId } : {}),
      ...(queuedTurns && queuedTurns.length > 0 ? { queuedTurns } : {}),
      ...(settledAbsorbedTurns && settledAbsorbedTurns.length > 0 ? { settledAbsorbedTurns } : {}),
      ...(parsed.steerPromotedTurn === true ? { steerPromotedTurn: true } : {}),
      ...(promotedAbsorbed ? {
        promotedAbsorbedTurn: true as const,
        promotedFromTurnId,
        ...(promotedFromDispatchAttempt !== undefined ? { promotedFromDispatchAttempt } : {}),
      } : {}),
      ...(typeof parsed.capability === 'string' ? { capability: parsed.capability } : {}),
      ...(reconcileHint ? { antigravityReconcileHint: reconcileHint } : {}),
    };
  } catch {
    return { sessionId: '' };
  }
}

/**
 * Was this marker written for THIS live process of THIS session? A successor
 * worker that reattaches a persistent pane adopts the turn its CLI's marker
 * records, so a file merely sitting at that PID's path — the leftover of a
 * since-exited process whose PID the kernel recycled, another session's marker,
 * a legacy marker without the worker's birth stamp — must never be adopted.
 */
export function markerBelongsToLiveProcess(
  raw: string,
  expected: { sessionId: string; procStart: string | undefined },
): boolean {
  const marker = parseIdentityBoundSessionMarker(raw);
  return !!expected.procStart
    && marker.sessionId === expected.sessionId
    && marker.procStart === expected.procStart;
}

/**
 * Strong marker lookup for authority-bearing commands. Unlike the legacy
 * read/reply resolver, this requires the worker's JSON procStart binding and
 * verifies it against the live ancestor process before returning identity.
 */
export function findAuthenticatedAncestorSessionContext(
  dataDir: string,
  startPid: number = process.ppid,
): AuthenticatedAncestorSessionContext | null {
  const markersDir = join(dataDir, '.botmux-cli-pids');
  if (!existsSync(markersDir)) return null;

  let pid = startPid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const markerPath = join(markersDir, String(pid));
    if (existsSync(markerPath)) {
      let marker: IdentityBoundSessionMarker;
      try {
        marker = parseIdentityBoundSessionMarker(readFileSync(markerPath, 'utf-8'));
      } catch (err) {
        throw new SessionMarkerAuthenticationError(
          `无法读取 CLI process marker ${markerPath}：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!marker.sessionId || !marker.procStart) {
        throw new SessionMarkerAuthenticationError(
          '后台进程信息不完整，暂时不能执行变更。请运行 botmux restart 后重试。',
        );
      }
      if (!marker.turnId) {
        throw new SessionMarkerAuthenticationError(
          '当前会话还没有绑定到这条消息，暂时不能执行变更。请在原话题重新发送一次；如果仍失败，请运行 botmux restart。',
        );
      }
      const liveStart = readProcessStartIdentity(pid);
      if (!liveStart || liveStart !== marker.procStart) {
        throw new SessionMarkerAuthenticationError(
          `CLI process marker ${markerPath} 已过期或 PID 被复用，拒绝授权`,
        );
      }
      return {
        sessionId: marker.sessionId,
        turnId: marker.turnId,
        ...(marker.dispatchAttempt !== undefined ? { dispatchAttempt: marker.dispatchAttempt } : {}),
        ...(marker.linkRefMode ? { linkRefMode: marker.linkRefMode } : {}),
        markerPid: pid,
        ...(marker.capability ? { capability: marker.capability } : {}),
        procStart: marker.procStart,
        ...(marker.queuedTurnId ? { queuedTurnId: marker.queuedTurnId } : {}),
        ...(marker.queuedTurns && marker.queuedTurns.length > 0 ? { queuedTurns: marker.queuedTurns } : {}),
        ...(marker.settledAbsorbedTurns && marker.settledAbsorbedTurns.length > 0
          ? { settledAbsorbedTurns: marker.settledAbsorbedTurns } : {}),
        ...(marker.steerPromotedTurn ? { steerPromotedTurn: true } : {}),
        ...(marker.antigravityReconcileHint ? { antigravityReconcileHint: marker.antigravityReconcileHint } : {}),
      };
    }
    const parent = readParentPid(pid);
    if (!parent) break;
    pid = parent;
  }
  return null;
}

/**
 * Is a process-tree marker safe to treat as THIS process's session origin?
 *
 * Two ways a marker lies, both seen in production:
 *  - Recycled PID: the file was written by a since-exited process, and the kernel
 *    later handed the same PID number to an unrelated process now sitting in our
 *    ancestry. When the marker carries a procStart birth-stamp we can prove this
 *    directly (the live process's start ≠ the recorded one).
 *  - Stale/foreign session: a legacy marker (written before procStart existed) on
 *    a reused PID names a DIFFERENT session than `BOTMUX_SESSION_ID`. That env var
 *    is injected at spawn, never mutates, and is inherited across every reparent,
 *    so it is ground truth for the session this process belongs to; a marker that
 *    disagrees with it is not ours and cannot be verified any other way.
 *
 * This exact pair leaked a PR review across bots: a June legacy marker (no
 * procStart) on a recycled low PID routed a `botmux send` into a different bot's
 * long-closed session. The recycled process was alive, so liveness alone said
 * nothing — only the birth-stamp mismatch OR the env disagreement exposes it.
 */
function isTrustworthyAncestorMarker(
  pid: number,
  marker: IdentityBoundSessionMarker,
  envSessionId: string | undefined,
): boolean {
  if (marker.procStart && readProcessStartIdentity(pid) !== marker.procStart) return false;
  if (envSessionId && marker.sessionId !== envSessionId) return false;
  return true;
}

/**
 * Walk the process tree looking for a CLI-pid marker written by the botmux
 * worker. Legacy markers contain just the session id; new markers are JSON and
 * also carry the current inbound turn id so long-lived CLI processes can route
 * `botmux send` to the correct topic alias on the 2nd/Nth turn.
 *
 * A matched marker is honored only when `isTrustworthyAncestorMarker` clears it
 * against `envSessionId` (the caller threads in the inherited BOTMUX_SESSION_ID;
 * resolveSessionContext and the v3 relay client both pass it explicitly). When
 * omitted, only the procStart birth-stamp check applies — the function never
 * reads the ambient global env itself, so it stays pure and its callers decide
 * what "ground truth" is. An untrustworthy marker — empty, a recycled PID, or a
 * different session than the authoritative env — is skipped and the walk keeps
 * climbing; a genuine ancestor marker may sit higher, and if none does the caller
 * falls back to the env id.
 */
export function findAncestorSessionMarkerContext(
  dataDir: string,
  startPid: number = process.ppid,
  envSessionId?: string,
): AncestorSessionMarkerContext | null {
  const markersDir = join(dataDir, '.botmux-cli-pids');
  if (!existsSync(markersDir)) return null;

  let pid = startPid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const markerPath = join(markersDir, String(pid));
    if (existsSync(markerPath)) {
      let marker: IdentityBoundSessionMarker;
      try { marker = parseIdentityBoundSessionMarker(readFileSync(markerPath, 'utf-8')); }
      catch { return { sessionId: '' }; }
      if (marker.sessionId && isTrustworthyAncestorMarker(pid, marker, envSessionId)) {
        return {
          sessionId: marker.sessionId,
          ...(marker.turnId ? { turnId: marker.turnId } : {}),
          ...(marker.dispatchAttempt !== undefined ? { dispatchAttempt: marker.dispatchAttempt } : {}),
          ...(marker.linkRefMode ? { linkRefMode: marker.linkRefMode } : {}),
          ...(marker.trustedCaller ? { trustedCaller: marker.trustedCaller } : {}),
          ...(marker.trustedController ? { trustedController: marker.trustedController } : {}),
          markerPid: pid,
          ...(marker.queuedTurnId ? { queuedTurnId: marker.queuedTurnId } : {}),
          ...(marker.queuedTurns && marker.queuedTurns.length > 0 ? { queuedTurns: marker.queuedTurns } : {}),
          ...(marker.settledAbsorbedTurns && marker.settledAbsorbedTurns.length > 0
            ? { settledAbsorbedTurns: marker.settledAbsorbedTurns } : {}),
          ...(marker.steerPromotedTurn ? { steerPromotedTurn: true } : {}),
          ...(marker.promotedAbsorbedTurn && marker.promotedFromTurnId ? {
            promotedAbsorbedTurn: true as const,
            promotedFromTurnId: marker.promotedFromTurnId,
            ...(marker.promotedFromDispatchAttempt !== undefined
              ? { promotedFromDispatchAttempt: marker.promotedFromDispatchAttempt } : {}),
          } : {}),
          ...(marker.antigravityReconcileHint ? { antigravityReconcileHint: marker.antigravityReconcileHint } : {}),
        };
      }
      // Marker present but not ours: keep climbing (see doc comment above).
    }
    const parent = readParentPid(pid);
    if (!parent) break;
    pid = parent;
  }
  return null;
}

export function findAncestorSessionContext(
  dataDir: string,
  startPid: number = process.ppid,
  envSessionId?: string,
): AncestorSessionContext | null {
  const markerCtx = findAncestorSessionMarkerContext(dataDir, startPid, envSessionId);
  if (!markerCtx) return null;
  const { markerPid: _, ...ctx } = markerCtx;
  return ctx;
}

export interface AdvanceAncestorSessionTurnOptions {
  /** Expected dispatchAttempt of the consumed host turn (optional; guards cross-attempt mismatch). */
  consumedDispatchAttempt?: number;
  /** Caller-provided gate deciding whether a leading queued turn structurally
   *  proven absorbed into the host turn may be settled with this final instead
   *  of promoted into a new execution turn. Fail-closed when omitted. */
  canSettleAbsorbed?: (
    turn: QueuedTypeAheadTurn,
    marker: AncestorSessionContext,
  ) => boolean;
  /** Runs inside the PID-marker lock before the marker is read. A final sender
   *  uses this to publish its bridge-send marker and advance the queue as one
   *  ordered cross-process transition. Called even when the PID file vanished,
   *  so the delivery marker is not lost with the queue-advance opportunity. */
  beforeTransition?: () => void;
}

export interface AdvanceAncestorSessionTurnResult {
  advanced: boolean;
  turnId?: string;
  /** Omitted when empty so existing `{ advanced, turnId }` expectations stay unchanged. */
  settledAbsorbedTurnIds?: string[];
}

/** Determine which leading contiguous absorbed turns bound to `consumedTurnId`
 *  are structurally eligible to settle with this host turn's final. Scans only
 *  within the contiguous block absorbed into `consumedTurnId` (stopping at the
 *  first non-absorbed or other-host turn), preserving original FIFO order for
 *  any turn not settled. */
export function selectAbsorbedTurnsToSettle(
  marker: AncestorSessionContext,
  consumedTurnId: string | undefined,
  canSettleAbsorbed: ((turn: QueuedTypeAheadTurn, marker: AncestorSessionContext) => boolean) | undefined,
): { settled: SettledAbsorbedTurn[]; remaining: QueuedTypeAheadTurn[] } {
  const queuedTurns = marker.queuedTurns ? [...marker.queuedTurns] : [];
  if (queuedTurns.length === 0 && marker.queuedTurnId) {
    queuedTurns.push({ turnId: marker.queuedTurnId });
  }
  if (!canSettleAbsorbed
    || !consumedTurnId
    || marker.turnId !== consumedTurnId
    || marker.dispatchAttempt !== undefined
    || marker.trustedCaller?.taskContinuation !== undefined) {
    return { settled: [], remaining: queuedTurns };
  }
  const settled: SettledAbsorbedTurn[] = [];
  const remaining: QueuedTypeAheadTurn[] = [];
  let inAbsorbedBlock = true;
  for (const item of queuedTurns) {
    if (!inAbsorbedBlock) {
      remaining.push(item);
      continue;
    }
    const absorbedIntoThisHost = item.inputConsumed === true
      && isValidMarkerIdentityTurnId(item.turnId)
      && item.absorbedIntoTurnId === consumedTurnId
      && item.absorbedIntoDispatchAttempt === marker.dispatchAttempt;
    if (!absorbedIntoThisHost) {
      inAbsorbedBlock = false;
      remaining.push(item);
      continue;
    }
    const structurallyEligible = item.dispatchAttempt === undefined
      && !item.turnId.startsWith('schedule:')
      && !item.turnId.startsWith('wf:')
      && item.trustedCaller?.source !== 'schedule_creator'
      && item.trustedCaller?.taskContinuation === undefined
      && canSettleAbsorbed(item, marker);
    if (structurallyEligible) {
      settled.push({
        turnId: item.turnId,
        hostTurnId: consumedTurnId,
      });
    } else {
      remaining.push(item);
    }
  }
  return { settled, remaining };
}

/**
 * Atomically advances the ancestor process-tree marker to the next queued type-ahead turn.
 * Used when a turn's final response has been successfully delivered so subsequent subcommands
 * inside the same long-lived CLI process will immediately observe the successor turn.
 *
 * When `opts.canSettleAbsorbed` is provided, leading queued turns structurally proven to have
 * been absorbed mid-turn into the just-completed host turn (Claude `attachment(queued_command)`)
 * are settled with that final rather than promoted into a new execution turn.
 */
export function advanceAncestorSessionTurn(
  dataDir: string,
  markerPid: number,
  consumedTurnId?: string,
  opts?: AdvanceAncestorSessionTurnOptions,
): AdvanceAncestorSessionTurnResult {
  const markersDir = join(dataDir, '.botmux-cli-pids');
  const markerPath = join(markersDir, String(markerPid));
  // Without a marker callback the old early return avoids touching the lock.
  // A final-delivery callback must still run when the PID file disappeared.
  if (!existsSync(markerPath) && !opts?.beforeTransition) return { advanced: false };
  return withFileLockSync(markerPath, () => {
    opts?.beforeTransition?.();
    if (!existsSync(markerPath)) return { advanced: false };
    try {
      const raw = readFileSync(markerPath, 'utf-8');
      const marker = parseIdentityBoundSessionMarker(raw);
      if (!marker.sessionId) return { advanced: false };
      if (consumedTurnId && marker.turnId && marker.turnId !== consumedTurnId) {
        return { advanced: false, turnId: marker.turnId };
      }
      if (opts?.consumedDispatchAttempt !== undefined
        && marker.dispatchAttempt !== undefined
        && marker.dispatchAttempt !== opts.consumedDispatchAttempt) {
        return { advanced: false, turnId: marker.turnId };
      }
      let rawObj: Record<string, unknown> | undefined;
      if (raw.trim().startsWith('{')) {
        try { rawObj = JSON.parse(raw) as Record<string, unknown>; } catch { /* handled by parseIdentityBoundSessionMarker */ }
      }
      const rootAttemptCorrupted = !!rawObj
        && 'dispatchAttempt' in rawObj
        && rawObj.dispatchAttempt !== undefined
        && rawObj.dispatchAttempt !== null
        && parseDispatchAttempt(rawObj.dispatchAttempt) === undefined;
      const initialQueuedCount = marker.queuedTurns?.length ?? (marker.queuedTurnId ? 1 : 0);
      if (initialQueuedCount === 0) {
        return { advanced: false, turnId: marker.turnId };
      }
      const { settled, remaining: queuedTurns } = selectAbsorbedTurnsToSettle(
        marker,
        consumedTurnId,
        rootAttemptCorrupted ? undefined : opts?.canSettleAbsorbed,
      );
      const mergedSettled = mergeSettledAbsorbedTurns(marker.settledAbsorbedTurns, settled);
      if (queuedTurns.length === 0) {
        if (settled.length === 0) return { advanced: false, turnId: marker.turnId };
        // Preserve every host-turn field on disk verbatim (capability,
        // identityTurnId, callerOpenId, backgroundHeld, etc.) when staying on
        // the host turn.
        const preservedHost = rawObj ? { ...rawObj } : (JSON.parse(raw) as Record<string, unknown>);
        delete preservedHost.queuedTurnId;
        delete preservedHost.queuedTurns;
        if (mergedSettled && mergedSettled.length > 0) {
          preservedHost.settledAbsorbedTurns = mergedSettled;
        }
        atomicWriteFileSync(markerPath, JSON.stringify(preservedHost), { mode: 0o600, followTargetSymlink: false });
        return {
          advanced: false,
          turnId: marker.turnId,
          settledAbsorbedTurnIds: settled.map(s => s.turnId),
        };
      }
      const nextTurn = queuedTurns.shift()!;
      const nextQueuedTurnId = queuedTurns[0]?.turnId;
      const promotedAbsorbed = nextTurn.inputConsumed === true
        && nextTurn.absorbedIntoTurnId === marker.turnId
        && nextTurn.absorbedIntoDispatchAttempt === marker.dispatchAttempt;
      const updatedPayload: Record<string, unknown> = {
        sessionId: marker.sessionId,
        turnId: nextTurn.turnId,
        steerPromotedTurn: true,
        ...(promotedAbsorbed ? {
          promotedAbsorbedTurn: true,
          promotedFromTurnId: marker.turnId,
          ...(marker.dispatchAttempt !== undefined ? { promotedFromDispatchAttempt: marker.dispatchAttempt } : {}),
        } : {}),
        ...(nextTurn.dispatchAttempt !== undefined ? { dispatchAttempt: nextTurn.dispatchAttempt } : {}),
        ...(nextTurn.linkRefMode ? { linkRefMode: nextTurn.linkRefMode } : {}),
        ...(nextTurn.trustedCaller ? { trustedCaller: nextTurn.trustedCaller } : {}),
        ...(nextTurn.trustedController ? { trustedController: nextTurn.trustedController } : {}),
        ...(nextTurn.antigravityReconcileHint ? { antigravityReconcileHint: nextTurn.antigravityReconcileHint } : {}),
        ...(marker.procStart ? { procStart: marker.procStart } : {}),
        ...(nextQueuedTurnId ? { queuedTurnId: nextQueuedTurnId } : {}),
        ...(queuedTurns.length > 0 ? { queuedTurns } : {}),
        ...(mergedSettled && mergedSettled.length > 0 ? { settledAbsorbedTurns: mergedSettled } : {}),
      };
      atomicWriteFileSync(markerPath, JSON.stringify(updatedPayload), { mode: 0o600, followTargetSymlink: false });
      return {
        advanced: true,
        turnId: nextTurn.turnId,
        ...(settled.length > 0 ? { settledAbsorbedTurnIds: settled.map(s => s.turnId) } : {}),
      };
    } catch {
      return { advanced: false };
    }
  });
}

/**
 * Resolve the owning session for an in-session subcommand (`botmux send`, etc.).
 *
 * Primary signal: the process-tree marker walk above — it carries the fresh
 * per-turn turnId, so it's preferred whenever it resolves a session id.
 *
 * Fallback: `BOTMUX_SESSION_ID` from the environment. The marker walk depends on
 * an unbroken ancestry between this process and the CLI's spawn pid. That link
 * is severed whenever the subcommand runs in a detached/backgrounded process
 * (`run_in_background`, `nohup`, `&`, `setsid` → reparented to init/pid 1),
 * nested deeper than the 8-level walk, or under a separate pid-namespace — in all
 * of which the marker walk returns null even though we ARE inside a botmux
 * session. The worker injects `BOTMUX_SESSION_ID` into the CLI's env, and every
 * descendant inherits it regardless of reparenting, so it stays correct. The
 * session id never changes after spawn, so this fallback can't route to the wrong
 * session; turnId is intentionally omitted (env can't be refreshed per-turn for a
 * long-lived CLI — callers fall back to `BOTMUX_TURN_ID` when they need it).
 */
export function resolveSessionContext(
  dataDir: string,
  envSessionId: string | undefined,
  startPid: number = process.ppid,
  originChannelId: string | undefined = process.env.BOTMUX_ORIGIN_CHANNEL_ID,
): AncestorSessionContext | null {
  // Pass envSessionId as ground truth so the walk rejects a recycled-PID marker
  // that names a different (stale/foreign) session than the one we belong to.
  const fromMarker = findAncestorSessionContext(dataDir, startPid, envSessionId);
  // A live process-tree marker is the primary source whenever it is visible.
  // Per-session capability snapshots may survive SIGKILL or a later config
  // change that disables read isolation; they are only a fallback for the
  // macOS profile where the shared marker directory is intentionally hidden.
  if (fromMarker && fromMarker.sessionId) return fromMarker;
  // Read-isolated macOS sessions cannot read the shared PID-marker directory.
  // Their exact per-session capability carve-out carries one atomically rotated
  // turn snapshot, preserving fresh routing without treating the tuple itself
  // as daemon authority. It is consulted only when no live marker is visible,
  // so fields from two generations are never mixed.
  const protectedClaim = envSessionId
    ? readManagedOriginCapability(dataDir, envSessionId, undefined, originChannelId)
    : null;
  if (protectedClaim) {
    return {
      sessionId: protectedClaim.sessionId,
      ...(protectedClaim.turnId ? { turnId: protectedClaim.turnId } : {}),
      ...(protectedClaim.dispatchAttempt !== undefined
        ? { dispatchAttempt: protectedClaim.dispatchAttempt }
        : {}),
      ...(protectedClaim.linkRefMode ? { linkRefMode: protectedClaim.linkRefMode } : {}),
    };
  }
  if (envSessionId) return { sessionId: envSessionId };
  return fromMarker;
}
