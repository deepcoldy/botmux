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
 *                     answer, and usage must accumulate across both
 *   retry           - first session/prompt fails with a JSON-RPC error, the
 *                     second runs the happy path (preamble must survive)
 *   error           - session/prompt fails with a JSON-RPC error
 *   empty           - tool calls only, no assistant text (empty final)
 *   hang            - never goes idle (exercises the turn watchdog)
 */

const scenario = process.env.FAKE_DSH_SCENARIO ?? 'happy';
const finalText = process.env.FAKE_DSH_FINAL_TEXT ?? '你好，我是 dsh。';
const logPath = process.env.FAKE_DSH_LOG;

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

function runHappyTurn(sessionId) {
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

function runMultiStepTurn(sessionId) {
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
      message: { role: 'assistant', content: [{ type: 'text', text: finalText }] },
      usage: { inputTokens: 50, outputTokens: 30, cacheReadTokens: 2, cacheWriteTokens: 1 },
    },
  });
  notify('session.status', { sessionId, status: 'idle' });
}

function runEmptyTurn(sessionId) {
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
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { serverInfo: { name: 'fake-dsh', version: '0.0.1' } },
    });
    return;
  }
  if (msg.method === 'session/prompt') {
    if (logPath) appendFileSync(logPath, JSON.stringify({ prompt: msg.params }) + '\n');
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
    send({ jsonrpc: '2.0', id: msg.id, result: { messageId: `msg-${msg.id}` } });
    const sessionId = msg.params?.sessionId ?? 'unknown';
    if (scenario === 'hang') return;
    // Notifications land after the enqueue receipt, like the real server.
    setImmediate(() => {
      if (scenario === 'empty') runEmptyTurn(sessionId);
      else if (scenario === 'multi-step') runMultiStepTurn(sessionId);
      else runHappyTurn(sessionId);
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
