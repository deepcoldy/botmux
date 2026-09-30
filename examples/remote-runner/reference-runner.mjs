#!/usr/bin/env node

import readline from 'node:readline';

const protocol = 'botmux.remote-runner';
const version = 1;
const capabilities = ['start', 'resume', 'turn', 'cancel', 'detach', 'status'];
let state;
let status = 'starting';

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
      return;
    case 'resume':
      if (!command.state || command.state.provider !== 'reference') {
        fail(command, 'state_provider_mismatch', 'reference runner cannot resume foreign state');
        return;
      }
      state = command.state;
      status = 'ready';
      emit({ type: 'ready', requestId: command.requestId, state });
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
      status = 'ready';
      emit({ type: 'final', turnId: command.turnId, content: command.content, state });
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
    case 'status':
      emit({ type: 'status', requestId: command.requestId, status, state });
      return;
    default:
      fail(command, 'unsupported_command', `unsupported command: ${String(command.type)}`);
  }
});
