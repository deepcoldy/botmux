import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CliTurnPayload } from '../types.js';
import { logger } from '../utils/logger.js';
import { addCodexAppContext } from '../utils/codex-app-context.js';
import { collectLinkRefCandidates } from './link-ref-extractor.js';
import { LinkRefLedger } from './link-ref-ledger.js';
import { renderLinkRefCompanion } from './link-ref-presenter.js';
import {
  findExecutableLinkRefs,
  resolveOutboundLinkRefs,
  type OutboundLinkRefPayload,
  type ResolvedOutboundLinkRefs,
} from './link-ref-resolver.js';
import {
  LinkRefError,
  type LinkRefDiagnostic,
  type LinkRefExtractionStats,
  type LinkRefMode,
  type LinkRefSourceInput,
  type LinkRefTurnKey,
} from './link-ref-types.js';

export interface LinkRefRuntime {
  prepareTurn(input: {
    key: LinkRefTurnKey;
    mode: LinkRefMode;
    payload: CliTurnPayload;
  }): CliTurnPayload;
  registerSources(input: {
    key: LinkRefTurnKey;
    mode: 'observe' | 'enabled';
    sources: readonly LinkRefSourceInput[];
  }): { companion?: string; stats: LinkRefExtractionStats };
  resolveForDaemon(
    key: LinkRefTurnKey,
    mode: LinkRefMode,
    payload: OutboundLinkRefPayload,
  ): ResolvedOutboundLinkRefs;
  restoreMode(key: LinkRefTurnKey): 'enabled' | undefined;
  prepareFinalDraft(input: {
    key: LinkRefTurnKey;
    mode: LinkRefMode;
    content: string;
  }): { content: string; draftPending: boolean };
  clearPendingDraft(key: LinkRefTurnKey): void;
  settleTurn(key: LinkRefTurnKey): void;
  deleteSession(appId: string, sessionId: string): number;
  pruneExpired(nowMs?: number): { expired: number; removed: number };
  recordDiagnostic(event: LinkRefDiagnostic): void;
  close(): void;
}

