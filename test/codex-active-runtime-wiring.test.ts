import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-lock for the Codex active-runtime wiring (PR #780 review point ①).
 *
 * Codex has no `active_runtime` IPC channel — that path is TRAE-gated. Its live
 * model/effort ride the `thread_settings_applied` snapshot already tracked by
 * CodexServiceTierTracker. The `codex_service_tier` handler must copy that
 * snapshot's model/effort into ds.activeModel/ds.activeReasoningEffort so the
 * card reflects an in-session /model or /effort switch; and the worker-generation
 * reset must clear those fields alongside codexServiceTier so a respawn's empty
 * window cannot leave a stale runtime tail on the card (review point ②).
 */
const workerPool = readFileSync(
  resolve(__dirname, '../src/core/worker-pool.ts'),
  'utf8',
);

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  return source.slice(start, end);
}

describe('Codex active-runtime wiring (source lock)', () => {
  it('the codex_service_tier handler seeds activeModel/activeReasoningEffort for codex', () => {
    const handler = sliceBetween(workerPool, "case 'codex_service_tier':", "case 'screen_update':");
    expect(handler).toContain("effectiveCliId === 'codex'");
    expect(handler).toContain('ds.activeModel = ds.codexServiceTier?.model?.trim() || undefined');
    expect(handler).toContain('ds.activeReasoningEffort = ds.codexServiceTier?.reasoningEffort?.trim() || undefined');
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
