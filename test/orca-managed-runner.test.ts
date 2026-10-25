import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OrcaRunnerStore } from '../src/services/orca-runner-store.js';
import { OrcaRunner } from '../src/services/orca-runner.js';
import type { OrcaRuntime } from '../src/services/orca-runtime-client.js';
import { OrcaRpcError } from '../src/services/orca-runtime-client.js';
import type { OrcaMutation, OrcaPage } from '../src/services/orca-session-protocol.js';
import type { RemoteRunnerBackendState } from '../src/adapters/backend/remote-runner-protocol.js';
import { remoteRunnerCommand } from '../src/adapters/backend/remote-runner-protocol.js';

const roots: string[] = [];
const runners: OrcaRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class Runtime implements OrcaRuntime {
  calls: Array<{ method: string; params: any }> = [];
  launches = new Set<string>();
  sends = new Map<string, OrcaMutation>();
  finished = true;
  busy = false;
  lostLaunchReply = false;
  lostSendReply = false;
  reset = false;
  workspaceExists = true;
  queueState?: 'waiting' | 'paused' | 'removed';
  statusFails = false;
  refuseTabClose = false;
  tabs = [{ id: 'native-tab', type: 'agent-session', sessionId: 'native-session' }];
  constructor(readonly cwd: string) {}
  async call<T>(method: string, params: any = {}): Promise<T> {
    this.calls.push({ method, params });
    let result: unknown;
    switch (method) {
      case 'status.get': if (this.statusFails) throw new Error('runtime unavailable'); result = { capabilities: ['agent.launch.replay-required.v1', 'agent.launch.surface.v1',
        'agent-session.structured.v1', 'agent-session.turn-item.v1'] }; break;
      case 'worktree.show':
        if (!this.workspaceExists) throw new OrcaRpcError('worktree_not_found', 'not registered');
        result = { worktree: { id: 'workspace', path: this.cwd } }; break;
      case 'repo.add': this.workspaceExists = true; result = {}; break;
      case 'agent.launchReplay':
        this.launches.add(params.operationId);
        if (this.lostLaunchReply) { this.lostLaunchReply = false; throw new Error('lost launch response'); }
        result = { worktreeId: 'workspace', outcome: { kind: 'structured', sessionId: 'native-session' } }; break;
      case 'agentSession.send':
        this.sends.set(params.envelope.clientOperationId, params);
        if (this.lostSendReply) { this.lostSendReply = false; throw new Error('lost send response'); }
        result = { ok: true, value: this.queueState ? { queued: { messageId: params.envelope.clientOperationId } } : {} }; break;
      case 'agentSession.history': result = { ok: !this.reset, page: this.page(params.cursor !== undefined) }; break;
      case 'agentSession.cancel': this.finished = true; result = { ok: true, value: { cancelled: true } }; break;
      case 'session.tabs.list': result = { tabs: this.tabs }; break;
      case 'session.tabs.close':
        if (this.refuseTabClose) { result = { refused: true, refusalReason: 'pinned' }; break; }
        this.tabs = this.tabs.filter(t => t.id !== params.tabId); result = { tabs: this.tabs }; break;
      case 'agentSession.close': result = { ok: true }; break;
      case 'agentSession.reveal':
        if (!this.tabs.some(t => t.sessionId === 'native-session')) this.tabs.push({ id: 'native-tab', type: 'agent-session', sessionId: 'native-session' });
        result = { ok: true, sessionId: 'native-session', workspaceId: 'workspace' }; break;
      case 'agentSession.queuedMessageDelete': this.queueState = 'removed'; result = { ok: true, value: { deleted: true } }; break;
      default: throw new Error(`Unexpected method ${method}`);
    }
    return result as T;
  }
  page(after: boolean): OrcaPage {
    const operation = [...this.sends.keys()].at(-1);
    const hasReply = after && operation && !this.queueState;
    return { sessionId: 'native-session', fence: 1, working: this.busy, hasNewer: false,
      queuedMessages: operation && this.queueState && this.queueState !== 'removed' ? [{ messageId: operation, state: 'waiting' }] : [],
      queuePause: this.queueState === 'paused' ? { reason: 'stopped' } : null,
      removedItemIds: [], submissions: [], window: { nextCursor: { epoch: 'epoch', sequence: 3 } },
      liveCursor: { epoch: 'epoch', sequence: 1 }, items: hasReply ? [
        { itemId: 'turn', revision: 1, sequence: 2, body: { kind: 'turn', turnId: 'native-turn',
          userItemId: `orca:${operation}`, state: this.finished ? 'completed' : 'running',
          ...(this.finished ? { outcome: 'success' } : {}) } },
        { itemId: 'answer', revision: 1, sequence: 3, turnScope: { kind: 'turn', turnItemId: 'turn' },
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'verified answer' }] } },
      ] : [] };
  }
}

