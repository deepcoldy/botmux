#!/usr/bin/env node

import readline from 'node:readline';

const protocol = 'botmux.remote-runner';
const version = 1;
const state = { version, provider: 'outbound-test', generation: 1, remoteSessionId: 'outbound-test-session' };
let status = 'starting';
let activeTurn;
let expectedResults = 0;
const results = [];

function emit(event) {
  process.stdout.write(`${JSON.stringify({ protocol, version, ...event })}\n`);
}

function outbound(operationId, turnId, content) {
  emit({
    type: 'outbound_message',
    operationId,
    turnId,
    generation: 1,
    content,
    responseKind: 'progress',
    mention: 'none',
  });
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'hello') {
    emit({
      type: 'hello', requestId: command.requestId, provider: 'outbound-test',
      capabilities: ['start', 'resume', 'turn', 'cancel', 'detach', 'reattach', 'status', 'outbound_message'],
    });
    return;
  }
  if (command.type === 'start') {
    status = 'ready';
    emit({ type: 'ready', requestId: command.requestId, state });
    return;
  }
  if (command.type === 'turn') {
    status = 'busy';
    activeTurn = command;
    results.length = 0;
    emit({ type: 'status', requestId: command.requestId, status });
    if (command.content === 'duplicate') {
      expectedResults = 2;
      outbound('same-operation', command.turnId, 'same payload');
      outbound('same-operation', command.turnId, 'same payload');
    } else if (command.content === 'conflict') {
      expectedResults = 2;
      outbound('same-operation', command.turnId, 'first payload');
      outbound('same-operation', command.turnId, 'changed payload');
    } else if (command.content === 'rate') {
      expectedResults = 11;
      for (let index = 0; index < expectedResults; index++) {
        outbound(`operation-${index}`, command.turnId, `payload ${index}`);
      }
    }
    return;
  }
  if (command.type === 'outbound_message_result') {
    results.push({ operationId: command.operationId, result: command.result });
    if (results.length === expectedResults) {
      status = 'ready';
      emit({ type: 'final', turnId: activeTurn.turnId, content: JSON.stringify(results) });
      activeTurn = undefined;
    }
    return;
  }
  if (command.type === 'cancel') {
    status = 'closed';
    emit({ type: 'status', requestId: command.requestId, status });
    return;
  }
  if (command.type === 'detach') {
    status = 'detached';
    emit({ type: 'status', requestId: command.requestId, status });
    return;
  }
  if (command.type === 'reattach') {
    status = 'ready';
    emit({ type: 'status', requestId: command.requestId, status });
    return;
  }
  if (command.type === 'status') {
    emit({ type: 'status', requestId: command.requestId, status });
  }
});
