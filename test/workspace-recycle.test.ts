import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { runWorkspaceRecycleCommand } from '../src/cli/workspace-recycle.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/types.js';
import type { DaemonSession } from '../src/core/types.js';
import { WorkspaceRecycler } from '../src/services/workspace-recycle.js';
import { WorkspaceRecycleRuntime } from '../src/core/workspace-recycle-runtime.js';
import { canonicalWorkspacePath, captureWorkspace, pathInside } from '../src/core/workspace-recycle-path.js';
import { discoverWorkspaceSessions, WORKSPACE_RECYCLE_PROTOCOL, workspaceTarget } from '../src/core/workspace-recycle-model.js';
import { readRecycleJournal, recycleJournalPath, type RecycleRequest } from '../src/core/workspace-recycle-journal.js';
import { rereadRecycleResources, resourceResiduals, type RecycleResources } from '../src/core/workspace-recycle-resources.js';
import { withBotTurnAdmission } from '../src/core/bot-turn-mutation-gate.js';
import { loadAllSessionsStrict } from '../src/services/session-store.js';

const roots: string[] = [];
const controllers: WorkspaceRecycleRuntime[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'botmux-recycle-'));
  roots.push(root);
  const workspace = join(root, 'work');
  const dataDir = join(root, 'data');
  mkdirSync(workspace); mkdirSync(dataDir);
  const sessions = new Map<string, Session>();
  const live = new Map<string, DaemonSession>();
  const runtime = new Map<string, WorkspaceRecycleRuntime>();
  const closed: string[] = [];
  const failures = new Set<string>();
  const residuals = new Set<string>();
  const resources = (session: Session, ds?: DaemonSession): RecycleResources => ({
    registered: !!ds, processes: [], backing: { type: 'pty', state: 'not_applicable' }, errors: [],
  });
  function add(id: string, app = 'app-a', cwd = workspace, chat = 'chat-one') {
    const session: Session = {
      sessionId: id, larkAppId: app, chatId: chat, rootMessageId: `thread-${id}`,
      title: id, status: 'active', scope: 'thread', createdAt: '2026-01-01T00:00:00.000Z',
      workingDir: cwd, backendType: 'pty',
    };
    sessions.set(id, session);
    live.set(id, {
      session, larkAppId: app, chatId: chat, scope: 'thread', worker: null,
      workerPort: null, workerToken: null, workingDir: cwd, lastMessageAt: 1,
      lastScreenStatus: 'idle',
    } as DaemonSession);
    if (!runtime.has(app)) {
      const controller = new WorkspaceRecycleRuntime({
        appId: () => app, dataDir: () => dataDir,
        getSession: sid => { const s = sessions.get(sid); return s?.larkAppId === app ? s : undefined; },
        getRuntime: sid => live.get(sid), lifecycleBusy: () => false,
        allSessions: () => [...sessions.values()],
        closeResidual: s => residuals.has(s.sessionId) ? 'mojo_lineage_quarantined' : undefined,
        capture: resources, reread: (_before, s, ds) => resources(s, ds),
        retireClosed: (sid, retirement) => { sessions.get(sid)!.workspaceRetirement ??= retirement; },
        close: async (sid, opts) => {
          if (failures.has(sid)) throw new Error('injected_close_failure');
          closed.push(sid); sessions.get(sid)!.status = 'closed'; live.delete(sid);
          sessions.get(sid)!.workspaceRetirement = opts.workspaceRetirement;
          return residuals.has(sid)
            ? { ok: true, outcome: 'closed_with_residual', known: true, alreadyClosed: false, residual: { reason: 'mojo_lineage_quarantined', taskId: 'remote-fixture' } }
            : { ok: true, outcome: 'closed', known: true, alreadyClosed: false };
        },
      });
      runtime.set(app, controller); controllers.push(controller);
    }
    return session;
  }
  const recycler = new WorkspaceRecycler({
    dataDir, sessions: () => [...sessions.values()],
    daemons: () => [...runtime.keys()].map(larkAppId => ({ larkAppId, ipcPort: 12345 })),
    call: async (daemon, action, request) => runtime.get(daemon.larkAppId)!.perform(action, request),
  });
  return { root, workspace, dataDir, sessions, live, runtime, closed, failures, residuals, add, recycler };
}

const success = { eventId: 'end-result-1', outcome: 'succeeded' as const };

