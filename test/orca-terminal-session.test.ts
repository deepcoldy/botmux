import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { OrcaTerminalSession } from '../src/services/orca-terminal-session.js';
import { OrcaRunnerStore, type OrcaTerminalTurn } from '../src/services/orca-runner-store.js';
import type { OrcaRuntime } from '../src/services/orca-runtime-client.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class Runtime implements OrcaRuntime {
  calls: Array<{ method: string; params: any }> = [];
  generation = 0;
  launches = new Map<string, any>();
  provider?: string;
  status = 'idle';
  draft = '';
  lostSend = false;
  lostPaste = false;
  lostClose = false;
  exitAfterPaste = false;
  stagedText = '';
  lostLaunch = false;
  refused = false;
  tabs: any[] = [{ id: 'foreign', type: 'terminal', terminal: 'foreign' }];
  messages: any[] = [];
  lifecycle: any;
  incarnation = 'incarnation';
  constructor(readonly cwd: string) {}
  async call<T>(method: string, params: any = {}): Promise<T> {
    this.calls.push({ method, params });
    let result: any;
    switch (method) {
      case 'status.get': result = { capabilities: ['agent.launch.replay-required.v1', 'agent.launch.surface.v1', 'terminal.program-status.v1'] }; break;
      case 'worktree.show': result = { worktree: { id: 'workspace', path: this.cwd } }; break;
      case 'settings.getAgentLaunch': result = { settings: { agentDefaultArgs: { codex: '--profile existing' } } }; break;
      case 'agent.launchReplay': {
        if (!this.launches.has(params.operationId)) {
          this.generation++;
          this.tabs.push({ id: `tab::leaf${this.generation}`, type: 'terminal', terminal: `handle${this.generation}`,
            ptyId: `pty${this.generation}`, incarnationId: this.incarnation });
          this.launches.set(params.operationId, { worktreeId: 'workspace', outcome: { kind: 'terminal', handle: `handle${this.generation}` } });
        }
        if (this.lostLaunch) { this.lostLaunch = false; throw new Error('lost launch reply'); }
        result = this.launches.get(params.operationId); break;
      }
      case 'terminal.show': result = { terminal: { handle: `handle${this.generation}`, ptyId: `pty${this.generation}`,
        incarnationId: this.incarnation, tabId: 'tab', leafId: `leaf${this.generation}`, worktreeId: 'workspace',
        worktreePath: this.cwd, connected: this.tabs.some(t => t.terminal === `handle${this.generation}`),
        writable: this.tabs.some(t => t.terminal === `handle${this.generation}`), agentIdentity: 'codex', executionHostId: 'local' } }; break;
      case 'terminal.agentStatus': result = { agentStatus: { isRunningAgent: true, status: this.status } }; break;
      case 'terminal.read': result = { terminal: { source: 'screen', draft: this.draft } }; break;
      case 'session.tabs.list': result = { tabs: this.tabs.map(t => ({ ...t, agentStatus: this.provider && t.terminal !== 'foreign'
        ? { providerSession: { key: 'session_id', id: this.provider } } : {} })) }; break;
      case 'nativeChat.readSession': result = { messages: this.messages, hasMore: false, lifecycle: this.lifecycle }; break;
      case 'terminal.send': {
        if (params.requireAgentStatus === 'sendable' && this.status !== 'idle') {
          result = { send: { accepted: false, refusedReason: 'no-agent' } }; break;
        }
        if (params.text) {
          this.stagedText = params.text.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, '');
          if (this.exitAfterPaste) this.status = 'none';
          if (this.lostPaste) throw new Error('lost paste reply');
          result = { send: { accepted: true } }; break;
        }
        this.provider = 'provider-session';
        this.messages.push({ id: 'user', source: 'transcript', role: 'user', timestamp: Date.now(), blocks: [{ type: 'text', text: this.stagedText }] },
          { id: 'reply', source: 'transcript', role: 'assistant', timestamp: Date.now(), blocks: [{ type: 'text', text: 'answer' }] });
        this.lifecycle = { state: 'completed', turnId: 'native-turn', timestamp: Date.now() };
        if (this.lostSend) throw new Error('lost send reply');
        result = { send: { accepted: true } }; break;
      }
      case 'session.tabs.close':
        if (!this.refused) this.tabs = this.tabs.filter(t => t.id !== params.tabId);
        if (this.lostClose) throw new Error('lost close reply');
        result = { refused: this.refused, tabs: this.tabs }; break;
      default: throw new Error(`Unexpected call ${method}`);
    }
    return result as T;
  }
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-terminal-'))); roots.push(root);
  const runtime = new Runtime(root); const store = new OrcaRunnerStore(root, 'bot');
  const state = store.initialize({ botmuxSessionId: 'bot', agent: 'codex', cwd: root, profile: root });
  const session = new OrcaTerminalSession(runtime, store, 1);
  const pending = async (): Promise<OrcaTerminalTurn> => ({ turnId: 'turn', startedAtMs: Date.now(), ...await session.prepare(state, 'hello') });
  const observer = { stopped: () => false, progress: () => {} };
  return { runtime, store, state, session, pending, observer };
}

