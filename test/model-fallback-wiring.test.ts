import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-lock for the model-fallback wiring — the seams a behavioural unit test
 * cannot reach (IPC hook-up, worker-generation authority, cold-start seed, the
 * cliId gates). Same idiom as codex-active-runtime-wiring.test.ts.
 *
 * The invariant these locks defend: the notice is claude-code + Fable only, and
 * once shown it stays shown every round until Claude is OBSERVED answering on a
 * different model. No "not found" path may ever clear it.
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

  it('gates both the observe and the seed path on cliId claude-code', () => {
    // Belt and braces over the call site: the notice is a claude-code product
    // affordance, so a future non-Claude caller of these helpers stays inert.
    expect(sliceBetween(worker, 'function observeModelFallback(', '\n}\n'))
      .toContain("lastInitConfig?.cliId !== 'claude-code'");
    expect(sliceBetween(worker, 'function seedModelFallbackFromTranscript(', '\n}\n'))
      .toContain("lastInitConfig?.cliId !== 'claude-code'");
  });

  it('never sends a "cleared" shape — the worker reports facts only', () => {
    // The old bug: the seed published `null` whenever its bounded tail scan
    // found nothing, wiping the daemon's persisted notice on every long session.
    const report = sliceBetween(worker, 'function reportModelFallbackObservation(', '\n}\n');
    expect(report).toContain('if (!observed) return;');
    expect(report).toContain("send({ type: 'model_fallback', ...observed });");
    expect(worker).not.toContain('publishModelFallbackIfChanged');
    expect(worker).not.toContain("type: 'model_fallback', state");
    // Every model_fallback send in the worker goes through that one helper.
    expect(worker.match(/type: 'model_fallback'/g)).toHaveLength(1);
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
      .toContain('reportModelFallbackObservation(seeded);');
  });

  it('also seeds on the lazy baseline, when the transcript appears after attach', () => {
    // bridgeAbsorbBaseline skips whatever is already in the file (EOF cursor in
    // the non-adopt branch; bridgeQueue.absorb — not observeModelFallback — in
    // the adopt one), so this second baseline site needs the tail scan too.
    const ingest = sliceBetween(worker, 'function bridgeIngest(', 'function maybeEmitStructuredRateLimit');
    const lazy = sliceBetween(ingest, 'if (!bridgeBaselineDone) {', '\n  }\n');
    expect(lazy).toContain('bridgeAbsorbBaseline();');
    expect(lazy).toContain('seedModelFallbackFromTranscript();');
    expect(lazy.indexOf('seedModelFallbackFromTranscript();'))
      .toBeGreaterThan(lazy.indexOf('bridgeAbsorbBaseline();'));
  });

  it('rejects a stale worker generation, gates on claude-code, and merges', () => {
    const handler = sliceBetween(workerPool, "case 'model_fallback': {", "case 'codex_service_tier':");
    expect(handler).toContain('ds.workerGeneration !== workerGeneration');
    expect(handler).toContain('ds.session.workerGeneration !== workerGeneration');
    expect(handler).toContain("if (effectiveCliId !== 'claude-code') break;");
    expect(handler).toContain('mergeModelFallbackObservation(ds.modelFallback, msg)');
    expect(handler).toContain('if (!merged.changed) break;');
    expect(handler).toContain('persistStreamCardState(ds);');
    expect(handler).toContain('scheduleActiveRuntimePatch(ds);');
    // The daemon must never take a "no fallback" claim from the worker.
    expect(handler).not.toContain('msg.state');
  });

  it('keeps the notice across worker generations for claude-code sessions', () => {
    // The persisted state is the authority: a new worker only moves it with
    // positive evidence. Clearing on respawn (and hoping the re-seed finds the
    // record again) loses the notice for good once the switch scrolls out of
    // the bounded tail scan. Only a role switch AWAY from claude-code clears.
    const generationReset = sliceBetween(workerPool, 'ds.codexServiceTier = undefined;', 'const handlerSession');
    expect(generationReset).toContain("!== 'claude-code'");
    expect(generationReset).toMatch(
      /if \(sessionCliId\(ds, getBot\(ds\.larkAppId\)\.config\) !== 'claude-code'\) \{\s*ds\.modelFallback = undefined;\s*\}/,
    );
    // …and there is no second, statement-level (2-space indent) clear next to
    // the other unconditional runtime resets.
    expect(generationReset).not.toMatch(/\n {2}ds\.modelFallback = undefined;/);
    expect(generationReset.match(/ds\.modelFallback = undefined;/g)).toHaveLength(1);
  });

  it('clears only on a serving model that disagrees with the held record', () => {
    const merge = sliceBetween(workerPool, 'export function mergeModelFallbackObservation(', '\n}\n');
    expect(merge).toContain('normalizeClaudeModelId(msg.servingModel)');
    expect(merge).toContain('normalizeClaudeModelId(next.fallbackModel)');
    expect(merge).toContain('next = undefined;');
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

  it('gates the parse on Fable originals, so every consumer inherits it', () => {
    const transcript = readFileSync(resolve(__dirname, '../src/services/claude-transcript.ts'), 'utf8');
    expect(sliceBetween(transcript, 'export function parseClaudeModelFallbackEvent(', '\n}\n'))
      .toContain('if (!isFableModelId(originalModel)) return undefined;');
  });
});