describe('workspace ownership discovery', () => {
  it('selects all bots/chats and nested paths, rejects prefix neighbours and same-chat unrelated rows', () => {
    const f = fixture();
    f.add('root'); f.add('nested', 'app-b', join(f.workspace, 'repo'), 'chat-two');
    f.add('neighbour', 'app-a', `${f.workspace}-other`);
    f.add('same-chat', 'app-c', join(f.root, 'unrelated'));
    const shared = f.add('shared'); shared.adoptedFrom = { source: 'tmux', tmuxTarget: 'user:1', cwd: f.workspace };
    f.add('old').status = 'closed';
    const discovered = f.recycler.discover(f.workspace);
    expect(discovered.targets.map(t => t.sessionId)).toEqual(['root', 'nested']);
    expect(discovered.targets[1]).toMatchObject({ larkAppId: 'app-b', chatId: 'chat-two', workingDir: join(f.workspace, 'repo'), evidence: 'session.workingDir' });
    expect(discovered.excluded.map(t => t.reason)).toEqual(['external_or_shared_session', 'already_closed']);
    expect(pathInside(f.workspace, `${f.workspace}-other`)).toBe(false);
  });

  it('resolves existing ancestor aliases after removal and detects changed symlink targets', async () => {
    const f = fixture();
    const alias = join(f.root, 'alias');
    symlinkSync(f.root, alias, 'dir');
    const raw = join(alias, 'work', 'repo');
    f.add('aliased', 'app-a', raw);
    expect(canonicalWorkspacePath(raw)).toBe(join(f.workspace, 'repo'));
    expect((await f.recycler.prepare('op-alias', f.workspace)).ok).toBe(true);
    rmSync(f.workspace, { recursive: true });
    expect((await f.recycler.finish('op-alias', success)).status).toBe('closed');
    expect(f.sessions.get('aliased')?.status).toBe('closed');
  });

  it('reports duplicate owners and malformed stores as coverage errors', () => {
    const f = fixture(); const a = f.add('duplicate');
    const result = discoverWorkspaceSessions([a, { ...a, larkAppId: 'app-b' }], f.workspace);
    expect(result.targets).toEqual([]);
    expect(result.errors).toHaveLength(2);
    writeFileSync(join(f.dataDir, 'sessions-app-a.json'), 'null');
    expect(() => loadAllSessionsStrict(f.dataDir)).toThrow('Invalid session store');
    writeFileSync(join(f.dataDir, 'sessions-app-a.json'), JSON.stringify({ duplicate: a }));
    writeFileSync(join(f.dataDir, 'sessions-app-b.json'), '{broken');
    expect(() => loadAllSessionsStrict(f.dataDir)).toThrow();
  });

  it('refuses malformed SQLite rows instead of silently dropping coverage', () => {
    const f = fixture();
    const dir = join(f.dataDir, 'session-stores', 'app-a'); mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, 'sessions.db'));
    db.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, row TEXT NOT NULL)');
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run('broken', '{bad json'); db.close();
    expect(() => loadAllSessionsStrict(f.dataDir)).toThrow();
  });

  it('allows missing-workspace dry-run but refuses prepare without a live directory', async () => {
    const f = fixture(); f.add('legacy'); rmSync(f.workspace, { recursive: true });
    expect(f.recycler.discover(f.workspace).targets).toHaveLength(1);
    await expect(f.recycler.prepare('legacy-op', f.workspace)).rejects.toThrow();
    expect(f.closed).toEqual([]);
  });
});