function fixture(autoAck = true) {
  const root = mkdtempSync(join(tmpdir(), 'orca-runner-')); roots.push(root);
  const cwd = join(root, 'project'); mkdirSync(cwd);
  const runtime = new Runtime(cwd);
  const events: any[] = [];
  const listeners = new Set<(event: any) => void>();
  const create = (profile = root) => {
    const runner = new OrcaRunner({ agent: 'codex', profile, dataDir: root, runtime, pollMs: 5,
      emit: event => {
        events.push(event); for (const f of listeners) f(event);
        if (event.type === 'outbound_message' && autoAck) queueMicrotask(() => void runner.handle(remoteRunnerCommand('outbound_message_result', {
          requestId: 'receipt', operationId: event.operationId, turnId: event.turnId, generation: event.generation,
          result: { outcome: 'delivered', messageId: 'feishu-message' },
        })));
      } });
    runners.push(runner); return runner;
  };
  const wait = (type: string) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(listener); reject(new Error(`No ${type} event`)); }, 2000);
    const listener = (event: any) => { if (event.type === type) { clearTimeout(timer); listeners.delete(listener); resolve(event); } };
    listeners.add(listener);
  });
  const start = (runner: OrcaRunner) => runner.handle(remoteRunnerCommand('start', { requestId: 'start', sessionId: 'bot-session', cwd }));
  const turn = (runner: OrcaRunner) => runner.handle(remoteRunnerCommand('turn', { requestId: 'send', turnId: 'bot-turn', content: 'hello', dispatchAttempt: 3 }));
  const resume = (runner: OrcaRunner, state: RemoteRunnerBackendState) => runner.handle(remoteRunnerCommand('resume', {
    requestId: 'resume', sessionId: 'bot-session', cwd, state,
  }));
  return { root, cwd, runtime, events, create, wait, start, turn, resume };
}

