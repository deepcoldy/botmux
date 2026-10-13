import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

function caseRegion(name: 'init' | 'message', next: 'message' | 'raw_input'): string {
  const start = workerSource.indexOf(`case '${name}': {`);
  const end = workerSource.indexOf(`case '${next}':`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return workerSource.slice(start, end);
}

describe('ordinary IM worker receipt wiring', () => {
  it('recognizes both real Lark ids and synthetic recovery ids', () => {
    expect(workerSource).toContain("msg.turnId?.startsWith('om_') || msg.turnId?.startsWith('bmx-recovery-')");
  });

  it('claims and ACKs init before any slow startup await', () => {
    const init = caseRegion('init', 'message');
    const receipt = init.indexOf('receiveOrdinaryImTurn(ordinaryImTurnId)');
    const firstStartupAwait = Math.min(
      ...[
        init.indexOf('await startWebServer('),
        init.indexOf('await orchestrateCodexRpcInit('),
        init.indexOf('await spawnCli('),
      ].filter(index => index >= 0),
    );

    expect(receipt).toBeGreaterThanOrEqual(0);
    expect(receipt).toBeLessThan(firstStartupAwait);
  });

  it('claims and ACKs a steady-state turn before crash recovery awaits', () => {
    const message = caseRegion('message', 'raw_input');
    const receipt = message.indexOf('receiveOrdinaryImTurn(ordinaryImTurnId)');
    const crashRestart = message.indexOf('await spawnCli(restartCfg)');

    expect(receipt).toBeGreaterThanOrEqual(0);
    expect(crashRestart).toBeGreaterThan(receipt);
  });

  it('queues pre-adapter follow-ups and preserves the init prompt at the head', () => {
    const sendToPtyStart = workerSource.indexOf('function sendToPty(');
    const sendToPtyEnd = workerSource.indexOf('// ─── Screen Update Timer', sendToPtyStart);
    const sendToPty = workerSource.slice(sendToPtyStart, sendToPtyEnd);
    const backendQueue = sendToPty.indexOf('if (cliRestartInProgress || !backend)');
    const adapterReject = sendToPty.indexOf('if (!cliAdapter) return false;');
    const init = caseRegion('init', 'message');
    const initialPromptQueue = init.indexOf('pendingMessages.unshift(...recoveredAcceptedInputs, {');
    const flushStart = workerSource.indexOf('async function flushPending()');
    const flushEnd = workerSource.indexOf('\nfunction sendToPty(', flushStart);
    const flush = workerSource.slice(flushStart, flushEnd);

    expect(backendQueue).toBeGreaterThanOrEqual(0);
    expect(adapterReject).toBeGreaterThan(backendQueue);
    expect(initialPromptQueue).toBeGreaterThanOrEqual(0);
    expect(flush).toContain('if (initialInputOwnershipPending) return;');
    expect(init.indexOf('initialInputOwnershipPending = !!msg.prompt;'))
      .toBeLessThan(init.indexOf('await startWebServer('));
    expect(init.indexOf('initialInputOwnershipPending = false;'))
      .toBeGreaterThan(initialPromptQueue);
  });
});

// ── native_input_consumed emission boundaries ────────────────────────────────
// The receipt covers shared group background, so it may only be sent from
// boundaries where the CLI itself evidenced this exact input. Pin the gates.
describe('native input consumption receipt wiring', () => {
  const emissions = [...workerSource.matchAll(/acknowledgeNativeInputConsumed\(/g)].map(m => m.index!)
    .filter(index => !workerSource.slice(index - 20, index).includes('function '));

  it('emits from exactly the five evidenced boundaries', () => {
    // Codex paste (immediate + deferred history match), Codex RPC (steady
    // turn/start + fresh first turn), Claude transcript full match.
    expect(emissions).toHaveLength(5);
  });

  it('Codex paste: only an exact owned history match, after session id persistence', () => {
    const region = workerSource.slice(workerSource.indexOf('if (result?.cliSessionId) {\n        persistCliSessionId(result.cliSessionId);'));
    const receipt = region.indexOf("acknowledgeNativeInputConsumed(item.turnId, 'codex_history_match'");
    expect(receipt).toBeGreaterThan(region.indexOf('persistCliSessionId(result.cliSessionId);'));
    expect(region.slice(0, receipt)).toContain('result?.submitted === true && result.ownershipProven === true && codexHistoryMatchProvesConsumption()');
    expect(workerSource).toContain("return lastInitConfig?.cliId === 'codex' && !lastInitConfig.adoptMode && !codexRpcEngine;");
    const deferred = workerSource.slice(workerSource.indexOf("case 'suppress-confirmed':"), workerSource.indexOf("case 'suppress-usage-limit':"));
    expect(deferred).toContain('if (settlement.ownershipProven === true && codexHistoryMatchProvesConsumption()) {');
    expect(deferred.indexOf('acknowledgeNativeInputConsumed(')).toBeGreaterThan(deferred.indexOf('persistCliSessionId(cliSessionId);'));
    // The ZMX late recheck settles into the same result object the gate reads:
    // a positive ownership proof must survive it, or the gate never fires.
    // Both managed-pid wiring sites (synchronous at spawn, delayed for late-child
    // backends) hand the pid to the adapter through one predicate that names codex.
    expect(workerSource).toContain("if (cliPid && cliAdapterBindsOwnershipPid(cfg.cliId, claudeDataDir)) {");
    expect(workerSource).toContain("if (cliAdapterBindsOwnershipPid(cfg.cliId, claudeDataDir)) {");
    expect(workerSource).not.toMatch(/claudeDataDir \|\| cfg\.cliId === 'grok'/);
    const settle = workerSource.slice(workerSource.indexOf('async function settleVerifiableSubmissionForJournal('), workerSource.indexOf('function captureAmbiguousSubmissionFence('));
    expect(settle).toContain('if (typeof recheck === \'object\' && recheck && recheck.ownershipProven === true) {\n      result.ownershipProven = true;');
  });

  it('Codex RPC: only after the acknowledged turn/start passed the generation fence', () => {
    const start = workerSource.indexOf('rpcNativeTurnId = (await writeRpcEngine.sendTurn(msg, rpcTurnIdentity!)).nativeTurnId;');
    const fence = workerSource.indexOf('if (!writeContinuationIsCurrent()) {', start);
    const receipt = workerSource.indexOf("acknowledgeNativeInputConsumed(item.turnId, 'codex_rpc_turn_start'", start);
    const bridgeMark = workerSource.indexOf('bridgeTurnId = rpcTurnIdentity.turnId;', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(fence).toBeGreaterThan(start);
    expect(receipt).toBeGreaterThan(fence);
    expect(receipt).toBeLessThan(bridgeMark);
    const fresh = workerSource.slice(workerSource.indexOf('const first = await engine.sendFirstTurn('), workerSource.indexOf('if (shouldPreMarkFirstTurn(first.outcome)) {'));
    expect(fresh).toContain("if (first.outcome === 'accepted') {");
    expect(fresh.indexOf("acknowledgeNativeInputConsumed(cfg.turnId, 'codex_rpc_turn_start'")).toBeGreaterThan(fresh.indexOf("if (first.outcome === 'not-sent') {"));
  });

  it('Claude: only a full normalised transcript match in a non-adopted Claude-family session', () => {
    const start = workerSource.indexOf('function notifyNativeTranscriptConsumedLarkTurn(');
    const end = workerSource.indexOf('function notifyTerminalTurnStarted(', start);
    const body = workerSource.slice(start, end);
    expect(body).toContain('if (!evidence.fullContentMatch || turn.isLocal || turn.isScheduled) return;');
    expect(body).toContain('if (!cliAdapter?.claudeDataDir || lastInitConfig?.adoptMode) return;');
    expect(body).toContain("acknowledgeNativeInputConsumed(turn.turnId, 'claude_transcript_user_record'");
    expect(workerSource).toContain('notifyNativeTranscriptConsumedLarkTurn,\n);');
  });

  it('never treats IPC receipt, queue commit or a generic submitted flag as consumption', () => {
    const receiveStart = workerSource.indexOf('function receiveOrdinaryImTurn(');
    const receiveEnd = workerSource.indexOf('function rejectOrdinaryImTurn(', receiveStart);
    expect(workerSource.slice(receiveStart, receiveEnd)).not.toContain('acknowledgeNativeInputConsumed');
    const commitStart = workerSource.indexOf('function acknowledgeTurnInputCommitted(');
    const commitEnd = workerSource.indexOf('function acknowledgeTurnInputReceived(', commitStart);
    expect(workerSource.slice(commitStart, commitEnd)).not.toContain('acknowledgeNativeInputConsumed');
  });
});
