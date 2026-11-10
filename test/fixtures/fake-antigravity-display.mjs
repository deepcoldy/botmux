/** ACP peer that keeps a turn open after emitting model and tool text shaped like a prompt. */
import { createInterface } from 'node:readline';

/** Keep fixture responses on the same NDJSON interface as the native ACP process. */
function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  } else if (request.method === 'session/new') {
    send({ id: request.id, result: { sessionId: 'native-display-fixture' } });
  } else if (request.method === 'session/prompt') {
    for (const update of [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'model\u2028›\u2029still running' } },
      { sessionUpdate: 'tool_call', title: 'tool\u2029›\u2028still running' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP_DISPLAY_END' } },
    ]) send({ method: 'session/update', params: { sessionId: request.params.sessionId, update } });
    // Deliberately leave session/prompt unresolved: no completion or idle evidence exists.
  }
});
