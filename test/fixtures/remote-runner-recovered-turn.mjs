#!/usr/bin/env node
import readline from 'node:readline';

const protocol = 'botmux.remote-runner';
const version = 1;
const turnId = 'turn-survived';
const generation = 7;
let state;

function emit(event) {
  process.stdout.write(`${JSON.stringify({ protocol, version, ...event })}\n`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (!line.trim()) return;
  const command = JSON.parse(line);
  if (command.type === 'hello') {
    emit({
      type: 'hello',
      requestId: command.requestId,
      provider: 'recovered-test',
      capabilities: ['start', 'resume', 'turn', 'cancel', 'detach', 'reattach', 'status', 'turn_recovery'],
    });
    return;
  }
  if (command.type === 'resume') {
    state = command.state;
    const ready = {
      protocol,
      version,
      type: 'ready',
      requestId: command.requestId,
      state,
      recoveredTurn: {
        turnId,
        generation,
        dispatchAttempt: 4,
        startedAtMs: 1000,
        trustedCaller: {
          requestUserOpenId: 'ou_actor',
          requestLarkAppId: 'cli_app',
          senderType: 'user',
        },
      },
    };
    const progress = {
      protocol,
      version,
      type: 'progress',
      turnId,
      content: 'recovered progress',
    };
    // Exercise the protocol edge where resume readiness and recovered-turn
    // output arrive in one stdout chunk. The host must install turn ownership
    // before it resolves the ready request's promise continuation.
    process.stdout.write(`${JSON.stringify(ready)}\n${JSON.stringify(progress)}\n`);
    setTimeout(() => emit({ type: 'final', turnId, content: 'recovered final', state }), 50);
    return;
  }
  if (command.type === 'cancel') {
    emit({ type: 'status', requestId: command.requestId, status: 'closed', state });
    return;
  }
  if (command.type === 'status') {
    emit({ type: 'status', requestId: command.requestId, status: 'busy' });
    return;
  }
  emit({
    type: 'failure',
    requestId: command.requestId,
    turnId: command.turnId,
    code: 'unexpected_command',
    message: 'unexpected command during recovered turn',
    status: 'failed',
    retryable: false,
  });
});
