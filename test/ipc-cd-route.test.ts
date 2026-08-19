// test/ipc-cd-route.test.ts
//
// POST /api/sessions/:sessionId/cd 路由级分支矩阵（Task 9）。
//
// 手法沿用 test/dashboard-ipc.test.ts：起真实 IPC server（port 0）+ fetch，
// 依赖经 vi.spyOn(模块命名空间) 打桩（vitest 的 vite 转换让被测模块的具名
// import 走命名空间访问，spy 即时生效）。
//
// 角色库根依赖：路由内 validateRoleLibraryPath 无 rootOverride 注入点，
// 采用「临时 HOME」最小方案——role-library 的 roleLibraryRoot() 在每次校验时
// 调用 os.homedir()（POSIX 下优先读 $HOME），故 beforeAll 把 HOME 指到临时
// 目录并在其中建 botmux-roles/role-a，即可用真实校验逻辑（realpath 归一 +
// dev/ino 包含判断）覆盖 403/400 分支，而不 mock role-library 本身。
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIpcAuthSecret, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as sessionCwd from '../src/core/session-cwd.js';

/** 会话当前轮换 capability（daemon 侧 ds.managedTurnOrigin 与请求 body 双方持有）。 */
const CAP = 'deadbeef'.repeat(8);
const HOST_SECRET = 'test-ipc-cd-host-secret';

let handle: IpcServerHandle | null = null;
let prevHome: string | undefined;
let fakeHome: string;
let roleDir: string;      // <fakeHome>/botmux-roles/role-a（角色库内合法目录）
let roleDirReal: string;  // 其 realpath —— validateRoleLibraryPath 的归一化产物

beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'ipc-cd-home-'));
  roleDir = join(fakeHome, 'botmux-roles', 'role-a');
  mkdirSync(roleDir, { recursive: true });
  roleDirReal = realpathSync(roleDir);
  prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
});

/** auth 三态：capability（默认，沙箱/读隔离 CLI 姿势）/ signed（trusted-host
 *  HMAC，需 authRequired 服务器）/ none（未证明身份的裸调用）。 */
