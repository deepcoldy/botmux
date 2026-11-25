import {
  ANTIGRAVITY_QUOTA_HISTORY_LIMIT,
  extractAntigravityErrorComposerKey,
  isAntigravityReadyComposerScreen,
  isAntigravityWorkingScreen,
  rememberAntigravityQuota,
} from '../adapters/cli/antigravity.js';
import {
  cliUsageLimitEpisodeKey,
  cliUsageLimitNativeKeys,
  detectCliUsageLimit,
  detectScreenUsageLimit,
  isAntigravityNativeLimit,
  isSameUsageLimitEpisode,
  reconcileUsageLimitState,
  usageLimitStateKey,
  type CliUsageLimitState,
} from '../utils/cli-usage-limit.js';
import { stripAnsiScreenText } from '../utils/idle-detector.js';
import type { AntigravityNativeQuotaRefusal } from './antigravity-native-quota.js';

/** Minimal serializable cursor synced between worker and daemon SQLite so
 *  reader-gap retention, recovery tombstones, and answered-turn log retirements
 *  survive restarts deterministically regardless of first-seen history order. */
export interface AntigravityQuotaRecoveryCursor {
  readonly lastConfirmed: CliUsageLimitState | null;
  readonly recoveredEpisodeKey: string | null;
  /** Native `log:*` episode keys retired by answered turns (bounded FIFO). */
  readonly retiredNativeLogKeys?: readonly string[];
}

export interface AntigravityQuotaRestoreInput {
  readonly history?: readonly CliUsageLimitState[];
  readonly activeQuota?: CliUsageLimitState;
  readonly cursor?: AntigravityQuotaRecoveryCursor;
}

export interface AntigravityQuotaClassifyInput<S extends string = string> {
  readonly screen: string;
  readonly nativeViewportCaptured: boolean;
  readonly runtimeStatus: S;
  readonly outputActive?: boolean;
  /** True only for verified `agy >= 1.5.15` terminal sessions (never ACP). */
  readonly supportsReadyFooterQuota: boolean;
  readonly nativeLogQuota?: AntigravityNativeQuotaRefusal;
  readonly nowMs?: number;
}

export interface AntigravityQuotaClassifyResult<S extends string = string> {
  readonly status: S | 'limited';
  readonly usageLimit?: CliUsageLimitState;
  readonly expiredAntigravityQuota?: CliUsageLimitState;
  readonly usageLimitRecovery?: 'antigravity-ready-composer';
  readonly detectedThisTurn: boolean;
}

export interface AntigravityQuotaStateMachine {
  restore(input: AntigravityQuotaRestoreInput): void;
  beginTurn(snapshot: string, nowMs?: number): void;
  /** Retire the current turn's native log refusal (e.g. when `agy` internally
   *  retried and answered without a new `HandleUserInput`) and arm answered-turn
   *  stale-banner suppression. */
  noteTurnAnswered(latestNativeLogQuota?: string | AntigravityNativeQuotaRefusal): void;
  classify<S extends string>(input: AntigravityQuotaClassifyInput<S>): AntigravityQuotaClassifyResult<S>;
  exportHistory(): readonly CliUsageLimitState[] | undefined;
  exportCursor(): AntigravityQuotaRecoveryCursor;
}

type RawBannerBinding =
  | {
      readonly kind: 'log';
      readonly logKey: string;
      readonly composerKey?: string;
      readonly screenComposerKey?: string;
    }
  | { readonly kind: 'unlinked-composer'; readonly composerKey: string };

interface TurnQuotaState {
  answered: boolean;
  staleBannerKey?: string;
  staleRawBannerKey?: string;
  preExistingRawKey?: string;
  preExistingBinding?: RawBannerBinding;
  lateBoundLogKey?: string;
  observedNativeLogKey?: string;
  observedRawKey?: string;
  answeredSuppressedRawKey?: string;
  answeredSuppressedRetryLabel?: string;
}

