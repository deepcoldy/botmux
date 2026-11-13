import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonSession } from '../src/core/types.js';
import { applyNativeReasoningObservation } from '../src/core/native-reasoning-observation.js';
import { withCardRuntimeIdentity } from '../src/core/card-runtime-identity.js';
import { cardUsageRuntimeSegment } from '../src/im/lark/md-card.js';
import { appliedReasoningSelectionFromRecord, type NativeReasoningObservation } from '../src/services/native-reasoning-observation.js';
import { drainCodexRollout, codexGenerationSessionIdFromRolloutPath } from '../src/services/codex-transcript.js';
import { drainTraexRollout, traexSessionIdFromRolloutPath } from '../src/services/traex-transcript.js';
import { readGrokRuntimeObservation } from '../src/services/grok-runtime-observer.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { loadWorkerPoolMessageHandlers } from './helpers/worker-pool-message-harness.js';

const NOW = 1_799_000_000_000;
const SID = '11111111-2222-4333-8444-555555555555';
const worker = {} as NonNullable<DaemonSession['worker']>;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'four-cli-effort-')); vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
function ds(cliId: NativeReasoningObservation['cliId']): DaemonSession {
  return { worker, workerGeneration: 4, activeModel: 'model-before', activeReasoningEffort: 'high',
    session: { sessionId: 'botmux-sid', cliSessionId: SID, cliId,
      reasoningEffort: 'high', model: 'launch-model', workerGeneration: 4 } } as DaemonSession;
}
function wiring(state: DaemonSession) {
  const patched: ReturnType<typeof withCardRuntimeIdentity>[] = [];
  const handle = loadWorkerPoolMessageHandlers(['native_reasoning', 'active_runtime'], {
    ds: state, worker, workerGeneration: 4, effectiveCliId: state.session.cliId,
    applyNativeReasoningObservation, scheduleActiveRuntimePatch: () => patched.push(
      withCardRuntimeIdentity(state, { context: null, tokens: null })),
  });
  return { patched, handle, publish: (value: NativeReasoningObservation) => handle({ type: 'native_reasoning', ...value }) };
}
function settings(effort: unknown, time = NOW) {
  return { type: 'event_msg', timestamp: new Date(time).toISOString(), payload: {
    type: 'thread_settings_applied', thread_id: SID, thread_settings: { reasoning_effort: effort },
  } };
}

