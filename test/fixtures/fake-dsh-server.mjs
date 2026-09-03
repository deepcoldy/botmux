#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
/**
 * Fake dsh SDK JSON-RPC server for dsh-runner tests.
 *
 * Speaks the deepseek-harness SDK runtime protocol over stdio
 * (newline-delimited JSON-RPC):
 *   - initialize  -> {serverInfo}
 *   - session/prompt -> {messageId}, then async notifications:
 *       session.event (tool/call, assistant/message, tool/result),
 *       session.status idle
 *   - shutdown -> {}
 *
 * Scenarios via FAKE_DSH_SCENARIO:
 *   happy (default) - full event stream with assistant text + usage
 *   multi-step      - two assistant/message events; only the last is the final
 *                     answer, usage accumulates, and its two text blocks join
 *                     with no separator
 *   stale           - stale assistant/message + idle BEFORE this turn's
 *                     inbox receipt; the runner must drop them
 *   early-receipt   - receipt + events + idle are sent BEFORE the JSON-RPC
 *                     response (real async ordering)
 *   retry           - first session/prompt fails with a JSON-RPC error, the
 *                     second runs the happy path (preamble must survive)
 *   bad-prompt-ack  - first session/prompt returns no messageId, the second
 *                     runs the happy path (preamble must survive)
 *   bad-initialize  - initialize returns no server identity
 *   error           - session/prompt fails with a JSON-RPC error
 *   turn-error      - prompt accepted, but the turn ends with an LLM error
 *                     (like the real 401 path): no assistant/message, a
 *                     turn/end with reason.error — the runner must surface it
 *   empty           - tool calls only, no assistant text (empty final)
 *   hang            - never goes idle (exercises the turn watchdog)
 */

const scenario = process.env.FAKE_DSH_SCENARIO ?? 'happy';
const finalText = process.env.FAKE_DSH_FINAL_TEXT ?? '你好，我是 dsh。';
const logPath = process.env.FAKE_DSH_LOG;
const expectedEnv = process.env.FAKE_DSH_EXPECT_ENV_JSON
  ? JSON.parse(process.env.FAKE_DSH_EXPECT_ENV_JSON)
  : {};
const expectedAbsentEnv = (process.env.FAKE_DSH_EXPECT_ABSENT_ENV ?? '')
  .split(',')
  .map(name => name.trim())
  .filter(Boolean);

for (const [name, expected] of Object.entries(expectedEnv)) {
  if (process.env[name] !== expected) {
    process.stderr.write(`expected env ${name} to match test value\n`);
    process.exit(2);
  }
}
for (const name of expectedAbsentEnv) {
  if (process.env[name] !== undefined) {
    process.stderr.write(`expected env ${name} to be absent\n`);
    process.exit(2);
  }
}

let inputBuffer = '';
let promptCount = 0;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function sessionEvent(sessionId, event) {
  notify('session.event', { sessionId, event });
}

function sendInboxReceipt(sessionId, messageId) {
  sessionEvent(sessionId, {
    type: 'agent/inbox/spliced',
    data: { inserted: [{ id: messageId, role: 'user' }] },
  });
}

function runHappyTurn(sessionId, messageId) {
  sendInboxReceipt(sessionId, messageId);
  const callId = 'call_test_1';
  sessionEvent(sessionId, {
    type: 'tool/call',
    data: { callId, name: 'bash', arguments: '{"command":"echo hi"}' },
  });
  sessionEvent(sessionId, {
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thinking...' },
          { type: 'text', text: finalText },
        ],
      },
      usage: { inputTokens: 100, outputTokens: 42, cacheReadTokens: 10, reasoningTokens: 8 },
    },
  });
  sessionEvent(sessionId, {
    type: 'tool/result',
    data: {
      message: {
        source: { callId },
        content: [{ type: 'tool-result', content: [{ type: 'text', text: 'hi\n' }], isError: false }],
      },
    },
  });
  notify('session.status', { sessionId, status: 'idle' });
}

function runMultiStepTurn(sessionId, messageId) {
  sendInboxReceipt(sessionId, messageId);
  const callId = 'call_multi_1';
  sessionEvent(sessionId, {
    type: 'tool/call',
    data: { callId, name: 'bash', arguments: '{"command":"ls"}' },
  });
  sessionEvent(sessionId, {
    type: 'assistant/message',
    data: {
      message: { role: 'assistant', content: [{ type: 'text', text: '中间步骤的阶段性文本' }] },
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 3 },
    },
  });
  sessionEvent(sessionId, {
    type: 'tool/result',
    data: {
      message: {
        source: { callId },
        content: [{ type: 'tool-result', content: [], isError: false }],
      },
    },
  });
  sessionEvent(sessionId, {
    type: 'assistant/message',
    data: {
      // Two text blocks in one message concatenate with no separator.
      message: { role: 'assistant', content: [{ type: 'text', text: '你好，' }, { type: 'text', text: '我是 dsh。' }] },
      usage: { inputTokens: 50, outputTokens: 30, cacheReadTokens: 2, cacheWriteTokens: 1 },
    },
  });
  notify('session.status', { sessionId, status: 'idle' });
}

