#!/usr/bin/env node

import readline from 'node:readline';

const protocol = 'botmux.remote-runner';
const version = 1;
const state = { version, provider: 'review-cases', generation: 1, remoteSessionId: 'review-cases-session' };

function emit(event) {
  process.stdout.write(`${JSON.stringify({ protocol, version, ...event })}\n`);
}

function outbound(operationId, turnId) {
  emit({
    type: 'outbound_message', operationId, turnId, generation: 1,
    content: operationId, responseKind: 'progress', mention: 'none',
  });
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'hello') {
    const capabilities = ['start', 'resume', 'turn', 'cancel', 'detach', 'reattach', 'status', 'terminal_screen'];
    if (!command.sessionId.includes('no-outbound')) capabilities.push('outbound_message');
    emit({
      type: 'hello', requestId: command.requestId, provider: 'review-cases',
      capabilities,
    });
    return;
  }
  if (command.type === 'start' || command.type === 'resume') {
    emit({ type: 'ready', requestId: command.requestId, state });
    return;
  }
  if (command.type !== 'turn') return;

  if (command.content === 'pre-busy-progress') {
    emit({ type: 'progress', turnId: command.turnId, content: 'too early' });
    return;
  }
  if (command.content === 'pre-busy-outbound') {
    outbound('too-early', command.turnId);
    return;
  }
  if (command.content === 'pre-busy-final') {
    emit({ type: 'final', turnId: command.turnId, content: 'too early' });
    return;
  }

  emit({ type: 'status', requestId: command.requestId, status: 'busy' });
  if (command.content === 'post-ack-failure-both') {
    emit({ type: 'failure', requestId: command.requestId, turnId: command.turnId,
      code: 'provider_failed', message: 'failed after acknowledgement', status: 'failed', retryable: true });
  } else if (command.content === 'post-ack-failure-turn') {
    emit({ type: 'failure', turnId: command.turnId,
      code: 'provider_failed', message: 'failed after acknowledgement', status: 'failed', retryable: true });
  } else if (command.content === 'post-ack-failure-request') {
    emit({ type: 'failure', requestId: command.requestId,
      code: 'provider_failed', message: 'missing turn id', status: 'failed', retryable: true });
  } else if (command.content === 'screen-sequence') {
    emit({ type: 'terminal_screen', generation: 1, sequence: 3, cols: 80, rows: 24, snapshot: 'fresh' });
    emit({ type: 'terminal_screen', generation: 1, sequence: 3, cols: 80, rows: 24, snapshot: 'duplicate' });
    emit({ type: 'terminal_screen', generation: 1, sequence: 2, cols: 80, rows: 24, snapshot: 'older' });
    emit({ type: 'final', turnId: command.turnId, content: 'done' });
  } else if (command.content === 'screen-stale-generation') {
    emit({ type: 'terminal_screen', generation: 0, sequence: 99, cols: 80, rows: 24, snapshot: 'stale' });
    emit({ type: 'final', turnId: command.turnId, content: 'done' });
  } else if (command.content === 'screen-future-generation') {
    emit({ type: 'terminal_screen', generation: 2, sequence: 0, cols: 80, rows: 24, snapshot: 'future' });
  } else if (command.content === 'usage-future-generation') {
    emit({ type: 'final', turnId: command.turnId, content: 'invalid usage',
      usage: { generation: 2, snapshot: { context: null, tokens: null } } });
  } else if (command.content === 'unadvertised-outbound') {
    outbound('not-advertised', command.turnId);
  } else if (command.content === 'outbound-future-generation') {
    emit({ type: 'outbound_message', operationId: 'future-generation', turnId: command.turnId,
      generation: 2, content: 'future', responseKind: 'progress', mention: 'none' });
  } else if (command.content === 'final-before-result') {
    outbound('pending-operation', command.turnId);
    emit({ type: 'final', turnId: command.turnId, content: 'too early' });
  } else if (command.content === 'cross-turn-one') {
    outbound('old-operation', command.turnId);
    setTimeout(() => emit({ type: 'failure', turnId: command.turnId,
      code: 'first_failed', message: 'first turn failed', status: 'failed', retryable: true }), 5);
  } else if (command.content === 'cross-turn-two') {
    outbound('new-operation', command.turnId);
    setTimeout(() => emit({ type: 'final', turnId: command.turnId, content: 'too early' }), 50);
  }
});
