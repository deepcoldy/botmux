import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/types.js';
import type { GroupCollaborationModeConfig } from '../src/services/group-collaboration-mode-store.js';
import type { ProjectGroupState } from '../src/services/project-group-store.js';

const mocks = vi.hoisted(() => ({
  dataDir: '/synthetic/project-association-data',
  readMode: vi.fn(),
  readProject: vi.fn(),
}));

vi.mock('../src/config.js', () => ({ config: { session: { dataDir: mocks.dataDir } } }));
vi.mock('../src/services/group-collaboration-mode-store.js', () => ({
  readGroupCollaborationMode: mocks.readMode,
}));
vi.mock('../src/services/project-group-store.js', () => ({
  readProjectGroup: mocks.readProject,
}));

import {
  markProjectImportPending,
  noteProjectAssociationChanged,
  setProjectAssociationConsumer,
} from '../src/core/project-session-association-events.js';

const mode: GroupCollaborationModeConfig = {
  schemaVersion: 1,
  chatId: 'oc_project',
  mode: 'project',
  coordinatorAppId: 'cli_main',
  workerAppIds: ['cli_worker'],
  importedSessionPolicy: 'notify',
  createdAt: '2026-11-11T00:00:00.000Z',
  updatedAt: '2026-11-11T00:00:00.000Z',
};
const project: ProjectGroupState = {
  schemaVersion: 1,
  revision: 1,
  chatId: 'oc_project',
  larkAppId: 'cli_main',
  coordinatorSessionId: 'main_one',
  title: 'Synthetic project',
  goal: 'Test committed route projections',
  phase: 'test',
  focus: 'test',
  status: 'active',
  blockers: [],
  workstreams: [],
  milestones: [],
  createdAt: '2026-11-11T00:00:00.000Z',
  updatedAt: '2026-11-11T00:00:00.000Z',
};

function session(patch: Partial<Session> = {}): Session {
  return {
    sessionId: 'source_one',
    larkAppId: 'cli_worker',
    chatId: 'oc_project',
    rootMessageId: 'om_source',
    chatType: 'group',
    scope: 'thread',
    status: 'active',
    title: 'PRIVATE TITLE',
    workingDir: '/synthetic/private-working-directory',
    ownerOpenId: 'ou_private_owner',
    ownerUnionId: 'on_private_owner',
    projectRouteRevision: 1,
    projectImportSource: 'relay',
    createdAt: '2026-11-11T00:00:00.000Z',
    ...patch,
  } as Session;
}

beforeEach(() => {
  mocks.readMode.mockReset().mockReturnValue(structuredClone(mode));
  mocks.readProject.mockReset().mockReturnValue(structuredClone(project));
  setProjectAssociationConsumer(undefined);
});
afterEach(() => { setProjectAssociationConsumer(undefined); });

