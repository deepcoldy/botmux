/** Deterministic ACP peer for transport, cancellation and native-session isolation tests. */
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const mode = process.env.AGY_TEST_MODE;
const sessionId = 'native-agy-test-session';
const configs = { models: { availableModels: [{ modelId: 'gemini-test-high' }] }, configOptions: [
  { id: 'model', category: 'model', options: [{ value: 'gemini-test' }] },
  { id: 'effort', category: 'thought_level', options: [{ value: 'high' }] },
] };
/** Emit a complete NDJSON frame, including UTF-8 split across transport chunks. */
function send(message) {
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const split = bytes.indexOf(Buffer.from('中文')) + 1;
  if (split > 0) {
    process.stdout.write(bytes.subarray(0, split));
    setImmediate(() => process.stdout.write(bytes.subarray(split)));
  } else process.stdout.write(bytes);
}
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(process.env.AGY_TEST_LOG, JSON.stringify({ ...request, pid: process.pid,
    owner: process.env.BOTMUX_OWNER_OPEN_ID, legacyOwner: process.env.__OWNER_OPEN_ID, args: process.argv.slice(2) }) + '\n');
  if (request.method === 'initialize') send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: mode !== 'no-restore' } } });
  else if (request.method === 'session/new') send({ id: request.id, result: { sessionId, ...configs } });
  else if (request.method === 'session/load') send({ id: request.id, result: mode === 'wrong-load' ? { sessionId: 'foreign-session' } : configs });
  else if (['session/set_config_option', 'session/set_model'].includes(request.method)) send({ id: request.id, result: configs });
  else if (request.method === 'session/prompt') {
    if (mode === 'hang') return;
    if (mode === 'exit') { process.exit(7); return; }
    if (mode === 'invalid-json') { process.stdout.write('{bad-json}\n'); return; }
    if (mode === 'permission') { send({ id: 900, method: 'session/request_permission', params: { sessionId } }); return; }
    const update = value => send({ method: 'session/update', params: {
      sessionId: mode === 'foreign-update' ? 'foreign-session' : request.params.sessionId, update: value,
    } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'intermediate commentary' } });
    update({ sessionUpdate: 'tool_call', title: 'Read fixture' });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '中文 complete answer' } });
    setImmediate(() => send({ id: request.id, result: { stopReason: mode === 'limit' ? 'max_tokens' : 'end_turn' } }));
  }
});
