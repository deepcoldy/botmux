#!/usr/bin/env node
/** Opt-in live smoke: uses Orca's configured model account; no Feishu message is sent. */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RemoteRunnerBackend } from '../dist/adapters/backend/remote-runner-backend.js';
import { createOrcaAdapter } from '../dist/adapters/cli/orca.js';
import { OrcaRuntimeClient } from '../dist/services/orca-runtime-client.js';
import { ORCA_RUNNER_CAPABILITIES } from '../dist/services/orca-runner-capabilities.js';

const args = process.argv.slice(2);
function option(name) { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }
const cwd = option('--cwd');
const agent = option('--agent') || 'codex';
const surface = option('--surface') || 'terminal';
if (!cwd || !['codex', 'claude'].includes(agent) || !['terminal', 'chat'].includes(surface)) {
  throw new Error('Usage: node scripts/orca-managed-smoke.mjs --cwd /existing/project [--agent codex|claude] [--surface terminal|chat] [--binary /path/to/botmux]');
}
const directory = realpathSync(cwd);
const binary = option('--binary');
const data = mkdtempSync(join(tmpdir(), 'botmux-orca-smoke-'));
const sessionId = randomUUID();
const adapter = createOrcaAdapter(`orca-${agent}${surface === 'chat' ? '-chat' : ''}`);
let state;
let delivered = '';
let backend;
let successful = false;
const received = [];

function create() {
  const b = new RemoteRunnerBackend({ expectedProvider: 'orca',
    requiredCapabilities: [...ORCA_RUNNER_CAPABILITIES], handshakeTimeoutMs: 120_000,
  }, sessionId, state);
  b.onBackendState(value => { state = value; });
  b.onData(() => {});
  b.onOutboundMessage(async message => {
    delivered = message.content;
    received.push({ turnId: message.turnId, content: message.content });
    // This is a protocol harness receipt, never evidence of real Feishu delivery.
    return { outcome: 'delivered', messageId: randomUUID() };
  });
  return b;
}

function start(b, remoteResumeMode) {
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('Orca runner ready timeout')), 125_000);
    b.onReady(() => { clearTimeout(timer); resolveReady(); });
    b.onExit(code => { clearTimeout(timer); reject(new Error(`Runner exited: ${code}`)); });
    b.spawn(binary ? resolve(binary) : adapter.resolvedBin,
      binary ? ['__orca-runner', agent, surface] : adapter.buildArgs({ sessionId }),
      { cwd: directory, cols: 120, rows: 40, remoteResumeMode,
        env: { ...process.env, SESSION_DATA_DIR: data } });
  });
}

async function assertNativeTab(visible) {
  const snapshot = await new OrcaRuntimeClient().call('session.tabs.list', {
    worktree: `id:${state.providerState.worktreeId}`,
  });
  const present = snapshot.tabs.some(tab => surface === 'chat'
    ? tab.sessionId === state.agentThreadId : tab.terminal === state.providerState.terminalHandle);
  if (present !== visible) throw new Error(`Native Orca tab visibility differs: expected ${visible}`);
}

function stop(b, commit) {
  return new Promise((resolveExit, reject) => {
    const pid = b.getChildPid();
    const timer = setTimeout(() => {
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
      reject(new Error('Runner did not exit after releasing its session'));
    }, 5000);
    b.onExit(() => { clearTimeout(timer); resolveExit(); });
    commit();
  });
}

async function turn(b, marker) {
  let timer;
  const completed = new Promise((resolveFinal, reject) => {
    timer = setTimeout(() => reject(new Error('Orca turn timeout')), 120_000);
    b.onTurnFinal(() => { clearTimeout(timer); resolveFinal(delivered); });
    b.onTurnFailure(error => { clearTimeout(timer); reject(new Error(JSON.stringify(error))); });
  });
  const submission = await b.submitTurn({ turnId: randomUUID(),
    content: `Reply with only this marker, without punctuation:\n${marker}\nDo not run tools or change files.` });
  if (!submission.submitted) { clearTimeout(timer); throw new Error(JSON.stringify(submission)); }
  const text = await completed;
  if (text.trim().replace(/[.。]$/, '') !== marker) throw new Error(`Unexpected answer: ${text}`);
}

try {
  backend = create(); await start(backend);
  await assertNativeTab(true);
  await turn(backend, 'BOTMUX_ORCA_FIRST');
  const nativeSessionId = state.agentThreadId;
  const detached = await backend.prepareShutdownDetach();
  if (!detached.ok) throw new Error(JSON.stringify(detached));
  await stop(backend, () => backend.commitShutdownDetach());
  backend = create(); await start(backend);
  await assertNativeTab(true);
  await turn(backend, 'BOTMUX_ORCA_RESUMED');
  const closed = await backend.destroySession();
  if (!closed.ok) throw new Error(JSON.stringify(closed));
  await assertNativeTab(false);
  await stop(backend, () => backend.commitDestroySession());
  backend = create(); await start(backend, 'rebuild');
  await assertNativeTab(true);
  await turn(backend, 'BOTMUX_ORCA_REOPENED');
  if (state.agentThreadId !== nativeSessionId || received.length !== 3) throw new Error('Conversation identity or delivery count changed');
  const cleanup = await backend.destroySession();
  if (!cleanup.ok) throw new Error(JSON.stringify(cleanup));
  await assertNativeTab(false);
  await stop(backend, () => backend.commitDestroySession());
  successful = true;
  console.log(JSON.stringify({ agent, surface, nativeSessionId, generation: state.generation,
    path: binary ? 'compiled-binary' : 'source', nativeConversationPreserved: true,
    turns: received.length, feishuDelivery: 'simulated-receipt', result: 'passed' }));
} finally {
  backend?.kill();
  if (successful) rmSync(data, { recursive: true, force: true });
  else console.error(`Recovery state retained at ${data}`);
}
