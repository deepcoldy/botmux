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
