import { describe, expect, it } from 'vitest';
import { groupWorkbenchSessionsForDimension, type WorkbenchSessionRow } from '../src/dashboard/web/agent-workbench-model.js';
import { redactSessionForPublic, redactSessionEventForPublic } from '../src/dashboard/public-redact.js';
import { Aggregator } from '../src/dashboard/aggregator.js';
import { createSessionPresentationCoordinator } from '../src/dashboard/session-presentation.js';
const workspace = { sourceId: 'source-a', kind: 'git' as const, rootPath: '/repo/feature', displayName: 'feature', branch: 'main', state: 'resolved' as const };
const row = (sessionId: string, more: Partial<WorkbenchSessionRow> = {}): WorkbenchSessionRow => ({ sessionId, status: 'idle', workingDir: '/repo/feature/src', workspace, ...more });
const groups = (rows: WorkbenchSessionRow[], query = '') => groupWorkbenchSessionsForDimension(rows, { dimension: 'worktree', query });
describe('worktree grouping', () => {
  it('merges children across bots but separates roots and sources with identical names', () => {
    const result = groups([row('s1', { larkAppId: 'a' }), row('s2', { larkAppId: 'b', workingDir: '/repo/feature' }),
      row('s3', { workspace: { ...workspace, sourceId: 'source-b' } }),
      row('s4', { workspace: { ...workspace, rootPath: '/other/feature' } })]);
    expect(result).toHaveLength(3); expect(result.find(g => g.sessions.length === 2)).toBeTruthy();
    expect(new Set(result.map(g => g.label)).size).toBe(3);
  });
  it('keeps attention unique and searches the root/branch of child sessions', () => {
    const result = groups([row('s1', { agentAttention: { reason: 'review' } }), row('s2')], 'main');
    expect(result[0].key).toBe('needs-you'); expect(result.flatMap(g => g.sessions)).toHaveLength(2);
  });
  it('does not merge old or unsupported sessions by untrusted textual paths', () => {
    expect(groups([row('s1', { workspace: undefined }), row('s2', { workspace: undefined })])).toHaveLength(2);
  });
  it('redacts metadata from anonymous snapshots and patches', () => {
    expect(redactSessionForPublic(row('s1'))).not.toHaveProperty('workspace');
    expect(redactSessionEventForPublic('session.update', { sessionId: 's1', patch: { workspace } })).not.toHaveProperty('patch.workspace');
  });
  it('enriches snapshots and clears metadata immediately on a cwd change', async () => {
    const aggregator = new Aggregator();
    const coordinator = createSessionPresentationCoordinator(aggregator, async () => null, async () => workspace);
    aggregator.hydrateSessions('a', [{ ...row('s1', { workspace: undefined }), larkAppId: 'a' }]);
    coordinator.schedule('a', aggregator.getSession('s1')!);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(aggregator.getSession('s1')?.workspace).toEqual(workspace);
    aggregator.applyEvent('a', { type: 'session.update', body: { sessionId: 's1', patch: { workingDir: '/different' } } });
    expect(aggregator.getSession('s1')?.workspace).toBeNull();
  });
  it('keeps cached metadata when an older or temporarily unavailable host cannot resolve it', async () => {
    const aggregator = new Aggregator();
    const coordinator = createSessionPresentationCoordinator(aggregator, async () => null, async () => null);
    aggregator.hydrateSessions('a', [{ ...row('s1'), larkAppId: 'a', repoName: 'feature', gitBranch: 'main' }]);
    coordinator.schedule('a', aggregator.getSession('s1')!);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(aggregator.getSession('s1')).toMatchObject({
      workspace,
      repoName: 'feature',
      gitBranch: 'main',
    });
  });
  it('rejects a delayed host result when execution switches to a remote backend', async () => {
    const aggregator = new Aggregator();
    let finish!: (value: typeof workspace) => void;
    const coordinator = createSessionPresentationCoordinator(aggregator, async () => null,
      () => new Promise(resolve => { finish = resolve; }));
    aggregator.hydrateSessions('a', [{ ...row('s1'), larkAppId: 'a', backendType: 'pty' }]);
    coordinator.schedule('a', aggregator.getSession('s1')!);
    aggregator.applyEvent('a', { type: 'session.update', body: { sessionId: 's1', patch: { backendType: 'riff' } } });
    expect(aggregator.getSession('s1')?.workspace).toBeNull();
    finish(workspace);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(aggregator.getSession('s1')?.workspace).toBeNull();
  });

});
