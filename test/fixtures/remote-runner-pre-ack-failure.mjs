#!/usr/bin/env node

import readline from 'node:readline';

const protocol = 'botmux.remote-runner';
const version = 1;
const state = {
  version,
  provider: 'pre-ack-failure',
  generation: 1,
  remoteSessionId: 'remote-pre-ack',
};
let failed = false;

function emit(event) {
  process.stdout.write(`${JSON.stringify({ protocol, version, ...event })}\n`);
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'hello') {
    emit({
      type: 'hello',
      requestId: command.requestId,
      provider: 'pre-ack-failure',
      capabilities: ['start', 'resume', 'turn', 'cancel', 'detach', 'reattach', 'status'],
    });
  } else if (command.type === 'start') {
    emit({ type: 'ready', requestId: command.requestId, state });
  } else if (command.type === 'turn' && !failed) {
    failed = true;
    emit({
      type: 'failure',
      requestId: command.requestId,
      code: 'provider_rejected',
      message: 'provider rejected before busy acknowledgement',
      status: 'failed',
      retryable: true,
    });
  } else if (command.type === 'turn') {
    emit({ type: 'status', requestId: command.requestId, status: 'busy', state });
    emit({ type: 'final', turnId: command.turnId, content: 'recovered', state });
  } else if (command.type === 'cancel') {
    emit({ type: 'status', requestId: command.requestId, status: 'closed', state });
  }
});
