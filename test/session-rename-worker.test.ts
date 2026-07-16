import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

function caseRegion(name: string): string {
  const start = workerSource.indexOf(`case '${name}':`);
  const next = workerSource.indexOf("\n    case '", start + 1);
  return workerSource.slice(start, next);
}

describe('worker native session rename queue', () => {
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
    expect(rawRegion).toContain('if (cliRestartInProgress || rawInputRestartGate || sessionRenameInFlight)');
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