export function createLinkRefRuntime(
  dataDir: string,
  deps: {
    ledger?: () => LinkRefLedger;
    onDiagnostic?: (event: LinkRefDiagnostic) => void;
  } = {},
): LinkRefRuntime {
  let openedLedger: LinkRefLedger | undefined;
  let pruneTimer: NodeJS.Timeout | undefined;
  const prune = (store: LinkRefLedger): void => {
    try {
      store.pruneExpired();
    } catch {
      logger.warn('[link-ref] maintenance failed code=link_ref_ledger_unavailable');
    }
  };
  const ledger = (): LinkRefLedger => {
    if (!openedLedger) {
      openedLedger = deps.ledger?.() ?? new LinkRefLedger(dataDir);
      prune(openedLedger);
      pruneTimer = setInterval(() => {
        if (openedLedger) prune(openedLedger);
      }, 24 * 60 * 60_000);
      pruneTimer.unref?.();
    }
    return openedLedger;
  };
  const recordDiagnostic = (event: LinkRefDiagnostic): void => {
    const projected: LinkRefDiagnostic = {};
    if (event.mode === 'disabled' || event.mode === 'observe' || event.mode === 'enabled') {
      projected.mode = event.mode;
    }
    if (event.sourceType && [
      'user_message', 'group_context', 'card', 'history', 'quoted', 'attachment',
      'tool', 'mcp', 'public_system_doc',
    ].includes(event.sourceType)) projected.sourceType = event.sourceType;
    for (const key of [
      'scannedBytes', 'found', 'registered', 'deduplicated', 'filtered', 'limited',
      'refCount', 'durationMs',
    ] as const) {
      const value = event[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        projected[key] = value;
      }
    }
    if (typeof event.refId === 'string' && /^lr_[0-9a-f]{32}$/.test(event.refId)) {
      projected.refId = event.refId;
    }
    if (typeof event.urlHash === 'string' && /^[0-9a-f]{64}$/.test(event.urlHash)) {
      projected.urlHash = event.urlHash;
    }
    if (typeof event.outcome === 'string' && /^[a-z0-9_:-]{1,128}$/.test(event.outcome)) {
      projected.outcome = event.outcome;
    }
    if (typeof event.errorCode === 'string' && /^[a-z0-9_:-]{1,128}$/.test(event.errorCode)) {
      projected.errorCode = event.errorCode;
    }
    if (deps.onDiagnostic) deps.onDiagnostic(projected);
    else logger.info(`[link-ref] ${JSON.stringify(projected)}`);
  };
  const runtime: LinkRefRuntime = {
    prepareTurn({ key, mode, payload }) {
      const sources = payload.linkRefs?.sources ?? [];
      if (mode === 'disabled') {
        const { linkRefs: _linkRefs, ...legacy } = payload;
        return legacy;
      }
      const frozen: CliTurnPayload = { ...payload, linkRefs: { mode } };
      const result = runtime.registerSources({ key, mode, sources });
      if (mode !== 'enabled' || !result.companion) return frozen;
      const additionalContext = { ...frozen.codexAppInput?.additionalContext };
      if (frozen.codexAppInput) {
        addCodexAppContext(additionalContext, 'botmux_link_refs', result.companion, 'untrusted');
      }
      return {
        ...frozen,
        content: `${frozen.content}\n\n${result.companion}`,
        ...(frozen.codexAppInput
          ? { codexAppInput: { ...frozen.codexAppInput, additionalContext } }
          : {}),
      };
    },
    registerSources({ key, mode, sources }) {
      const extraction = collectLinkRefCandidates(sources);
      if (mode === 'observe') {
        recordDiagnostic({
          mode,
          scannedBytes: extraction.stats.scannedBytes,
          found: extraction.stats.found,
          filtered: extraction.stats.filteredCredential + extraction.stats.filteredMetadata + extraction.stats.filteredInvalid,
        });
        return { stats: extraction.stats };
      }
      try {
        const store = ledger();
        store.openTurn(key);
        if (extraction.candidates.length === 0) return { stats: extraction.stats };
        const registration = store.registerBatch(key, extraction.candidates);
        recordDiagnostic({
          mode,
          scannedBytes: extraction.stats.scannedBytes,
          found: extraction.stats.found,
          registered: registration.registered.length,
          deduplicated: registration.deduplicated,
          limited: registration.filteredByLimit,
          ...(registration.failure ? { errorCode: registration.failure } : {}),
        });
        const companion = renderLinkRefCompanion(registration.registered);
        return { ...(companion ? { companion } : {}), stats: extraction.stats };
      } catch (error) {
        recordDiagnostic({
          mode,
          found: extraction.stats.found,
          outcome: 'registration_failed',
          errorCode: typeof error === 'object' && error && 'code' in error
            ? String((error as { code: unknown }).code)
            : 'link_ref_ledger_unavailable',
        });
        return { stats: extraction.stats };
      }
    },
    resolveForDaemon(key, mode, payload) {
      if (mode === 'disabled' || mode === 'observe') return { ...payload, refCount: 0 };
      const startedAt = performance.now();
      try {
        const resolved = resolveOutboundLinkRefs(ledger(), key, payload);
        recordDiagnostic({
          mode,
          outcome: 'resolved',
          refCount: resolved.refCount,
          durationMs: Math.max(0, performance.now() - startedAt),
        });
        return resolved;
      } catch (error) {
        recordDiagnostic({
          mode,
          outcome: 'resolution_failed',
          errorCode: error && typeof error === 'object' && 'code' in error
            ? String((error as { code: unknown }).code)
            : 'link_ref_ledger_unavailable',
          durationMs: Math.max(0, performance.now() - startedAt),
        });
        throw error;
      }
    },
    restoreMode(key) {
      if (!openedLedger && !deps.ledger
        && !existsSync(join(dataDir, 'link-refs', 'link-refs.sqlite'))) return undefined;
      const row = ledger().readTurn(key);
      return row?.mode === 'enabled' && row.state === 'open' && row.expiresAtMs > Date.now()
        ? 'enabled'
        : undefined;
    },
    prepareFinalDraft({ key, mode, content }) {
      if (mode !== 'enabled') return { content, draftPending: false };
      const executable = findExecutableLinkRefs(content);
      if (executable.refIds.length === 0) {
        return { content: executable.expand(new Map()), draftPending: false };
      }
      const store = ledger();
      let draft: string;
      try {
        const persisted = store.readPendingDraft(key);
        draft = persisted ?? content;
        if (persisted === undefined) store.savePendingDraft(key, draft);
      } catch {
        throw new LinkRefError('link_ref_ledger_unavailable');
      }
      try {
        const resolved = runtime.resolveForDaemon(key, mode, { text: draft });
        return { content: resolved.text ?? draft, draftPending: true };
      } catch (error) {
        if (error instanceof LinkRefError) throw error;
        throw new LinkRefError('link_ref_ledger_unavailable');
      }
    },
    clearPendingDraft(key) {
      openedLedger?.clearPendingDraft(key);
    },
    settleTurn(key) {
      try {
        openedLedger?.settleTurn(key);
      } catch (error) {
        if (error instanceof LinkRefError && error.code === 'link_ref_turn_missing') return;
        throw error;
      }
    },
    deleteSession(appId, sessionId) {
      return openedLedger?.deleteSession(appId, sessionId) ?? 0;
    },
    pruneExpired(nowMs) {
      return openedLedger?.pruneExpired(nowMs) ?? { expired: 0, removed: 0 };
    },
    recordDiagnostic,
    close() {
      if (pruneTimer) clearInterval(pruneTimer);
      pruneTimer = undefined;
      openedLedger?.close();
      openedLedger = undefined;
    },
  };
  return runtime;
}

let currentRuntime: LinkRefRuntime | undefined;

export function setLinkRefRuntime(runtime: LinkRefRuntime | undefined): void {
  currentRuntime = runtime;
}

export function getLinkRefRuntime(): LinkRefRuntime | undefined {
  return currentRuntime;
}

export function initializeLinkRefRuntime(dataDir: string): LinkRefRuntime {
  const runtime = createLinkRefRuntime(dataDir);
  currentRuntime?.close();
  currentRuntime = runtime;
  return runtime;
}

export function closeLinkRefRuntime(): void {
  currentRuntime?.close();
  currentRuntime = undefined;
}
