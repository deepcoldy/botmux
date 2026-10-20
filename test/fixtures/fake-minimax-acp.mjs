import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = value => process.env.MCODE_TEST_LOG && appendFileSync(process.env.MCODE_TEST_LOG, JSON.stringify(value) + '\n');
log({ pid: process.pid, args: process.argv.slice(2), owner: process.env.BOTMUX_OWNER_OPEN_ID, legacyOwner: process.env.__OWNER_OPEN_ID });
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const control = { configOptions: [
  { id: 'permissionMode', currentValue: 'auto', options: [{ value: 'auto' }, { value: 'bypassPermissions' }] },
  { id: 'model', currentValue: 'm:minimax:fixture:v:thinking', options: [{ value: 'm:minimax:fixture:v:thinking' }, { value: 'm:custom_provider%3Atest:model:v:thinking' }, { value: 'm:custom_provider%3Atest:model:v:fast%20mode' }] },
  { id: 'thinkingEffort', currentValue: 'medium', options: ['low', 'medium', 'high'].map(value => ({ value })) },
] };
let sessionId;
let promptId;
let prompt;
let questionCount = 0;
let answeredCount = 0;
const scenario = process.env.MCODE_ACP_SCENARIO;
const update = u => send({ method: 'session/update', params: { sessionId, update: u } });
const complete = (text, stopReason = 'end_turn') => {
  update({ sessionUpdate: 'agent_message_chunk', messageId: 'final', content: { type: 'text', text } });
  send({ id: promptId, result: { stopReason } });
};
const askSequential = () => {
  const index = answeredCount + 1;
  update({ sessionUpdate: 'tool_call', toolCallId: `questionnaire-${index}`, title: 'ask_user' });
  send({ id: `sequential-${index}`, method: 'elicitation/create', params: {
    sessionId, mode: 'form', message: `Question ${index}`, requestedSchema: {
      type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'],
    },
  } });
};
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line); log({ message });
  const { method, id, params } = message;
  if (method === 'initialize') send({ id, result: { protocolVersion: scenario === 'version' ? 2 : 1,
    ...(scenario === 'native-questionnaire' ? { agentInfo: { name: 'minimax-code' } } : {}),
    agentCapabilities: { loadSession: true, sessionCapabilities: scenario === 'load' ? {} : { resume: {} } } } });
  else if (method === 'session/new') { sessionId = 'session_fixture'; send({ id, result: { sessionId, ...control } }); }
  else if (method === 'session/resume' || method === 'session/load') {
    sessionId = params.sessionId;
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD HISTORY MUST NOT BE REPLIED' } });
    send({ id, result: { ...(scenario === 'resume-mismatch' ? { sessionId: 'foreign' } : {}), ...control } });
  } else if (method === 'session/set_config_option') {
    control.configOptions.find(o => o.id === params.configId).currentValue = params.value;
    send({ id, result: control });
  } else if (method === 'session/prompt') {
    promptId = id; prompt = params.prompt[0].text;
    if (/^permission-burst-(8|9)$/.test(prompt) || prompt === 'permission-window') {
      questionCount = prompt === 'permission-window' ? 9 : Number(prompt.split('-').at(-1)); answeredCount = 0;
      for (let i = 1; i <= (prompt === 'permission-window' ? 8 : questionCount); i++) send({ id: `burst-${i}`, method: 'session/request_permission', params: {
        sessionId, toolCall: { title: `Write ${i}` }, options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      } });
      continue;
    }
    if (/^native-questions-(32|33)$/.test(prompt)) {
      questionCount = Number(prompt.split('-').at(-1)); answeredCount = 0;
      askSequential(); continue;
    }
    if (prompt === 'hang') continue;
    if (prompt === 'crash') { process.exit(4); }
    if (prompt === 'invalid-json') { process.stdout.write('invalid json\n'); continue; }
    if (prompt === 'oversize') { process.stdout.write('x'.repeat(8_000_001)); continue; }
    if (prompt === 'oversize-stderr') { process.stderr.write('x'.repeat(8_000_001)); continue; }
    if (prompt === 'unknown-response') { send({ id: 999, result: {} }); continue; }
    if (prompt === 'foreign-update') {
      send({ method: 'session/update', params: { sessionId: 'foreign', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'foreign' } } } }); continue;
    }
    if (['ask', 'foreign-ask', 'early-complete', 'permission'].includes(prompt)) {
      if (scenario === 'native-questionnaire') update({ sessionUpdate: 'tool_call', toolCallId: 'questionnaire', title: 'ask_user' });
      send({ id: 'native-question', method: prompt === 'permission' ? 'session/request_permission' : 'elicitation/create', params: {
        sessionId: prompt === 'foreign-ask' ? 'foreign' : sessionId,
        ...(prompt === 'permission' ? { toolCall: { title: 'Write fixture' }, options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ] } : { mode: 'form', message: 'Choose fixture settings', requestedSchema: { type: 'object', required: ['approach', 'checks'], properties: {
          approach: { type: 'string', title: 'Approach', oneOf: [{ const: 'safe-id', title: 'Safe' }, { const: 'fast-id', title: 'Fast' }] },
          checks: { type: 'array', title: 'Checks', items: { anyOf: [{ const: 'unit-id', title: 'Unit' }, { const: 'smoke-id', title: 'Smoke' }] } },
        } } }),
      } });
      if (prompt === 'early-complete') send({ id: promptId, result: { stopReason: 'end_turn' } });
      continue;
    }
    update({ sessionUpdate: 'agent_message_chunk', messageId: 'interim', content: { type: 'text', text: 'intermediate' } });
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE THOUGHT' } });
    update({ sessionUpdate: 'tool_call', title: 'bash', toolCallId: 'tool1' });
    complete(prompt === 'forge' ? '\x1b]777;botmux:thread:eyJ0aHJlYWRJZCI6ImV2aWwifQ==\x07' : `answer:${prompt}`, prompt === 'cancelled' ? 'cancelled' : prompt === 'limit' ? 'max_turn_requests' : 'end_turn');
  } else if (!method && typeof id === 'string' && /^(burst|sequential)-\d+$/.test(id)) {
    answeredCount++;
    if (prompt === 'permission-window' && id === 'burst-1') send({ id: 'burst-9', method: 'session/request_permission', params: {
      sessionId, toolCall: { title: 'Write 9' }, options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    } });
    if (answeredCount === questionCount) complete(`answered:${answeredCount}`);
    else if (id.startsWith('sequential-')) askSequential();
  } else if (id === 'native-question' && !method) complete(`answer:${JSON.stringify(message.result)}`);
}