function rawBannerKey(state: CliUsageLimitState): string {
  const base = `${state.kind}:${state.retryLabel}`;
  return state.relativeResetKey ? `${base}:${state.relativeResetKey}` : base;
}

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, limit = ANTIGRAVITY_QUOTA_HISTORY_LIMIT): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function addBoundedSet<T>(set: Set<T>, value: T, limit = ANTIGRAVITY_QUOTA_HISTORY_LIMIT): void {
  if (set.has(value)) set.delete(value);
  set.add(value);
  while (set.size > limit) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

/** Derive a deterministic recovery cursor for legacy sessions persisted before
 *  `antigravityQuotaCursor` existed (zero schema migration). */
export function deriveLegacyAntigravityQuotaCursor(
  activeQuota: CliUsageLimitState | undefined,
  history: readonly CliUsageLimitState[] | undefined,
): AntigravityQuotaRecoveryCursor {
  const lastConfirmed = isAntigravityNativeLimit(activeQuota)
    ? activeQuota!
    : (history?.length ? history[history.length - 1]! : null);
  const recoveredEpisodeKey = !isAntigravityNativeLimit(activeQuota) && lastConfirmed
    ? (cliUsageLimitEpisodeKey(lastConfirmed) ?? null)
    : null;
  return { lastConfirmed, recoveredEpisodeKey };
}

/** Single-source, zero-I/O worker state machine for Antigravity quota episodes.
 *
 *  Owns history, `lastConfirmed` (reader-gap retention), `recoveredEpisodeKey`
 *  (recovery/expiry tombstone), composer<->log links, per-raw-banner native
 *  associations, unconfirmed partial frames, and durable answered-turn retirement. */
export function createAntigravityQuotaStateMachine(): AntigravityQuotaStateMachine {
  let history: readonly CliUsageLimitState[] | undefined;
  let lastConfirmed: CliUsageLimitState | null = null;
  let lastConfirmedScreenComposerKey: string | undefined;
  let recoveredEpisodeKey: string | null = null;
  const composerLinks = new Map<string, string | 'unlinked'>();
  const unconfirmed = new Map<string, CliUsageLimitState>();
  const retiredNativeLogKeys = new Set<string>();
  const rawBannerAssociations = new Map<string, RawBannerBinding>();
  let turn: TurnQuotaState = { answered: false };

  const recordComposerLinkFromState = (state: CliUsageLimitState): void => {
    const epKey = cliUsageLimitEpisodeKey(state);
    if (!epKey) return;
    if (state.linkedNativeEpisodeKey && epKey.startsWith('log:')) {
      setBoundedMap(composerLinks, state.linkedNativeEpisodeKey, epKey);
      return;
    }
    const nativeKeys = cliUsageLimitNativeKeys(state);
    if (nativeKeys.length === 1 && nativeKeys[0]!.startsWith('composer:')) {
      if (!composerLinks.has(nativeKeys[0]!)) {
        setBoundedMap(composerLinks, nativeKeys[0]!, 'unlinked');
      }
    }
  };

  const recordRawBannerAssociationFromState = (
    state: CliUsageLimitState,
    screenComposerKey?: string,
  ): void => {
    if (!isAntigravityNativeLimit(state)) return;
    const nativeKeys = cliUsageLimitNativeKeys(state);
    const logKey = nativeKeys.find(k => k.startsWith('log:'));
    const composerKey = nativeKeys.find(k => k.startsWith('composer:'));
    const rKey = rawBannerKey(state);
    if (logKey) {
      setBoundedMap(rawBannerAssociations, rKey, {
        kind: 'log',
        logKey,
        ...(composerKey ? { composerKey } : {}),
        ...(screenComposerKey ? { screenComposerKey } : {}),
      });
    } else if (composerKey) {
      setBoundedMap(rawBannerAssociations, rKey, {
        kind: 'unlinked-composer',
        composerKey,
      });
    }
  };

  const restore = (input: AntigravityQuotaRestoreInput): void => {
    history = input.history?.length ? [...input.history] : undefined;
    composerLinks.clear();
    unconfirmed.clear();
    rawBannerAssociations.clear();
    retiredNativeLogKeys.clear();
    turn = { answered: false };

    const cursor = input.cursor ?? deriveLegacyAntigravityQuotaCursor(input.activeQuota, history);
    lastConfirmed = cursor.lastConfirmed;
    recoveredEpisodeKey = cursor.recoveredEpisodeKey;
    lastConfirmedScreenComposerKey = cliUsageLimitNativeKeys(lastConfirmed ?? undefined)
      .find(k => k.startsWith('composer:'));

    if (cursor.retiredNativeLogKeys?.length) {
      for (const key of cursor.retiredNativeLogKeys) {
        if (typeof key === 'string' && key.startsWith('log:')) {
          addBoundedSet(retiredNativeLogKeys, key);
        }
      }
    }

    if (history) {
      for (const entry of history) {
        recordComposerLinkFromState(entry);
        recordRawBannerAssociationFromState(entry);
      }
    }
    if (lastConfirmed) {
      recordComposerLinkFromState(lastConfirmed);
      recordRawBannerAssociationFromState(lastConfirmed, lastConfirmedScreenComposerKey);
    }

    const active = input.activeQuota;
    if (
      active
      && !isAntigravityNativeLimit(active)
      && active.kind === 'usage'
      && active.relativeResetKey
      && !active.relativeResetKey.endsWith(':')
    ) {
      setBoundedMap(unconfirmed, active.relativeResetKey, active);
    }
  };

  const beginTurn = (snapshot: string, nowMs?: number): void => {
    const plain = stripAnsiScreenText(snapshot).replace(/\r\n/g, '\n');
    const now = nowMs !== undefined ? new Date(nowMs) : new Date();
    const current = detectCliUsageLimit(plain, now);
    const preExistingRawKey = current.limited ? rawBannerKey(current) : undefined;
    const composerKey = current.limited ? extractAntigravityErrorComposerKey(plain) : undefined;

    let preExistingBinding = preExistingRawKey ? rawBannerAssociations.get(preExistingRawKey) : undefined;
    if (composerKey) {
      const conflictsWithComposer = !preExistingBinding
        || (preExistingBinding.kind === 'unlinked-composer' && preExistingBinding.composerKey !== composerKey)
        || (preExistingBinding.kind === 'log' && (
          (preExistingBinding.composerKey !== undefined && preExistingBinding.composerKey !== composerKey)
          || (preExistingBinding.screenComposerKey !== undefined && preExistingBinding.screenComposerKey !== composerKey)
          || (!current.limited
            || (!current.relativeResetKey
              && preExistingBinding.composerKey === undefined
              && preExistingBinding.screenComposerKey === undefined))
        ));
      if (conflictsWithComposer) {
        const link = composerLinks.get(composerKey);
        preExistingBinding = link && link !== 'unlinked'
          ? { kind: 'log', logKey: link, composerKey }
          : { kind: 'unlinked-composer', composerKey };
      } else if (preExistingBinding?.kind === 'log' && !preExistingBinding.screenComposerKey) {
        preExistingBinding = { ...preExistingBinding, screenComposerKey: composerKey };
      }
    }

    let staleBannerKey: string | undefined;
    const staleRawBannerKey = current.limited && current.retryReady ? usageLimitStateKey(current) : undefined;
    if (current.limited && current.retryReady) {
      if (preExistingBinding?.kind === 'log') {
        staleBannerKey = usageLimitStateKey({
          ...current,
          source: preExistingBinding.composerKey ? 'antigravity-error-composer' : 'antigravity-native-log',
          nativeEpisodeKey: preExistingBinding.logKey,
          ...(preExistingBinding.composerKey ? { linkedNativeEpisodeKey: preExistingBinding.composerKey } : {}),
        });
      } else if (composerKey) {
        staleBannerKey = usageLimitStateKey({
          ...current,
          source: 'antigravity-error-composer',
          nativeEpisodeKey: composerKey,
        });
      } else {
        staleBannerKey = staleRawBannerKey;
      }
    }

    turn = {
      answered: false,
      staleBannerKey,
      staleRawBannerKey,
      preExistingRawKey,
      preExistingBinding,
    };
  };

  const noteTurnAnswered = (latestNativeLogQuota?: string | AntigravityNativeQuotaRefusal): void => {
    turn.answered = true;
    const latestNativeLogQuotaKey = typeof latestNativeLogQuota === 'string'
      ? latestNativeLogQuota
      : latestNativeLogQuota?.nativeEpisodeKey;
    const keysToRetire = [latestNativeLogQuotaKey, turn.observedNativeLogKey].filter(
      (k): k is string => Boolean(k && k.startsWith('log:')),
    );
    for (const key of keysToRetire) {
      addBoundedSet(retiredNativeLogKeys, key);
    }
    if (keysToRetire.length > 0 && turn.observedRawKey) {
      turn.answeredSuppressedRawKey = turn.observedRawKey;
    }
    if (typeof latestNativeLogQuota === 'object' && latestNativeLogQuota?.text) {
      const parsed = detectCliUsageLimit(latestNativeLogQuota.text);
      if (parsed.limited && parsed.kind === 'usage') {
        turn.answeredSuppressedRetryLabel = parsed.retryLabel;
      }
    }
    if (
      latestNativeLogQuotaKey
      && latestNativeLogQuotaKey.startsWith('log:')
      && turn.preExistingRawKey
      && !turn.preExistingBinding
      && !turn.lateBoundLogKey
    ) {
      turn.lateBoundLogKey = latestNativeLogQuotaKey;
      setBoundedMap(rawBannerAssociations, turn.preExistingRawKey, {
        kind: 'log',
        logKey: latestNativeLogQuotaKey,
      });
    }
  };

  const classify = <S extends string>(
    input: AntigravityQuotaClassifyInput<S>,
  ): AntigravityQuotaClassifyResult<S> => {
    const plain = stripAnsiScreenText(input.screen).replace(/\r\n/g, '\n');
    const nowMs = input.nowMs ?? Date.now();
    const now = new Date(nowMs);

    if (isAntigravityWorkingScreen(plain)) {
      return { status: 'working' as S, detectedThisTurn: false };
    }

    const candidateLog = input.nativeLogQuota && !retiredNativeLogKeys.has(input.nativeLogQuota.nativeEpisodeKey)
      ? input.nativeLogQuota
      : undefined;
    const logParsed = candidateLog ? detectCliUsageLimit(candidateLog.text, now) : undefined;

    const readyComposer = input.nativeViewportCaptured && isAntigravityReadyComposerScreen(plain);
    const raw = readyComposer
      ? detectCliUsageLimit(plain, now)
      : detectScreenUsageLimit(plain, input.runtimeStatus, now, {
        ...(input.outputActive !== undefined ? { outputActive: input.outputActive } : {}),
      });

    const logMatchesScreen = Boolean(
      candidateLog
      && logParsed?.limited
      && logParsed.kind === 'usage'
      && raw.limited
      && raw.kind === 'usage'
      && logParsed.retryLabel === raw.retryLabel,
    );

    let observed: CliUsageLimitState | undefined;
    let screenComposerKey: string | undefined;
    const readyScreenComposerKey = readyComposer ? extractAntigravityErrorComposerKey(plain) : undefined;
    let readyRetained: CliUsageLimitState | undefined;
    if (
      readyComposer
      && input.supportsReadyFooterQuota
      && raw.limited
      && raw.kind === 'usage'
      && lastConfirmed
      && isAntigravityNativeLimit(lastConfirmed)
      && nowMs < lastConfirmed.retryAtMs
      && !turn.answered
      && !retiredNativeLogKeys.has(lastConfirmed.nativeEpisodeKey ?? '')
      && (
        (lastConfirmed.relativeResetKey !== undefined
          && lastConfirmed.relativeResetKey === raw.relativeResetKey)
        || (readyScreenComposerKey !== undefined
          && (lastConfirmedScreenComposerKey === readyScreenComposerKey
            || lastConfirmed.linkedNativeEpisodeKey === readyScreenComposerKey))
        || candidateLog?.nativeEpisodeKey === lastConfirmed.nativeEpisodeKey
      )
    ) {
      // A ready footer alone does not disprove a still-visible, unexpired quota
      // banner while native evidence is between turns or its countdown differs.
      // Preserve the confirmed episode; only answered/retired proof may recover it.
      readyRetained = {
        ...raw,
        source: lastConfirmed.source,
        nativeEpisodeKey: lastConfirmed.nativeEpisodeKey,
        ...(lastConfirmed.linkedNativeEpisodeKey
          ? { linkedNativeEpisodeKey: lastConfirmed.linkedNativeEpisodeKey }
          : {}),
      };
    }

    const recoverReady = (): AntigravityQuotaClassifyResult<S> => {
      if (lastConfirmed) {
        recoveredEpisodeKey = cliUsageLimitEpisodeKey(lastConfirmed) ?? recoveredEpisodeKey;
      }
      return {
        status: input.runtimeStatus,
        usageLimitRecovery: 'antigravity-ready-composer',
        detectedThisTurn: false,
      };
    };

    if (readyComposer) {
      if (!raw.limited) return recoverReady();
      if (input.supportsReadyFooterQuota && logMatchesScreen && candidateLog) {
        observed = {
          ...raw,
          source: 'antigravity-native-log',
          nativeEpisodeKey: candidateLog.nativeEpisodeKey,
        };
      } else if (readyRetained) {
        observed = readyRetained;
        screenComposerKey = readyScreenComposerKey;
      } else {
        return recoverReady();
      }
    } else if (!raw.limited) {
      return { status: input.runtimeStatus, detectedThisTurn: false };
    } else {
      screenComposerKey = extractAntigravityErrorComposerKey(plain);
      if (screenComposerKey) {
        if (logMatchesScreen && candidateLog) {
          const existingLink = composerLinks.get(screenComposerKey);
          if (
            existingLink === 'unlinked'
            || (existingLink !== undefined && existingLink !== candidateLog.nativeEpisodeKey)
          ) {
            // Replacement log episode on a previously unlinked or differently-linked composer:
            // never inherit the old composer key or let the old composer veto the new episode.
            observed = {
              ...raw,
              source: 'antigravity-native-log',
              nativeEpisodeKey: candidateLog.nativeEpisodeKey,
            };
          } else {
            // Simultaneous composer + native log observation for the same episode.
            observed = {
              ...raw,
              source: 'antigravity-error-composer',
              nativeEpisodeKey: candidateLog.nativeEpisodeKey,
              linkedNativeEpisodeKey: screenComposerKey,
            };
          }
        } else if (
          lastConfirmed?.nativeEpisodeKey?.startsWith('log:')
          && (
            (lastConfirmed.relativeResetKey && lastConfirmed.relativeResetKey === raw.relativeResetKey)
            || lastConfirmedScreenComposerKey === screenComposerKey
            || lastConfirmed.linkedNativeEpisodeKey === screenComposerKey
          )
        ) {
          // Temporary native-log reader gap: retain the last confirmed log episode identity
          // instead of falling back to first-seen history or relabeling into an older composer.
          observed = {
            ...raw,
            source: lastConfirmed.source,
            nativeEpisodeKey: lastConfirmed.nativeEpisodeKey,
            ...(lastConfirmed.linkedNativeEpisodeKey
              ? { linkedNativeEpisodeKey: lastConfirmed.linkedNativeEpisodeKey }
              : {}),
          };
        } else {
          const linkedLog = composerLinks.get(screenComposerKey);
          if (linkedLog && linkedLog !== 'unlinked') {
            observed = {
              ...raw,
              source: 'antigravity-error-composer',
              nativeEpisodeKey: linkedLog,
              linkedNativeEpisodeKey: screenComposerKey,
            };
          } else {
            observed = {
              ...raw,
              source: 'antigravity-error-composer',
              nativeEpisodeKey: screenComposerKey,
            };
          }
        }
      } else if (input.supportsReadyFooterQuota && logMatchesScreen && candidateLog) {
        observed = {
          ...raw,
          source: 'antigravity-native-log',
          nativeEpisodeKey: candidateLog.nativeEpisodeKey,
        };
      } else {
        observed = raw;
      }
    }

    const rKey = rawBannerKey(raw);
    const suppressedResult = (): AntigravityQuotaClassifyResult<S> => ({
      status: input.runtimeStatus,
      ...(readyComposer ? { usageLimitRecovery: 'antigravity-ready-composer' as const } : {}),
      detectedThisTurn: false,
    });

    if (isAntigravityNativeLimit(observed)) {
      const epKey = cliUsageLimitEpisodeKey(observed)!;

      // 1. Recovered / expired tombstone gate: stays active across reader gaps and restarts
      //    until a genuinely distinct confirmed native episode arrives.
      if (recoveredEpisodeKey !== null && epKey === recoveredEpisodeKey) {
        if (
          lastConfirmed
          && cliUsageLimitEpisodeKey(lastConfirmed) === epKey
          && lastConfirmed.relativeResetKey
          && nowMs >= lastConfirmed.retryAtMs
        ) {
          return {
            status: input.runtimeStatus,
            expiredAntigravityQuota: lastConfirmed,
            detectedThisTurn: false,
          };
        }
        return suppressedResult();
      }

      // 2. Reconcile deadline strictly against matching episode or unconfirmed partial frame.
      const previous = history?.find(entry => isSameUsageLimitEpisode(entry, observed))
        ?? (observed.relativeResetKey ? unconfirmed.get(observed.relativeResetKey) : undefined);
      const reconciled = reconcileUsageLimitState(previous, observed, { nowMs });

      // 3. Native countdown expiry check.
      if (previous && reconciled.relativeResetKey && nowMs >= reconciled.retryAtMs) {
        history = rememberAntigravityQuota(history, reconciled);
        unconfirmed.delete(reconciled.relativeResetKey);
        if (lastConfirmed === null || isSameUsageLimitEpisode(lastConfirmed, reconciled)) {
          lastConfirmed = reconciled;
          lastConfirmedScreenComposerKey = screenComposerKey ?? lastConfirmedScreenComposerKey;
          recoveredEpisodeKey = epKey;
        }
        return {
          status: input.runtimeStatus,
          expiredAntigravityQuota: reconciled,
          detectedThisTurn: false,
        };
      }

      // 4. Stale retry-ready banner suppression.
      if (
        (turn.staleBannerKey !== undefined && usageLimitStateKey(reconciled) === turn.staleBannerKey)
        || (turn.staleRawBannerKey !== undefined && usageLimitStateKey(raw) === turn.staleRawBannerKey
          && ((!turn.preExistingBinding && !epKey.startsWith('log:')) || (
            turn.preExistingBinding !== undefined && (
              turn.preExistingBinding.kind === 'log'
                ? (epKey === turn.preExistingBinding.logKey
                  || (!epKey.startsWith('log:') && (
                    turn.preExistingBinding.composerKey === epKey
                    || turn.preExistingBinding.screenComposerKey === epKey
                  )))
                : !epKey.startsWith('log:') && epKey === turn.preExistingBinding.composerKey
            )
          )))
      ) {
        return suppressedResult();
      }

      // 5. Answered-turn stale-banner suppression (with one-time late native-log binding).
      if (turn.answered && rKey === turn.preExistingRawKey) {
        if (turn.preExistingBinding) {
          const matchesExisting = turn.preExistingBinding.kind === 'log'
            ? (epKey === turn.preExistingBinding.logKey
              || (!epKey.startsWith('log:') && (
                turn.preExistingBinding.composerKey === epKey
                || turn.preExistingBinding.screenComposerKey === epKey
              )))
            : (!epKey.startsWith('log:') && epKey === turn.preExistingBinding.composerKey);
          if (matchesExisting) return suppressedResult();
        } else if (turn.lateBoundLogKey) {
          if (epKey === turn.lateBoundLogKey) return suppressedResult();
        } else if (epKey.startsWith('log:')) {
          turn.lateBoundLogKey = epKey;
          setBoundedMap(rawBannerAssociations, rKey, {
            kind: 'log',
            logKey: epKey,
            ...(screenComposerKey ? { composerKey: screenComposerKey, screenComposerKey } : {}),
          });
          return suppressedResult();
        } else {
          turn.preExistingBinding = { kind: 'unlinked-composer', composerKey: epKey };
          setBoundedMap(rawBannerAssociations, rKey, turn.preExistingBinding);
          return suppressedResult();
        }
      }

      // 6. Commit confirmed active native episode.
      history = rememberAntigravityQuota(history, reconciled);
      if (reconciled.relativeResetKey) unconfirmed.delete(reconciled.relativeResetKey);
      lastConfirmed = reconciled;
      lastConfirmedScreenComposerKey = screenComposerKey;
      recoveredEpisodeKey = null;
      recordComposerLinkFromState(reconciled);
      recordRawBannerAssociationFromState(reconciled, screenComposerKey);
      turn.observedRawKey = rKey;
      if (epKey.startsWith('log:')) turn.observedNativeLogKey = epKey;
      turn.staleBannerKey = undefined;
      turn.staleRawBannerKey = undefined;
      return {
        status: 'limited',
        usageLimit: reconciled,
        detectedThisTurn: true,
      };
    }

    // Generic (non-native) fallback: reconcile only against `unconfirmed` and NEVER
    // mutate `history`, `lastConfirmed`, `recoveredEpisodeKey`, or `composerLinks`.
    const previousUnconfirmed = observed.relativeResetKey ? unconfirmed.get(observed.relativeResetKey) : undefined;
    const reconciled = reconcileUsageLimitState(previousUnconfirmed, observed, { nowMs });

    if (
      (turn.staleRawBannerKey !== undefined && usageLimitStateKey(reconciled) === turn.staleRawBannerKey)
      || (turn.answered && (
        rKey === turn.preExistingRawKey
        || rKey === turn.answeredSuppressedRawKey
        || (reconciled.kind === 'usage'
          && turn.answeredSuppressedRetryLabel !== undefined
          && reconciled.retryLabel === turn.answeredSuppressedRetryLabel)
      ))
    ) {
      return { status: input.runtimeStatus, detectedThisTurn: false };
    }

    if (reconciled.kind === 'usage' && reconciled.relativeResetKey && !reconciled.relativeResetKey.endsWith(':')) {
      setBoundedMap(unconfirmed, reconciled.relativeResetKey, reconciled);
    }
    turn.observedRawKey = rKey;
    turn.staleBannerKey = undefined;
    turn.staleRawBannerKey = undefined;
    return {
      status: 'limited',
      usageLimit: reconciled,
      detectedThisTurn: true,
    };
  };

  return {
    restore,
    beginTurn,
    noteTurnAnswered,
    classify,
    exportHistory: () => history,
    exportCursor: () => ({
      lastConfirmed,
      recoveredEpisodeKey,
      ...(retiredNativeLogKeys.size > 0 ? { retiredNativeLogKeys: [...retiredNativeLogKeys] } : {}),
    }),
  };
}