/** Stale notifications from a previous turn arrive BEFORE this turn's
 *  receipt; the runner must drop them and only own what follows the receipt. */
function runStaleTurn(sessionId, messageId) {
  sessionEvent(sessionId, {
    type: 'assistant/message',
    data: {
      message: { role: 'assistant', content: [{ type: 'text', text: 'STALE' }] },
      usage: { inputTokens: 999, outputTokens: 999 },
    },
  });
  notify('session.status', { sessionId, status: 'idle' });
  sendInboxReceipt(sessionId, messageId);
  sessionEvent(sessionId, {
    type: 'assistant/message',
    data: {
      message: { role: 'assistant', content: [{ type: 'text', text: finalText }] },
      usage: { inputTokens: 10, outputTokens: 5 },
    },
  });
  notify('session.status', { sessionId, status: 'idle' });
}

/** A turn that fails at the LLM call (mirrors the real 401 path): no
 *  assistant/message, just a turn/end with an error reason. */
function runTurnErrorTurn(sessionId, messageId) {
  sendInboxReceipt(sessionId, messageId);
  sessionEvent(sessionId, { type: 'turn/start', data: { turn: 1 } });
  sessionEvent(sessionId, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'error', error: { message: 'Authentication Fails', code: 'AUTH', status: 401 } } },
  });
  notify('session.status', { sessionId, status: 'idle' });
}

function runEmptyTurn(sessionId, messageId) {
  sendInboxReceipt(sessionId, messageId);
  sessionEvent(sessionId, {
    type: 'tool/call',
    data: { callId: 'call_empty', name: 'bash', arguments: '{}' },
  });
  sessionEvent(sessionId, {
    type: 'tool/result',
    data: {
      message: {
        source: { callId: 'call_empty' },
        content: [{ type: 'tool-result', content: [], isError: false }],
      },
    },
  });
  notify('session.status', { sessionId, status: 'idle' });
}

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    if (logPath) appendFileSync(logPath, JSON.stringify({ initialize: msg.params }) + '\n');
    if (scenario === 'bad-initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { serverInfo: { name: 'fake-dsh', version: '0.0.1' } },
    });
    return;
  }
  if (msg.method === 'session/prompt') {
    if (logPath) appendFileSync(logPath, JSON.stringify({ prompt: msg.params }) + '\n');
    if (scenario === 'bad-prompt-ack' && promptCount === 0) {
      promptCount++;
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    }
    if (scenario === 'error' || (scenario === 'retry' && promptCount === 0)) {
      promptCount++;
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: 'boom' },
      });
      return;
    }
    promptCount++;
    const messageId = `msg-${msg.id}`;
    const sessionId = msg.params?.sessionId ?? 'unknown';
    if (scenario === 'early-receipt') {
      // Notifications BEFORE the JSON-RPC response (real async ordering:
      // the real server emits the spliced receipt before returning the ACK).
      if (logPath) appendFileSync(logPath, JSON.stringify({ phase: 'notifications' }) + '\n');
      runHappyTurn(sessionId, messageId);
      send({ jsonrpc: '2.0', id: msg.id, result: { messageId } });
      if (logPath) appendFileSync(logPath, JSON.stringify({ phase: 'response' }) + '\n');
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { messageId } });
    if (scenario === 'hang') return;
    // Notifications land after the enqueue receipt, like the real server.
    setImmediate(() => {
      if (scenario === 'empty') runEmptyTurn(sessionId, messageId);
      else if (scenario === 'multi-step') runMultiStepTurn(sessionId, messageId);
      else if (scenario === 'stale') runStaleTurn(sessionId, messageId);
      else if (scenario === 'turn-error') runTurnErrorTurn(sessionId, messageId);
      else runHappyTurn(sessionId, messageId);
    });
    return;
  }
  if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    setTimeout(() => process.exit(0), 50);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  inputBuffer += chunk;
  for (;;) {
    const idx = inputBuffer.indexOf('\n');
    if (idx < 0) break;
    const line = inputBuffer.slice(0, idx).trim();
    inputBuffer = inputBuffer.slice(idx + 1);
    if (line) handleLine(line);
  }
});
process.stdin.on('end', () => process.exit(0));