async function postCd(sessionId: string, dir?: string, opts: {
  auth?: 'capability' | 'signed' | 'none';
  authRequired?: boolean;
} = {}): Promise<Response> {
  if (!handle) {
    if (opts.authRequired) setIpcAuthSecret(HOST_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', ...(opts.authRequired ? { authRequired: true } : {}) });
  }
  const auth = opts.auth ?? 'capability';
  const path = `/api/sessions/${sessionId}/cd`;
  const bodyObj: Record<string, unknown> = dir === undefined ? {} : { dir };
  if (auth === 'capability') bodyObj.originCapability = CAP;
  const headers: HeadersInit = auth === 'signed'
    ? daemonIpcAuthHeaders({ secret: HOST_SECRET, port: handle.port, method: 'POST', path, headers: { 'content-type': 'application/json' } })
    : { 'content-type': 'application/json' };
  return fetch(`http://127.0.0.1:${handle.port}${path}`, { method: 'POST', headers, body: JSON.stringify(bodyObj) });
}

describe('POST /api/sessions/:sessionId/cd', () => {
  it('404s for sessions that are not active — trusted-host caller (signed, authRequired on)', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(undefined);
    const repinSpy = vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    const res = await postCd('missing', roleDir, { auth: 'signed', authRequired: true });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: 'session_not_active' });
    expect(repinSpy).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('409s adopt sessions (adoptedFrom set) — injecting or killing would hit the user pane', async () => {
    const send = vi.fn();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-adopt', cliId: 'claude-code' },
      managedTurnOrigin: { capability: CAP },
      worker: { send, killed: false },
      adoptedFrom: { source: 'tmux', tmuxTarget: '0:1.0', cwd: '/x' },
    } as any);
    const repinSpy = vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    const res = await postCd('s-adopt', roleDir);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'adopt_cd_unsupported' });
    expect(send).not.toHaveBeenCalled();
    expect(repinSpy).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('409s adopt sessions (initConfig.adoptMode, adoptedFrom absent)', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-adopt-init', cliId: 'claude-code' },
      managedTurnOrigin: { capability: CAP },
      worker: { send: vi.fn(), killed: false },
      adoptedFrom: undefined,
      initConfig: { adoptMode: true },
    } as any);

    const res = await postCd('s-adopt-init', roleDir);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'adopt_cd_unsupported' });
  });

  it('409s MOJO sessions before repin/kill — remote retirement cannot follow a repin (P1-a)', async () => {
    // killWorker refuses unprepared live retirement for every remote backend
    // (P0-2). The riff-only guard let mojo through: repin ran, killWorker
    // no-opped, and the route reported cold-restart while the live worker kept
    // running on the OLD cwd. The guard must fire before any mutation.
    const send = vi.fn();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      larkAppId: 'app-mojo',
      session: { sessionId: 's-mojo-cd', cliId: 'mojo', backendType: 'mojo' },
      managedTurnOrigin: { capability: CAP },
      worker: { send, killed: false },
      initConfig: { backendType: 'mojo' },
    } as any);
    const repinSpy = vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    const res = await postCd('s-mojo-cd', roleDir);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'remote_cd_unsupported' });
    expect(send).not.toHaveBeenCalled();
    expect(repinSpy).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('409s RIFF sessions with the same remote guard (unchanged contract)', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      larkAppId: 'app-riff',
      session: { sessionId: 's-riff-cd', cliId: 'riff', backendType: 'riff' },
      managedTurnOrigin: { capability: CAP },
      worker: { send: vi.fn(), killed: false },
      initConfig: { backendType: 'riff' },
    } as any);
    const repinSpy = vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});

    const res = await postCd('s-riff-cd', roleDir);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'remote_cd_unsupported' });
    expect(repinSpy).not.toHaveBeenCalled();
  });

  it('403s an existing dir outside the role library root — repin/kill never happen', async () => {
    const send = vi.fn();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-outside', cliId: 'claude-code' },
      managedTurnOrigin: { capability: CAP },
      worker: { send, killed: false },
      adoptedFrom: undefined,
    } as any);
    const repinSpy = vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    // fakeHome 真实存在但位于 botmux-roles 之外 → outside_role_library
    const res = await postCd('s-outside', fakeHome);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: 'outside_role_library' });
    expect(repinSpy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('400s a nonexistent dir (dir_not_found)', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-noent', cliId: 'claude-code' },
      managedTurnOrigin: { capability: CAP },
      worker: { send: vi.fn(), killed: false },
      adoptedFrom: undefined,
    } as any);
    const repinSpy = vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});

    const res = await postCd('s-noent', join(fakeHome, 'botmux-roles', 'nope'));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'dir_not_found' });
    expect(repinSpy).not.toHaveBeenCalled();
  });

  it('400s a missing/empty dir field (empty_path)', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-empty', cliId: 'claude-code' },
      managedTurnOrigin: { capability: CAP },
      worker: { send: vi.fn(), killed: false },
      adoptedFrom: undefined,
    } as any);

    const res = await postCd('s-empty');

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'empty_path' });
  });

  it('403s origin_unproven with ZERO side effects: no capability / wrong capability never reach repin/inject/kill', async () => {
    const send = vi.fn();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-unproven', cliId: 'claude-code' },
      managedTurnOrigin: { capability: 'f00d'.repeat(16) },  // live ≠ CAP
      worker: { send, killed: false },
      adoptedFrom: undefined,
    } as any);
    const repinSpy = vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    // 无 capability
    const resNone = await postCd('s-unproven', roleDir, { auth: 'none' });
    expect(resNone.status).toBe(403);
    expect(await resNone.json()).toMatchObject({ ok: false, error: 'origin_unproven' });

    // 错 capability（body 里带的 CAP 与 live 不符）
    const resWrong = await postCd('s-unproven', roleDir);
    expect(resWrong.status).toBe(403);
    expect(await resWrong.json()).toMatchObject({ ok: false, error: 'origin_unproven' });

    // cd 是有副作用的路由：鉴权失败必须发生在 repin（落盘）与 kill/inject 之前。
    expect(repinSpy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('200 mode:respawn-resume — live worker: repin FIRST, then send restart carrying updateWorkingDir', async () => {
    const send = vi.fn();
    const ds = {
      session: { sessionId: 's-respawn', cliId: 'claude-code' },
      managedTurnOrigin: { capability: CAP },
      worker: { send, killed: false },
      adoptedFrom: undefined,
      initConfig: { workingDir: '/old/stale/dir' },
    } as any;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const repinSpy = vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    const res = await postCd('s-respawn', roleDir);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: 'respawn-resume', dir: roleDirReal });
    // TOCTOU 契约：restart 携带的 updateWorkingDir 原样使用校验产出 resolvedPath
    // （realpath 归一），而非请求原始输入。worker 侧据此收敛 lastInitConfig 后
    // respawn（--resume 续上下文 + 新 cwd 开场注入新角色 CLAUDE.md/记忆索引）。
    expect(send).toHaveBeenCalledWith({ type: 'restart', updateWorkingDir: roleDirReal });
    expect(repinSpy).toHaveBeenCalledWith(ds, roleDirReal);
    // 落盘重钉必须先于 restart（记录 = 唯一事实源；respawn 只是让活进程跟上）。
    expect(repinSpy.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(killSpy).not.toHaveBeenCalled();
    // daemon 侧 ds.initConfig 同步更新，与 worker 侧收敛到同一新目录，避免下次
    // forkWorker 用陈旧 initConfig 重建 init 消息。
    expect(ds.initConfig.workingDir).toBe(roleDirReal);
  });

  it('200 mode:cold-restart — worker.send() throws: record already repinned, kill it so next message cold-starts in the new dir', async () => {
    const send = vi.fn(() => { throw new Error('EPIPE: worker channel closed'); });
    const ds = {
      session: { sessionId: 's-send-throws', cliId: 'claude-code' },
      managedTurnOrigin: { capability: CAP },
      worker: { send, killed: false },
      adoptedFrom: undefined,
      initConfig: { workingDir: '/old/stale/dir' },
    } as any;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const repinSpy = vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    const res = await postCd('s-send-throws', roleDir);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: 'cold-restart', dir: roleDirReal });
    expect(send).toHaveBeenCalledTimes(1);
    // 绝不能留下「记录新、进程仍在旧目录」的分裂状态：send 抛错必须触发 killWorker。
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(ds);
    expect(repinSpy).toHaveBeenCalledWith(ds, roleDirReal);
  });

  it('200 mode:cold-restart — NO live worker: killWorker is STILL called (unconditional, no ds.worker guard)', async () => {
    // 锁定行为：worker 为 null 时也必须调用 killWorker——其内部的
    // destroyOrphanedBackingSession 是清掉 lazy-restore/crash-stopped 场景下
    // 仍绑着旧 cwd 的残留 tmux/herdr/zellij backing session 的唯一路径。
    // 若有人把 `if (ds.worker && !ds.worker.killed)` 守卫加回去，此断言失败。
    const ds = {
      session: { sessionId: 's-cold-noworker', cliId: 'claude-code' },
      managedTurnOrigin: { capability: CAP },
      worker: null,
      adoptedFrom: undefined,
    } as any;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const repinSpy = vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    const res = await postCd('s-cold-noworker', roleDir);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: 'cold-restart', dir: roleDirReal });
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(ds);
    expect(repinSpy).toHaveBeenCalledWith(ds, roleDirReal);
  });

  it('200 mode:respawn-resume — respawn 对 CLI 一视同仁（codex 等非 claude 家族同样走 restart）', async () => {
    // 旧实现按 supportsSessionCwdMove 能力位分流（claude 注入 /cd、codex 杀进程
    // 冷启动）。respawn 方案与 /restart 同机制、适配器无关，能力位不再进场。
    const send = vi.fn();
    const ds = {
      session: { sessionId: 's-respawn-codex', cliId: 'codex' },
      managedTurnOrigin: { capability: CAP },
      worker: { send, killed: false },
      adoptedFrom: undefined,
    } as any;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const repinSpy = vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    const res = await postCd('s-respawn-codex', roleDir);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: 'respawn-resume', dir: roleDirReal });
    expect(send).toHaveBeenCalledWith({ type: 'restart', updateWorkingDir: roleDirReal });
    expect(killSpy).not.toHaveBeenCalled();
    expect(repinSpy).toHaveBeenCalledWith(ds, roleDirReal);
  });

  it('200 mode:respawn-resume — unknown cliId 不再查适配器，同样 respawn（no crash）', async () => {
    const send = vi.fn();
    const ds = {
      session: { sessionId: 's-respawn-unknown', cliId: 'no-such-cli' },
      managedTurnOrigin: { capability: CAP },
      worker: { send, killed: false },
      adoptedFrom: undefined,
    } as any;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    const res = await postCd('s-respawn-unknown', roleDir);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: 'respawn-resume', dir: roleDirReal });
    expect(send).toHaveBeenCalledWith({ type: 'restart', updateWorkingDir: roleDirReal });
    expect(killSpy).not.toHaveBeenCalled();
  });
  // ── per-bot 收窄（ds.larkAppId → validateRoleLibraryPath 的 ownAppId）──
  // 上面所有用例的 ds 都不带 larkAppId，走的是「不收窄」旧语义（内部/测试调用方）；
  // 下面覆盖 appId 命名下的收窄行为，以及非 appId 布局的 fail-closed。
  it('403s a switch into ANOTHER bot\u2019s role subtree once the per-bot dir is named by appId', async () => {
    const rolesRoot = join(fakeHome, 'botmux-roles');
    const ownRole = join(rolesRoot, 'cli_self', 'shared', 'default');
    const otherRole = join(rolesRoot, 'cli_other', 'shared', 'default');
    mkdirSync(ownRole, { recursive: true });
    mkdirSync(otherRole, { recursive: true });
    const send = vi.fn();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-crossbot', cliId: 'claude-code' },
      managedTurnOrigin: { capability: CAP },
      worker: { send, killed: false },
      adoptedFrom: undefined,
      larkAppId: 'cli_self',
    } as any);
    const repinSpy = vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    const res = await postCd('s-crossbot', otherRole);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: 'outside_own_role_library' });
    expect(send).not.toHaveBeenCalled();
    expect(repinSpy).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('409s FAIL-CLOSED when the per-bot dir is NOT named by appId (legacy human-slug layout) \u2014 no fallback, zero side effects', async () => {
    // \u5b58\u91cf\u90e8\u7f72\u8fd9\u4e00\u5c42\u7528\u4eba\u7c7b slug\uff08<root>/<\u672c bot appId> \u4e0d\u5b58\u5728\uff09\u3002\u66fe\u7ecf\u56de\u843d\u5168\u5c40\u6839 =
    // fail-open\uff08\u53ef\u7ee7\u7eed\u8de8 bot \u5207 + \u7ecf workingDir \u62ff rw\uff09\uff1b\u73b0\u5728\u5fc5\u987b fail-closed\uff0c
    // \u4e14 repin/kill/inject \u4e00\u4e2a\u90fd\u4e0d\u80fd\u53d1\u751f\uff08\u5426\u5219\u4f1a\u8bdd\u4ecd\u88ab\u9489\u8fdb\u76ee\u6807\u76ee\u5f55\uff09\u3002
    // \u7528\u4e00\u4e2a\u524d\u9762\u7528\u4f8b\u6ca1\u5efa\u8fc7 appId \u76ee\u5f55\u7684 bot\uff08cli_legacy\uff09\uff0c\u786e\u4fdd <root>/cli_legacy \u4e0d\u5b58\u5728\u3002
    const rolesRoot = join(fakeHome, 'botmux-roles');
    const humanSelf = join(rolesRoot, 'human-legacy', 'shared', 'default');
    const otherRole = join(rolesRoot, 'cli_other', 'shared', 'default'); // \u53e6\u4e00\u4e2a bot\uff08\u672c bot \u60f3\u5207\u8fdb\u53bb\uff09
    mkdirSync(humanSelf, { recursive: true });
    mkdirSync(otherRole, { recursive: true });
    const send = vi.fn();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-legacy-noop', cliId: 'claude-code' },
      managedTurnOrigin: { capability: CAP },
      worker: { send, killed: false },
      adoptedFrom: undefined,
      larkAppId: 'cli_legacy',   // <root>/cli_legacy \u4e0d\u662f\u771f\u76ee\u5f55 \u2192 own_role_library_missing
    } as any);
    const repinSpy = vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    // \u8fde\u5207\u81ea\u5df1 human-slug \u76ee\u5f55\u90fd\u88ab\u62d2\uff08\u8fc1\u79fb\u524d\u529f\u80fd\u4e0d\u53ef\u7528\u662f fail-closed \u7684\u5df2\u77e5\u4ee3\u4ef7\uff09\u3002
    const resOwn = await postCd('s-legacy-noop', humanSelf);
    expect(resOwn.status).toBe(409);
    expect(await resOwn.json()).toMatchObject({ ok: false, error: 'own_role_library_missing' });
    // \u66f4\u91cd\u8981\uff1a\u4e0d\u80fd\u9760\u56de\u843d\u5168\u5c40\u6839\u5207\u8fdb\u522b\u7684 bot \u7684\u76ee\u5f55\u3002
    const resCross = await postCd('s-legacy-noop', otherRole);
    expect(resCross.status).toBe(409);
    expect(await resCross.json()).toMatchObject({ ok: false, error: 'own_role_library_missing' });

    expect(send).not.toHaveBeenCalled();
    expect(repinSpy).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('200s a switch inside the bot\u2019s OWN appId subtree', async () => {
    const rolesRoot = join(fakeHome, 'botmux-roles');
    const ownRole = join(rolesRoot, 'cli_self', 'shared', 'pm');
    mkdirSync(ownRole, { recursive: true });
    const ownRoleReal = realpathSync(ownRole);
    const send = vi.fn();
    const ds = {
      session: { sessionId: 's-ownbot', cliId: 'claude-code' },
      managedTurnOrigin: { capability: CAP },
      worker: { send, killed: false },
      adoptedFrom: undefined,
      larkAppId: 'cli_self',
    } as any;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const repinSpy = vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});
    vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    const res = await postCd('s-ownbot', ownRole);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: 'respawn-resume', dir: ownRoleReal });
    expect(repinSpy).toHaveBeenCalledWith(ds, ownRoleReal);
  });
  it('initConfig.workingDir 与 repin 同步 —— 连 no-worker 分支也同步（否则冷启动带回旧 cwd）', async () => {
    const rolesRoot = join(fakeHome, 'botmux-roles');
    const ownRole = join(rolesRoot, 'cli_self', 'shared', 'sync');
    mkdirSync(ownRole, { recursive: true });
    const ownRoleReal = realpathSync(ownRole);
    const initConfig = { workingDir: '/old/cwd' } as any;
    const ds = {
      session: { sessionId: 's-nosync', cliId: 'claude-code' },
      managedTurnOrigin: { capability: CAP },
      worker: undefined,               // no-worker 分支
      adoptedFrom: undefined,
      larkAppId: 'cli_self',
      initConfig,
    } as any;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});
    vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    const res = await postCd('s-nosync', ownRole);

    expect(res.status).toBe(200);
    expect(initConfig.workingDir).toBe(ownRoleReal);
  });
});
