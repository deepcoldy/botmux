import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = value => process.env.ATOMCODE_TEST_LOG && appendFileSync(process.env.ATOMCODE_TEST_LOG, JSON.stringify(value) + '\n');
log({ pid: process.pid, args: process.argv.slice(2), owner: process.env.BOTMUX_OWNER_OPEN_ID, home: process.env.ATOMCODE_HOME });

const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const skipPerms = process.argv.includes('--dangerously-skip-permissions');
const scenario = process.env.ATOMCODE_ACP_SCENARIO;
const control = {
  configOptions: [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: skipPerms ? 'bypass' : 'build',
      options: [
        { value: 'build', name: 'Build' },
        { value: 'accept_edits', name: 'AcceptEdits' },
        { value: 'bypass', name: 'Auto' },
        { value: 'plan', name: 'Plan' },
      ],
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'off',
      options: [
        { value: 'off', name: 'Off (API default)' },
        { value: 'high', name: 'High' },
        { value: 'max', name: 'Max' },
      ],
    },
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'demo-default',
      options: [
        { value: 'demo-default', name: 'demo-default' },
        { value: 'codingplan/glm-5', name: 'codingplan/glm-5' },
      ],
    },
  ],
};

let sessionId;
let promptId;
let promptText;
const update = u => send({ method: 'session/update', params: { sessionId, update: u } });
const complete = (text, stopReason = 'end_turn', messageId = 'm-final') => {
  update({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } });
  send({ id: promptId, result: { stopReason } });
};

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  log({ message });
  const { method, id, params } = message;
  if (method === 'initialize') {
    send({
      id,
      result: {
        protocolVersion: scenario === 'version' ? 2 : 1,
        agentInfo: { name: 'atomcode', title: 'AtomCode', version: '5.2.9' },
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: scenario === 'load' ? { close: {} } : { resume: {}, close: {} },
        },
      },
    });
  } else if (method === 'session/new') {
    sessionId = 'acp-fixture-session-1';
    send({ id, result: { sessionId, ...control } });
    update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact' }] });
  } else if (method === 'session/resume' || method === 'session/load') {
    sessionId = params.sessionId;
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STALE REPLAY MUST BE IGNORED' } });
    send({ id, result: { ...(scenario === 'resume-mismatch' ? { sessionId: 'acp-other' } : {}), ...control } });
  } else if (method === 'session/set_config_option') {
    const opt = control.configOptions.find(o => o.id === params.configId);
    if (!opt || !opt.options.some(o => o.value === params.value)) {
      send({ id, error: { code: -32602, message: 'Invalid params', data: `invalid ${params.configId}=${params.value}` } });
    } else {
      opt.currentValue = params.value;
      send({ id, result: control });
    }
  } else if (method === 'session/close') {
    send({ id, result: {} });
  } else if (method === 'session/cancel') {
    if (promptId !== undefined) send({ id: promptId, result: { stopReason: 'cancelled' } });
  } else if (method === 'session/prompt') {
    promptId = id;
    promptText = params.prompt[0].text;
    if (promptText === 'hang') continue;
    if (promptText === 'crash') process.exit(4);
    if (promptText === 'invalid-json') { process.stdout.write('not-json\n'); continue; }
    if (promptText === 'refusal') { complete('refused', 'refusal'); continue; }
    if (promptText === '/compact') {
      complete('compact requested; the next request continues on the compacted context');
      continue;
    }
    if (promptText === 'multi-round') {
      update({ sessionUpdate: 'agent_thought_chunk', messageId: 'm1', content: { type: 'text', text: 'internal thought' } });
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'intermediate text' } });
      update({ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'bash', status: 'in_progress' });
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'final ' } });
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'answer' } });
      send({ id: promptId, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (promptText === 'ask-form') {
      send({
        id: 'form-1',
        method: 'elicitation/create',
        params: {
          sessionId,
          mode: 'form',
          message: 'Which option?',
          requestedSchema: {
            type: 'object',
            properties: { answer: { type: 'string', title: 'Pick', enum: ['A', 'B'] } },
            required: ['answer'],
          },
        },
      });
      continue;
    }
    if (promptText === 'ask-permission') {
      send({
        id: 'perm-1',
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId: 'tc-perm', title: 'bash', rawInput: { command: 'ls' } },
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
          ],
        },
      });
      continue;
    }
    if (promptText === 'unknown-client-method') {
      send({ id: 'unk-1', method: 'client/unsupported', params: { sessionId } });
      continue;
    }
    const mode = control.configOptions.find(o => o.id === 'mode').currentValue;
    const model = control.configOptions.find(o => o.id === 'model').currentValue;
    const effort = control.configOptions.find(o => o.id === 'reasoning_effort').currentValue;
    complete(`echo:${promptText}|mode=${mode}|model=${model}|effort=${effort}`);
  } else if (id === 'form-1') {
    complete(`form:${JSON.stringify(message.result)}`);
  } else if (id === 'perm-1') {
    complete(`perm:${JSON.stringify(message.result)}`);
  } else if (id === 'unk-1') {
    complete(`unsupported:${message.error?.code}`);
  }
}