describe('four CLI reasoning observations', () => {
  it.each(['codex', 'traex'] as const)('%s shows a native settings change before a new turn_context', cliId => {
    const path = join(dir, `rollout-2026-11-12-${SID}.jsonl`);
    const context = { type: 'turn_context', timestamp: new Date(NOW - 10).toISOString(),
      payload: { model: 'model-before', reasoning_effort: 'high' } };
    writeFileSync(path, [context, settings('medium')].map(r => JSON.stringify(r)).join('\n') + '\n');
    const state = ds(cliId); const wire = wiring(state);
    const scope = {
      lastInitConfig: { cliId }, codexBridgeRolloutPath: path, nativeReasoningNotBeforeMs: NOW - 1,
      codexGenerationSessionIdFromRolloutPath, traexSessionIdFromRolloutPath,
      publishNativeReasoningObservation: wire.publish, structuredBridgeDriverState: undefined,
      nativeGoalSourcePath: undefined, nativeGoalGeneration: undefined, cliSpawnGeneration: 1,
      nativeGoalCardEnabled: () => false,
      bridgeSpecFor: () => ({ stateCommit: 'ingest', drain: (p: string, offset: number) =>
        cliId === 'codex' ? drainCodexRollout(p, offset) : drainTraexRollout(p, offset) }),
      structuredBridgeIs: (id: string) => id === cliId,
      codexEventsWithStableIds: (_path: string, events: unknown[]) => events,
    };
    const ingest = loadWorkerFunction<(p: string, offset: number) => ReturnType<typeof drainCodexRollout>>('structuredBridgeIngestPath', scope);
    const result = ingest(path, 0);
    expect(result.latestReasoningEffort).toBe('high');
    expect(result.latestReasoningSelection?.reasoningEffort).toBe('medium');
    expect(result.events.some(e => e.kind === 'assistant_final')).toBe(false);
    const publish = loadWorkerFunction<(p: string, value: typeof result.latestReasoningSelection) => void>(
      'publishAppliedReasoningSelection', { lastInitConfig: { cliId }, codexBridgeRolloutPath: path,
        nativeReasoningNotBeforeMs: NOW - 1, codexGenerationSessionIdFromRolloutPath, traexSessionIdFromRolloutPath,
        publishNativeReasoningObservation: wire.publish });
    expect(wire.patched.at(-1)?.reasoningEffort).toBe('medium');
    expect(cardUsageRuntimeSegment(wire.patched.at(-1)!)).toMatch(/medium（[^（）]+）/);
    expect(state.activeReasoningEffort).toBe('high');
    expect(state.session.reasoningEffort).toBe('high');
    wire.handle({ type: 'active_runtime', model: 'model-before', reasoningEffort: 'high' });
    expect(withCardRuntimeIdentity(state, { context: null, tokens: null }).reasoningEffort).toBe('medium');
    publish(path, { ...result.latestReasoningSelection!, reasoningEffort: null });
    expect(wire.patched.at(-1)?.reasoningEffort).toBeUndefined();
  });

  it('native process attestation retires the previous Grok display generation', () => {
    const state = ds('grok'); state.localProcessAttestation = { cliSpawnGeneration: 1 } as any;
    const handle = loadWorkerPoolMessageHandlers(['native_reasoning', 'local_process_attestation'], {
      ds: state, worker, workerGeneration: 4, effectiveCliId: 'grok', applyNativeReasoningObservation,
      scheduleActiveRuntimePatch: vi.fn(), logger: { warn: vi.fn() }, t: 'test',
    });
    handle({ type: 'native_reasoning', cliId: 'grok', nativeSessionId: SID,
      reasoningEffort: 'medium', source: 'native-summary', cliSpawnGeneration: 1 });
    expect(withCardRuntimeIdentity(state, { context: null, tokens: null }).reasoningEffort).toBe('medium');
    handle({ type: 'local_process_attestation', cliSpawnGeneration: 2 });
    expect(state.nativeReasoningObservation).toBeUndefined();
    expect(withCardRuntimeIdentity(state, { context: null, tokens: null }).reasoningEffort).toBeUndefined();
  });

  it('publisher deduplicates unchanged UI readings but keeps their clock against a delayed older ACK', () => {
    const send = vi.fn();
    const scope = { backend: {}, closeRequested: false, lastInitConfig: { cliId: 'codex' },
      workerSessionEventScope: undefined, cliLifetimeNonce: 'current-cli', cliSpawnGeneration: 1,
      lastNativeReasoningKey: undefined, nativeReasoningClock: undefined, send };
    const publish = loadWorkerFunction<(reading: NativeReasoningObservation) => void>('publishNativeReasoningObservation', scope);
    const reading: NativeReasoningObservation = { cliId: 'codex', nativeSessionId: SID,
      reasoningEffort: 'medium', source: 'native-footer', observedAtMs: NOW - 2 };
    publish(reading); publish({ ...reading, observedAtMs: NOW });
    publish({ ...reading, source: 'native-settings', reasoningEffort: 'high', observedAtMs: NOW - 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ reasoningEffort: 'medium', cliSpawnGeneration: 1 });
  });

  it.each(['codex', 'traex'] as const)('%s passively follows the live footer without sending input', cliId => {
    const state = ds(cliId); const wire = wiring(state);
    const publish = loadWorkerFunction<(screen: string) => void>('publishNativeReasoningFooter', {
      lastInitConfig: { cliId, cliSessionId: SID }, publishNativeReasoningObservation: wire.publish,
    });
    for (const level of ['high', 'medium']) {
      const screen = cliId === 'codex' ? `› \n  gpt-6.1-sol ${level} · 98% context left\n  ? for shortcuts`
        : `${'─'.repeat(80)}\n❯ Explain this codebase\n${'─'.repeat(80)}\n  GPT-6.1-Sol ${level} · /fixture · Context 98% left\n  ? for shortcuts`;
      publish(screen);
    }
    expect(wire.patched.map(p => p.reasoningEffort)).toEqual(['high', 'medium']);
    expect(state.activeModel).toBe('model-before');
  });

  it('Grok prefers native summary state with usage hidden, including against an older usage snapshot', () => {
    const sessionDir = join(dir, SID); mkdirSync(sessionDir);
    const state = ds('grok'); const wire = wiring(state);
    for (const [level, time] of [['high', NOW], ['medium', NOW + 1]] as const) {
      vi.setSystemTime(time);
      const file = join(sessionDir, 'summary.json');
      writeFileSync(file, JSON.stringify({ current_model_id: 'native-grok', reasoning_effort: level }));
      utimesSync(file, new Date(time), new Date(time));
      wire.publish(readGrokRuntimeObservation(sessionDir, SID, time));
    }
    const out = withCardRuntimeIdentity(state, { context: null, tokens: null,
      model: 'old-snapshot-model', reasoningEffort: 'high' });
    expect(out).toMatchObject({ model: 'native-grok', reasoningEffort: 'medium' });
    expect(state.activeReasoningEffort).toBe('medium');
    expect(state.session).toMatchObject({ model: 'launch-model', reasoningEffort: 'high' });
    rmSync(join(sessionDir, 'summary.json'));
    wire.publish(readGrokRuntimeObservation(sessionDir, SID, NOW + 2));
    expect(wire.patched.at(-1)?.reasoningEffort).toBeUndefined();
  });

  it('Antigravity ACP selection changes do not replace its established model observer', () => {
    const state = ds('antigravity'); const wire = wiring(state);
    for (const level of ['high', 'medium'] as const) wire.publish({ cliId: 'antigravity', nativeSessionId: SID,
      reasoningEffort: level, source: 'acp-config', model: 'must-not-change-model' });
    expect(wire.patched.at(-1)).toMatchObject({ model: 'model-before', reasoningEffort: 'medium', reasoningEffortSource: 'selected' });
    wire.handle({ type: 'active_runtime', model: 'existing-model-observer', reasoningEffort: null });
    expect(wire.patched.at(-1)).toMatchObject({ model: 'existing-model-observer', reasoningEffort: 'medium' });
    wire.publish({ cliId: 'antigravity', nativeSessionId: SID, reasoningEffort: null, source: 'acp-config' });
    expect(wire.patched.at(-1)?.reasoningEffort).toBeUndefined();
  });

  it.each(['codex', 'traex', 'grok', 'antigravity'] as const)('%s omits a launch effort when no observation exists', cliId => {
    const state = ds(cliId); state.activeReasoningEffort = undefined;
    expect(withCardRuntimeIdentity(state, { context: null, tokens: null }).reasoningEffort).toBeUndefined();
    expect(state.activeModel).toBe('model-before');
  });

  it('keeps Claude and other CLI behavior and refuses stale/foreign native observations', () => {
    for (const cliId of ['claude-code', 'kimi', 'zcode', 'minimax'] as const) {
      const state = ds('codex'); state.session.cliId = cliId; state.activeReasoningEffort = 'medium';
      expect(withCardRuntimeIdentity(state, { context: null, tokens: null }).reasoningEffort).toBe('medium');
    }
    const state = ds('codex'); const value: NativeReasoningObservation = {
      cliId: 'codex', nativeSessionId: SID, reasoningEffort: 'medium', source: 'native-settings' };
    const source = { worker, workerGeneration: 4, cliId: 'codex' };
    expect(applyNativeReasoningObservation(state, value, { ...source, workerGeneration: 3 })).toBe(false);
    expect(applyNativeReasoningObservation(state, { ...value, nativeSessionId: 'foreign' }, source)).toBe(false);
    expect(applyNativeReasoningObservation(state, { ...value, source: 'native-summary' }, source)).toBe(false);
    expect(applyNativeReasoningObservation(state, { ...value, reasoningEffort: 'bogus' } as any, source)).toBe(false);
    expect(state.nativeReasoningObservation).toBeUndefined();
  });

  it('ignores quoted, malformed, partial, and service-tier-only settings as effort selections', () => {
    const value = settings('medium');
    expect(appliedReasoningSelectionFromRecord({ type: 'response_item', payload: value })).toBeUndefined();
    expect(appliedReasoningSelectionFromRecord(settings('bogus'))).toBeUndefined();
    expect(appliedReasoningSelectionFromRecord({ ...value, timestamp: 'bad' })).toBeUndefined();
    expect(appliedReasoningSelectionFromRecord({ ...value, payload: { ...value.payload,
      thread_settings: { service_tier: 'fast' } } })).toBeUndefined();
  });

  it('rejects an older viewport and stale native process generation without restoring launch values', () => {
    const state = ds('codex');
    const source = { worker, workerGeneration: 4, cliId: 'codex' };
    const reading: NativeReasoningObservation = { cliId: 'codex', nativeSessionId: SID,
      reasoningEffort: 'medium', source: 'native-settings', observedAtMs: NOW };
    expect(applyNativeReasoningObservation(state, reading, source)).toBe(true);
    expect(applyNativeReasoningObservation(state, { ...reading, source: 'native-footer',
      reasoningEffort: 'high', observedAtMs: NOW - 1 }, source)).toBe(false);
    expect(withCardRuntimeIdentity(state, { context: null, tokens: null }).reasoningEffort).toBe('medium');
    state.localProcessAttestation = { cliSpawnGeneration: 2 } as any;
    expect(applyNativeReasoningObservation(state, { ...reading, cliSpawnGeneration: 1 }, source)).toBe(false);
    expect(withCardRuntimeIdentity(state, { context: null, tokens: null }).reasoningEffort).toBeUndefined();
  });

  it('a missing Grok file does not advance its evidence clock past a later file write', () => {
    const state = ds('grok'); const source = { worker, workerGeneration: 4, cliId: 'grok' };
    const base: NativeReasoningObservation = { cliId: 'grok', nativeSessionId: SID,
      reasoningEffort: 'high', source: 'native-summary', observedAtMs: NOW - 10 };
    applyNativeReasoningObservation(state, base, source);
    applyNativeReasoningObservation(state, { ...base, reasoningEffort: null, observedAtMs: undefined }, source);
    expect(applyNativeReasoningObservation(state, { ...base, reasoningEffort: 'medium', observedAtMs: NOW - 1 }, source)).toBe(true);
    expect(withCardRuntimeIdentity(state, { context: null, tokens: null }).reasoningEffort).toBe('medium');
  });
});
