import { appendFileSync, closeSync, openSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const log = value => process.env.ATOMCODE_TEST_LOG && appendFileSync(process.env.ATOMCODE_TEST_LOG, JSON.stringify(value) + '\n');
log({ pid: process.pid, ppid: process.ppid, args: process.argv.slice(2), owner: process.env.BOTMUX_OWNER_OPEN_ID, home: process.env.ATOMCODE_HOME });

const leaseFile = process.env.ATOMCODE_ACP_LEASE_FILE;
let holdsLease = false;
const acquireLease = () => {
  if (!leaseFile || holdsLease) return true;
  try {
    const fd = openSync(leaseFile, 'wx');
    closeSync(fd);
    holdsLease = true;
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
};
const releaseLease = () => {
  if (!leaseFile || !holdsLease) return;
  holdsLease = false;
  try { unlinkSync(leaseFile); } catch { /* already gone */ }
};
process.on('exit', releaseLease);
process.on('SIGTERM', () => { releaseLease(); process.exit(143); });
process.on('SIGINT', () => { releaseLease(); process.exit(130); });

const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const NUL = String.fromCharCode(0);
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
  const id = promptId;
  promptId = undefined;
  update({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } });
  if (id !== undefined) send({ id, result: { stopReason } });
};

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  log({ message });
  const { method, id, params } = message;
  if (method === 'initialize') {
    const initDelay = Number(process.env.ATOMCODE_ACP_INIT_DELAY_MS ?? '0');
    if (initDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, initDelay));
    }
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
    acquireLease();
    sessionId = 'acp-fixture-session-1';
    send({ id, result: { sessionId, ...control } });
    update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact' }] });
  } else if (method === 'session/resume' || method === 'session/load') {
    if (scenario === 'unknown-session') {
      send({ id, error: { code: -32602, message: 'Invalid params', data: `unknown session \`${params.sessionId}\`` } });
      continue;
    }
    if (scenario === 'crash-during-lease-wait') {
      log({ event: 'resume_lease_busy', pid: process.pid, sessionId: params.sessionId });
      send({
        id,
        error: {
          code: -32602,
          message: 'Invalid params',
          data: 'session is active in another atomcode process; close it before resuming',
        },
      });
      setTimeout(() => process.exit(8), 25);
      continue;
    }
    if (!acquireLease()) {
      log({ event: 'resume_lease_busy', pid: process.pid, sessionId: params.sessionId });
      send({
        id,
        error: {
          code: -32602,
          message: 'Invalid params',
          data: 'session is active in another atomcode process; close it before resuming',
        },
      });
      continue;
    }
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
    const closeDelay = Number(process.env.ATOMCODE_ACP_CLOSE_DELAY_MS ?? '0');
    if (closeDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, closeDelay));
    }
    releaseLease();
    log({ event: 'close_done', pid: process.pid });
    send({ id, result: {} });
  } else if (method === 'session/cancel') {
    log({ event: 'cancel_received', pid: process.pid });
    const cancelDelay = Number(process.env.ATOMCODE_ACP_CANCEL_DELAY_MS ?? '0');
    const idToCancel = promptId;
    promptId = undefined;
    if (idToCancel !== undefined) {
      if (cancelDelay > 0) {
        setTimeout(() => send({ id: idToCancel, result: { stopReason: 'cancelled' } }), cancelDelay);
      } else {
        send({ id: idToCancel, result: { stopReason: 'cancelled' } });
      }
    }
  } else if (method === 'session/prompt') {
    promptId = id;
    promptText = params.prompt[0].text;
    if (promptText === 'hang') continue;
    if (promptText === 'stream-then-slow-cancel') {
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'm-stream', content: { type: 'text', text: 'chunk1' } });
      setTimeout(() => {
        update({ sessionUpdate: 'agent_message_chunk', messageId: 'm-stream', content: { type: 'text', text: 'chunk2' } });
      }, 30);
      continue;
    }
    if (promptText === 'crash') process.exit(4);
    if (promptText === 'detached-grandchild-crash' || promptText === 'detached-grandchild-hang') {
      const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], {
        detached: true,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      sleeper.unref();
      log({ event: 'grandchild_spawned', pid: process.pid, grandchildPid: sleeper.pid });
      if (promptText === 'detached-grandchild-crash') process.exit(9);
      continue;
    }
    if (promptText === 'invalid-json') { process.stdout.write('not-json\n'); continue; }
    if (promptText === 'idle-exit-after-turn') {
      complete('ok-before-idle-exit');
      setTimeout(() => process.exit(7), 30);
      continue;
    }
    if (promptText === 'idle-garbage-after-turn') {
      complete('ok-before-idle-garbage');
      setTimeout(() => process.stdout.write('corrupt-idle-frame\n'), 30);
      continue;
    }
    if (promptText === 'idle-request-after-turn') {
      complete('ok-before-idle-request');
      setTimeout(() => send({ id: 'idle-req-1', method: 'session/request_permission', params: { sessionId } }), 30);
      continue;
    }
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
    if (promptText === 'big-ascii-8m') {
      // One chunk whose decoded text is exactly at the content cap: the wire
      // frame is larger than the text due to the JSON-RPC envelope.
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'm-big', content: { type: 'text', text: 'a'.repeat(8_000_000) } });
      send({ id: promptId, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (promptText === 'big-quotes-4m') {
      // 4 M raw characters, each escaped to two wire bytes by JSON.stringify:
      // decoded content stays at 4 MB while the frame approaches 8 MB.
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'm-big', content: { type: 'text', text: '"'.repeat(4_000_000) } });
      send({ id: promptId, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (promptText === 'big-nul-2m8') {
      // 2.8 M control chars: only 2.8 MB decoded (well under the content cap),
      // but each NUL serializes to a six-byte \u0000 escape (~16.8 MB wire).
      // Must pass: the frame cap is derived from the 6x content-cap ratio.
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'm-big', content: { type: 'text', text: NUL.repeat(2_800_000) } });
      send({ id: promptId, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (promptText === 'over-content') {
      // Two chunks under one messageId accumulating past the 8 MB decoded cap.
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'm-big', content: { type: 'text', text: 'a'.repeat(8_000_000) } });
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'm-big', content: { type: 'text', text: 'b' } });
      send({ id: promptId, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (promptText === 'oversized-frame') {
      // 8.1 M NUL chars: decoded text is past the content cap and the six-byte
      // escaping pushes the wire frame (~48.6 MB) past the derived line cap;
      // the reader must reject the frame itself before content accumulation.
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'm-big', content: { type: 'text', text: NUL.repeat(8_100_000) } });
      send({ id: promptId, result: { stopReason: 'end_turn' } });
      continue;
    }
    const mode = control.configOptions.find(o => o.id === 'mode').currentValue;
    const model = control.configOptions.find(o => o.id === 'model').currentValue;
    const effort = control.configOptions.find(o => o.id === 'reasoning_effort').currentValue;
    complete(`echo:${promptText}|mode=${mode}|model=${model}|effort=${effort}`);
  } else if (id === 'form-1') {
    if (message.result?.action === 'cancel') {
      log({ event: 'interaction_cancelled', id, result: message.result });
      const idToCancel = promptId;
      promptId = undefined;
      if (idToCancel !== undefined) send({ id: idToCancel, result: { stopReason: 'cancelled' } });
    } else {
      complete(`form:${JSON.stringify(message.result)}`);
    }
  } else if (id === 'perm-1') {
    if (message.result?.outcome?.outcome === 'cancelled') {
      log({ event: 'interaction_cancelled', id, result: message.result });
      const idToCancel = promptId;
      promptId = undefined;
      if (idToCancel !== undefined) send({ id: idToCancel, result: { stopReason: 'cancelled' } });
    } else {
      complete(`perm:${JSON.stringify(message.result)}`);
    }
  } else if (id === 'unk-1') {
    complete(`unsupported:${message.error?.code}`);
  }
}
