#!/usr/bin/env node

import readline from 'node:readline';

const protocol = 'botmux.remote-runner';
const version = 1;
const state = {
  version,
  provider: 'stalled-reattach',
  generation: 1,
  remoteSessionId: 'remote-stalled-reattach',
};
const emit = event => process.stdout.write(`${JSON.stringify({ protocol, version, ...event })}\n`);

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'hello') {
    emit({
      type: 'hello',
      requestId: command.requestId,
      provider: 'stalled-reattach',
      capabilities: ['start', 'resume', 'turn', 'cancel', 'detach', 'status', 'reattach'],
    });
  } else if (command.type === 'start') {
    emit({ type: 'ready', requestId: command.requestId, state });
  } else if (command.type === 'detach') {
    emit({ type: 'status', requestId: command.requestId, status: 'detached', state });
  }
  // Deliberately ignore reattach: admission must remain fenced.
});
