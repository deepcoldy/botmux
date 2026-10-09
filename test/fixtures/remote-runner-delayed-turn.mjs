#!/usr/bin/env node

import readline from 'node:readline';

const protocol = 'botmux.remote-runner';
const version = 1;
const capabilities = ['start', 'resume', 'turn', 'cancel', 'detach', 'reattach', 'status'];
let state;
let status = 'starting';

const emit = event => process.stdout.write(`${JSON.stringify({ protocol, version, ...event })}\n`);

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'hello') {
    emit({ type: 'hello', requestId: command.requestId, provider: 'delayed-turn', capabilities });
  } else if (command.type === 'start') {
    state = {
      version,
      provider: 'delayed-turn',
      generation: 1,
      remoteSessionId: `delayed:${command.sessionId}`,
    };
    status = 'ready';
    emit({ type: 'ready', requestId: command.requestId, state });
  } else if (command.type === 'turn') {
    status = 'busy';
    emit({ type: 'status', requestId: command.requestId, status, state });
    setTimeout(() => {
      status = 'ready';
      emit({ type: 'final', turnId: command.turnId, content: 'done', state });
    }, 250);
  } else if (command.type === 'detach') {
    status = 'detached';
    emit({ type: 'status', requestId: command.requestId, status, state });
  } else if (command.type === 'reattach') {
    status = 'ready';
    emit({ type: 'status', requestId: command.requestId, status, state });
  } else if (command.type === 'cancel') {
    status = 'closed';
    emit({ type: 'status', requestId: command.requestId, status, state });
  } else if (command.type === 'status') {
    emit({ type: 'status', requestId: command.requestId, status, state });
  }
});
