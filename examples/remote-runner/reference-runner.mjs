#!/usr/bin/env node

import readline from 'node:readline';

const protocol = 'botmux.remote-runner';
const version = 1;
const capabilities = [
  'start', 'resume', 'turn', 'cancel', 'detach', 'status',
  'terminal_screen', 'terminal_input', 'terminal_resize', 'reattach',
  'outbound_message',
  // Unknown additive capabilities are intentionally safe for older clients.
  'reference_future_capability',
];
let state;
let status = 'starting';
let screen = '';
let screenSequence = 0;
let cols = 120;
let rows = 40;
let pendingOutboundTurn;

function emit(event) {
  process.stdout.write(`${JSON.stringify({ protocol, version, ...event })}\n`);
}

function fail(command, code, message) {
  emit({
    type: 'failure',
    requestId: command?.requestId,
    turnId: command?.turnId,
    code,
    message,
    status: 'failed',
    retryable: false,
  });
}

function emitScreen() {
  emit({
    type: 'terminal_screen',
    generation: state?.generation ?? 0,
    sequence: screenSequence++,
    cols,
    rows,
    snapshot: screen,
  });
}

function finishTurn(command, content = command.content) {
  status = 'ready';
  emit({
    type: 'final',
    turnId: command.turnId,
    content,
    state,
    usage: {
      generation: state.generation,
      snapshot: {
        context: { usedTokens: 11, windowTokens: 1000, percentUsed: 1.1 },
        tokens: { in: 8, out: 3 },
        turnTokens: { in: 8, out: 3 },
        model: 'reference-model',
        reasoningEffort: 'medium',
      },
    },
  });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (!line.trim()) return;
  let command;
  try { command = JSON.parse(line); } catch { fail(undefined, 'invalid_json', 'invalid JSON command'); return; }
  if (command.protocol !== protocol || command.version !== version) {
    fail(command, 'protocol_mismatch', `expected ${protocol} v${version}`);
    return;
  }

  switch (command.type) {
    case 'hello':
      emit({ type: 'hello', requestId: command.requestId, provider: 'reference', capabilities });
      return;
    case 'start':
      state = {
        version,
        provider: 'reference',
        generation: 1,
        remoteSessionId: `reference:${command.sessionId}`,
      };
      status = 'ready';
      emit({ type: 'lineage_changed', state });
      emit({ type: 'ready', requestId: command.requestId, state });
      screen = 'reference runner ready\nline two';
      emitScreen();
      return;
    case 'resume':
      if (!command.state || command.state.provider !== 'reference') {
        fail(command, 'state_provider_mismatch', 'reference runner cannot resume foreign state');
        return;
      }
      state = command.resumeMode === 'rebuild'
        ? {
            ...command.state,
            generation: command.state.generation + 1,
            remoteSessionId: `reference:${command.sessionId}:generation-${command.state.generation + 1}`,
          }
        : command.state;
      status = 'ready';
      emit({ type: 'ready', requestId: command.requestId, state });
      screen = 'reference runner resumed';
      emitScreen();
      return;
    case 'turn': {
      if (status !== 'ready' || !state) {
        fail(command, 'not_ready', 'runner is not ready');
        return;
      }
      status = 'busy';
      emit({ type: 'status', requestId: command.requestId, status, state });
      if (!state.agentThreadId) {
        state = { ...state, agentThreadId: `reference-thread:${command.turnId}` };
        emit({ type: 'lineage_changed', state });
      }
      emit({ type: 'progress', turnId: command.turnId, content: `reference: ${command.content}` });
      screen = `reference: ${command.content}`;
      emitScreen();
      if (command.content === 'request-outbound') {
        pendingOutboundTurn = command;
        emit({
          type: 'outbound_message',
          operationId: 'reference-outbound-1',
          turnId: command.turnId,
          generation: state.generation,
          content: 'reference progress',
          responseKind: 'progress',
          mention: 'none',
        });
        return;
      }
      finishTurn(command);
      return;
    }
    case 'outbound_message_result': {
      if (!pendingOutboundTurn
          || command.operationId !== 'reference-outbound-1'
          || command.turnId !== pendingOutboundTurn.turnId
          || command.generation !== state?.generation) {
        fail(command, 'outbound_result_mismatch', 'outbound result does not match the pending operation');
        return;
      }
      const turn = pendingOutboundTurn;
      pendingOutboundTurn = undefined;
      finishTurn(turn, JSON.stringify(command.result));
      return;
    }
    case 'cancel':
      status = 'closed';
      emit({ type: 'status', requestId: command.requestId, status, state });
      return;
    case 'detach':
      status = 'detached';
      emit({ type: 'status', requestId: command.requestId, status, state });
      return;
    case 'reattach':
      if (status !== 'detached') {
        fail(command, 'not_detached', 'reference runner is not detached');
        return;
      }
      status = 'ready';
      emit({ type: 'status', requestId: command.requestId, status, state });
      return;
    case 'status':
      emit({ type: 'status', requestId: command.requestId, status, state });
      return;
    case 'terminal_input':
      if (command.generation !== state?.generation) {
        fail(command, 'stale_terminal_generation', 'terminal input generation mismatch');
        return;
      }
      screen += command.data;
      emitScreen();
      emit({ type: 'status', requestId: command.requestId, status, state });
      return;
    case 'terminal_resize':
      if (command.generation !== state?.generation) {
        fail(command, 'stale_terminal_generation', 'terminal resize generation mismatch');
        return;
      }
      cols = command.cols;
      rows = command.rows;
      emitScreen();
      emit({ type: 'status', requestId: command.requestId, status, state });
      return;
    default:
      fail(command, 'unsupported_command', `unsupported command: ${String(command.type)}`);
  }
});