describe('committed project import marker', () => {
  it('marks only an explicitly enabled existing project with an allowed Worker', () => {
    const source = session();
    const result = markProjectImportPending(source);
    expect(result).toBeUndefined();
    expect(source.projectImportPending).toBe(true);
    expect(mocks.readMode).toHaveBeenCalledWith(mocks.dataDir, 'oc_project');
    expect(mocks.readProject).toHaveBeenCalledWith(mocks.dataDir, 'oc_project');
    expect(source).toMatchObject({
      sessionId: 'source_one', chatId: 'oc_project', rootMessageId: 'om_source',
      status: 'active', projectRouteRevision: 1,
    });
  });

  it('stays default-off with no group configuration', () => {
    mocks.readMode.mockReturnValue(undefined);
    const source = session({ projectImportPending: true });
    markProjectImportPending(source);
    expect(source.projectImportPending).toBe(false);
  });

  it.each([
    { importedSessionPolicy: undefined },
    { importedSessionPolicy: 'ignore' as const },
    { mode: 'standard' as const, importedSessionPolicy: 'notify' as const },
    { workerAppIds: ['cli_elsewhere'] },
    { workerAppIds: undefined },
    { coordinatorAppId: 'cli_wrong_main' },
  ])('does not leave a pending event for disabled or unrelated policy %j', patch => {
    mocks.readMode.mockReturnValue({ ...mode, ...patch });
    const source = session({ projectImportPending: true });
    markProjectImportPending(source);
    expect(source.projectImportPending).toBe(false);
  });

  it('requires project state rather than treating a configured group as a started project', () => {
    mocks.readProject.mockReturnValue(undefined);
    const source = session();
    markProjectImportPending(source);
    expect(source.projectImportPending).toBe(false);
  });

  it.each([
    { chatType: 'p2p' as const },
    { scope: 'chat' as const },
    { larkAppId: undefined },
    { projectImportSource: undefined },
    { workflowNode: {} as NonNullable<Session['workflowNode']> },
    { vcMeetingReceiver: {} as NonNullable<Session['vcMeetingReceiver']> },
    { deferredScheduleRun: {} as NonNullable<Session['deferredScheduleRun']> },
    { messageListenerRun: {} as NonNullable<Session['messageListenerRun']> },
  ])('excludes non-thread or specially-owned sources before policy reads %j', patch => {
    const source = session({ projectImportPending: true, ...patch });
    markProjectImportPending(source);
    expect(source.projectImportPending).toBe(false);
    expect(mocks.readMode).not.toHaveBeenCalled();
    expect(mocks.readProject).not.toHaveBeenCalled();
  });

  it('uses the explicit persisted projectImportSource, not arbitrary provenance text', () => {
    const source = session({ projectImportSource: undefined });
    Object.assign(source, { source: 'relay', title: 'relay import', forkedFrom: 'another_source' });
    markProjectImportPending(source);
    expect(source.projectImportPending).toBe(false);
    expect(mocks.readMode).not.toHaveBeenCalled();
  });

  it.each(['relay', 'bind', 'adopt', 'resume_import', 'fork'] as const)(
    'supports explicitly committed %s without inferring task status', sourceKind => {
      const source = session({ projectImportSource: sourceKind });
      markProjectImportPending(source);
      expect(source.projectImportPending).toBe(true);
      expect(source.status).toBe('active');
      expect(source.projectRouteRevision).toBe(1);
    },
  );

  it('the fork child needs its own persisted app identity before marking an import', () => {
    const child = session({
      sessionId: 'fork_child', projectImportSource: 'fork',
      forkedFrom: 'source_parent', larkAppId: undefined,
    });
    markProjectImportPending(child);
    expect(child.projectImportPending).toBe(false);
    expect(mocks.readMode).not.toHaveBeenCalled();
    child.larkAppId = 'cli_worker';
    markProjectImportPending(child);
    expect(child.projectImportPending).toBe(true);
    expect(child.forkedFrom).toBe('source_parent');
  });

  it.each(['policy', 'project'])('a failing %s lookup keeps the synchronous marker default-off', failing => {
    if (failing === 'policy') mocks.readMode.mockImplementation(() => { throw new Error('policy unavailable'); });
    else mocks.readProject.mockImplementation(() => { throw new Error('project unavailable'); });
    const source = session({ projectImportPending: true });
    expect(() => markProjectImportPending(source)).not.toThrow();
    expect(source.projectImportPending).toBe(false);
    expect(source.chatId).toBe('oc_project');
    expect(source.rootMessageId).toBe('om_source');
  });

  it('marking does not invoke the post-commit consumer or wake any model', () => {
    const consumer = vi.fn();
    setProjectAssociationConsumer(consumer);
    markProjectImportPending(session());
    expect(consumer).not.toHaveBeenCalled();
  });
});

describe('post-commit project association projection', () => {
  it('publishes an explicit metadata allowlist without title, owner, cwd or input', () => {
    const consumer = vi.fn();
    setProjectAssociationConsumer(consumer);
    const source = session();
    Object.assign(source, { lastUserPrompt: 'PRIVATE USER CONTENT', lastScreenContent: 'PRIVATE TERMINAL' });
    noteProjectAssociationChanged(source);
    expect(consumer).toHaveBeenCalledWith({
      sessionId: 'source_one', larkAppId: 'cli_worker', chatId: 'oc_project',
      rootMessageId: 'om_source', status: 'active', scope: 'thread',
    });
    const emitted = consumer.mock.calls[0]![0];
    expect(Object.keys(emitted).sort()).toEqual([
      'chatId', 'larkAppId', 'rootMessageId', 'scope', 'sessionId', 'status',
    ]);
    expect(JSON.stringify(emitted)).not.toContain('PRIVATE');
    expect(emitted).not.toHaveProperty('ownerOpenId');
    expect(emitted).not.toHaveProperty('workingDir');
  });

  it('a consumer error cannot roll back or fail an already committed route', () => {
    const source = session({ chatId: 'oc_committed_target', rootMessageId: 'om_committed_target' });
    const before = structuredClone(source);
    setProjectAssociationConsumer(() => { throw new Error('projection failed'); });
    expect(() => noteProjectAssociationChanged(source)).not.toThrow();
    expect(source).toEqual(before);
  });

  it('does not publish without source app identity', () => {
    const consumer = vi.fn();
    setProjectAssociationConsumer(consumer);
    noteProjectAssociationChanged(session({ larkAppId: undefined }));
    expect(consumer).not.toHaveBeenCalled();
  });

  it('does not look up policies or change business status on close/move signals', () => {
    const consumer = vi.fn();
    setProjectAssociationConsumer(consumer);
    const closed = session({ status: 'closed' });
    noteProjectAssociationChanged(closed);
    expect(consumer.mock.calls[0]![0].status).toBe('closed');
    expect(closed.status).toBe('closed');
    expect(mocks.readMode).not.toHaveBeenCalled();
    expect(mocks.readProject).not.toHaveBeenCalled();
  });

  it('keeps the legacy thread-scope default for metadata-only association events', () => {
    const consumer = vi.fn();
    setProjectAssociationConsumer(consumer);
    noteProjectAssociationChanged(session({ scope: undefined }));
    expect(consumer.mock.calls[0]![0].scope).toBe('thread');
  });
});
