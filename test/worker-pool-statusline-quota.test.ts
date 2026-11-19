/**
 * getDaemonSessionUsageSnapshot 是回复卡页脚 / 流式卡用量行 / IPC `/usage` 三个读取点的
 * 唯一汇合处：Claude Code / Antigravity statusline 快照（ctx / 5h / 7d）只在这里合并一次。
 * 无快照 / 陈旧 / 其它 CLI ⇒ 原样返回 transcript 快照（同一对象，不带 quota key），
 * 保证卡片与无 statusline 时逐字节相同。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import * as costCalculator from '../src/core/cost-calculator.js';
import * as botRegistry from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';
import { __testOnly_cardFooterExtensionCache } from '../src/services/card-footer-extension.js';
import {
  __testOnly_resetRestartCoordinator,
  __testOnly_sessionAgentConfig,
  getDaemonSessionUsageSnapshot,
  latestModelForRespawn,
  requestSessionRestart,
} from '../src/core/worker-pool.js';
import {
  __testOnly_resetStatuslineCache,
  statuslineFilePath,
  STATUSLINE_STALE_MS,
  writeStatuslineSnapshot,
} from '../src/services/statusline-snapshot.js';
import { normalizeClaudeModelId } from '../src/services/claude-transcript.js';
import { loadWorkerPoolMessageHandlers } from './helpers/worker-pool-message-harness.js';

let dataDir: string;
let prevDataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-wp-statusline-'));
  prevDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  __testOnly_resetStatuslineCache();
});
afterEach(() => {
  __testOnly_resetRestartCoordinator();
  config.session.dataDir = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// 不带 larkAppId：pricing 解析短路为 undefined，且 cliId 由显式参数给出，不触碰 bot registry。
const ds = (sessionId: string) => ({ session: { sessionId }, workingDir: '/repo' }) as any;

describe('getDaemonSessionUsageSnapshot × Claude statusline quota', () => {
  it('merges the on-disk statusline snapshot for claude-code (rounded percentages)', () => {
    const base = { context: { usedTokens: 12_345 }, tokens: { in: 1, out: 2 } };
    vi.spyOn(costCalculator, 'getSessionUsageSnapshot').mockReturnValue(base as any);
    writeStatuslineSnapshot(dataDir, 's1', { ts: Date.now(), contextPercent: 23.4, fiveHourPercent: 18, sevenDayPercent: 5.4 });
    expect(getDaemonSessionUsageSnapshot(ds('s1'), 'claude-code')).toEqual({
      ...base,
      quota: { contextPercent: 23, fiveHourPercent: 18, sevenDayPercent: 5 },
    });
  });

  it('returns the transcript snapshot untouched (same object, no quota key) when no snapshot exists', () => {
    const base = { context: { usedTokens: 12_345 }, tokens: null };
    vi.spyOn(costCalculator, 'getSessionUsageSnapshot').mockReturnValue(base as any);
    const out = getDaemonSessionUsageSnapshot(ds('s2'), 'claude-code');
    expect(out).toBe(base);
    expect('quota' in out).toBe(false);
  });

  it('merges the on-disk statusline snapshot for antigravity (including resumed snapshots without contextPercent)', () => {
    const base = { context: { usedTokens: 230_000, windowTokens: 1_000_000, percentUsed: 23 }, tokens: { in: 300_000, out: 12_000 } };
    vi.spyOn(costCalculator, 'getSessionUsageSnapshot').mockReturnValue(base as any);
    writeStatuslineSnapshot(dataDir, 's-agy', { ts: Date.now(), fiveHourPercent: 20.9, sevenDayPercent: 6.7 });
    expect(getDaemonSessionUsageSnapshot(ds('s-agy'), 'antigravity')).toEqual({
      ...base,
      quota: { fiveHourPercent: 21, sevenDayPercent: 7 },
    });
  });

  it('ignores the snapshot for other CLIs even when a file exists', () => {
    const base = { context: null, tokens: { in: 1, out: 2 } };
    vi.spyOn(costCalculator, 'getSessionUsageSnapshot').mockReturnValue(base as any);
    writeStatuslineSnapshot(dataDir, 's3', { ts: Date.now(), fiveHourPercent: 18 });
    expect(getDaemonSessionUsageSnapshot(ds('s3'), 'codex' as any)).toBe(base);
  });

  it('drops a stale snapshot (older than STATUSLINE_STALE_MS) → no quota key', () => {
    const base = { context: { usedTokens: 1 }, tokens: null };
    vi.spyOn(costCalculator, 'getSessionUsageSnapshot').mockReturnValue(base as any);
    writeStatuslineSnapshot(dataDir, 's4', { ts: Date.now() - STATUSLINE_STALE_MS - 1, contextPercent: 50 });
    expect(getDaemonSessionUsageSnapshot(ds('s4'), 'claude-code')).toBe(base);
  });

  it('matches Antigravity slug launch models with statusLine display names and rejects cross-family or cross-variant stale snapshots', () => {
    const base = { context: { usedTokens: 10 }, tokens: { in: 1, out: 2 } };
    vi.spyOn(costCalculator, 'getSessionUsageSnapshot').mockReturnValue(base as any);
    const now = Date.now();

    // Matching slug ↔ display name (Neon & Orchestrator Argon)
    writeStatuslineSnapshot(dataDir, 's-agy-neon', {
      ts: now, model: 'Gemini 4 Neon (XHigh)', fiveHourPercent: 21, sevenDayPercent: 7,
    });
    expect(getDaemonSessionUsageSnapshot({
      session: { sessionId: 's-agy-neon', model: 'gemini-4-neon-xhigh' }, workingDir: '/repo',
    } as any, 'antigravity')).toEqual({ ...base, quota: { fiveHourPercent: 21, sevenDayPercent: 7 } });

    writeStatuslineSnapshot(dataDir, 's-agy-orch', {
      ts: now, model: 'Orchestrator (Argon)', fiveHourPercent: 21, sevenDayPercent: 45,
    });
    expect(getDaemonSessionUsageSnapshot({
      session: { sessionId: 's-agy-orch', model: 'gemini-pro-orchestrator-g1-pro' }, workingDir: '/repo',
    } as any, 'antigravity')).toEqual({ ...base, quota: { fiveHourPercent: 21, sevenDayPercent: 45 } });

    // Cross-family switch (Claude 3P snapshot left on disk after switching to Gemini Neon) → rejected
    writeStatuslineSnapshot(dataDir, 's-agy-3p-stale', {
      ts: now, model: 'Claude Opus 5.5 (High)', fiveHourPercent: 60, sevenDayPercent: 15,
    });
    expect(getDaemonSessionUsageSnapshot({
      session: { sessionId: 's-agy-3p-stale', model: 'gemini-4-neon-xhigh' }, workingDir: '/repo',
    } as any, 'antigravity')).toBe(base);

    // Cross-variant Gemini switch (Argon WTU weekly snapshot left after switching to Neon) → rejected
    writeStatuslineSnapshot(dataDir, 's-agy-argon-stale', {
      ts: now, model: 'Gemini 4 Argon (High)', fiveHourPercent: 21, sevenDayPercent: 45,
    });
    expect(getDaemonSessionUsageSnapshot({
      session: { sessionId: 's-agy-argon-stale', model: 'gemini-4-neon-xhigh' }, workingDir: '/repo',
    } as any, 'antigravity')).toBe(base);
  });

  it('rejects snapshots written before statuslineNotBeforeMs and ignores stale pre-restart activeModel once invalidated', () => {
    const base = { context: { usedTokens: 10 }, tokens: null };
    vi.spyOn(costCalculator, 'getSessionUsageSnapshot').mockReturnValue(base as any);
    const now = Date.now();

    // Even without a configured model, launch-generation notBefore blocks pre-restart snapshots
    writeStatuslineSnapshot(dataDir, 's-gen', { ts: now - 5_000, fiveHourPercent: 80, sevenDayPercent: 40 });
    expect(getDaemonSessionUsageSnapshot({
      session: { sessionId: 's-gen' }, statuslineNotBeforeMs: now - 1_000, workingDir: '/repo',
    } as any, 'antigravity')).toBe(base);

    // After restart invalidation, a stale pre-restart activeModel (e.g. from prior model_fallback)
    // does not falsely reject a fresh snapshot matching the new launch model
    writeStatuslineSnapshot(dataDir, 's-fallback-restart', {
      ts: now, model: 'claude-opus-5[1m]', fiveHourPercent: 12, sevenDayPercent: 4,
    });
    expect(getDaemonSessionUsageSnapshot({
      session: { sessionId: 's-fallback-restart', model: 'opus' },
      activeModel: 'claude-sonnet-5',
      statuslineActiveModelStale: true,
      statuslineNotBeforeMs: now - 100,
      workingDir: '/repo',
    } as any, 'claude-code')).toEqual({ ...base, quota: { fiveHourPercent: 12, sevenDayPercent: 4 } });

    // Without invalidation (fresh activeModel from live fallback), an older family's snapshot is rejected
    writeStatuslineSnapshot(dataDir, 's-fallback-live', {
      ts: now, model: 'claude-fable-5', fiveHourPercent: 90, sevenDayPercent: 50,
    });
    expect(getDaemonSessionUsageSnapshot({
      session: { sessionId: 's-fallback-live', model: 'claude-fable-5' },
      activeModel: 'claude-sonnet-5',
      workingDir: '/repo',
    } as any, 'claude-code')).toBe(base);
  });

  it('records a changed launch model without prematurely clearing statusline, then commits stale state on fresh attestation', () => {
    const base = { context: { usedTokens: 10 }, tokens: null };
    vi.spyOn(costCalculator, 'getSessionUsageSnapshot').mockReturnValue(base as any);
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    const now = Date.now();

    // Unchanged launch model preserves the existing snapshot file.
    writeStatuslineSnapshot(dataDir, 's-same', {
      ts: now, model: 'Gemini 4 Neon (XHigh)', fiveHourPercent: 20, sevenDayPercent: 8,
    });
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({
      config: { cliId: 'antigravity', name: 'agy', model: 'gemini-4-neon-xhigh' },
    } as any);
    const sameDs = {
      larkAppId: 'cli_agy',
      session: { sessionId: 's-same', cliId: 'antigravity', model: 'gemini-4-neon-xhigh' },
      workingDir: '/repo',
    } as any;
    expect(latestModelForRespawn(sameDs)).toBe('gemini-4-neon-xhigh');
    expect(existsSync(statuslineFilePath(dataDir, 's-same'))).toBe(true);
    expect(sameDs.statuslineNotBeforeMs).toBeUndefined();

    // A model edit is recorded immediately, but the old snapshot remains until
    // the worker proves whether this is a fresh spawn or a warm reattach.
    writeStatuslineSnapshot(dataDir, 's-switch', {
      ts: now - 1000, model: 'Claude Opus 5.5 (High)', launchGen: 'gen-old', fiveHourPercent: 60, sevenDayPercent: 15,
    });
    const switchDs: any = {
      larkAppId: 'cli_agy',
      activeModel: 'Claude Opus 5.5 (High)',
      session: { sessionId: 's-switch', cliId: 'antigravity', model: 'claude-opus-5-5-high' },
      workingDir: '/repo',
    };
    expect(latestModelForRespawn(switchDs)).toBe('gemini-4-neon-xhigh');
    expect(switchDs.session.model).toBe('gemini-4-neon-xhigh');
    expect(existsSync(statuslineFilePath(dataDir, 's-switch'))).toBe(true);
    expect(switchDs.statuslineActiveModelStale).toBeUndefined();

    const worker = {} as any;
    switchDs.worker = worker;
    switchDs.workerGeneration = 2;
    switchDs.session.workerGeneration = 2;
    switchDs.statuslineLaunchFenceRollback = {
      launchGen: 'gen-old', notBeforeMs: now - 1_000,
      activeModelStale: false, activeModelFromSeed: false,
    };
    const onAttestation = loadWorkerPoolMessageHandlers(['local_process_attestation'], {
      ds: switchDs, worker, workerGeneration: 2, effectiveCliId: 'antigravity', scheduleActiveRuntimePatch: () => {},
    });
    onAttestation({
      type: 'local_process_attestation', backendType: 'tmux', credentialIsolated: false,
      cliSpawnGeneration: 1, statuslineLaunchGen: 'gen-new',
    });
    expect(switchDs.statuslineLaunchGen).toBe('gen-new');
    expect(switchDs.statuslineActiveModelStale).toBe(true);
    expect(switchDs.statuslineLaunchFenceRollback).toBeUndefined();
    expect(getDaemonSessionUsageSnapshot(switchDs, 'antigravity')).toBe(base);
  });

  it('ignores pre-restart seeded active_runtime / model_fallback until a live post-spawn turn updates activeModel', () => {
    const base = { context: { usedTokens: 10 }, tokens: null };
    vi.spyOn(costCalculator, 'getSessionUsageSnapshot').mockReturnValue(base as any);
    const now = Date.now();
    const worker = {} as any;

    // Antigravity: switched Claude Opus → Gemini Neon; resumed conv.db seeds old Claude Opus with seeded: true
    const agyDs: any = {
      worker,
      workerGeneration: 2,
      activeModel: 'Claude Opus 5.5 (High)',
      statuslineActiveModelStale: true,
      statuslineNotBeforeMs: now - 100,
      session: { sessionId: 's-seed-agy', cliId: 'antigravity', model: 'gemini-4-neon-xhigh', workerGeneration: 2 },
      workingDir: '/repo',
    };
    const agyHandler = loadWorkerPoolMessageHandlers(['active_runtime'], {
      ds: agyDs, worker, workerGeneration: 2, effectiveCliId: 'antigravity',
      scheduleActiveRuntimePatch: () => {}, sessionStore: { updateSession: () => {} },
    });
    agyHandler({ type: 'active_runtime', model: 'Claude Opus 5.5 (High)', reasoningEffort: null, seeded: true });
    expect(agyDs.statuslineActiveModelStale).toBe(true);
    expect(agyDs.activeModelFromSeed).toBe(true);

    writeStatuslineSnapshot(dataDir, 's-seed-agy', {
      ts: now, model: 'Gemini 4 Neon (XHigh)', fiveHourPercent: 21, sevenDayPercent: 7,
    });
    expect(getDaemonSessionUsageSnapshot(agyDs, 'antigravity')).toEqual({
      ...base, quota: { fiveHourPercent: 21, sevenDayPercent: 7 },
    });

    // Late write from old model must still be rejected while seeded
    writeStatuslineSnapshot(dataDir, 's-seed-agy', {
      ts: now + 10, model: 'Claude Opus 5.5 (High)', fiveHourPercent: 60, sevenDayPercent: 15,
    });
    expect(getDaemonSessionUsageSnapshot(agyDs, 'antigravity')).toBe(base);

    // Once a real post-spawn turn updates active_runtime (no seeded flag), live model takes precedence
    agyHandler({ type: 'active_runtime', model: 'Claude Opus 5.5 (High)', reasoningEffort: null });
    expect(agyDs.statuslineActiveModelStale).toBe(false);
    expect(agyDs.activeModelFromSeed).toBe(false);
    expect(getDaemonSessionUsageSnapshot(agyDs, 'antigravity')).toEqual({
      ...base, quota: { fiveHourPercent: 60, sevenDayPercent: 15 },
    });

    // A later historical seed must not downgrade the established live model.
    agyHandler({ type: 'active_runtime', model: 'Gemini 4 Neon (XHigh)', reasoningEffort: null, seeded: true });
    expect(agyDs.activeModel).toBe('Claude Opus 5.5 (High)');
    expect(agyDs.activeModelFromSeed).toBe(false);

    // Claude Code: worker refork after switch to opus; transcript seed reports pre-switch sonnet with seeded: true
    const claudeDs: any = {
      worker,
      workerGeneration: 3,
      statuslineActiveModelStale: true,
      session: { sessionId: 's-seed-claude', cliId: 'claude-code', model: 'opus', workerGeneration: 3 },
      workingDir: '/repo',
    };
    const claudeHandler = loadWorkerPoolMessageHandlers(['model_fallback'], {
      ds: claudeDs, worker, workerGeneration: 3, effectiveCliId: 'claude-code',
      mergeModelFallbackObservation: () => ({ changed: false, next: undefined }),
      normalizeClaudeModelId,
      persistStreamCardState: () => {},
      scheduleActiveRuntimePatch: () => {},
    });
    claudeHandler({ type: 'model_fallback', claudeSessionId: 'native-1', servingModel: 'claude-sonnet-5', seeded: true });
    expect(claudeDs.activeModelFromSeed).toBe(true);
    writeStatuslineSnapshot(dataDir, 's-seed-claude', {
      ts: now, model: 'claude-opus-5[1m]', fiveHourPercent: 12, sevenDayPercent: 4,
    });
    expect(getDaemonSessionUsageSnapshot(claudeDs, 'claude-code')).toEqual({
      ...base, quota: { fiveHourPercent: 12, sevenDayPercent: 4 },
    });
  });

  it('clears stale ds.initConfig.model when bot model is cleared and honors ds.spawnModelOverride precedence', () => {
    const base = { context: { usedTokens: 10 }, tokens: null };
    vi.spyOn(costCalculator, 'getSessionUsageSnapshot').mockReturnValue(base as any);
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    const now = Date.now();

    // Clearing bot model to undefined must clear ds.initConfig.model so default-model snapshots are accepted
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({
      config: { cliId: 'antigravity', name: 'agy', model: undefined },
    } as any);
    const clearedDs: any = {
      larkAppId: 'cli_agy',
      initConfig: { model: 'claude-opus-5-5-high' },
      session: { sessionId: 's-cleared', cliId: 'antigravity', model: 'claude-opus-5-5-high' },
      workingDir: '/repo',
    };
    expect(latestModelForRespawn(clearedDs)).toBeNull();
    expect(clearedDs.session.model).toBeUndefined();
    expect(clearedDs.initConfig.model).toBeUndefined();
    writeStatuslineSnapshot(dataDir, 's-cleared', {
      ts: now + 50, model: 'Gemini 4 Neon (XHigh)', fiveHourPercent: 21, sevenDayPercent: 7,
    });
    expect(getDaemonSessionUsageSnapshot(clearedDs, 'antigravity')).toEqual({
      ...base, quota: { fiveHourPercent: 21, sevenDayPercent: 7 },
    });

    // One-shot ds.spawnModelOverride outranks ds.session.model at the merge
    // point without mutating the recorded model or prematurely deleting the file.
    writeStatuslineSnapshot(dataDir, 's-override', {
      ts: now - 1000, model: 'Gemini 4 Neon (XHigh)', fiveHourPercent: 21, sevenDayPercent: 7,
    });
    const overrideDs: any = {
      larkAppId: 'cli_agy',
      spawnModelOverride: 'claude-opus-5-5-high',
      session: { sessionId: 's-override', cliId: 'antigravity', model: 'gemini-4-neon-xhigh' },
      workingDir: '/repo',
    };
    const agentCfg = __testOnly_sessionAgentConfig(overrideDs, { cliId: 'antigravity', model: 'gemini-4-neon-xhigh' });
    expect(agentCfg.model).toBe('claude-opus-5-5-high');
    expect(overrideDs.session.model).toBe('gemini-4-neon-xhigh');
    expect(existsSync(statuslineFilePath(dataDir, 's-override'))).toBe(true);

    writeStatuslineSnapshot(dataDir, 's-override', {
      ts: now + 50, model: 'Gemini 4 Neon (XHigh)', fiveHourPercent: 21, sevenDayPercent: 7,
    });
    expect(getDaemonSessionUsageSnapshot(overrideDs, 'antigravity')).toBe(base);

    writeStatuslineSnapshot(dataDir, 's-override', {
      ts: now + 60, model: 'Claude Opus 5.5 (High)', fiveHourPercent: 60, sevenDayPercent: 15,
    });
    expect(getDaemonSessionUsageSnapshot(overrideDs, 'antigravity')).toEqual({
      ...base, quota: { fiveHourPercent: 60, sevenDayPercent: 15 },
    });
  });

  it('preserves live pane model and snapshot on reattachLiveBackend even after bot config model edit', () => {
    const base = { context: { usedTokens: 10 }, tokens: null };
    vi.spyOn(costCalculator, 'getSessionUsageSnapshot').mockReturnValue(base as any);
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    const now = Date.now();

    writeStatuslineSnapshot(dataDir, 's-reattach', {
      ts: now, model: 'Claude Opus 5.5 (High)', fiveHourPercent: 60, sevenDayPercent: 15,
    });
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({
      config: { cliId: 'antigravity', name: 'agy', model: 'gemini-4-neon-xhigh' },
    } as any);
    const dsReattach: any = {
      larkAppId: 'cli_agy',
      session: { sessionId: 's-reattach', cliId: 'antigravity', model: 'claude-opus-5-5-high' },
      workingDir: '/repo',
    };
    __testOnly_sessionAgentConfig(
      dsReattach,
      { cliId: 'antigravity', model: 'gemini-4-neon-xhigh' },
      { allowTraexCatalogEmptyReattach: true, reattachLiveBackend: true },
    );
    expect(dsReattach.session.model).toBe('claude-opus-5-5-high');
    expect(existsSync(statuslineFilePath(dataDir, 's-reattach'))).toBe(true);
    expect(getDaemonSessionUsageSnapshot(dsReattach, 'antigravity')).toEqual({
      ...base, quota: { fiveHourPercent: 60, sevenDayPercent: 15 },
    });
  });

  it('restores the last attested fence on warm reattach and trusts only the surviving pane seed', () => {
    const base = { context: { usedTokens: 10 }, tokens: null };
    vi.spyOn(costCalculator, 'getSessionUsageSnapshot').mockReturnValue(base as any);
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({
      config: { cliId: 'antigravity', name: 'agy', model: 'gemini-4-neon-xhigh' },
    } as any);
    const now = Date.now();
    writeStatuslineSnapshot(dataDir, 's-warm-reattach', {
      ts: now, model: 'Claude Opus 5.5 (High)', launchGen: 'gen-old', fiveHourPercent: 60, sevenDayPercent: 15,
    });
    const worker = {} as any;
    const ds: any = {
      larkAppId: 'cli_agy', worker, workerGeneration: 4,
      session: { sessionId: 's-warm-reattach', cliId: 'antigravity', model: 'claude-opus-5-5-high', workerGeneration: 4 },
      workingDir: '/repo',
    };

    // An ordinary fork resolves the edited model before the worker discovers
    // that the old pane is alive; it must not delete the old snapshot.
    __testOnly_sessionAgentConfig(ds, { cliId: 'antigravity', model: 'gemini-4-neon-xhigh' });
    expect(ds.session.model).toBe('gemini-4-neon-xhigh');
    expect(existsSync(statuslineFilePath(dataDir, 's-warm-reattach'))).toBe(true);
    ds.statuslineLaunchFenceRollback = {
      launchGen: 'gen-old', notBeforeMs: now - 1_000,
      activeModelStale: false, activeModelFromSeed: false,
    };
    ds.statuslineLaunchGen = 'gen-new-speculative';
    ds.statuslineNotBeforeMs = now + 1_000;

    const onAttestation = loadWorkerPoolMessageHandlers(['local_process_attestation'], {
      ds, worker, workerGeneration: 4, effectiveCliId: 'antigravity', scheduleActiveRuntimePatch: () => {},
    });
    onAttestation({
      type: 'local_process_attestation', backendType: 'tmux', credentialIsolated: false,
      cliSpawnGeneration: 1, statuslineReattach: true,
    });
    expect(ds.statuslineLaunchGen).toBe('gen-old');
    expect(ds.statuslineNotBeforeMs).toBe(now - 1_000);
    expect(ds.statuslineActiveModelStale).toBe(false);
    expect(ds.statuslineLaunchFenceRollback).toBeUndefined();

    const onRuntime = loadWorkerPoolMessageHandlers(['active_runtime'], {
      ds, worker, workerGeneration: 4, effectiveCliId: 'antigravity',
      scheduleActiveRuntimePatch: () => {}, sessionStore: { updateSession: () => {} },
    });
    onRuntime({ type: 'active_runtime', model: 'Claude Opus 5.5 (High)', reasoningEffort: null, seeded: true });
    expect(ds.activeModelFromSeed).toBe(false);
    expect(getDaemonSessionUsageSnapshot(ds, 'antigravity')).toEqual({
      ...base, quota: { fiveHourPercent: 60, sevenDayPercent: 15 },
    });

    // Reattach restores the surviving pane's generation, not a license for an
    // even older dying process to publish a final frame.
    writeStatuslineSnapshot(dataDir, 's-warm-reattach', {
      ts: now + 100, model: 'Claude Opus 5.5 (High)', launchGen: 'gen-dying-prior', fiveHourPercent: 77,
    });
    expect(getDaemonSessionUsageSnapshot(ds, 'antigravity')).toBe(base);
  });

  it('requestSessionRestart rolls back on failed IPC send, fences dying CLI via statuslineLaunchGen on success, and marks activeModel stale on in-worker respawn', () => {
    const base = { context: { usedTokens: 10 }, tokens: null };
    vi.spyOn(costCalculator, 'getSessionUsageSnapshot').mockReturnValue(base as any);
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({
      config: { cliId: 'antigravity', name: 'agy', model: 'gemini-4-neon-xhigh' },
    } as any);
    const now = Date.now();

    // 1. Failed IPC send must not mutate session.model, initConfig.model, or delete the live CLI's snapshot
    writeStatuslineSnapshot(dataDir, 's-fail-ipc', {
      ts: now, model: 'Claude Opus 5.5 (High)', fiveHourPercent: 60, sevenDayPercent: 15,
    });
    const failingDs: any = {
      larkAppId: 'cli_agy',
      worker: { killed: false, send: () => { throw new Error('ERR_IPC_CHANNEL_CLOSED'); } },
      initConfig: { model: 'claude-opus-5-5-high' },
      session: { sessionId: 's-fail-ipc', cliId: 'antigravity', model: 'claude-opus-5-5-high' },
      workingDir: '/repo',
    };
    const failed = requestSessionRestart(failingDs, { source: 'slash', notify: async () => {} });
    expect(failed?.startFailure).toBeDefined();
    expect(failingDs.session.model).toBe('claude-opus-5-5-high');
    expect(failingDs.initConfig.model).toBe('claude-opus-5-5-high');
    expect(failingDs.statuslineNotBeforeMs).toBeUndefined();
    expect(existsSync(statuslineFilePath(dataDir, 's-fail-ipc'))).toBe(true);
    expect(getDaemonSessionUsageSnapshot(failingDs, 'antigravity')).toEqual({
      ...base, quota: { fiveHourPercent: 60, sevenDayPercent: 15 },
    });

    // 2. Successful restart IPC sends statuslineLaunchGen and rejects post-T0 late write from old CLI gen
    const sent: any[] = [];
    const okWorker = { killed: false, send: (m: any) => { sent.push(m); return true; } };
    writeStatuslineSnapshot(dataDir, 's-ok-ipc', {
      ts: now - 100, model: 'Claude Opus 5.5 (High)', launchGen: 'gen-old', fiveHourPercent: 60, sevenDayPercent: 15,
    });
    const okDs: any = {
      larkAppId: 'cli_agy',
      worker: okWorker,
      workerGeneration: 1,
      initConfig: { model: 'claude-opus-5-5-high' },
      session: { sessionId: 's-ok-ipc', cliId: 'antigravity', model: 'claude-opus-5-5-high', workerGeneration: 1 },
      workingDir: '/repo',
    };
    const ok = requestSessionRestart(okDs, { source: 'slash', notify: async () => {} });
    expect(ok?.startFailure).toBeUndefined();
    expect(sent).toHaveLength(1);
    const nextGen = sent[0].statuslineLaunchGen as string;
    expect(typeof nextGen).toBe('string');
    expect(okDs.statuslineLaunchGen).toBe(nextGen);
    expect(okDs.session.model).toBe('gemini-4-neon-xhigh');
    expect(okDs.initConfig.model).toBe('gemini-4-neon-xhigh');
    // The speculative generation fence is immediate, but snapshot deletion and
    // activeModel invalidation wait for an actual fresh-spawn attestation.
    expect(existsSync(statuslineFilePath(dataDir, 's-ok-ipc'))).toBe(true);

    // Late write from the dying old CLI is rejected by the speculative launchGen fence
    writeStatuslineSnapshot(dataDir, 's-ok-ipc', {
      ts: Date.now() + 200, model: 'Gemini 4 Neon (XHigh)', launchGen: 'gen-old', fiveHourPercent: 88, sevenDayPercent: 55,
    });
    expect(getDaemonSessionUsageSnapshot(okDs, 'antigravity')).toBe(base);

    // Replacement CLI write with matching launchGen is accepted
    writeStatuslineSnapshot(dataDir, 's-ok-ipc', {
      ts: Date.now() + 300, model: 'Gemini 4 Neon (XHigh)', launchGen: nextGen, fiveHourPercent: 21, sevenDayPercent: 7,
    });
    expect(getDaemonSessionUsageSnapshot(okDs, 'antigravity')).toEqual({
      ...base, quota: { fiveHourPercent: 21, sevenDayPercent: 7 },
    });

    // 3. In-worker respawn (e.g. crash-park same-model retry) attested via local_process_attestation
    // updates statuslineLaunchGen and marks pre-crash activeModel stale
    const retryDs: any = {
      worker: okWorker,
      workerGeneration: 1,
      activeModel: 'claude-sonnet-5',
      localProcessAttestation: { backendType: 'tmux', credentialIsolated: false, cliSpawnGeneration: 1 },
      session: { sessionId: 's-retry', cliId: 'claude-code', model: 'opus', workerGeneration: 1 },
      workingDir: '/repo',
    };
    const attHandler = loadWorkerPoolMessageHandlers(['local_process_attestation'], {
      ds: retryDs, worker: okWorker, workerGeneration: 1, effectiveCliId: 'claude-code',
      scheduleActiveRuntimePatch: () => {},
    });
    attHandler({
      type: 'local_process_attestation',
      backendType: 'tmux',
      credentialIsolated: false,
      cliSpawnGeneration: 2,
      statuslineLaunchGen: 'gen-retry-2',
    });
    expect(retryDs.statuslineLaunchGen).toBe('gen-retry-2');
    expect(retryDs.statuslineActiveModelStale).toBe(true);
    writeStatuslineSnapshot(dataDir, 's-retry', {
      ts: Date.now(), model: 'claude-opus-5[1m]', launchGen: 'gen-retry-2', fiveHourPercent: 10, sevenDayPercent: 3,
    });
    expect(getDaemonSessionUsageSnapshot(retryDs, 'claude-code')).toEqual({
      ...base, quota: { fiveHourPercent: 10, sevenDayPercent: 3 },
    });
  });
});

describe('getDaemonSessionUsageSnapshot × cardFooterExtension', () => {
  const cache = __testOnly_cardFooterExtensionCache();
  beforeEach(() => cache.reset());

  it('appends the bot\'s cached extension segments once the command has produced them', async () => {
    const base = { context: null, tokens: { in: 1, out: 2 } };
    vi.spyOn(costCalculator, 'getSessionUsageSnapshot').mockReturnValue(base as any);
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({
      config: { cliId: 'codex', name: 'demo', cardFooterExtension: { command: 'printf "a 1%%\\nb 2%%"' } },
    } as any);
    const session = { session: { sessionId: 's5', larkAppId: 'cli_ext' }, larkAppId: 'cli_ext', workingDir: '/repo' } as any;
    expect(getDaemonSessionUsageSnapshot(session, 'codex' as any)).toBe(base);
    await cache.pending('cli_ext');
    expect(getDaemonSessionUsageSnapshot(session, 'codex' as any)).toEqual({ ...base, extensionSegments: ['a 1%', 'b 2%'] });
  });

  it('exposes the bot-configured CLI to the command, not the session effective CLI', async () => {
    // 缓存按 bot 共享：环境里的 CLI 必须稳定取 bot 配置，不能随触发会话的 CLI 覆盖跳变。
    const base = { context: null, tokens: null };
    vi.spyOn(costCalculator, 'getSessionUsageSnapshot').mockReturnValue(base as any);
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({
      config: { cliId: 'codex', name: 'demo', cardFooterExtension: { command: 'printf \'%s\' "$BOTMUX_CLI_ID"' } },
    } as any);
    const session = { session: { sessionId: 's6', larkAppId: 'cli_envcli' }, larkAppId: 'cli_envcli', workingDir: '/repo' } as any;
    getDaemonSessionUsageSnapshot(session, 'opencode');
    await cache.pending('cli_envcli');
    expect(getDaemonSessionUsageSnapshot(session, 'opencode')).toEqual({ ...base, extensionSegments: ['codex'] });
  });
});
