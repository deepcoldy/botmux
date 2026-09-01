import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';

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
    const structuredBridgeComment = workerSource.indexOf('// Structured transcript bridge fallback:');
    const spawnStart = workerSource.indexOf("} else if (cfg.cliId === 'codex') {", structuredBridgeComment);
    const spawn = workerSource.slice(spawnStart, workerSource.indexOf("} else if (cfg.cliId === 'traex')", spawnStart));

    expect(structuredBridgeComment).toBeGreaterThanOrEqual(0);
    expect(spawn).toContain('if (cfg.existingAppServerEndpoint) {');
    expect(spawn).toContain('codexAdoptStartMs = Date.now();');
    expect(spawn).toContain('codexBridgeQueue.setLocalTurns(true, codexAdoptStartMs);');
    expect(spawn).toContain("cfg.existingAppServerEndpoint\n            ? 'split-live'");
  });

  it('uses adopt-style forwarding only for App-side local turns', () => {
    const emitStart = workerSource.indexOf('function emitReadyCodexTurns');
    const emit = workerSource.slice(emitStart, workerSource.indexOf('\nfunction stopCodexBridge', emitStart));

    expect(emit).toContain('const terminalAdoptMode = lastInitConfig?.adoptMode === true;');
    expect(emit).toContain('const sharedAppServerBridge = isExistingAppServerSharedBridge();');
    expect(emit).toContain(
      'const adoptMode = terminalAdoptMode\n'
      + '      || (sharedAppServerBridge && turn.isLocal === true);',
    );
    expect(emit).toContain('const markers = terminalAdoptMode ? [] : readSendMarkers();');
  });
});
