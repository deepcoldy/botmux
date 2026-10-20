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
      provider: 'stalled-close',
      capabilities: ['start', 'resume', 'turn', 'cancel', 'detach', 'status'],
    });
  } else if (command.type === 'start') {
    emit({
      type: 'ready',
      requestId: command.requestId,
      state: {
        version,
        provider: 'stalled-close',
        generation: 1,
        remoteSessionId: 'remote-stalled',
      },
    });
  }
  // Deliberately ignore cancel: the backend must classify the outcome as
  // uncertain and keep write admission fenced.
});
