import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-lock for the Codex active-runtime wiring (PR #780 review point ①).
 *
 * Codex's live model/effort ride the `active_runtime` IPC channel, published
 * from every `turn_context` record (the reliable per-turn source — the optional
 * `thread_settings_applied` snapshot is absent in many sessions). The
 * `codex_service_tier` handler is therefore scoped to the ⚡ service-tier badge
 * only and must NOT also write ds.activeModel/ds.activeReasoningEffort (that
 * would race the active_runtime writer and could clobber the good value with a
 * stale one). The worker-generation reset still clears those fields alongside
 * codexServiceTier so a respawn's empty window cannot leave a stale runtime tail
 * on the card (review point ②).
 */
const workerPool = readFileSync(
  resolve(__dirname, '../src/core/worker-pool.ts'),
  'utf8',
);
const worker = readFileSync(
  resolve(__dirname, '../src/worker.ts'),
  'utf8',
);

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  return source.slice(start, end);
}

describe('Codex active-runtime wiring (source lock)', () => {
  it('the codex_service_tier handler does NOT seed activeModel/effort (that races active_runtime)', () => {
    const handler = sliceBetween(workerPool, "case 'codex_service_tier':", "case 'screen_update':");
    expect(handler).toContain("effectiveCliId === 'codex'");
    // Model/effort must flow through active_runtime, never the tier handler.
    expect(handler).not.toContain('ds.activeModel = ds.codexServiceTier');
    expect(handler).not.toContain('ds.activeReasoningEffort = ds.codexServiceTier');
  });

  it('the codex bridge publishes turn_context runtime through active_runtime', () => {
    // Live ingest + split-live attach both surface Codex model/effort via the
    // shared publishActiveRuntime path (same channel TRAE uses), reading the
    // drain's latestModel/latestReasoningEffort (from turn_context).
    const codexIngest = sliceBetween(worker, 'if (structuredBridgeIsCodex()) {\n    const codex = result as CodexDrainResult;', '}');
    expect(codexIngest).toContain('publishActiveRuntime({');
    expect(codexIngest).toContain('codex.latestModel');
    expect(codexIngest).toContain('codex.latestReasoningEffort');
    // Baseline/attach paths seed via a bounded backward read.
    expect(worker).toContain('publishActiveRuntime(readLatestCodexRuntime(rolloutPath));');
  });

  it('the worker-generation reset clears active runtime alongside codexServiceTier', () => {
    // Both the tier and the active runtime are authority of the exact worker
    // generation; the reset lives where codexServiceTier is cleared.
    const reset = sliceBetween(workerPool, 'ds.codexServiceTier = undefined;', 'const handlerSession');
    expect(reset).toContain('ds.activeModel = undefined;');
    expect(reset).toContain('ds.activeReasoningEffort = undefined;');
    expect(reset).toContain('ds.pendingActiveRuntimeCardRefresh = undefined;');
  });

  it('the streaming usage snapshot never falls back to the raw transcript model', () => {
    // review point ⑤: snapshot.tokens.model is the RAW transcript model and for
    // relay-style CLIs is an internal routing code (ark/relay-code) that must
    // not surface on a user card. Model comes only from wired runtime or the
    // user-configured launch model.
    const fn = sliceBetween(
      workerPool,
      'export function getDaemonStreamingCardUsageSnapshot(',
      'import { normalizeBrand }',
    );
    expect(fn).not.toContain('snapshot.tokens?.model');
    expect(fn).toContain('ds.activeModel?.trim() || ds.session.model?.trim()');
  });
});
