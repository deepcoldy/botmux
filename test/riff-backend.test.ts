/**
 * Unit tests for RiffBackend — write serialization (no duplicate task-execute
 * on rapid writes) and sandbox access-URL handling (directAccessUrl preference
 * + accessUrl origin rewrite onto the configured baseUrl).
 *
 * Run:  pnpm vitest run test/riff-backend.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { RiffBackend, parseRiffRepoName, deriveRiffRepoFromWorkingDir, deriveRiffReposFromDirs } from '../src/adapters/backend/riff-backend.js';

const BASE = 'https://riff-infra-boe.bytedance.net';

type FetchCall = { url: string; init?: RequestInit };

/** Never-ending SSE body so streamTask stays pending without emitting events. */
function pendingSseResponse(): Response {
  const body = new ReadableStream<Uint8Array>({ start() { /* never pushes */ } });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function taskResponse(id: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ success: true, data: { id, status: 'running', ...extra } });
}

describe('RiffBackend', () => {
  let calls: FetchCall[];
  let resolvers: Array<(r: Response) => void>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    calls = [];
    resolvers = [];
    fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.includes('/api2/task-stream')) return pendingSseResponse();
      if (u.includes('/api/task-detail')) {
        return Response.json({ success: true, data: { task: {} } });
      }
      // task-cancel：即时成功（mock fetch 不接 AbortSignal，挂起会假死测试）
      if (u.includes('/api/task-cancel')) {
        return Response.json({ success: true, data: {} });
      }
      // task-execute / task-follow-up: resolve manually so tests control timing
      return new Promise<Response>((resolve) => { resolvers.push(resolve); });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeBackend(config: Record<string, unknown> = {}): RiffBackend {
    return new RiffBackend({ baseUrl: BASE, jwt: 'test-jwt', ...config } as any, 'session-1');
  }

  const flush = () => new Promise((r) => setTimeout(r, 0));

  describe('write serialization', () => {
    it('queues a second write until the first task-execute returns (no duplicate createTask)', async () => {
      const be = makeBackend();
      be.spawn('', [], {} as any);

      be.write('first message');
      be.write('second message');
      await flush();

      // Only ONE task-execute in flight — the second write must wait.
      const execCalls = () => calls.filter(c => c.url.includes('/api/task-execute'));
      const followCalls = () => calls.filter(c => c.url.includes('/api/task-follow-up'));
      expect(execCalls().length).toBe(1);
      expect(followCalls().length).toBe(0);

      // First task lands → second write becomes a follow-up, not a new task.
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      expect(execCalls().length).toBe(1);
      expect(followCalls().length).toBe(1);
      const followBody = JSON.parse(String(followCalls()[0]!.init?.body));
      expect(followBody.parentTaskId).toBe('task-1');
      expect(String(followBody.prompt)).toContain('second message');
    });

    it('routes the next message after task completion to follow-up (sandbox continuity)', async () => {
      const be = makeBackend({ injectStatusLines: false });
      be.spawn('', [], {} as any);
      be.write('first');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      // Task completes — the next turn must still follow up on task-1, not
      // cold-boot a brand-new task/sandbox.
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-1');
      await flush(); await flush();

      be.write('second');
      await flush();
      resolvers.shift()!(taskResponse('task-2'));
      await flush();
      expect(calls.filter(c => c.url.includes('/api/task-execute')).length).toBe(1);
      const follow = calls.filter(c => c.url.includes('/api/task-follow-up'));
      expect(follow.length).toBe(1);
      expect(JSON.parse(String(follow[0]!.init?.body)).parentTaskId).toBe('task-1');
    });

    it('falls back to a fresh task after a follow-up failure', async () => {
      const be = makeBackend({ injectStatusLines: false });
      be.spawn('', [], {} as any);
      be.write('first');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-1');
      await flush(); await flush();

      be.write('second');
      await flush();
      resolvers.shift()!(new Response('gone', { status: 410 }));
      await flush();
      // Lineage broken → next message starts a new task instead of failing forever.
      be.write('third');
      await flush();
      expect(calls.filter(c => c.url.includes('/api/task-execute')).length).toBe(2);
    });

    it('ignores a duplicate done event (no double turn-boundary)', async () => {
      const be = makeBackend({ injectStatusLines: false });
      const done = vi.fn();
      be.onTaskDone(done);
      (be as any).currentTaskId = 'task-1';
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-1');
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-1');
      await flush(); await flush();
      expect(done).toHaveBeenCalledTimes(1);
    });

    it('cross-turn duplicate done: A done → B write → A duplicate done must not fire mid-B', async () => {
      const be = makeBackend({ injectStatusLines: false });
      const done = vi.fn();
      be.onTaskDone(done);
      be.spawn('', [], {} as any);
      be.write('first');
      await flush();
      resolvers.shift()!(taskResponse('task-A'));
      await flush();
      // A completes → boundary fires once, queued follow-up becomes task B.
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-A');
      await flush(); await flush();
      expect(done).toHaveBeenCalledTimes(1);
      be.write('second');
      await flush();
      resolvers.shift()!(taskResponse('task-B'));
      await flush();
      expect((be as any).taskDone).toBe(false); // B is running
      // A's duplicate done arrives ~500ms later (observed live): must be inert.
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-A');
      await flush(); await flush();
      expect(done).toHaveBeenCalledTimes(1);
      expect((be as any).taskDone).toBe(false); // B must not be marked done
      // B's own done still fires the boundary normally.
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-B');
      await flush(); await flush();
      expect(done).toHaveBeenCalledTimes(2);
    });
  });

  describe('SSE clean EOF without done (finding C)', () => {
    it('treats a clean EOF with no done event as a stream failure — session must not stay busy forever', async () => {
      const be = makeBackend({ injectStatusLines: false });
      (be as any).maxReconnectAttempts = 0; // skip the timed retries in test
      const done = vi.fn();
      be.onTaskDone(done);
      // task-stream responds 200 then closes immediately WITHOUT a done event.
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        if (u.includes('/api2/task-stream')) {
          return new Response(new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), { status: 200 });
        }
        if (u.includes('/api/task-detail')) return Response.json({ success: true, data: { task: {} } });
        return taskResponse('task-1');
      });
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      await flush();
      // Reconnect budget exhausted (0) → emitError → turn boundary fires so
      // queued follow-ups are not stuck.
      expect(done).toHaveBeenCalledTimes(1);
    });

    it('CRLF-framed done event is parsed (proxy-normalized SSE)', async () => {
      const be = makeBackend({ injectStatusLines: false });
      (be as any).maxReconnectAttempts = 0;
      const done = vi.fn();
      be.onTaskDone(done);
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        if (u.includes('/api2/task-stream')) {
          const body = 'event:done\r\ndata:{"status":"completed"}\r\n\r\n';
          return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }), { status: 200 });
        }
        if (u.includes('/api/task-detail')) return Response.json({ success: true, data: { task: {} } });
        return taskResponse('task-1');
      });
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      await flush();
      expect(done).toHaveBeenCalledTimes(1); // CRLF 分帧被归一化，done 正常触发（无 EOF 误判）
    });

    it('EOF-tail done (no trailing blank line) is still processed', async () => {
      const be = makeBackend({ injectStatusLines: false });
      (be as any).maxReconnectAttempts = 0;
      const done = vi.fn();
      be.onTaskDone(done);
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        if (u.includes('/api2/task-stream')) {
          const body = 'event:done\ndata:{"status":"completed"}';  // 无结尾空行
          return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }), { status: 200 });
        }
        if (u.includes('/api/task-detail')) return Response.json({ success: true, data: { task: {} } });
        return taskResponse('task-1');
      });
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      await flush();
      expect(done).toHaveBeenCalledTimes(1);
    });

    it('clean EOF AFTER done is normal shutdown — no error, no second boundary', async () => {
      const be = makeBackend({ injectStatusLines: false });
      (be as any).maxReconnectAttempts = 0;
      const done = vi.fn();
      be.onTaskDone(done);
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        if (u.includes('/api2/task-stream')) {
          const body = 'event:done\ndata:{"status":"completed"}\n\n';
          return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }), { status: 200 });
        }
        if (u.includes('/api/task-detail')) return Response.json({ success: true, data: { task: {} } });
        return taskResponse('task-1');
      });
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      await flush();
      expect(done).toHaveBeenCalledTimes(1); // done event only — EOF added nothing
    });
  });

  describe('restart lineage resume (finding D)', () => {
    it('resumeParentTaskId makes the first write a follow-up on the persisted parent', async () => {
      const be = makeBackend({ resumeParentTaskId: 'task-old', injectStatusLines: false });
      const ids: string[] = [];
      be.onTaskId(id => ids.push(id));
      expect(ids).toEqual(['task-old']); // immediate replay for late subscribers
      be.spawn('', [], {} as any);
      be.write('after restart');
      await flush();
      expect(calls.filter(c => c.url.includes('/api/task-execute')).length).toBe(0);
      const follow = calls.filter(c => c.url.includes('/api/task-follow-up'));
      expect(follow.length).toBe(1);
      expect(JSON.parse(String(follow[0]!.init?.body)).parentTaskId).toBe('task-old');
      resolvers.shift()!(taskResponse('task-new'));
      await flush();
      expect(ids).toEqual(['task-old', 'task-new']); // new id announced for persistence
    });
  });

  describe('task isolation (finding F)', () => {
    it('stale stream events are inert once a newer task is current', () => {
      const be = makeBackend({ injectStatusLines: false });
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      (be as any).currentTaskId = 'task-B';
      (be as any).handleSseEvent('event:output\ndata:{"chunk":"OLD-A-OUTPUT"}', 'task-A');
      expect(lines.join('')).not.toContain('OLD-A-OUTPUT');
    });

    it("A's late task-detail must not overwrite B's sandbox URL", async () => {
      const be = makeBackend();
      const urls: string[] = [];
      be.onAccessUrl(u => urls.push(u));
      let resolveDetail!: (r: Response) => void;
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        if (u.includes('/api/task-detail')) return new Promise<Response>((r) => { resolveDetail = r; });
        return pendingSseResponse();
      });
      (be as any).currentTaskId = 'task-A';
      const p = (be as any).fetchDirectAccessUrl('task-A');
      (be as any).currentTaskId = 'task-B';
      resolveDetail(Response.json({ success: true, data: { task: { directAccessUrl: 'https://old-a.example/' } } }));
      await p;
      expect(urls).not.toContain('https://old-a.example/');
    });
  });

  describe('completedTaskIds bounded eviction (finding E)', () => {
    it('never evicts the just-completed task — its duplicate done stays inert past 64 turns', async () => {
      const be = makeBackend({ injectStatusLines: false });
      const done = vi.fn();
      be.onTaskDone(done);
      for (let i = 1; i <= 70; i++) {
        (be as any).currentTaskId = `task-${i}`;
        (be as any).taskDone = false;
        (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', `task-${i}`);
      }
      await flush(); await flush();
      expect(done).toHaveBeenCalledTimes(70);
      // 第 70 轮的 duplicate done（~500ms 后到达）必须仍被吞掉
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-70');
      await flush(); await flush();
      expect(done).toHaveBeenCalledTimes(70);
      expect(((be as any).completedTaskIds as Set<string>).size).toBeLessThanOrEqual(64);
    });
  });

  describe('onTaskDone turn boundary', () => {
    it('fires when the done SSE event arrives', async () => {
      const be = makeBackend({ injectStatusLines: false });
      const done = vi.fn();
      be.onTaskDone(done);
      (be as any).currentTaskId = 'task-1';
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed","exitCode":0}', 'task-1');
      await flush(); await flush();
      expect(done).toHaveBeenCalledTimes(1);
      expect((be as any).taskDone).toBe(true);
    });

    it('fires when task creation fails, so queued follow-ups are not stuck', async () => {
      const be = makeBackend();
      const done = vi.fn();
      be.onTaskDone(done);
      fetchMock.mockImplementation(async () => { throw new Error('network down'); });
      be.write('hello');
      await flush();
      expect(done).toHaveBeenCalledTimes(1);
    });
  });

  describe('agent default (config simplification)', () => {
    it('defaults the task agent to codex when not configured', async () => {
      const be = makeBackend({ injectStatusLines: false });
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      const exec = calls.find(c => c.url.includes('/api/task-execute'))!;
      expect(JSON.parse(String(exec.init?.body)).config.agent).toBe('codex');
    });
  });

  describe('repo reuse (复用本地仓库+分支)', () => {
    it('parseRiffRepoName normalizes internal specs and rejects external hosts', () => {
      expect(parseRiffRepoName('git@code.byted.org:webinfra/agent-monorepo.git')).toBe('webinfra/agent-monorepo');
      expect(parseRiffRepoName('https://code.byted.org/webinfra/agent-monorepo.git')).toBe('webinfra/agent-monorepo');
      expect(parseRiffRepoName('https://code.byted.org/webinfra/agent-monorepo/')).toBe('webinfra/agent-monorepo');
      expect(parseRiffRepoName('webinfra/agent-monorepo')).toBe('webinfra/agent-monorepo');
      expect(parseRiffRepoName('git@github.com:deepcoldy/botmux.git')).toBeNull();
      expect(parseRiffRepoName('https://github.com/deepcoldy/botmux')).toBeNull();
      expect(parseRiffRepoName('')).toBeNull();
    });

    it('derives repoName + pinned branch when the branch exists on the remote', () => {
      const git = (answers: Record<string, string | null>) => (args: string[]) =>
        answers[args.join(' ')] ?? null;
      const derived = deriveRiffRepoFromWorkingDir('/repo', git({
        'remote get-url origin': 'git@code.byted.org:webinfra/agent-monorepo.git',
        'rev-parse --abbrev-ref HEAD': 'feat/x',
        'rev-parse --verify --quiet refs/remotes/origin/feat/x': 'abc123',
        'rev-list --count refs/remotes/origin/feat/x..HEAD': '0',
        'status --porcelain': null,
      }));
      expect(derived).toEqual({ repo: { repoName: 'webinfra/agent-monorepo', repoBranch: 'feat/x' }, warnings: [] });
    });

    it('warns on unpushed branch (falls back to default branch) and dirty tree', () => {
      const git = (answers: Record<string, string | null>) => (args: string[]) =>
        answers[args.join(' ')] ?? null;
      const derived = deriveRiffRepoFromWorkingDir('/repo', git({
        'remote get-url origin': 'git@code.byted.org:g/r.git',
        'rev-parse --abbrev-ref HEAD': 'local-only',
        'status --porcelain': ' M src/a.ts',
      }));
      expect(derived!.repo).toEqual({ repoName: 'g/r' });
      expect(derived!.warnings.some(w => w.includes('未推送到远端'))).toBe(true);
      expect(derived!.warnings.some(w => w.includes('未提交改动'))).toBe(true);
    });

    it('multi-repo: derives the EXPLICIT stamped dirs in user-selection order (B,A stays B,A)', () => {
      const perDir: Record<string, { repo: any; warnings: string[] } | null> = {
        '/wt/b': { repo: { repoName: 'g/b', repoBranch: 'wt/x' }, warnings: [] },
        '/wt/a': { repo: { repoName: 'g/a' }, warnings: ['本地分支 wt/y 未推送到远端，沙箱将使用默认分支'] },
      };
      const derived = deriveRiffReposFromDirs(['/wt/b', '/wt/a'], (dir: string) => perDir[dir] ?? null);
      // 用户选 B,A → primary 必须是 B（顺序即语义，不随文件系统枚举漂移）
      expect(derived!.repos).toEqual([{ repoName: 'g/b', repoBranch: 'wt/x' }, { repoName: 'g/a' }]);
      expect(derived!.warnings).toEqual(['[g/a] 本地分支 wt/y 未推送到远端，沙箱将使用默认分支']);
    });

    it('multi-repo: returns null when no stamped dir derives (never scans children)', () => {
      expect(deriveRiffReposFromDirs(['/x/a', '/x/b'], () => null)).toBeNull();
    });

    it('plain non-git workingDir derives nothing (no repo attached)', () => {
      const git = () => null;
      expect(deriveRiffRepoFromWorkingDir('/home/user', git)).toBeNull();
    });

    it('returns null for non-internal origins and non-git dirs', () => {
      const git = (answers: Record<string, string | null>) => (args: string[]) =>
        answers[args.join(' ')] ?? null;
      expect(deriveRiffRepoFromWorkingDir('/repo', git({ 'remote get-url origin': 'git@github.com:a/b.git' }))).toBeNull();
      expect(deriveRiffRepoFromWorkingDir('/repo', git({}))).toBeNull();
    });

    it('sends config.repos in the API-native shape and a status line', async () => {
      const be = makeBackend({ repos: [{ repoName: 'g/r', repoBranch: 'dev' }], repoWarnings: ['本地工作区有未提交改动，沙箱只能看到已推送内容'] });
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      const exec = calls.find(c => c.url.includes('/api/task-execute'))!;
      const body = JSON.parse(String(exec.init?.body));
      expect(body.config.repos).toEqual([{ repoName: 'g/r', repoBranch: 'dev' }]);
      expect(lines.join('')).toContain('[riff] 仓库: g/r@dev');
      expect(lines.join('')).toContain('⚠️ 本地工作区有未提交改动');
    });

    it('ignores stale defaultRepo config — repos come only from config.repos', async () => {
      const be = makeBackend({ defaultRepo: 'https://code.byted.org/g/r.git', defaultBranch: 'dev', injectStatusLines: false } as any);
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      const exec = calls.find(c => c.url.includes('/api/task-execute'))!;
      expect(JSON.parse(String(exec.init?.body)).config.repos).toBeUndefined();
    });
  });

  describe('close race with in-flight create/follow-up (finding L-race)', () => {
    it('close during create: the late task is cancelled, never streamed or adopted', async () => {
      const be = makeBackend({ injectStatusLines: false });
      be.spawn('', [], {} as any);
      be.write('hello');
      await flush();
      // create HTTP 尚未返回时 /close
      const destroyP = be.destroySession();
      await flush();
      resolvers.shift()!(taskResponse('task-late'));
      await new Promise((r) => setTimeout(r, 20));
      await destroyP;
      const cancels = calls.filter(c => c.url.includes('/api/task-cancel'));
      expect(cancels.length).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(String(cancels[cancels.length - 1]!.init?.body ?? '{}')).id ?? JSON.parse(String(cancels[0]!.init?.body)).id).toBe('task-late');
      expect(calls.filter(c => c.url.includes('/api2/task-stream')).length).toBe(0);
      expect((be as any).currentTaskId).not.toBe('task-late');
    });

    it('close during follow-up: the late follow-up task is cancelled', async () => {
      const be = makeBackend({ injectStatusLines: false });
      be.spawn('', [], {} as any);
      be.write('first');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-1');
      await flush(); await flush();
      be.write('second');
      await flush();
      const destroyP = be.destroySession();
      await flush();
      resolvers.shift()!(taskResponse('task-late-2'));
      await new Promise((r) => setTimeout(r, 20));
      await destroyP;
      const cancelIds = calls.filter(c => c.url.includes('/api/task-cancel')).map(c => JSON.parse(String(c.init?.body)).id);
      expect(cancelIds).toContain('task-late-2');
      // late follow-up 不得成为 current，也不得开流
      expect((be as any).currentTaskId).not.toBe('task-late-2');
    });
  });

  describe('close teardown awaits pending cancel (finding L-race hard proof)', () => {
    it('destroySession does NOT resolve while the late-task cancel is still pending', async () => {
      const be = makeBackend({ injectStatusLines: false });
      let resolveCancel!: (r: Response) => void;
      const cancelCalls: string[] = [];
      fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        calls.push({ url: u, init });
        if (u.includes('/api/task-cancel')) {
          cancelCalls.push(JSON.parse(String(init?.body)).id);
          return new Promise<Response>((r) => { resolveCancel = r; }); // cancel 挂起
        }
        if (u.includes('/api2/task-stream')) return pendingSseResponse();
        if (u.includes('/api/task-detail')) return Response.json({ success: true, data: { task: {} } });
        return new Promise<Response>((resolve) => { resolvers.push(resolve); });
      });
      be.spawn('', [], {} as any);
      be.write('hello');
      await flush();
      let destroyed = false;
      const destroyP = be.destroySession().then(() => { destroyed = true; });
      await flush();
      // create 返回 late task —— closing 已立，late cancel 在链内 await
      resolvers.shift()!(taskResponse('task-late'));
      await new Promise((r) => setTimeout(r, 30));
      expect(cancelCalls).toContain('task-late');
      expect(destroyed).toBe(false); // cancel 未 resolve 前 teardown 不得完成
      resolveCancel(Response.json({ success: true, data: {} }));
      await destroyP;
      expect(destroyed).toBe(true);
      expect(calls.filter(c => c.url.includes('/api2/task-stream')).length).toBe(0);
    });
  });

  describe('close deadline boundary (no inner chain window)', () => {
    it('create resolving late (after destroy started) still gets its cancel awaited before teardown', async () => {
      const be = makeBackend({ injectStatusLines: false });
      (be as any).destroyDeadlineMs = 1_000; // 注入小预算便于边界测试
      let resolveCancel!: (r: Response) => void;
      const cancelIds: string[] = [];
      fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        calls.push({ url: u, init });
        if (u.includes('/api/task-cancel')) {
          cancelIds.push(JSON.parse(String(init?.body)).id);
          return new Promise<Response>((r) => { resolveCancel = r; });
        }
        if (u.includes('/api2/task-stream')) return pendingSseResponse();
        if (u.includes('/api/task-detail')) return Response.json({ success: true, data: { task: {} } });
        return new Promise<Response>((resolve) => { resolvers.push(resolve); });
      });
      be.spawn('', [], {} as any);
      be.write('hello');
      await flush();
      let destroyed = false;
      const destroyP = be.destroySession().then(() => { destroyed = true; });
      // create 晚于 destroy 启动才返回（模拟 chain 窗口末端）
      await new Promise((r) => setTimeout(r, 120));
      resolvers.shift()!(taskResponse('task-late-edge'));
      await new Promise((r) => setTimeout(r, 60));
      expect(cancelIds).toContain('task-late-edge');
      expect(destroyed).toBe(false); // teardown 必须等到 late cancel，不因内层窗口提前 resolve
      resolveCancel(Response.json({ success: true, data: {} }));
      await destroyP;
      expect(destroyed).toBe(true);
      expect(calls.filter(c => c.url.includes('/api2/task-stream')).length).toBe(0);
    });
  });

  describe('final report ordering (F-edge)', () => {
    it('emits the completed task report BEFORE firing the turn boundary', async () => {
      const be = makeBackend({ injectStatusLines: false });
      const order: string[] = [];
      be.onData((d) => { if (d.includes('REPORT-A')) order.push('report'); });
      be.onTaskDone(() => order.push('boundary'));
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        if (u.includes('/api/task-detail')) {
          await new Promise((r) => setTimeout(r, 10)); // 模拟 detail 延迟
          return Response.json({ success: true, data: { task: { resultOutput: { displayReport: { content: 'REPORT-A' } } } } });
        }
        return pendingSseResponse();
      });
      (be as any).currentTaskId = 'task-A';
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-A');
      await new Promise((r) => setTimeout(r, 30));
      expect(order).toEqual(['report', 'boundary']);
    });
  });

  describe('prompt single @-rule (finding K/2)', () => {
    it('payload prompt forbids mention-back and keeps mandatory routing under a custom systemPrompt', async () => {
      const be = makeBackend({ injectStatusLines: false, systemPrompt: '你是 QA 专家，回答尽量简短。' });
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      const exec = calls.find(c => c.url.includes('/api/task-execute'))!;
      const prompt = String(JSON.parse(String(exec.init?.body)).config.userPrompt);
      expect(prompt).toContain('NEVER use `--mention-back`');       // 禁用规则在
      expect(prompt).not.toMatch(/--mention-back（|→ ?--mention-back/); // 无推荐语
      expect(prompt).toContain('COMPLETION CONTRACT');               // mandatory 未被替换
      expect(prompt).toContain('你是 QA 专家');                      // 自定义作为追加
      expect(prompt.indexOf('COMPLETION CONTRACT')).toBeLessThan(prompt.indexOf('你是 QA 专家'));
    });
  });

  describe('status line redaction (finding S)', () => {
    it('sandbox status line shows host only, never the full capability URL', async () => {
      const be = makeBackend();
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      (be as any).currentTaskId = 'task-9';
      (be as any).handleSseEvent('event:init\ndata:{"directAccessUrl":"https://port-8080-v1-SECRETSANDBOXID.cn-north.ai-sandbox-boe.byted.org/?folder=x"}', 'task-9');
      const out = lines.join('');
      expect(out).toContain('Sandbox 已就绪');
      // 可写能力编码在唯一子域——hostname 的任何部分都不得出现在群可见输出里
      expect(out).not.toContain('SECRETSANDBOXID');
      expect(out).not.toContain('port-8080');
      expect(out).not.toContain('byted.org');
    });
  });

  describe('access URL handling', () => {
    it('rewrites accessUrl origin onto the configured baseUrl', async () => {
      const be = makeBackend();
      const urls: string[] = [];
      be.onAccessUrl((u) => urls.push(u));
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      resolvers.shift()!(taskResponse('task-1', {
        accessUrl: 'https://riff.bytedance.net/sandbox-access?sessionId=abc&folder=%2Fx',
      }));
      await flush();
      expect(urls).toContain(`${BASE}/sandbox-access?sessionId=abc&folder=%2Fx`);
    });

    it('prefers directAccessUrl and never downgrades back to a frontend URL', async () => {
      const be = makeBackend();
      const urls: string[] = [];
      be.onAccessUrl((u) => urls.push(u));
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      resolvers.shift()!(taskResponse('task-1', {
        accessUrl: 'https://riff.bytedance.net/sandbox-access?sessionId=abc',
        directAccessUrl: 'https://port-8080-v1-abc.cn-north.ai-sandbox-boe.byted.org/?folder=%2Fx',
      }));
      await flush();
      expect(urls[urls.length - 1]).toBe('https://port-8080-v1-abc.cn-north.ai-sandbox-boe.byted.org/?folder=%2Fx');

      // A later frontend-only URL must not replace the direct terminal URL.
      (be as any).updateAccessUrl({ accessUrl: 'https://riff.bytedance.net/sandbox-access?sessionId=late' });
      expect(urls[urls.length - 1]).toBe('https://port-8080-v1-abc.cn-north.ai-sandbox-boe.byted.org/?folder=%2Fx');
    });

    it('upgrades to directAccessUrl from a task-detail fetch after an SSE accessUrl', async () => {
      const be = makeBackend();
      const urls: string[] = [];
      be.onAccessUrl((u) => urls.push(u));
      (be as any).currentTaskId = 'task-9';
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        if (u.includes('/api/task-detail')) {
          return Response.json({ success: true, data: { task: {
            accessUrl: 'https://riff.bytedance.net/sandbox-access?sessionId=z',
            directAccessUrl: 'https://port-8080-z.cn-north.ai-sandbox-boe.byted.org/',
          } } });
        }
        return pendingSseResponse();
      });
      // Simulate the SSE init event carrying only the frontend accessUrl.
      (be as any).handleSseEvent('event:init\ndata:{"accessUrl":"https://riff.bytedance.net/sandbox-access?sessionId=z"}', 'task-9');
      expect(urls[urls.length - 1]).toBe(`${BASE}/sandbox-access?sessionId=z`);
      await flush();
      expect(urls[urls.length - 1]).toBe('https://port-8080-z.cn-north.ai-sandbox-boe.byted.org/');
    });
  });
});