describe('recycle lifecycle and recovery', () => {
  it('closes exact targets across bots, keeps history, and replays without another close', async () => {
    const f = fixture(); f.add('one'); f.add('two', 'app-b'); f.add('unrelated', 'app-b', `${f.workspace}-other`);
    expect((await f.recycler.prepare('op', f.workspace)).status).toBe('prepared');
    rmSync(f.workspace, { recursive: true });
    expect((await f.recycler.finish('op', success)).status).toBe('closed');
    expect((await f.recycler.finish('op', success)).status).toBe('closed');
    expect(f.closed).toEqual(['one', 'two']);
    expect(f.sessions.get('one')?.title).toBe('one');
    expect(f.sessions.get('unrelated')?.status).toBe('active');
  });

  it('does not close after a failed recycle or when the root still exists/reappears', async () => {
    const f = fixture(); f.add('one'); await f.recycler.prepare('op', f.workspace);
    await expect(f.recycler.finish('op', success)).rejects.toThrow('workspace_still_exists');
    const failed = await f.recycler.finish('op', { eventId: 'failed', outcome: 'failed' });
    expect(failed.status).toBe('aborted'); expect(f.closed).toEqual([]);
    expect(f.sessions.get('one')?.workspaceRetirement).toBeUndefined();
    await expect(f.recycler.finish('op', success)).rejects.toThrow('recycle_event_conflict');
  });

  it('rechecks busy preflight on replay while keeping changed input unapproved', async () => {
    const f = fixture(); f.add('one');
    f.live.get('one')!.pendingWaitPromises = new Set([Promise.resolve()]);
    expect((await f.recycler.prepare('op', f.workspace)).ok).toBe(false);
    f.live.get('one')!.pendingWaitPromises.clear();
    expect((await f.recycler.prepare('op', f.workspace)).ok).toBe(true);
    f.live.get('one')!.lastMessageAt = 2;
    const retry = await f.recycler.prepare('op', f.workspace);
    expect(retry.ok).toBe(false);
    expect(retry.errors[0].error).toContain('new_input_or_worker_generation');
    expect(f.closed).toEqual([]);
  });

  it('rejects an explicit initiator outside the exact target plan', async () => {
    const f = fixture(); f.add('one');
    await expect(f.recycler.prepare('op', f.workspace, 'wrong-id')).rejects.toThrow('initiator_not_in_plan');
    expect(f.closed).toEqual([]);
  });

  it('records partial failure and resumes only the remaining exact session', async () => {
    const f = fixture(); f.add('one'); f.add('two', 'app-b'); f.failures.add('two');
    await f.recycler.prepare('op', f.workspace); rmSync(f.workspace, { recursive: true });
    const partial = await f.recycler.finish('op', success);
    expect(partial.status).toBe('partial'); expect(f.closed).toEqual(['one']);
    f.failures.delete('two');
    const recovered = await f.recycler.finish('op', success);
    expect(recovered.status).toBe('closed'); expect(f.closed).toEqual(['one', 'two']);
  });

  it('retains closed_with_residual on retries and never calls it overall success', async () => {
    const f = fixture(); f.add('remote'); f.residuals.add('remote');
    await f.recycler.prepare('op', f.workspace); rmSync(f.workspace, { recursive: true });
    const first = await f.recycler.finish('op', success);
    expect(first.status).toBe('partial'); expect(first.ok).toBe(false);
    expect(first.results[0].phase).toBe('closed_with_residual');
    expect((await f.recycler.finish('op', success)).results[0].phase).toBe('closed_with_residual');
    expect(f.closed).toEqual(['remote']);
  });

  it('protects a busy session before reclamation and refuses to discard new input after preparation', async () => {
    const f = fixture(); f.add('busy'); f.live.get('busy')!.pendingPrompt = 'in-flight';
    expect((await f.recycler.prepare('op-busy', f.workspace)).ok).toBe(false);
    await expect(f.recycler.finish('op-busy', success)).rejects.toThrow('preflight_not_ready');
    f.live.get('busy')!.pendingPrompt = undefined;
    await f.recycler.prepare('op-idle', f.workspace);
    f.live.get('busy')!.lastMessageAt++;
    rmSync(f.workspace, { recursive: true });
    const changed = await f.recycler.finish('op-idle', success);
    expect(changed.status).toBe('partial'); expect(f.closed).toEqual([]);
    expect(changed.errors.some(e => e.error.includes('new_input'))).toBe(true);
  });

  it('refuses a transferred or repinned session and does not act on a replacement owner', async () => {
    const f = fixture(); const s = f.add('moved'); await f.recycler.prepare('op', f.workspace);
    s.workingDir = join(f.root, 'elsewhere');
    rmSync(f.workspace, { recursive: true });
    expect((await f.recycler.finish('op', success)).status).toBe('partial');
    expect(f.closed).toEqual([]);
  });

  it('waits for already-admitted input before taking its closing decision', async () => {
    const f = fixture(); f.add('race'); await f.recycler.prepare('op', f.workspace);
    rmSync(f.workspace, { recursive: true });
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    let admitted!: () => void;
    const ready = new Promise<void>(r => { admitted = r; });
    const turn = withBotTurnAdmission('app-a', async () => { admitted(); await held; f.live.get('race')!.pendingPrompt = 'new-message'; });
    await ready;
    const closing = f.recycler.finish('op', success);
    release(); await turn;
    expect((await closing).status).toBe('partial'); expect(f.closed).toEqual([]);
  });

  it('hands off the initiator durably, closes it last when idle, and keeps all peers explicit', async () => {
    const f = fixture(); f.add('initiator'); f.add('peer', 'app-b');
    f.live.get('initiator')!.pendingPrompt = 'finishing turn';
    expect((await f.recycler.prepare('op', f.workspace, 'initiator')).ok).toBe(true);
    rmSync(f.workspace, { recursive: true });
    const result = await f.recycler.finish('op', success);
    expect(result.status).toBe('pending'); expect(result.ok).toBe(false);
    expect(f.closed).toEqual(['peer']);
    const journal = readRecycleJournal(recycleJournalPath(f.dataDir, 'op', { larkAppId: 'app-a', sessionId: 'initiator' }));
    expect(journal?.phase).toBe('deferred');
    await f.runtime.get('app-a')!.recoverDeferred();
    expect(f.closed).toEqual(['peer']);
    f.live.get('initiator')!.pendingPrompt = undefined;
    await f.runtime.get('app-a')!.recoverDeferred();
    expect(f.closed).toEqual(['peer', 'initiator']);
    expect(f.recycler.status('op').status).toBe('closed');
  });

  it('does not hand off the initiator if a peer fails or an unplanned session arrives', async () => {
    const f = fixture(); f.add('initiator'); f.add('peer', 'app-b');
    await f.recycler.prepare('op', f.workspace, 'initiator');
    f.add('new', 'app-b'); rmSync(f.workspace, { recursive: true });
    const result = await f.recycler.finish('op', success);
    expect(result.status).toBe('partial');
    expect(f.closed).toEqual(['peer']); expect(f.live.has('initiator')).toBe(true);
    expect(f.sessions.get('new')?.status).toBe('active');
  });

  it('rechecks new peers and reactivated peers before deferred initiator exit', async () => {
    const f = fixture(); f.add('initiator'); f.add('peer', 'app-b');
    await f.recycler.prepare('op', f.workspace, 'initiator');
    rmSync(f.workspace, { recursive: true });
    expect((await f.recycler.finish('op', success)).status).toBe('pending');
    f.sessions.get('peer')!.status = 'active';
    await f.runtime.get('app-a')!.recoverDeferred();
    expect(f.closed).toEqual(['peer']);
    expect(f.recycler.status('op').status).toBe('partial');
  });

  it('recovers a lost local close receipt from durable closed state without killing twice', async () => {
    const f = fixture(); f.add('one'); await f.recycler.prepare('op', f.workspace);
    rmSync(f.workspace, { recursive: true });
    await f.recycler.finish('op', success);
    const path = recycleJournalPath(f.dataDir, 'op', { larkAppId: 'app-a', sessionId: 'one' });
    const journal = readRecycleJournal(path)!;
    journal.phase = 'closing'; delete journal.closeResult; delete journal.after;
    writeFileSync(path, JSON.stringify(journal));
    expect((await f.recycler.finish('op', success)).status).toBe('closed');
    expect(f.closed).toEqual(['one']);
  });

  it('retires a target closed independently after prepare without repeating process close', async () => {
    const f = fixture(); f.add('one'); await f.recycler.prepare('op', f.workspace);
    f.sessions.get('one')!.status = 'closed'; f.live.delete('one');
    rmSync(f.workspace, { recursive: true });
    expect((await f.recycler.finish('op', success)).status).toBe('closed');
    expect(f.sessions.get('one')?.workspaceRetirement).toMatchObject({ operationId: 'op', workspacePath: f.workspace });
    expect(f.closed).toEqual([]);
  });

  it('keeps a reused path or changed alias from authorizing any stale close', async () => {
    const f = fixture();
    const alias = join(f.root, 'alias'); symlinkSync(f.workspace, alias, 'dir');
    f.add('one', 'app-a', alias); await f.recycler.prepare('op', f.workspace);
    const other = join(f.root, 'other'); mkdirSync(other);
    rmSync(alias); symlinkSync(other, alias, 'dir');
    rmSync(f.workspace, { recursive: true });
    expect((await f.recycler.finish('op', success)).status).toBe('partial');
    expect(f.closed).toEqual([]);
  });

  it('returns partial on missing owners; never writes session files as a fallback', async () => {
    const f = fixture(); f.add('offline');
    const before = JSON.stringify([...f.sessions.values()]);
    f.runtime.clear();
    expect((await f.recycler.prepare('op', f.workspace)).ok).toBe(false);
    expect(JSON.stringify([...f.sessions.values()])).toBe(before);
  });

  it('fails closed for state inside the workspace, changed operation identity, and missing prepare', async () => {
    const f = fixture(); const s = f.add('one');
    const inside = new WorkspaceRecycler({ dataDir: f.workspace, sessions: () => [s] });
    await expect(inside.prepare('bad', f.workspace)).rejects.toThrow('recycle_state_inside_workspace');
    const workspace = captureWorkspace(f.workspace);
    const request: RecycleRequest = { protocol: WORKSPACE_RECYCLE_PROTOCOL, operationId: 'no-prepare', workspace, target: workspaceTarget(s, workspace)!, peers: [{ sessionId: s.sessionId, larkAppId: s.larkAppId! }] };
    await expect(f.runtime.get('app-a')!.perform('close', request)).rejects.toThrow('recycle_not_prepared');
    await f.recycler.prepare('op', f.workspace);
    const other = join(f.root, 'other'); mkdirSync(other);
    await expect(f.recycler.prepare('op', other)).rejects.toThrow('recycle_operation_conflict');
  });

  it('keeps active registrations bounded over repeated create/recycle rounds', async () => {
    const f = fixture();
    for (let round = 0; round < 8; round++) {
      if (round) mkdirSync(f.workspace);
      f.add(`round-${round}-a`); f.add(`round-${round}-b`, 'app-b');
      expect((await f.recycler.prepare(`op-${round}`, f.workspace)).ok).toBe(true);
      rmSync(f.workspace, { recursive: true });
      expect((await f.recycler.finish(`op-${round}`, { ...success, eventId: `event-${round}` })).status).toBe('closed');
      expect(f.live.size).toBe(0);
    }
    expect(f.sessions.size).toBe(16); // retained historical records
  });
});

