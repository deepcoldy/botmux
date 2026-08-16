import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

function caseBody(type: string, nextType: string): string {
  const start = workerSource.indexOf(`case '${type}':`);
  const end = workerSource.indexOf(`case '${nextType}':`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return workerSource.slice(start, end);
}

describe('worker transfer detach lifecycle', () => {
  it('detaches through backend.kill without invoking permanent close teardown', () => {
    const detach = caseBody('detach_for_transfer', 'riff_shutdown_prepare');
    expect(detach).toContain('killCli({ preserveSandbox: true });');
    expect(detach).toContain('await flushTransferDetachAck(msg.requestId);');
    expect(detach).toContain('process.exit(0);');
    expect(detach).not.toContain('backend?.destroySession');
    expect(detach).not.toContain('clearSendMarkers');

    const killCliStart = workerSource.indexOf('function killCli(');
    const restartStart = workerSource.indexOf('async function restartCliProcess(', killCliStart);
    const killCli = workerSource.slice(killCliStart, restartStart);
    expect(killCli).toContain('backend?.kill();');
    expect(killCli).toContain('sandboxCleanup = null;');
    expect(killCli).toContain('sandboxTeardownDone = true;');

    const ackStart = workerSource.indexOf('async function flushTransferDetachAck(');
    const fatalStart = workerSource.indexOf('let fatalWorkerErrorPending', ackStart);
    const ack = workerSource.slice(ackStart, fatalStart);
    expect(ackStart).toBeGreaterThanOrEqual(0);
    expect(fatalStart).toBeGreaterThan(ackStart);
    expect(ack).toContain('Promise.race([');
    expect(ack).toContain("sendAndFlush({ type: 'transfer_detached', requestId })");
    expect(ack).toContain('setTimeout(resolve, TRANSFER_DETACH_ACK_FLUSH_MS)');
  });

  it('keeps ordinary close on destroySession semantics', () => {
    const close = caseBody('close', 'detach_for_transfer');
    expect(close).toContain('backend?.destroySession?.()');
    expect(close).toContain('killCli();');
    expect(close).not.toContain('preserveSandbox');
    expect(close).toContain('clearSendMarkers();');
  });
});
