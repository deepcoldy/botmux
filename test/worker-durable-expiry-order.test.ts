/**
 * worker.ts is a process entrypoint, so pin the exact three-way expiry wiring
 * rather than importing it and installing IPC/signal handlers in Vitest.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

describe('worker durable lease expiry ordering', () => {
  it('removes exact queued attempt N behind an ordinary current turn before ACKing', () => {
    const start = workerSource.indexOf("case 'expire_durable_turn':");
    const end = workerSource.indexOf("case 'reset_ambiguous_receiver':", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const branch = workerSource.slice(start, end);

    const currentExact = branch.indexOf('const currentExact = durableTurnInFlight');
    const pendingLoop = branch.indexOf('for (let i = pendingMessages.length - 1; i >= 0; i--)');
    const exactTurn = branch.indexOf('item.turnId === msg.turnId', pendingLoop);
    const exactAttempt = branch.indexOf('item.dispatchAttempt === msg.dispatchAttempt', pendingLoop);
    const remove = branch.indexOf('pendingMessages.splice(i, 1)', pendingLoop);
    const pendingAck = branch.indexOf("acknowledge('queued_removed');", remove);
    const noProof = branch.indexOf('withholding ACK for daemon fencing', pendingAck);

    expect(currentExact).toBeGreaterThanOrEqual(0);
    expect(pendingLoop).toBeGreaterThan(currentExact);
    expect(exactTurn).toBeGreaterThan(pendingLoop);
    expect(exactAttempt).toBeGreaterThan(exactTurn);
    expect(remove).toBeGreaterThan(exactAttempt);
    expect(pendingAck).toBeGreaterThan(remove);
    expect(noProof).toBeGreaterThan(pendingAck);
  });

  it('ACKs active exact expiry only after synchronous owned-CLI restart fencing', () => {
    const start = workerSource.indexOf("case 'expire_durable_turn':");
    const end = workerSource.indexOf("case 'reset_ambiguous_receiver':", start);
    const branch = workerSource.slice(start, end);
    const exactBranch = branch.indexOf('if (currentExact)');
    const restart = branch.indexOf("restartCliProcess('durable lease expiry'", exactBranch);
    const ack = branch.indexOf("acknowledge('cli_fenced');", restart);

    expect(exactBranch).toBeGreaterThanOrEqual(0);
    expect(restart).toBeGreaterThan(exactBranch);
    expect(ack).toBeGreaterThan(restart);
  });
});