describe('generic lifecycle hook command', () => {
  it('accepts equivalent before/after events and rejects conflicting or malformed events', async () => {
    const f = fixture();
    vi.stubEnv('SESSION_DATA_DIR', f.dataDir);
    vi.stubEnv('BOTMUX_SESSION_ID', '');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const eventPath = join(f.root, 'event.json');
    const run = async (event: unknown) => {
      writeFileSync(eventPath, JSON.stringify(event));
      return runWorkspaceRecycleCommand(['hook', '--event-file', eventPath]);
    };
    const event = { protocol: WORKSPACE_RECYCLE_PROTOCOL, operationId: 'hook-op' };
    expect(await run({ ...event, phase: 'before-reclaim', workspacePath: f.workspace })).toBe(0);
    expect(JSON.parse(output.mock.calls.at(-1)![0]).status).toBe('prepared');
    expect(await run({ ...event, phase: 'after-reclaim', eventId: 'end-1', outcome: 'succeeded' })).toBe(2);
    rmSync(f.workspace, { recursive: true });
    expect(await run({ ...event, phase: 'after-reclaim', eventId: 'end-1', outcome: 'succeeded' })).toBe(0);
    expect(JSON.parse(output.mock.calls.at(-1)![0]).status).toBe('closed');
    expect(await run({ ...event, phase: 'after-reclaim', eventId: 'end-2', outcome: 'failed' })).toBe(2);
    expect(await run(null)).toBe(2);
    expect(await runWorkspaceRecycleCommand(['finish', '--operation', 'hook-op', '--operation', 'duplicate'])).toBe(2);
  });
});

describe('durable process readback', () => {
  it('does not reattribute a reused stored PID or its children to the closed session', () => {
    const f = fixture(); const session = f.add('closed'); session.status = 'closed'; session.pid = process.pid;
    const before: RecycleResources = {
      registered: true, processes: [{ pid: process.pid, identity: 'previous-process-birth', source: 'worker', state: 'alive' }],
      backing: { type: 'pty', state: 'not_applicable' }, errors: [],
    };
    const after = rereadRecycleResources(before, session);
    expect(after.processes).toEqual([{ pid: process.pid, identity: 'previous-process-birth', source: 'worker', state: 'reused' }]);
    expect(resourceResiduals(after)).toEqual([]);
  });
});
