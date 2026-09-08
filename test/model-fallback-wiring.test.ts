import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-lock for the model-fallback wiring — the seams a behavioural unit test
 * cannot reach (IPC hook-up, worker-generation authority, cold-start seed, the
 * cliId gates, and the fan-out of transcript drains). Same idiom as
 * codex-active-runtime-wiring.test.ts.
 *
 * The invariants these locks defend:
 *   - the notice is claude-code + Fable only, and once shown it stays shown
 *     every round until POSITIVE evidence retires it (a different serving
 *     model, a newer non-Fable switch, another Claude session). No "not found"
 *     path may ever clear it;
 *   - EVERY transcript drain that feeds the bridge queue also feeds the
 *     fallback observer — bridgeIngest is only one of seven (P1-2);
 *   - the state is bound to a Claude session id, re-declared at every
 *     bind/switch of the primary path (P1-3).
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
    expect(ingest).toContain('observeModelFallbackEvents(bridgeJsonlPath, result.events);');
    expect(worker).not.toContain('observeModelFallbackEvents(codex');
  });

  describe('P1-2: every queue-feeding drain reaches the observer', () => {
    // The bug: bridgeIngest was the ONLY drain wired to the observer, while the
    // adopt baseline, the journal restore, the fingerprint switch, the
    // fd-rotation switch, drainPathInto and the secondary-path sweep all pull
    // transcript events into the same queue. A switch record that arrived
    // through any of those was silently dropped.
    //
    // Slice the file at each `drainTranscript(` call site: whichever slice
    // hands events to bridgeQueue must also hand them to the one observer
    // entry. That way a NEW drain added later fails this test by construction.
    const CALL = 'drainTranscript(';
    const sites: number[] = [];
    for (let i = worker.indexOf(CALL); i >= 0; i = worker.indexOf(CALL, i + CALL.length)) {
      // Skip the import statement and prose mentions.
      if (/[A-Za-z0-9_$.]/.test(worker[i - 1] ?? '')) continue;
      sites.push(i);
    }
    const slices = sites.map((start, i) => ({
      line: worker.slice(0, start).split('\n').length,
      text: worker.slice(start, sites[i + 1] ?? worker.length),
    }));
    const feedsQueue = slices.filter(s =>
      s.text.includes('bridgeQueue.ingest(') || s.text.includes('bridgeQueue.absorb('));

    it('finds every call site (guard against the slicer silently matching none)', () => {
      expect(sites.length).toBeGreaterThanOrEqual(8);
      expect(feedsQueue.length).toBeGreaterThanOrEqual(7);
    });

    it('routes each of them through observeModelFallbackEvents', () => {
      for (const slice of feedsQueue) {
        expect(slice.text, `drainTranscript( at worker.ts:${slice.line} feeds bridgeQueue `
          + 'but never reaches observeModelFallbackEvents')
          .toContain('observeModelFallbackEvents(');
      }
    });

    it('keeps one observer entry, which owns the cliId gate and the routing', () => {
      const entry = sliceBetween(worker, 'function observeModelFallbackEvents(', '\n}\n');
      expect(entry).toContain("lastInitConfig?.cliId !== 'claude-code'");
      expect(entry).toContain('sessionIdFromJsonlPath(path)');
      // Bound session → observe; a different session on the CURRENT primary
      // path → rebind; a different session on a secondary/retired path → drop.
      expect(entry).toContain('modelFallbackTracker.boundClaudeSessionId');
      expect(entry).toContain('if (path !== bridgeJsonlPath) return;');
      expect(entry).toContain('modelFallbackTracker.bind(claudeSessionId);');
      expect(entry).toContain('modelFallbackTracker.observe(events)');
      // …and it is the only observe() caller.
      expect(worker.match(/modelFallbackTracker\.observe\(/g)).toHaveLength(1);
    });
  });

  it('gates both the observe and the seed path on cliId claude-code', () => {
    // Belt and braces over the call site: the notice is a claude-code product
    // affordance, so a future non-Claude caller of these helpers stays inert.
    expect(sliceBetween(worker, 'function observeModelFallbackEvents(', '\n}\n'))
      .toContain("lastInitConfig?.cliId !== 'claude-code'");
    expect(sliceBetween(worker, 'function seedModelFallbackFromTranscript(', '\n}\n'))
      .toContain("lastInitConfig?.cliId !== 'claude-code'");
  });

  it('reports facts only — an empty tail scan is never turned into a clear', () => {
    // The old bug: the seed published a "no fallback" decision whenever its
    // bounded tail scan found nothing, wiping the daemon's persisted notice on
    // every long session. Absence still says nothing; the two shapes that DO
    // clear are positive evidence the daemon applies (a foreign
    // claudeSessionId, and fallback: null from the newest switch record).
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
    // bridgeAbsorbBaseline cursors the non-adopt branch straight to EOF, so a
    // switch already written to the file is never drained and only the tail
    // scan can recover it — this second baseline site needs it too.
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
    // F2: the gate must fire BEFORE the merge and the state write. A toContain
    // shape lock is blind to the gate being moved below them, which would let
    // a non-Claude worker move the state (the worker-side gates make that
    // unlikely, but this is the daemon's defense-in-depth — keep it load-bearing).
    expect(handler.indexOf("if (effectiveCliId !== 'claude-code') break;"))
      .toBeLessThan(handler.indexOf('mergeModelFallbackObservation(ds.modelFallback, msg)'));
    expect(handler.indexOf('mergeModelFallbackObservation(ds.modelFallback, msg)'))
      .toBeLessThan(handler.indexOf('ds.modelFallback = merged.next'));
    // State is written and persisted only when the merge actually moved it.
    expect(handler).toMatch(
      /if \(merged\.changed\) \{\s*ds\.modelFallback = merged\.next;\s*persistStreamCardState\(ds\);\s*\}/,
    );
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
      /if \(sessionCliId\(ds, getBot\(ds\.larkAppId\)\.config\) !== 'claude-code'\) \{\s*ds\.modelFallback = undefined;\s*persistStreamCardState\(ds\);\s*\}/,
    );
    // …and there is no second, statement-level (2-space indent) clear next to
    // the other unconditional runtime resets.
    expect(generationReset).not.toMatch(/\n {2}ds\.modelFallback = undefined;/);
    expect(generationReset.match(/ds\.modelFallback = undefined;/g)).toHaveLength(1);
  });

  it('clears only on a serving model back on a Fable model', () => {
    const merge = sliceBetween(workerPool, 'export function mergeModelFallbackObservation(', '\n}\n');
    expect(merge).toContain('normalizeClaudeModelId(msg.servingModel)');
    // The clear predicate is "back on a Fable model", NOT "differs from the
    // fallback model": a drift onto a third non-Fable model must keep the
    // notice (see model-fallback-daemon-state F1 regression).
    expect(merge).toContain('isFableModelId(serving)');
    expect(merge).not.toContain('normalizeClaudeModelId(next.fallbackModel)');
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

  describe('P1-3: the state is bound to a Claude session', () => {
    it('re-seeds at every bind/switch of the primary path', () => {
      // Five places move bridgeJsonlPath. Each must re-declare which Claude
      // conversation the worker is now on, or the daemon keeps showing (or can
      // never clear) a notice that belongs to the previous one.
      const SEED = 'seedModelFallbackFromTranscript();';
      for (const [name, slice] of [
        ['startBridgeWatcher', sliceBetween(worker, 'function startBridgeWatcher(', 'function stopBridgeWatcher(')],
        ['lazy baseline', sliceBetween(worker, 'if (!bridgeBaselineDone) {', '\n  }\n')],
        ['fingerprint switch', sliceBetween(worker, 'function bridgeApplyFingerprintSwitch(', '\n}\n')],
        ['rotation switch', sliceBetween(worker, 'function performRotationSwitch(', '\n}\n')],
        // The pid resolver is the fifth: it swaps the path and cursors to 0
        // WITHOUT draining, so nothing else here would rebind the tracker until
        // the new transcript happens to hold something observable.
        ['pid-resolver switch', sliceBetween(worker, 'function maybeFollowSessionRotationViaPid(', '\nfunction bridgeIngest(')],
      ] as const) {
        expect(slice, `${name} does not re-seed the fallback tracker`).toContain(SEED);
      }
      expect(worker.match(/seedModelFallbackFromTranscript\(\);/g)).toHaveLength(5);
      // Guard against a SIXTH switch site appearing unnoticed: three of the six
      // assignments are startBridgeWatcher's own (initial bind + the pid-file
      // and fd-probe adjustments it makes before its single seed); the other
      // three are the fingerprint, fd-rotation and pid-resolver switches above.
      expect(worker.match(/\bbridgeJsonlPath = /g)).toHaveLength(6);
    });

    it('the seed ALWAYS publishes, even when the scan found nothing', () => {
      // The empty message is what tells the daemon to drop another session's
      // state. `seed` therefore returns a value, not a nullable one, and the
      // helper has no "found nothing → return" arm.
      const seed = sliceBetween(worker, 'function seedModelFallbackFromTranscript(', '\n}\n');
      expect(seed).toContain('let seeded: ModelFallbackObservation;');
      expect(seed).toContain('modelFallbackTracker.seed(bridgeJsonlPath, claudeSessionId)');
      expect(seed).toContain('reportModelFallbackObservation(seeded);');
      expect(seed).not.toContain('if (!seeded) return;');
      const tracker = readFileSync(resolve(__dirname, '../src/services/claude-transcript.ts'), 'utf8');
      expect(sliceBetween(tracker, '  seed(path: string, claudeSessionId: string)', '\n  }\n'))
        .toContain('?? { claudeSessionId: this.claudeSessionId }');
    });

    it('the daemon drops state belonging to another Claude session first', () => {
      const merge = sliceBetween(workerPool, 'export function mergeModelFallbackObservation(', '\n}\n');
      const dropIdx = merge.indexOf('next.claudeSessionId !== msg.claudeSessionId');
      const recordIdx = merge.indexOf('msg.fallback === null');
      expect(dropIdx).toBeGreaterThanOrEqual(0);
      // Rule (a) runs BEFORE the record and serving-model rules.
      expect(recordIdx).toBeGreaterThan(dropIdx);
      // The record is stamped with the message's session, and `changed` is
      // identity over uuid AND session so the stamping is persisted.
      expect(merge).toContain('claudeSessionId: msg.claudeSessionId');
      expect(merge).toContain("current?.claudeSessionId !== next?.claudeSessionId");
    });
  });

  it('P1-4: the serving model becomes the card usage line\'s runtime model', () => {
    // Claude Code never emits `active_runtime`, so without this the usage line
    // shows the LAUNCH model forever while a fallback answers. Same
    // "changed-only + patch" semantics as the active_runtime handler; effort is
    // untouched because Claude reports none.
    const handler = sliceBetween(workerPool, "case 'model_fallback': {", "case 'codex_service_tier':");
    expect(handler).toContain('normalizeClaudeModelId(msg.servingModel)');
    expect(handler).toContain('ds.activeModel !== servingModel');
    expect(handler).toContain('ds.activeModel = servingModel;');
    expect(handler).toContain('if (merged.changed || runtimeChanged) scheduleActiveRuntimePatch(ds);');
    expect(handler).not.toContain('ds.activeReasoningEffort');
    // A card patch requires a real change on one of the two axes; nothing is
    // patched for a message that moved neither.
    expect(handler).not.toMatch(/\n\s*scheduleActiveRuntimePatch\(ds\);\n\s*break;/);
  });

  it('P2-3: a role switch away from claude-code clears the notice on disk too', () => {
    // Memory-only clearing left the mirror on Session.modelFallback, so a
    // daemon restart revived the notice on a session no longer running Claude.
    const generationReset = sliceBetween(workerPool, 'ds.codexServiceTier = undefined;', 'const handlerSession');
    expect(generationReset).toMatch(
      /ds\.modelFallback = undefined;\s*persistStreamCardState\(ds\);/,
    );
  });

  it('P2-2: the parse keeps every session switch, flagged rather than dropped', () => {
    // Dropping non-Fable records at parse time let the backward tail scan walk
    // past the newest one and resurrect an older Fable notice.
    const transcript = readFileSync(resolve(__dirname, '../src/services/claude-transcript.ts'), 'utf8');
    const parse = sliceBetween(transcript, 'export function parseClaudeModelFallbackEvent(', '\n}\n');
    expect(parse).not.toContain('if (!isFableModelId(originalModel)) return undefined;');
    expect(parse).toContain('fable: isFableModelId(originalModel),');
    expect(parse).toContain('neutralizedByFork: ev.neutralizedByFork === true,');
    // The Fable scope now lives in ONE mapper both the scan and the tracker use.
    expect(sliceBetween(transcript, 'function noticeFromSessionRecord(', '\n}\n'))
      .toContain('rec.fable && !rec.neutralizedByFork ? rec : null');
    expect(transcript.match(/noticeFromSessionRecord\(/g)).toHaveLength(3);
  });
});
