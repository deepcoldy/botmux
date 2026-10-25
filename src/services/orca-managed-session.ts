import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { OrcaRuntime } from './orca-runtime-client.js';
import { OrcaRpcError } from './orca-runtime-client.js';
import type { OrcaRunnerState, OrcaRunnerStore } from './orca-runner-store.js';
import type { OrcaCursor, OrcaHistory, OrcaPage } from './orca-session-protocol.js';

const REQUIRED_CAPABILITIES = [
  'agent.launch.replay-required.v1', 'agent.launch.surface.v1',
  'agent-session.structured.v1', 'agent-session.turn-item.v1',
];

export class OrcaManagedSession {
  constructor(readonly runtime: OrcaRuntime, readonly store: OrcaRunnerStore) {}

  async open(state: OrcaRunnerState, preferences: { model?: string; reasoningEffort?: string }): Promise<void> {
    const status = await this.runtime.call<{ capabilities?: string[] }>('status.get');
    const missing = REQUIRED_CAPABILITIES.filter(c => !status.capabilities?.includes(c));
    if (missing.length) throw new Error(`Update Orca on this host; missing capabilities: ${missing.join(', ')}`);
    if (state.sessionId) {
      if (state.closed) {
        const revealed = await this.runtime.call<{ ok: boolean; sessionId: string; workspaceId: string }>(
          'agentSession.reveal', { sessionId: state.sessionId });
        if (!revealed.ok || revealed.sessionId !== state.sessionId || revealed.workspaceId !== state.worktreeId) {
          throw new Error('Orca could not reopen the original conversation in its workspace');
        }
      }
      await this.history(state);
      return;
    }
    const worktree = await this.workspace(state.cwd);
    if (preferences.reasoningEffort && !preferences.model) throw new Error('Orca effort requires an explicit model');
    const sessionOptions = state.launchOptions ?? {
      ...(preferences.model ? { model: preferences.model } : {}),
      ...(preferences.reasoningEffort ? { effort: preferences.reasoningEffort } : {}),
    };
    state.launchOptions = sessionOptions;
    this.store.save(state);
    const launched = await this.runtime.call<{
      worktreeId: string;
      outcome: { kind: string; sessionId?: string };
    }>('agent.launchReplay', {
      operationId: state.launchOperationId,
      target: { kind: 'existing', worktree: `id:${worktree.id}` },
      agent: state.agent, surface: 'chat', presentation: 'background', launchSource: 'cli',
      ...(Object.keys(sessionOptions).length ? { sessionOptions } : {}),
    });
    if (launched.outcome.kind !== 'structured' || !launched.outcome.sessionId) {
      throw new Error('Orca did not create a Chat session. Inspect the Orca workspace before retrying');
    }
    state.sessionId = launched.outcome.sessionId;
    state.worktreeId = launched.worktreeId;
    this.store.save(state);
    await this.history(state);
  }

  private async workspace(cwd: string): Promise<{ id: string }> {
    const path = realpathSync(cwd);
    try {
      const result = await this.runtime.call<{ worktree: { id: string; path: string } }>('worktree.show', { worktree: `path:${path}` });
      if (realpathSync(result.worktree.path) !== path) throw new Error('Orca resolved a different working directory');
      return result.worktree;
    } catch (error) {
      if (!(error instanceof OrcaRpcError) || !['selector_not_found', 'worktree_not_found', 'repo_not_found'].includes(error.code)) throw error;
    }
    await this.runtime.call('repo.add', { path, kind: existsSync(join(path, '.git')) ? 'git' : 'folder' });
    const result = await this.runtime.call<{ worktree: { id: string; path: string } }>('worktree.show', { worktree: `path:${path}` });
    if (realpathSync(result.worktree.path) !== path) throw new Error('Orca resolved a different working directory');
    return result.worktree;
  }

  async close(state: OrcaRunnerState): Promise<void> {
    if (!state.sessionId || !state.worktreeId) throw new Error('Orca session has not been created');
    const worktree = `id:${state.worktreeId}`;
    const snapshot = await this.runtime.call<{ tabs: Array<{ id: string; type: string; sessionId?: string }> }>(
      'session.tabs.list', { worktree });
    if (!Array.isArray(snapshot.tabs)) throw new Error('Invalid Orca workspace tab snapshot');
    for (const tab of snapshot.tabs) {
      if (tab.type !== 'agent-session' || tab.sessionId !== state.sessionId) continue;
      const result = await this.runtime.call<{ refused?: boolean; refusalReason?: string }>(
        'session.tabs.close', { worktree, tabId: tab.id, reason: 'user' });
      if (result.refused) throw new Error(`Orca refused to close this tab: ${result.refusalReason || 'unknown reason'}`);
    }
    // Closing the provider alone leaves renderer-owned desktop tabs visible.
    // Also release a headless session when it has no published tab to close.
    const result = await this.runtime.call<{ ok: boolean }>('agentSession.close', { sessionId: state.sessionId });
    if (!result.ok) throw new Error('Orca did not confirm closing the conversation');
  }

  async history(state: OrcaRunnerState, cursor?: OrcaCursor): Promise<OrcaPage> {
    if (!state.sessionId) throw new Error('Orca session has not been created');
    const result = await this.runtime.call<OrcaHistory>('agentSession.history', {
      sessionId: state.sessionId, direction: cursor ? 'after' : 'tail', limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    if (!result.ok) throw new Error('Orca history cursor cannot be recovered safely; inspect this conversation in Orca');
    if (result.page?.sessionId !== state.sessionId || !Array.isArray(result.page.items)
        || !result.page.window?.nextCursor) throw new Error('Invalid Orca history response');
    return result.page;
  }
}
