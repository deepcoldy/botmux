import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const configOptions = [{ id: 'permissionMode', currentValue: 'auto', options: [{ value: 'auto' }] }];
let sessionId;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  appendFileSync(process.env.MCODE_COMPACT_TEST_LOG, JSON.stringify(message) + '\n');
  const { id, method, params } = message;
  if (method === 'initialize') send({ id, result: { protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } } });
  else if (method === 'session/resume') {
    sessionId = params.sessionId;
    send({ id, result: { sessionId, configOptions } });
  } else if (method === 'session/prompt') {
    const text = params.prompt[0].text;
    if (text === '/compact' && process.env.MCODE_COMPACT_TEST_FAIL === '1') {
      send({ id, error: { code: -32603, message: 'compaction failed' } });
      continue;
    }
    const content = text === '/compact'
      ? 'Compaction completed.\nMessages: 10 → 3\nTokens: 5000 → 1200'
      : `answer:${text}`;
    send({ method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: content },
    } } });
    send({ id, result: { stopReason: 'end_turn' } });
  } else send({ id, error: { code: -32601, message: `unexpected method: ${method}` } });
}
