#!/usr/bin/env node

import readline from 'node:readline';

const protocol = 'botmux.remote-runner';
const version = 1;
const state = {
  version,
  provider: 'session-tool-test',
  generation: 1,
  remoteSessionId: 'session-tool-test-session',
};
let status = 'starting';
let activeTurn;

function emit(event) {
  process.stdout.write(`${JSON.stringify({ protocol, version, ...event })}\n`);
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'hello') {
    const capabilities = ['start', 'resume', 'turn', 'cancel', 'detach', 'reattach', 'status'];
    if (!command.sessionId.includes('no-session-tool')) capabilities.push('session_tool');
    if (!command.sessionId.includes('no-schedule-capability')) {
      capabilities.push('session_tool_schedule');
    }
    if (!command.sessionId.includes('no-actor-capability')) {
      capabilities.push('session_tool_schedule_actor');
    }
    emit({
      type: 'hello', requestId: command.requestId, provider: 'session-tool-test',
      capabilities,
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
    emit({ type: 'status', requestId: command.requestId, status });
    emit({
      type: 'session_tool',
      operationId: 'session-tool-1',
      turnId: command.turnId,
      generation: command.content === 'future-generation' ? 2 : 1,
      ...(['schedule-actor', 'schedule-actor-mutate'].includes(command.content)
        ? { controllerOpenId: 'ou_developer' }
        : {}),
      request: command.content === 'schedule-tool'
        ? { tool: 'schedule.list' }
        : command.content === 'schedule-actor'
          ? { tool: 'schedule.add', schedule: '10m', prompt: 'check' }
        : command.content === 'schedule-actor-mutate'
          ? { tool: 'schedule.remove', taskId: 'a1b2c3d4' }
        : { tool: 'history', limit: 20, scope: 'thread', withCardJson: true },
    });
    return;
  }
  if (command.type === 'session_tool_result') {
    status = 'ready';
    emit({
      type: 'final',
      turnId: activeTurn.turnId,
      content: JSON.stringify(command.result),
    });
    activeTurn = undefined;
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