describe('managed Orca terminal', () => {
  it('creates a Terminal by default and preserves the provider conversation on explicit rebuild', async () => {
    const f = fixture(); expect(f.state.surface).toBe('terminal');
    await f.session.open(f.state, {});
    expect(f.runtime.calls.find(c => c.method === 'agent.launchReplay')?.params.surface).toBe('terminal');
    const pending = await f.pending(); f.state.pending = pending;
    expect(await f.session.run(f.state, pending, f.observer)).toEqual({ content: 'answer' });
    expect(f.state.sessionId).toBe('provider-session');
    await f.session.close(f.state);
    expect(f.runtime.tabs.map(t => t.id)).toEqual(['foreign']);
    f.state.closed = true; await f.session.open(f.state, {});
    expect(f.state.sessionId).toBe('provider-session');
    expect(f.runtime.calls.filter(c => c.method === 'agent.launchReplay').at(-1)?.params.agentArgs)
      .toBe('--profile existing resume provider-session');
  });
  it('replays an uncertain launch without creating another terminal', async () => {
    const f = fixture(); f.runtime.lostLaunch = true;
    await expect(f.session.open(f.state, {})).rejects.toThrow('lost launch');
    await f.session.open(f.state, {});
    expect(f.runtime.generation).toBe(1);
  });
  it('recovers a submitted answer after a lost send response without sending again', async () => {
    const f = fixture(); await f.session.open(f.state, {});
    const pending = await f.pending(); f.state.pending = pending; f.runtime.lostSend = true;
    await expect(f.session.run(f.state, pending, f.observer)).rejects.toThrow('lost send');
    expect(f.store.load()?.pending).toMatchObject({ inputPhase: 'submit-attempted' });
    expect(await f.session.run(f.state, pending, f.observer)).toEqual({ content: 'answer' });
    expect(f.runtime.calls.filter(c => c.method === 'terminal.send' && c.params.enter)).toHaveLength(1);
  });
  it('never sends Enter after an uncertain paste or after the CLI exits to its shell', async () => {
    const f = fixture(); await f.session.open(f.state, {});
    const pending = await f.pending(); f.state.pending = pending; f.runtime.lostPaste = true;
    await expect(f.session.run(f.state, pending, f.observer)).rejects.toThrow('lost paste');
    await f.session.run(f.state, pending, { ...f.observer, stopped: () => true });
    expect(f.runtime.calls.some(c => c.method === 'terminal.send' && c.params.enter)).toBe(false);
    const g = fixture(); await g.session.open(g.state, {}); const next = await g.pending();
    g.state.pending = next; g.runtime.exitAfterPaste = true;
    await expect(g.session.run(g.state, next, g.observer)).rejects.toThrow('no-agent');
    expect(g.runtime.messages).toHaveLength(0);
    expect(g.runtime.calls.filter(c => c.method === 'terminal.send').every(c => c.params.requireAgentStatus === 'sendable')).toBe(true);
  });
  it('does not submit a staged paste after the bridge has been stopped', async () => {
    const f = fixture(); await f.session.open(f.state, {}); const pending = await f.pending(); f.state.pending = pending;
    await f.session.run(f.state, pending, { progress: () => {},
      stopped: () => f.runtime.calls.some(c => c.method === 'terminal.send') });
    expect(f.store.load()?.pending).toMatchObject({ inputPhase: 'paste-confirmed' });
    expect(f.runtime.calls.some(c => c.method === 'terminal.send' && c.params.enter)).toBe(false);
  });
  it('confirms a lost close response after control-channel restart and can then rebuild', async () => {
    const f = fixture(); await f.session.open(f.state, {}); const pending = await f.pending(); f.state.pending = pending;
    await f.session.run(f.state, pending, f.observer); f.runtime.lostClose = true;
    await expect(f.session.close(f.state)).rejects.toThrow('lost close');
    const restored = f.store.load()!; const session = new OrcaTerminalSession(f.runtime, f.store, 1);
    await session.open(restored, {}); await session.close(restored);
    restored.closed = true; await session.open(restored, {});
    expect(restored.sessionId).toBe('provider-session');
    expect(f.runtime.calls.filter(c => c.method === 'session.tabs.close')).toHaveLength(1);
  });
  it('refuses replaced PTYs before input and preserves pinned tabs', async () => {
    const f = fixture(); await f.session.open(f.state, {});
    const pending = await f.pending(); f.runtime.incarnation = 'replacement';
    await expect(f.session.run(f.state, pending, f.observer)).rejects.toThrow('replaced');
    expect(f.runtime.calls.some(c => c.method === 'terminal.send')).toBe(false);
    f.runtime.incarnation = 'incarnation'; f.runtime.refused = true;
    await expect(f.session.close(f.state)).rejects.toThrow('did not close');
    expect(f.runtime.tabs).toHaveLength(2);
  });
  it('refuses busy/approval states, drafts and changed provider sessions', async () => {
    const f = fixture(); await f.session.open(f.state, {});
    for (const status of ['working', 'permission']) {
      f.runtime.status = status; await expect(f.pending()).rejects.toThrow('busy');
    }
    f.runtime.status = 'idle'; f.runtime.draft = 'desktop draft';
    await expect(f.pending()).rejects.toThrow('composer');
    f.runtime.draft = ''; f.state.sessionId = 'saved-session'; f.runtime.provider = 'different-session';
    await expect(f.pending()).rejects.toThrow('conversation changed');
  });
  it('refuses control bytes and never guesses the conversation of an unobserved closed terminal', async () => {
    const f = fixture(); await f.session.open(f.state, {});
    await expect(f.session.prepare(f.state, 'text\x1b[201~\ncommand')).rejects.toThrow('control characters');
    await f.session.close(f.state); f.state.closed = true;
    await expect(f.session.open(f.state, {})).rejects.toThrow('identity was not recorded');
  });
  it('preserves the Chat mode of state written before surface selection existed', () => {
    const f = fixture(); delete f.state.surface; f.store.save(f.state);
    const restored = f.store.initialize({ botmuxSessionId: 'bot', agent: 'codex', cwd: f.state.cwd,
      profile: f.state.profile, surface: 'terminal' });
    expect(restored.surface ?? 'chat').toBe('chat');
  });
});
