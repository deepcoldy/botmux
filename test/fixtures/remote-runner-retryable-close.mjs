#!/usr/bin/env node

import readline from 'node:readline';

const protocol = 'botmux.remote-runner';
const version = 1;
const emit = event => process.stdout.write(`${JSON.stringify({ protocol, version, ...event })}\n`);

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'hello') {
    emit({
      type: 'hello',
      requestId: command.requestId,
      provider: 'retryable-close',
      capabilities: ['start', 'resume', 'turn', 'cancel', 'detach', 'reattach', 'status'],
    });
  } else if (command.type === 'start') {
    emit({
      type: 'ready',
      requestId: command.requestId,
      state: {
        version,
        provider: 'retryable-close',
        generation: 1,
        remoteSessionId: 'remote-retryable',
      },
    });
  } else if (command.type === 'cancel') {
    emit({
      type: 'failure',
      requestId: command.requestId,
      code: 'remote_close_not_applied',
      message: 'remote target remains live',
      status: 'failed',
      retryable: true,
    });
  } else if (command.type === 'turn') {
    emit({ type: 'status', requestId: command.requestId, status: 'busy' });
    emit({ type: 'final', turnId: command.turnId, content: command.content });
  }
});
