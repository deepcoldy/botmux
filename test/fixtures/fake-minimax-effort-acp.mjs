import { createInterface } from 'node:readline';

const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const model = { id: 'model', currentValue: 'm:minimax:MiniMax-M3:v:thinking', options: [
  { value: 'm:minimax:MiniMax-M3:v:thinking' },
  { value: 'm:minimax:MiniMax-M3.1-Flash:v:thinking' },
] };
const effort = { id: 'thinkingEffort', currentValue: 'default', options: [
  'default', 'low', 'medium', 'high', 'xhigh', 'max',
].map(value => ({ value })) };
const permission = { id: 'permissionMode', currentValue: 'auto', options: [
  { value: 'auto' }, { value: 'bypassPermissions' },
] };
const control = () => ({ configOptions: [permission, model,
  ...(model.currentValue === 'm:minimax:MiniMax-M3.1-Flash:v:thinking' ? [effort] : []),
] });
let sessionId;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') send({ id, result: { protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } } });
  else if (method === 'session/new' || method === 'session/resume') {
    sessionId = params.sessionId ?? 'effort-session';
    send({ id, result: { sessionId, ...control() } });
  } else if (method === 'session/set_config_option') {
    const option = control().configOptions.find(o => o.id === params.configId);
    if (!option?.options.some(o => o.value === params.value)) {
      send({ id, error: { code: -32602, message: 'Unsupported configuration' } });
    } else {
      option.currentValue = params.value;
      send({ id, result: control() });
    }
  } else if (method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text',
        text: `${sessionId}:${model.currentValue}:${effort.currentValue}` },
    } } });
    send({ id, result: { stopReason: 'end_turn' } });
  }
}
