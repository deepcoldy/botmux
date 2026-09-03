import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-lock for the model-fallback wiring — the seams a behavioural unit test
 * cannot reach (IPC hook-up, worker-generation authority, cold-start seed).
 * Same idiom as codex-active-runtime-wiring.test.ts.
 */
const worker = readFileSync(resolve(__dirname, '../src/worker.ts'), 'utf8');
const workerPool = readFileSync(resolve(__dirname, '../src/core/worker-pool.ts'), 'utf8');

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `missing marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(end, `missing marker: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('model-fallback wiring (source lock)', () => {
  it('observes fallbacks from the Claude bridge drain only', () => {
    // bridgeIngest IS the Claude bridge (Codex/TRAE have their own drains), so
    // hooking it here is what keeps the notice Claude-only.
    const ingest = sliceBetween(worker, 'function bridgeIngest(', 'function maybeEmitStructuredRateLimit');
    expect(ingest).toContain('observeModelFallback(result.events);');
    expect(worker).not.toContain('observeModelFallback(codex');
  });

  it('publishes only when the resolved state changes', () => {
    const publish = sliceBetween(worker, 'function publishModelFallbackIfChanged(', '\n}\n');
    expect(publish).toContain('publishedModelFallback?.uuid === state?.uuid) return;');
    expect(publish).toContain("send({ type: 'model_fallback', state });");
  });

  it('seeds from the transcript tail at bridge start, after baseline', () => {
    // Baseline cursors to EOF, so a switch recorded before --resume / a daemon
    // restart is never drained; the bounded backward scan recovers it.
    const start = sliceBetween(worker, 'function startBridgeWatcher(', 'function stopBridgeWatcher(');
    const baselineIdx = start.indexOf('bridgeAbsorbBaseline();');
    const seedIdx = start.indexOf('seedModelFallbackFromTranscript();');
    expect(baselineIdx).toBeGreaterThanOrEqual(0);
    expect(seedIdx).toBeGreaterThan(baselineIdx);
    expect(sliceBetween(worker, 'function seedModelFallbackFromTranscript(', '\n}\n'))
      .toContain('publishModelFallbackIfChanged();');
  });

  it('rejects a stale worker generation and persists what it accepts', () => {
    const handler = sliceBetween(workerPool, "case 'model_fallback': {", "case 'codex_service_tier':");
    expect(handler).toContain('ds.workerGeneration !== workerGeneration');
    expect(handler).toContain('ds.session.workerGeneration !== workerGeneration');
    expect(handler).toContain('if (ds.modelFallback?.uuid === next?.uuid) break;');
    expect(handler).toContain('persistStreamCardState(ds);');
    expect(handler).toContain('scheduleActiveRuntimePatch(ds);');
  });

  it('clears the state with the other worker-generation runtime facts', () => {
    // Without this a role switch to a non-Claude CLI would strand the notice:
    // that worker never sends a clearing model_fallback of its own.
    expect(sliceBetween(workerPool, 'ds.codexServiceTier = undefined;', 'const handlerSession'))
      .toContain('ds.modelFallback = undefined;');
  });

  it('keeps the notice out of the reply-card footer snapshot', () => {
    // The final reply card is the answer; the fallback notice belongs on the
    // live status card only.
    expect(sliceBetween(
      workerPool,
      'export function getDaemonReplyCardUsageSnapshot(',
      'export function getDaemonStreamingCardUsageSnapshot(',
    )).not.toContain('modelFallback');
  });
});
