import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

function caseRegion(name: string): string {
  const start = workerSource.indexOf(`case '${name}':`);
  const next = workerSource.indexOf("\n    case '", start + 1);
  return workerSource.slice(start, next);
}

describe('worker native session rename queue', () => {
  it('does not queue the automatic title as a pre-prompt slash command', () => {
    const region = caseRegion('init');
    expect(region).not.toContain('pendingSessionRename = msg.nativeSessionTitle');
  });

  it('waits for the first-message preview before applying the native title', () => {
    const syncStart = workerSource.indexOf('async function applyCodexNativeSessionTitle(');
    const syncEnd = workerSource.indexOf('/** Stand up (or re-establish)', syncStart);
    const syncRegion = workerSource.slice(syncStart, syncEnd);
    const flushStart = workerSource.indexOf('async function flushPending()');
    const flushEnd = workerSource.indexOf('\nfunction sendToPty(', flushStart);
    const flushRegion = workerSource.slice(flushStart, flushEnd);

    expect(syncRegion).toContain('await engine.waitForThreadPreview(10_000)');
    expect(syncRegion.indexOf('engine.waitForThreadPreview'))
      .toBeLessThan(syncRegion.indexOf('engine.setThreadName'));
    expect(syncRegion).toContain("waitForExistingPreview: wait === 'preview'");
    expect(syncRegion).toContain('engine.waitForThreadUpdatedAfter(');
    expect(syncRegion).toContain('waitForUpdatedAfter: nativeSessionTitleResumeUpdatedAt');
    expect(syncRegion).toContain('revision !== nativeSessionTitleRevision');
    expect(flushRegion.indexOf('await cliAdapter.writeInput'))
      .toBeLessThan(flushRegion.indexOf('syncFreshCodexNativeSessionTitle'));
    expect(flushRegion).toContain('syncFreshCodexNativeSessionTitle(threadId, codexRpcEngine)');
  });

  it('captures the resume metadata baseline without applying the title before the first append', () => {
    const region = caseRegion('init');
    expect(region).toContain('await prepareCodexNativeTitleGeneration(msg, codexRpcEngine)');
    expect(region).not.toContain('syncFreshCodexNativeSessionTitle(msg.cliSessionId');
  });

  it('rebuilds title synchronization state after an in-worker CLI restart', () => {
    const start = workerSource.indexOf('async function restartCliProcess(');
    const end = workerSource.indexOf('// ─── HTTP + WebSocket Server', start);
    const region = workerSource.slice(start, end);
    expect(region).toContain('await spawnCli(restartCfg');
    expect(region).toContain('await prepareCodexNativeTitleGeneration(restartCfg, codexRpcEngine)');
    const prepareStart = workerSource.indexOf('async function prepareCodexNativeTitleGeneration(');
    const prepareEnd = workerSource.indexOf('/** Stand up (or re-establish)', prepareStart);
    const prepareRegion = workerSource.slice(prepareStart, prepareEnd);
    expect(prepareRegion).toContain('nativeSessionTitleAppliedThreadId = undefined');
    expect(prepareRegion).toContain('nativeSessionTitleCurrentGenerationResume = lastSpawnEffectiveResume');
    expect(prepareRegion).toContain('await captureCodexResumeTitleBaseline(threadId, engine)');
  });

  it('does not block RPC thread ownership or persistence on title sync', () => {
    const start = workerSource.indexOf('async function engageCodexRpc(');
    const end = workerSource.indexOf('/** RPC panes have NO terminal input path', start);
    const region = workerSource.slice(start, end);
    const ownershipIdx = region.indexOf('codexRpcEngine = engine');
    const persistIdx = region.indexOf('persistCliSessionId(threadId)');
    const titleIdx = region.indexOf('void syncFreshCodexNativeSessionTitle');

    expect(ownershipIdx).toBeGreaterThanOrEqual(0);
    expect(ownershipIdx).toBeLessThan(persistIdx);
    expect(persistIdx).toBeLessThan(titleIdx);
  });

  it('invalidates an in-flight automatic title when a user rename arrives', () => {
    const region = caseRegion('rename_session');
    expect(region).toContain('nativeSessionTitleRevision += 1');
    expect(region).toContain('lastInitConfig.nativeSessionTitle = msg.title');
    expect(region).toContain('lastInitConfig.nativeSessionTitlePrompt = undefined');
    expect(region).toContain('stopNativeSessionTitleSync()');
  });

  it('generates one isolated semantic title only for a fresh session', () => {
    const start = workerSource.indexOf('async function syncFreshCodexNativeSessionTitle(');
    const end = workerSource.indexOf('/** 在 resume 首条输入前记录', start);
    const region = workerSource.slice(start, end);

    expect(region).toContain("const sourceText = resumeGeneration ? ''");
    expect(region).toContain('cfg.nativeSessionTitlePrompt = undefined');
    expect(region).toContain('generateCodexAppThreadTitle({');
    expect(region).toContain('buildBotmuxLarkNativeSessionTitle(semanticCore)');
    expect(region).toContain("send({ type: 'native_session_title_generated', title: semanticTitle })");
  });

  it('queues rename IPC without opening a renderer or usage turn', () => {
    const region = caseRegion('rename_session');
    expect(region).toContain('pendingSessionRename = msg.title');
    expect(region).toContain('void flushPending()');
    expect(region).not.toContain('renderer?.markNewTurn()');
    expect(region).not.toContain('usageLimitTracker.beginTurn');
  });

  it('waits for prompt readiness, uses the adapter command, and runs before user prompts', () => {
    const start = workerSource.indexOf('async function flushPending()');
    const end = workerSource.indexOf('\nfunction sendToPty(', start);
    const region = workerSource.slice(start, end);
    const renameIdx = region.indexOf('buildSessionRenameCommand');
    const promptLoopIdx = region.indexOf('while (pendingMessages.length > 0');

    expect(region).toContain('const sessionRenameReady = isPromptReady && pendingSessionRename !== null');
    expect(region).toContain('if (sessionRenameInFlight) return');
    expect(region).toContain('if (commandLineWritesPending > 0) return');
    expect(region).toContain('const rawInputReady = isPromptReady');
    expect(region).toContain('await sendRawCommandLineSerially(backend, buildRename(title))');
    expect(region).toContain('armSessionRenameIdleTimeout()');
    expect(region).toContain("effectiveBackendType === 'riff'");
    expect(renameIdx).toBeGreaterThanOrEqual(0);
    expect(renameIdx).toBeLessThan(promptLoopIdx);
  });

  it('blocks type-ahead messages until the rename command returns to prompt', () => {
    const sendToPtyStart = workerSource.indexOf('function sendToPty(');
    const sendToPtyEnd = workerSource.indexOf('// ─── Screen Update Timer', sendToPtyStart);
    const sendToPtyRegion = workerSource.slice(sendToPtyStart, sendToPtyEnd);
    const readyStart = workerSource.indexOf('function markPromptReady()');
    const readyEnd = workerSource.indexOf('\nfunction persistCliSessionId', readyStart);
    const readyRegion = workerSource.slice(readyStart, readyEnd);

    expect(sendToPtyRegion).toContain('!sessionRenameInFlight && commandLineWritesPending === 0 && shouldWriteNow');
    expect(readyRegion).toContain('clearSessionRenameInFlight()');
    expect(workerSource).toContain('Native session rename idle timeout');
  });

  it('fails open without losing deferred passthrough commands', () => {
    const timeoutStart = workerSource.indexOf('function armSessionRenameIdleTimeout()');
    const timeoutEnd = workerSource.indexOf('\n/** Deliver passthrough', timeoutStart);
    const timeoutRegion = workerSource.slice(timeoutStart, timeoutEnd);
    const killStart = workerSource.indexOf('function killCli()');
    const killEnd = workerSource.indexOf('// ─── HTTP + WebSocket Server', killStart);
    const killRegion = workerSource.slice(killStart, killEnd);
    const flushStart = workerSource.indexOf('async function flushPending()');
    const flushEnd = workerSource.indexOf('\nfunction sendToPty(', flushStart);
    const flushRegion = workerSource.slice(flushStart, flushEnd);

    expect(timeoutRegion).toContain('isPromptReady = true');
    expect(timeoutRegion).toContain('void flushPending()');
    expect(flushRegion).toContain('command failed');
    expect(flushRegion).toContain('armSessionRenameIdleTimeout()');
    expect(killRegion).not.toContain('pendingRawInputs.length = 0');
  });

  it('serializes passthrough writes without changing their busy-delivery semantics', () => {
    const rawRegion = caseRegion('raw_input');
    // PR #441 起入队条件多了注入围栏（injectionFlushing / barrier），rename 围栏
    // 仍必须在场——只钉本测试关心的三个 restart/rename 因子，不钉整行。
    expect(rawRegion).toContain('if (cliRestartInProgress || rawInputRestartGate || sessionRenameInFlight');
    expect(rawRegion).toContain('pendingRawInputs.push(msg)');
    expect(rawRegion).toContain('await deliverRawInput(msg)');

    const flushStart = workerSource.indexOf('async function flushPending()');
    const flushEnd = workerSource.indexOf('\nfunction sendToPty(', flushStart);
    const flushRegion = workerSource.slice(flushStart, flushEnd);
    expect(flushRegion).toContain('pendingRawInputs.shift()');
    expect(flushRegion).toContain('await deliverRawInput(raw)');
    expect(workerSource).toContain('await sendRawCommandLineSerially(targetBackend, msg.content)');
    expect(flushRegion.indexOf('await deliverRawInput(raw)'))
      .toBeLessThan(flushRegion.indexOf('await sendRawCommandLineSerially(backend, buildRename(title))'));
  });
});
