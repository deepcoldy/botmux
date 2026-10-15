import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

describe('existing Codex App Server bridge wiring', () => {
  it('treats the share as split-live rather than replaying pre-share history', () => {
    const helperStart = workerSource.indexOf('function codexBridgeUsesSplitLiveAttach');
    const helper = workerSource.slice(helperStart, workerSource.indexOf('\n}', helperStart));
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helper).toContain('lastInitConfig?.adoptMode === true');
    expect(helper).toContain('isExistingAppServerSharedBridge()');

    const timerStart = workerSource.indexOf('function codexBridgeStartTimer');
    const timer = workerSource.slice(timerStart, workerSource.indexOf('\nfunction hermesBridgeAttach', timerStart));
    expect(timer).toContain("codexBridgeUsesSplitLiveAttach() ? 'split-live' : 'fresh-empty'");
  });

  it('enables App-side local turn synthesis at the share attach boundary', () => {
    // The spawn chain is spec-driven now: the codex adapter declares
    // `spawn.appServerShare`, and the shared attach helper enables App-side local
    // turn synthesis (and split-live) only for a spec that opted in AND a config
    // that actually carries an existing App Server endpoint.
    const structuredBridgeComment = workerSource.indexOf('// Structured transcript bridge fallback:');
    const helperStart = workerSource.indexOf('function attachStructuredBridgeAtSpawn(');
    const spawn = workerSource.slice(helperStart, workerSource.indexOf('async function setupAdoptTranscriptBridges(', helperStart));

    expect(structuredBridgeComment).toBeGreaterThanOrEqual(0);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(spawn).toContain('spawn.appServerShare === true && !!cfg.existingAppServerEndpoint');
    expect(spawn).toContain('if (sharesAppServer) {');
    expect(spawn).toContain('codexAdoptStartMs = Date.now();');
    expect(spawn).toContain('codexBridgeQueue.setLocalTurns(true, codexAdoptStartMs);');
    expect(spawn).toContain("const mode = sharesAppServer\n      ? 'split-live'");
    const codexAdapter = readFileSync(new URL('../src/adapters/cli/codex.ts', import.meta.url), 'utf8');
    expect(codexAdapter).toContain("spawn: { sessionId: 'cli', baseline: 'resume-aware', appServerShare: true }");
  });

  it('uses adopt-style forwarding for App-side local turns outside zero-prompt mode', () => {
    const emitStart = workerSource.indexOf('function emitReadyCodexTurns');
    const emit = workerSource.slice(emitStart, workerSource.indexOf('\nfunction stopCodexBridge', emitStart));

    expect(emit).toContain('const terminalAdoptMode = lastInitConfig?.adoptMode === true;');
    expect(emit).toContain('const sharedAppServerBridge = isExistingAppServerSharedBridge();');
    // Zero-prompt local turns use ordinary final delivery without an App input
    // transcript. Explicit adopt sessions retain their existing forwarding.
    expect(emit).toContain(
      'const adoptMode = terminalAdoptMode\n'
      + '      || (sharedAppServerBridge && turn.isLocal === true && !zeroPromptTerminalSync());',
    );
    expect(emit).toContain('const markers = terminalAdoptMode ? [] : readSendMarkers();');
  });
});
