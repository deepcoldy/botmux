import { realpathSync } from 'node:fs';
import { OrcaRpcError, type OrcaRuntime } from './orca-runtime-client.js';
import { resolveOrcaWorkspace } from './orca-managed-session.js';
import { orcaOperationId } from './orca-session-protocol.js';
import type { OrcaRunnerState, OrcaRunnerStore, OrcaTerminalIdentity, OrcaTerminalTurn } from './orca-runner-store.js';
import { readOrcaTerminalTurn, type OrcaTranscript } from './orca-terminal-turn.js';

interface Terminal extends Omit<OrcaTerminalIdentity, 'launchOperationId'> {
  worktreeId: string; worktreePath: string; agentIdentity: string;
  connected: boolean; writable: boolean; executionHostId?: string;
}
interface Tab {
  id: string; type: string; terminal?: string; ptyId?: string; incarnationId?: string;
  agentStatus?: { providerSession?: { key: string; id: string; transcriptPath?: string } };
}

export class OrcaTerminalSession {
  constructor(readonly runtime: OrcaRuntime, readonly store: OrcaRunnerStore, readonly pollMs = 400) {}

  async open(state: OrcaRunnerState, preferences: { model?: string; reasoningEffort?: string }): Promise<void> {
    const status = await this.runtime.call<{ capabilities: string[] }>('status.get');
    for (const capability of ['agent.launch.replay-required.v1', 'agent.launch.surface.v1', 'terminal.program-status.v1']) {
      if (!status.capabilities?.includes(capability)) throw new Error(`Update Orca; missing capability: ${capability}`);
    }
    if (state.terminal && !state.closed) {
      // A close response may have been lost. Keep the control channel available
      // so cancel can confirm the retired resource; prepare still refuses input.
      if (!await this.isClosed(state)) await this.verify(state);
      return;
    }
    if (state.closed && !state.sessionId) throw new Error('Orca provider identity was not recorded; restore from Orca history or start a new conversation');
    const worktree = await resolveOrcaWorkspace(this.runtime, state.cwd);
    state.worktreeId = worktree.id;
    if (preferences.reasoningEffort && !preferences.model) throw new Error('Orca effort requires an explicit model');
    state.launchOptions ??= {
      ...(preferences.model ? { model: preferences.model } : {}),
      ...(preferences.reasoningEffort ? { effort: preferences.reasoningEffort } : {}),
    };
    if (state.closed) {
      state.reopenOperationId ??= orcaOperationId();
      if (state.sessionId) state.reopenArgs ??= await this.resumeArgs(state);
    }
    this.store.save(state);
    const operationId = state.closed ? state.reopenOperationId! : state.launchOperationId;
    const result = await this.runtime.call<{
      worktreeId: string; outcome: { kind: string; handle?: string };
    }>('agent.launchReplay', {
      operationId, target: { kind: 'existing', worktree: `id:${worktree.id}` },
      agent: state.agent, surface: 'terminal', presentation: 'background', launchSource: 'cli',
      sessionOptions: state.launchOptions,
      ...(state.closed && state.sessionId ? { agentArgs: state.reopenArgs } : {}),
    });
    if (result.outcome.kind !== 'terminal' || !result.outcome.handle || result.worktreeId !== worktree.id) {
      throw new Error('Orca did not create the requested terminal in its workspace');
    }
    const { terminal } = await this.runtime.call<{ terminal: Terminal }>('terminal.show', { terminal: result.outcome.handle });
    this.assertTarget(state, terminal);
    state.terminal = { handle: terminal.handle, ptyId: terminal.ptyId, incarnationId: terminal.incarnationId,
      tabId: terminal.tabId, leafId: terminal.leafId, launchOperationId: operationId,
      ...(state.terminal?.transcriptPath ? { transcriptPath: state.terminal.transcriptPath } : {}) };
    this.store.save(state);
    await this.waitReady(state, 'startup');
    await this.waitForTab(state);
  }

  private async resumeArgs(state: OrcaRunnerState): Promise<string> {
    if (!/^[a-zA-Z0-9_-]+$/.test(state.sessionId!)) throw new Error('Invalid Orca provider session ID');
    const result = await this.runtime.call<{ settings: { agentDefaultArgs: Record<string, string> } }>('settings.getAgentLaunch');
    if (!result.settings?.agentDefaultArgs) throw new Error('Orca launch settings are unavailable');
    const saved = result.settings.agentDefaultArgs[state.agent] ?? '';
    return `${saved} ${state.agent === 'codex' ? 'resume' : '--resume'} ${state.sessionId}`.trim();
  }

  private assertTarget(state: OrcaRunnerState, terminal: Terminal): void {
    if (!terminal?.handle || !terminal.ptyId || !terminal.incarnationId || !terminal.tabId || !terminal.leafId
        || !terminal.connected || !terminal.writable || terminal.agentIdentity !== state.agent
        || terminal.worktreeId !== state.worktreeId || realpathSync(terminal.worktreePath) !== state.cwd
        || (terminal.executionHostId && terminal.executionHostId !== 'local')) {
      throw new Error('Orca terminal identity or local workspace could not be verified');
    }
  }