describe('managed Orca conversations', () => {
  it('releases ownership when disposed during startup without launching a conversation', async () => {
    const f = fixture(); const runner = f.create();
    const opening = f.start(runner);
    await runner.dispose(); await opening;
    expect(f.runtime.launches.size).toBe(0);
    await f.start(f.create());
    expect(f.events.at(-1)).toMatchObject({ type: 'ready' });
  });

  it('creates a native session and returns its exact turn output', async () => {
    const f = fixture(); const runner = f.create();
    await f.start(runner);
    const done = f.wait('final'); await f.turn(runner);
    expect(await done).toMatchObject({ content: '', turnId: 'bot-turn' });
    expect(f.events.find(e => e.type === 'outbound_message')).toMatchObject({ content: 'verified answer', responseKind: 'final' });
    const launch = f.runtime.calls.find(c => c.method === 'agent.launchReplay')!.params;
    expect(launch).toMatchObject({ agent: 'codex', surface: 'chat', target: { kind: 'existing', worktree: 'id:workspace' } });
    expect(launch).not.toHaveProperty('prompt');
  });

  it('registers a plain knowledge directory as a folder project', async () => {
    const f = fixture(); f.runtime.workspaceExists = false;
    await f.start(f.create());
    expect(f.runtime.calls.find(c => c.method === 'repo.add')!.params).toEqual({ path: realpathSync(f.cwd), kind: 'folder' });
  });

  it('passes model and effort through Orca launch preferences', async () => {
    const f = fixture();
    await f.create().handle(remoteRunnerCommand('start', { requestId: 'start', sessionId: 'bot-session',
      cwd: f.cwd, model: 'selected-model', reasoningEffort: 'high' }));
    expect(f.runtime.calls.find(c => c.method === 'agent.launchReplay')!.params.sessionOptions)
      .toEqual({ model: 'selected-model', effort: 'high' });
  });

  it('reuses a launch operation after losing the creation response', async () => {
    const f = fixture(); f.runtime.lostLaunchReply = true;
    const first = f.create(); await f.start(first); await first.dispose();
    await f.start(f.create());
    expect(f.runtime.launches.size).toBe(1);
    expect(f.events.at(-1)).toMatchObject({ type: 'ready' });
  });

  it('recovers an accepted send without submitting a new operation', async () => {
    const f = fixture(); const first = f.create(); await f.start(first);
    f.runtime.lostSendReply = true;
    const failure = f.wait('failure'); await f.turn(first); await failure; await first.dispose();
    const state = f.events.findLast(e => e.type === 'lineage_changed').state;
    const final = f.wait('final'); await f.resume(f.create(), state);
    expect(await final).toMatchObject({ content: '' });
    expect(f.events.find(e => e.type === 'outbound_message').content).toBe('verified answer');
    expect(f.runtime.sends.size).toBe(1);
    expect(f.events.findLast(e => e.type === 'ready').recoveredTurn).toMatchObject({ turnId: 'bot-turn', dispatchAttempt: 3 });
  });

  it('resumes without re-emitting a final the host already consumed', async () => {
    const f = fixture(); const first = f.create(); await f.start(first);
    const final = f.wait('final'); await f.turn(first); await final;
    await first.handle(remoteRunnerCommand('detach', { requestId: 'detach' }));
    const detached = f.events.findLast(e => e.type === 'status');
    await first.dispose();
    await f.resume(f.create(), detached.state);
    expect(f.events.filter(e => e.type === 'final')).toHaveLength(1);
    expect(f.runtime.launches.size).toBe(1);
    expect(f.events.findLast(e => e.type === 'ready')).not.toHaveProperty('recoveredTurn');
  });

  it('recovers an undelivered completion even when the host only saved its initial ready state', async () => {
    const f = fixture(); const first = f.create(); await f.start(first);
    const initial = f.events[0].state;
    f.runtime.lostSendReply = true;
    const failed = f.wait('failure'); await f.turn(first); await failed; await first.dispose();
    const store = new OrcaRunnerStore(f.root, 'bot-session'); const saved = store.load()!;
    saved.pending!.completed = { content: 'durable answer' }; store.save(saved);
    const final = f.wait('final'); await f.resume(f.create(), initial); await final;
    expect(f.events.find(e => e.type === 'outbound_message').content).toBe('durable answer');
    expect(f.runtime.sends.size).toBe(1);
  });

  it('replays a failed turn even when its lineage state reached the host before failure', async () => {
    const f = fixture(); const first = f.create(); await f.start(first);
    f.runtime.lostSendReply = true;
    const failed = f.wait('failure'); await f.turn(first); await failed; await first.dispose();
    const store = new OrcaRunnerStore(f.root, 'bot-session'); const saved = store.load()!;
    saved.pending!.completed = { content: '', failed: 'provider failed' }; store.save(saved);
    const state = f.events.findLast(e => e.type === 'lineage_changed').state;
    state.providerState.settledTurnId = 'bot-turn';
    const failure = f.wait('failure'); await f.resume(f.create(), state);
    expect(await failure).toMatchObject({ message: 'provider failed', status: 'failed' });
  });

  it('does not repeat an outbound attempt after losing the host receipt', async () => {
    const f = fixture(false); const first = f.create(); await f.start(first);
    const initial = f.events[0].state;
    const outbound = f.wait('outbound_message'); await f.turn(first); await outbound; await first.dispose();
    const failed = f.wait('failure'); await f.resume(f.create(), initial);
    expect(await failed).toMatchObject({ status: 'ambiguous' });
    expect(f.events.filter(e => e.type === 'outbound_message')).toHaveLength(1);
  });

  it('settles lifecycle without resending a delivered answer when the host state is stale', async () => {
    const f = fixture(); const first = f.create(); await f.start(first);
    const initial = f.events[0].state;
    const final = f.wait('final'); await f.turn(first); await final; await first.dispose();
    const settled = f.wait('final'); await f.resume(f.create(), initial); expect(await settled).toMatchObject({ content: '' });
    expect(f.events.filter(e => e.type === 'outbound_message')).toHaveLength(1);
  });

  it.each(['paused', 'removed'] as const)('reports a %s queued draft and can still close', async queueState => {
    const f = fixture(); f.runtime.queueState = queueState;
    const runner = f.create(); await f.start(runner);
    const failed = f.wait('failure'); await f.turn(runner);
    expect(await failed).toMatchObject({ status: 'ambiguous' });
    await runner.handle(remoteRunnerCommand('cancel', { requestId: 'close' }));
    expect(f.events.at(-1)).toMatchObject({ type: 'status', status: 'closed' });
    expect(f.runtime.calls.some(c => c.method === 'agentSession.queuedMessageDelete')).toBe(queueState === 'paused');
  });

  it('closes while a queued turn is waiting without waiting for a provider turn', async () => {
    const f = fixture(); f.runtime.queueState = 'waiting';
    const runner = f.create(); await f.start(runner); await f.turn(runner);
    await runner.handle(remoteRunnerCommand('cancel', { requestId: 'close' }));
    expect(f.events.at(-1)).toMatchObject({ type: 'status', status: 'closed' });
  });

  it('closes its native desktop tab while preserving unrelated conversations', async () => {
    const f = fixture(); const runner = f.create(); await f.start(runner);
    f.runtime.tabs.push({ id: 'other-tab', type: 'agent-session', sessionId: 'other-session' });
    await runner.handle(remoteRunnerCommand('cancel', { requestId: 'close' }));
    expect(f.runtime.tabs.map(t => t.id)).toEqual(['other-tab']);
    expect(f.events.at(-1)).toMatchObject({ type: 'status', status: 'closed' });
    expect(f.runtime.calls.find(c => c.method === 'session.tabs.close')!.params)
      .toEqual({ worktree: 'id:workspace', tabId: 'native-tab', reason: 'user' });
  });

  it('does not report a pinned desktop tab as closed when Orca refuses', async () => {
    const f = fixture(); const runner = f.create(); await f.start(runner);
    f.runtime.refuseTabClose = true;
    await runner.handle(remoteRunnerCommand('cancel', { requestId: 'close' }));
    expect(f.events.at(-1)).toMatchObject({ type: 'failure', requestId: 'close' });
    expect(f.runtime.tabs).toHaveLength(1);
    expect(f.runtime.calls.some(c => c.method === 'agentSession.close')).toBe(false);
  });

  it('retries rebuild before ready and after the new generation was persisted', async () => {
    const f = fixture(); const first = f.create(); await f.start(first);
    await first.handle(remoteRunnerCommand('cancel', { requestId: 'close' }));
    const state = f.events.at(-1).state; await first.dispose();
    const rebuild = (runner: OrcaRunner) => runner.handle(remoteRunnerCommand('resume', {
      requestId: 'rebuild', sessionId: 'bot-session', cwd: f.cwd, state, resumeMode: 'rebuild',
    }));
    f.runtime.statusFails = true;
    const failed = f.create(); await rebuild(failed); await failed.dispose();
    f.runtime.statusFails = false;
    const recovered = f.create(); await rebuild(recovered); await recovered.dispose();
    await rebuild(f.create());
    expect(f.events.at(-1)).toMatchObject({ type: 'ready', state: { generation: 2, agentThreadId: 'native-session' } });
    expect(f.runtime.launches.size).toBe(1);
  });

  it('does not send into a conversation currently used in Orca', async () => {
    const f = fixture(); const runner = f.create(); await f.start(runner); f.runtime.busy = true;
    await f.turn(runner);
    expect(f.events.at(-1)).toMatchObject({ type: 'failure', requestId: 'send' });
    expect(f.runtime.sends.size).toBe(0);
  });

  it('does not use a reset history tail as the pending reply', async () => {
    const f = fixture(); const runner = f.create(); await f.start(runner);
    const original = f.runtime.call.bind(f.runtime);
    f.runtime.call = async (method, params) => { const r = await original(method, params); if (method === 'agentSession.send') f.runtime.reset = true; return r as any; };
    const failure = f.wait('failure'); await f.turn(runner);
    expect(await failure).toMatchObject({ status: 'ambiguous' });
    expect(f.events.some(e => e.type === 'final')).toBe(false);
  });

  it('rejects a profile change rather than moving the existing conversation', async () => {
    const f = fixture(); const first = f.create(); await f.start(first); await first.dispose();
    const another = join(f.root, 'other'); mkdirSync(another);
    await f.resume(f.create(another), f.events[0].state);
    expect(f.events.at(-1).message).toContain('profile changed');
    expect(f.runtime.launches.size).toBe(1);
  });
});
