#!/usr/bin/env node

import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const version = process.env.FAKE_CODEX_VERSION ?? '0.136.0';

if (args[0] === '--version') {
  process.stdout.write(`codex-cli ${version}\n`);
  process.exit(0);
}

if (args[0] !== 'app-server') {
  process.stderr.write(`unexpected fake codex invocation: ${args.join(' ')}\n`);
  process.exit(2);
}

const logPath = process.env.FAKE_CODEX_LOG;
const behavior = process.env.FAKE_CODEX_BEHAVIOR ?? 'success';
let inputBuffer = '';
let turnAttempt = 0;

function write(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

function respond(id, result) {
  write({ id, result });
}

function reject(id, code, message) {
  write({ id, error: { code, message } });
}

function notify(method, params) {
  write({ method, params });
}

function completeTurn(request) {
  const threadId = request.params.threadId;
  const turnId = `turn-fake-${turnAttempt}`;
  respond(request.id, { turn: { id: turnId } });
  notify('turn/started', { threadId, turn: { id: turnId } });
  notify('item/completed', {
    threadId,
    turnId,
    item: {
      id: `message-fake-${turnAttempt}`,
      type: 'agentMessage',
      phase: 'final_answer',
      text: `fake answer ${turnAttempt}`,
    },
  });
  notify('turn/completed', { threadId, turn: { id: turnId } });
}

function handle(request) {
  if (logPath) appendFileSync(logPath, JSON.stringify(request) + '\n');
  if (typeof request.id !== 'number') return;

  if (request.method === 'initialize') {
    respond(request.id, { userAgent: 'fake-codex-app-server' });
    return;
  }
  if (request.method === 'thread/start') {
    respond(request.id, { thread: { id: 'thread-fake' } });
    return;
  }
  if (request.method === 'thread/resume') {
    respond(request.id, { thread: { id: request.params.threadId } });
    return;
  }
  if (request.method === 'thread/name/set') {
    respond(request.id, {});
    return;
  }
  if (request.method !== 'turn/start') {
    respond(request.id, {});
    return;
  }

  turnAttempt += 1;
  if (behavior === 'capability-error' && turnAttempt === 1) {
    reject(request.id, -32602, 'unknown field additionalContext; experimentalApi unsupported');
    return;
  }
  if (behavior === 'generic-error') {
    reject(request.id, -32000, 'model overloaded');
    return;
  }
  completeTurn(request);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  inputBuffer += chunk;
  for (;;) {
    const newline = inputBuffer.indexOf('\n');
    if (newline < 0) break;
    const line = inputBuffer.slice(0, newline).trim();
    inputBuffer = inputBuffer.slice(newline + 1);
    if (!line) continue;
    handle(JSON.parse(line));
  }
});