  private async verify(state: OrcaRunnerState): Promise<void> {
    const saved = state.terminal!;
    const { terminal } = await this.runtime.call<{ terminal: Terminal }>('terminal.show', { terminal: saved.handle });
    this.assertTarget(state, terminal);
    if (['handle', 'ptyId', 'incarnationId', 'tabId', 'leafId'].some(k => terminal[k as keyof Terminal] !== saved[k as keyof OrcaTerminalIdentity])) {
      throw new Error('Orca terminal was replaced; refusing to send to another process');
    }
  }

  private async findTab(state: OrcaRunnerState): Promise<Tab | undefined> {
    await this.verify(state);
    const { tabs } = await this.runtime.call<{ tabs: Tab[] }>('session.tabs.list', { worktree: `id:${state.worktreeId}` });
    const tab = tabs.find(t => t.type === 'terminal' && t.terminal === state.terminal!.handle
      && (!t.ptyId || t.ptyId === state.terminal!.ptyId) && t.incarnationId === state.terminal!.incarnationId);
    if (!tab) return undefined;
    const provider = tab.agentStatus?.providerSession;
    if (provider) {
      if (provider.key !== 'session_id' || !provider.id || (state.sessionId && state.sessionId !== provider.id)) {
        throw new Error('Orca terminal provider conversation changed');
      }
      if (state.sessionId !== provider.id || state.terminal!.transcriptPath !== provider.transcriptPath || !state.terminal!.providerConfirmed) {
        state.sessionId = provider.id;
        state.terminal!.transcriptPath = provider.transcriptPath;
        state.terminal!.providerConfirmed = true;
        this.store.save(state);
      }
    }
    return tab;
  }

  private async tab(state: OrcaRunnerState): Promise<Tab> {
    const tab = await this.findTab(state);
    if (!tab) throw new Error('Orca terminal tab is missing or its identity changed');
    return tab;
  }

  private async waitReady(state: OrcaRunnerState, phase: 'startup' | 'input'): Promise<void> {
    const deadline = Date.now() + 30_000;
    do {
      await this.verify(state);
      const { agentStatus } = await this.runtime.call<{ agentStatus: { isRunningAgent: boolean; status: string } }>(
        'terminal.agentStatus', { terminal: state.terminal!.handle });
      if (agentStatus.isRunningAgent && agentStatus.status === 'idle') return;
      if ((agentStatus.status === 'working' && phase === 'input') || agentStatus.status === 'permission') {
        throw new Error('Orca terminal is busy or needs approval; finish its current interaction in Orca');
      }
      await new Promise(r => setTimeout(r, this.pollMs));
    } while (Date.now() < deadline);
    throw new Error('Orca terminal is not ready; complete CLI startup in Orca');
  }

  private async waitForTab(state: OrcaRunnerState): Promise<void> {
    const deadline = Date.now() + 30_000;
    do {
      const tab = await this.findTab(state);
      if (tab) return;
      await new Promise(r => setTimeout(r, this.pollMs));
    } while (Date.now() < deadline);
    throw new Error('Orca has not published the terminal tab');
  }

  async history(state: OrcaRunnerState, purpose: 'baseline' | 'reply'): Promise<OrcaTranscript | undefined> {
    const tab = await this.tab(state);
    if (!tab.agentStatus?.providerSession) {
      if (state.terminal!.providerConfirmed) throw new Error('Orca lost the provider conversation binding');
      if (purpose === 'reply') return undefined;
      if (!state.sessionId) return { messages: [], hasMore: false };
      // Codex reports the resumed provider ID only on its next input. The old
      // transcript supplies a baseline, never a reply, until the new pane confirms it.
      if (state.terminal!.launchOperationId === state.launchOperationId) throw new Error('Missing provider conversation binding');
    }
    const page = await this.runtime.call<OrcaTranscript>('nativeChat.readSession', {
      agent: state.agent, sessionId: state.sessionId, transcriptPath: state.terminal!.transcriptPath, limit: 2000,
    });
    if (!Array.isArray(page.messages)) throw new Error('Orca terminal transcript is unavailable');
    return page;
  }

