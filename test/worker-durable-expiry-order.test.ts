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

  it('holds new input for the full async teardown window and wakes it only after replacement spawn', () => {
    const restartStart = workerSource.indexOf('async function restartCliProcess(');
    const restartEnd = workerSource.indexOf('// ─── HTTP + WebSocket Server', restartStart);
    const restart = workerSource.slice(restartStart, restartEnd);
    const arm = restart.indexOf('cliRestartInProgress = true;');
    const rawArm = restart.indexOf('rawInputRestartGate = true;', arm);
    const revoke = restart.indexOf('revokeManagedTurnOriginForRestart();', rawArm);
    const destroy = restart.indexOf('destroySession?.()', arm);
    const kill = restart.indexOf('killCli({ preservePending: opts.preservePending });', destroy);
    const spawn = restart.indexOf("spawnCli({ ...lastInitConfig, resume: true, prompt: '' });", destroy);
    const release = restart.indexOf('cliRestartInProgress = false;', spawn);
    const riffRawRelease = restart.indexOf(
      "if (effectiveBackendType === 'riff' && isPromptReady) releaseRawInputRestartGate();",
      release,
    );
    const wake = restart.indexOf('void flushPending();', riffRawRelease);

    expect(restartStart).toBeGreaterThanOrEqual(0);
    expect(restartEnd).toBeGreaterThan(restartStart);
    expect(arm).toBeGreaterThanOrEqual(0);
    expect(rawArm).toBeGreaterThan(arm);
    expect(revoke).toBeGreaterThan(rawArm);
    expect(revoke).toBeLessThan(destroy);
    expect(destroy).toBeGreaterThan(arm);
    expect(kill).toBeGreaterThan(destroy);
    expect(spawn).toBeGreaterThan(kill);
    expect(release).toBeGreaterThan(spawn);
    expect(riffRawRelease).toBeGreaterThan(release);
    expect(wake).toBeGreaterThan(riffRawRelease);

    const promptStart = workerSource.indexOf('function markPromptReady(): void');
    const promptEnd = workerSource.indexOf('\nfunction persistCliSessionId(', promptStart);
    const promptReady = workerSource.slice(promptStart, promptEnd);
    expect(promptReady).toContain('if (!cliRestartInProgress) releaseRawInputRestartGate();');

    const flushStart = workerSource.indexOf('async function flushPending(): Promise<void>');
    const flushEnd = workerSource.indexOf('\nfunction sendToPty(', flushStart);
    const flush = workerSource.slice(flushStart, flushEnd);
    expect(flush.indexOf('if (cliRestartInProgress) return;')).toBeGreaterThanOrEqual(0);
    expect(flush.indexOf('if (cliRestartInProgress) return;')).toBeLessThan(
      flush.indexOf('if (!backend || !cliAdapter) return;'),
    );

    const sendStart = flushEnd + 1;
    const sendEnd = workerSource.indexOf('// ─── Screen Update Timer', sendStart);
    const sendToPty = workerSource.slice(sendStart, sendEnd);
    expect(sendToPty).toContain('if (cliRestartInProgress || !backend)');
    expect(sendToPty.indexOf('if (cliRestartInProgress || !backend)')).toBeLessThan(
      sendToPty.indexOf('pendingInputAllowsTypeAhead'),
    );

    const rawStart = workerSource.indexOf("case 'raw_input':");
    const rawEnd = workerSource.indexOf("case 'rename_session':", rawStart);
    const rawInput = workerSource.slice(rawStart, rawEnd);
    const rawGate = rawInput.indexOf(
      'if (cliRestartInProgress || rawInputRestartGate || sessionRenameInFlight)',
    );
    const rawQueue = rawInput.indexOf('pendingRawInputs.push(msg)', rawGate);
    const rawDeliver = rawInput.indexOf('await deliverRawInput(msg)', rawQueue);
    expect(rawGate).toBeGreaterThanOrEqual(0);
    expect(rawQueue).toBeGreaterThan(rawGate);
    expect(rawDeliver).toBeGreaterThan(rawQueue);
    expect(rawInput).not.toContain('isPromptReady');

    const killStart = workerSource.indexOf('function killCli(');
    const killEnd = workerSource.indexOf('async function restartCliProcess(', killStart);
    const killCli = workerSource.slice(killStart, killEnd);
    for (const clear of [
      'currentBotmuxTurnId = undefined;',
      'currentBotmuxDispatchAttempt = undefined;',
      'currentVcMeetingImTurnOrigin = undefined;',
    ]) {
      expect(killCli).toContain(clear);
    }

    const revokeStart = workerSource.indexOf('function revokeManagedTurnOriginForRestart()');
    const revokeEnd = workerSource.indexOf('function authorizeManagedSend(', revokeStart);
    const revokeAuthority = workerSource.slice(revokeStart, revokeEnd);
    const commonRevokeStart = workerSource.indexOf('function completeManagedTurnOriginRevocation(');
    const commonRevoke = workerSource.slice(commonRevokeStart, revokeStart);
    expect(commonRevoke).toContain('sandboxRelayCapability = null;');
    expect(commonRevoke).toContain('currentVcMeetingImTurnOrigin = undefined;');
    expect(commonRevoke).toContain("type: 'managed_turn_origin_revoked'");
    expect(revokeAuthority).not.toContain('currentBotmuxTurnId = undefined;');
    expect(revokeAuthority).not.toContain('currentBotmuxDispatchAttempt = undefined;');

    const terminalStart = workerSource.indexOf('function emitTurnTerminal(');
    const terminalEnd = workerSource.indexOf('\nfunction workerIpcPayload(', terminalStart);
    const terminal = workerSource.slice(terminalStart, terminalEnd);
    expect(terminal).toContain('revokeManagedTurnOriginForTerminal(turnId, dispatchAttempt);');
    expect(terminal.indexOf('revokeManagedTurnOriginForTerminal(turnId, dispatchAttempt);'))
      .toBeLessThan(terminal.indexOf("type: 'turn_terminal'"));

    const flushStartForRotation = workerSource.indexOf('async function flushPending(): Promise<void>');
    const flushEndForRotation = workerSource.indexOf('\nfunction sendToPty(', flushStartForRotation);
    const flushForRotation = workerSource.slice(flushStartForRotation, flushEndForRotation);
    const assignNextTurn = flushForRotation.indexOf('currentBotmuxTurnId = item.turnId;');
    const republish = flushForRotation.indexOf('publishSandboxRelayCapability();', assignNextTurn);
    expect(assignNextTurn).toBeGreaterThanOrEqual(0);
    expect(republish).toBeGreaterThan(assignNextTurn);
  });
});