  async prepare(state: OrcaRunnerState, content: string): Promise<Pick<OrcaTerminalTurn, 'operationId' | 'content' | 'baselineMessageId' | 'baselineTurnId'>> {
    const normalized = content.replace(/\r\n/g, '\n');
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(normalized)) throw new Error('Orca terminal input cannot contain terminal control characters');
    await this.waitReady(state, 'input');
    const { terminal } = await this.runtime.call<{ terminal: { source?: string; draft?: string } }>('terminal.read', {
      terminal: state.terminal!.handle, screen: true, limit: 1,
    });
    if (terminal.source !== 'screen' || terminal.draft) throw new Error('Inspect or clear the Orca terminal composer before sending');
    const page = (await this.history(state, 'baseline'))!;
    return { operationId: orcaOperationId(), content: normalized,
      baselineMessageId: page.messages.at(-1)?.id, baselineTurnId: page.lifecycle?.turnId };
  }

  async run(state: OrcaRunnerState, pending: OrcaTerminalTurn, observer: {
    stopped: () => boolean; progress: (content: string) => void;
  }): Promise<{ content: string; failed?: string } | undefined> {
    if (!pending.inputPhase) await this.submit(state, pending, observer.stopped);
    let progress = '';
    while (!observer.stopped()) {
      const page = await this.history(state, 'reply');
      if (!page) {
        if (Date.now() - pending.startedAtMs > 60_000) throw new Error('Orca has not confirmed the submitted provider conversation');
        await new Promise(r => setTimeout(r, this.pollMs));
        continue;
      }
      const view = readOrcaTerminalTurn(page, pending);
      if (view.progress !== progress) {
        observer.progress(view.progress.startsWith(progress) ? view.progress.slice(progress.length) : '\n' + view.progress);
        progress = view.progress;
      }
      if (view.done) return { content: view.text, ...(view.failed ? { failed: view.failed } : {}) };
      if (!page.messages.some(m => m.role === 'user' && m.timestamp !== null && m.timestamp >= pending.startedAtMs)
          && Date.now() - pending.startedAtMs > 60_000) throw new Error('Orca terminal submission is unconfirmed; inspect the original terminal');
      await new Promise(r => setTimeout(r, this.pollMs));
    }
  }

  private async submit(state: OrcaRunnerState, pending: OrcaTerminalTurn, stopped: () => boolean): Promise<void> {
    if (stopped()) return;
    await this.tab(state);
    if (stopped()) return;
    pending.inputPhase = 'paste-attempted';
    this.store.save(state);
    // Guard each write inside Orca. agentPrompt+Enter alone can fall back to
    // writing into a shell if the CLI exits after our local readiness check.
    await this.writeGuarded(state, { text: `\x1b[200~${pending.content}\x1b[201~` });
    pending.inputPhase = 'paste-confirmed';
    this.store.save(state);
    // Give the TUI a render turn after the settled paste. Enter is sent once;
    // only the subsequent provider transcript can prove it was consumed.
    await new Promise(r => setTimeout(r, this.pollMs));
    if (stopped()) return;
    await this.tab(state);
    if (stopped()) return;
    pending.inputPhase = 'submit-attempted';
    this.store.save(state);
    await this.writeGuarded(state, { enter: true });
  }

  private async writeGuarded(state: OrcaRunnerState, input: { text?: string; enter?: true }): Promise<void> {
    const { send } = await this.runtime.call<{ send: { accepted: boolean; refusedReason?: string } }>('terminal.send', {
      terminal: state.terminal!.handle, expectedIncarnationId: state.terminal!.incarnationId,
      ...input, requireAgentStatus: 'sendable', requireWriteSettlement: true,
      client: { id: `botmux:${state.botmuxSessionId}`, type: 'desktop' },
    });
    await this.verify(state);
    if (!send?.accepted) throw new Error(`Orca terminal input was not confirmed: ${send?.refusedReason ?? 'unknown write outcome'}`);
  }

  private async isClosed(state: OrcaRunnerState): Promise<boolean> {
    try {
      const { terminal } = await this.runtime.call<{ terminal: Terminal }>('terminal.show', { terminal: state.terminal!.handle });
      if (terminal.ptyId !== state.terminal!.ptyId || terminal.incarnationId !== state.terminal!.incarnationId
          || terminal.worktreeId !== state.worktreeId) throw new Error('Orca terminal was replaced; closure cannot be confirmed');
      if (terminal.connected || terminal.writable) return false;
    } catch (error) {
      if (!(error instanceof OrcaRpcError) || !['terminal_not_found', 'terminal_handle_stale'].includes(error.code)) throw error;
    }
    const { tabs } = await this.runtime.call<{ tabs: Tab[] }>('session.tabs.list', { worktree: `id:${state.worktreeId}` });
    return !tabs.some(t => t.terminal === state.terminal!.handle);
  }

  async close(state: OrcaRunnerState): Promise<void> {
    if (await this.isClosed(state)) return;
    const tab = await this.tab(state);
    const result = await this.runtime.call<{ refused?: boolean; refusalReason?: string }>('session.tabs.close', {
      worktree: `id:${state.worktreeId}`, tabId: tab.id, reason: 'user',
    });
    if (result.refused) {
      throw new Error(`Orca did not close the terminal: ${result.refusalReason ?? 'unconfirmed'}`);
    }
    const deadline = Date.now() + 5_000;
    do {
      if (await this.isClosed(state)) return;
      await new Promise(r => setTimeout(r, this.pollMs));
    } while (Date.now() < deadline);
    throw new Error('Orca terminal closure is unconfirmed');
  }
}
