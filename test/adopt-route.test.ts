/**
 * adopt-route.test.ts
 *
 * 测试 getAncestorPids 和 resolveAdoptRoute 的纯逻辑。
 * 全部依赖注入，不访问真实 /proc / ps / 网络。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getAncestorPids,
  queryCliSession,
  resolveAdoptRoute,
  resolveCliSessionRoute,
  type AdoptRoute,
  type CliSessionLookup,
} from '../src/adapters/adopt-route.js';

// queryCliSession 走 fetchDaemonIpc（真实 HTTP），mock 掉以便纯逻辑测试。
const { fetchDaemonIpcMock } = vi.hoisted(() => ({
  fetchDaemonIpcMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock('../src/core/daemon-ipc-auth.js', () => ({
  fetchDaemonIpc: (...args: unknown[]) => fetchDaemonIpcMock(...args),
}));

// ── getAncestorPids ────────────────────────────────────────────────────────────

describe('getAncestorPids', () => {
  it('返回祖先链（不含 startPid 自己）', () => {
    // 进程树：child(100) → p1(200) → p2(300) → p3(400)
    const parentMap: Record<number, number> = {
      100: 200,
      200: 300,
      300: 400,
    };
    const readParent = (pid: number): number | null => parentMap[pid] ?? null;
    const result = getAncestorPids(100, readParent);
    expect(result).toEqual([200, 300, 400]);
  });

  it('遇到 pid<=1 时停止', () => {
    const parentMap: Record<number, number> = {
      100: 50,
      50: 1,   // 到 init
    };
    const readParent = (pid: number): number | null => parentMap[pid] ?? null;
    const result = getAncestorPids(100, readParent);
    // pid=1 不加入结果，在 50 处已停
    expect(result).toEqual([50]);
  });

  it('readParent 返回 null 时停止', () => {
    const parentMap: Record<number, number> = {
      100: 200,
    };
    const readParent = (pid: number): number | null => parentMap[pid] ?? null;
    const result = getAncestorPids(100, readParent);
    expect(result).toEqual([200]);
  });

  it('防环：检测到循环时停止，结果有限', () => {
    // 人为制造循环：100→200→300→100（不可能在真实进程树中，但代码要防范）
    const parentMap: Record<number, number> = {
      100: 200,
      200: 300,
      300: 100,  // 指回 startPid
    };
    const readParent = (pid: number): number | null => parentMap[pid] ?? null;
    const result = getAncestorPids(100, readParent);
    // 在遇到 100（startPid，已在 visited 里）时停止
    expect(result).toEqual([200, 300]);
    expect(result.length).toBeLessThan(10);
  });

  it('maxDepth 限制深度', () => {
    // 构造深链：100→101→102→...→200（101 级）
    const readParent = (pid: number): number | null => (pid < 200 ? pid + 1 : null);
    const result = getAncestorPids(100, readParent, 5);
    expect(result).toHaveLength(5);
    expect(result[0]).toBe(101);
    expect(result[4]).toBe(105);
  });

  it('startPid 无父（readParent 立刻返回 null）→ 空数组', () => {
    const result = getAncestorPids(1, () => null);
    expect(result).toEqual([]);
  });
});

// ── resolveAdoptRoute ──────────────────────────────────────────────────────────

const MOCK_ROUTE: AdoptRoute = {
  sessionId: 's-adopt',
  chatId: 'oc_chat1',
  larkAppId: 'cli_apptest',
  rootMessageId: 'om_root1',
};

describe('resolveAdoptRoute', () => {
  it('遍历 daemon × 祖先，首个命中即返回', async () => {
    // 祖先：[100, 200]；两个 daemon
    const getAncestors = () => [100, 200];
    const listDaemons = () => [{ ipcPort: 1 }, { ipcPort: 2 }];

    // 只有 (port=2, pid=200) 命中
    const queryDaemon = async (port: number, pid: number): Promise<AdoptRoute | null> => {
      if (port === 2 && pid === 200) return MOCK_ROUTE;
      return null;
    };

    const result = await resolveAdoptRoute({
      startPid: 999,
      listDaemons,
      queryDaemon,
      getAncestors,
    });
    expect(result).toEqual(MOCK_ROUTE);
  });

  it('并发查询，多命中时按候选 index 取最小（确定性）', async () => {
    // 候选编号：daemon 列表序 × 祖先链序 →
    //   #0 (port1,100) #1 (port1,200) #2 (port2,100) #3 (port2,200)
    const getAncestors = () => [100, 200];
    const listDaemons = () => [{ ipcPort: 1 }, { ipcPort: 2 }];

    // 让 #1(port1,200) 和 #3(port2,200) 都命中，但 #1 故意慢、#3 快返回；
    // 并发下 #3 先 settle，但结果必须取 index 更小的 #1（确定性）。
    const route1: AdoptRoute = { ...MOCK_ROUTE, sessionId: 's-idx1' };
    const route3: AdoptRoute = { ...MOCK_ROUTE, sessionId: 's-idx3' };
    const queryDaemon = async (port: number, pid: number): Promise<AdoptRoute | null> => {
      if (port === 1 && pid === 200) { await new Promise((r) => setTimeout(r, 20)); return route1; }
      if (port === 2 && pid === 200) return route3;
      return null;
    };

    const result = await resolveAdoptRoute({ startPid: 999, listDaemons, queryDaemon, getAncestors, budgetMs: 1000 });
    expect(result?.sessionId).toBe('s-idx1');
  });

  it('全局 budget：所有 query 都挂起 → budget 内返回 null（不被无响应 daemon 卡住）', async () => {
    const getAncestors = () => [100, 200, 300];
    const listDaemons = () => [{ ipcPort: 1 }, { ipcPort: 2 }];
    // 永不 resolve，模拟 still-online 但 IPC 不响应的 daemon
    const queryDaemon = (): Promise<AdoptRoute | null> => new Promise<AdoptRoute | null>(() => {});

    const t0 = Date.now();
    const result = await resolveAdoptRoute({ startPid: 999, listDaemons, queryDaemon, getAncestors, budgetMs: 60 });
    const elapsed = Date.now() - t0;
    expect(result).toBeNull();
    // 应在 budget 量级返回（给足余量），绝不线性叠加到 祖先×daemon×2s
    expect(elapsed).toBeLessThan(1000);
  });

  it('全部 daemon × 祖先都未命中 → 返回 null', async () => {
    const getAncestors = () => [100, 200];
    const listDaemons = () => [{ ipcPort: 1 }, { ipcPort: 2 }];
    const queryDaemon = async (): Promise<AdoptRoute | null> => null;

    const result = await resolveAdoptRoute({
      startPid: 999,
      listDaemons,
      queryDaemon,
      getAncestors,
    });
    expect(result).toBeNull();
  });

  it('无祖先（getAncestors 返回空数组）→ 返回 null', async () => {
    const getAncestors = () => [];
    const listDaemons = () => [{ ipcPort: 1 }];
    const queryDaemon = async (): Promise<AdoptRoute | null> => MOCK_ROUTE;

    const result = await resolveAdoptRoute({
      startPid: 999,
      listDaemons,
      queryDaemon,
      getAncestors,
    });
    expect(result).toBeNull();
  });

  describe('queryCliSession（单 daemon 反查，409 conflict 区分歧义）', () => {
    const ROUTE_BODY = {
      sessionId: 's_1',
      chatId: 'c_1',
      larkAppId: 'a_1',
      rootMessageId: 'om_1',
    };
    const route = { sessionId: 's_1', chatId: 'c_1', larkAppId: 'a_1', rootMessageId: 'om_1' };

    beforeEach(() => {
      fetchDaemonIpcMock.mockReset();
    });

    it('200 恰好一个命中 → hit', async () => {
      fetchDaemonIpcMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ROUTE_BODY,
      });
      const result = await queryCliSession(1234, 'ses_abc');
      expect(result).toEqual({ kind: 'hit', route });
    });

    it('409 conflict（本 daemon 内重复绑定）→ conflict', async () => {
      fetchDaemonIpcMock.mockResolvedValue({ ok: false, status: 409 });
      const result = await queryCliSession(1234, 'ses_abc');
      expect(result).toEqual({ kind: 'conflict' });
    });

    it('404 明确无匹配 → miss', async () => {
      fetchDaemonIpcMock.mockResolvedValue({ ok: false, status: 404 });
      const result = await queryCliSession(1234, 'ses_abc');
      expect(result).toEqual({ kind: 'miss' });
    });

    it('非 2xx 其它状态（401/403/5xx）→ unknown（不是否定答案，必须 fail closed）', async () => {
      fetchDaemonIpcMock.mockResolvedValue({ ok: false, status: 500 });
      const result = await queryCliSession(1234, 'ses_abc');
      expect(result).toEqual({ kind: 'unknown' });
    });

    it('网络异常（连接拒绝/超时）→ unknown（结果未知，上层 fail closed）', async () => {
      fetchDaemonIpcMock.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await queryCliSession(1234, 'ses_abc');
      expect(result).toEqual({ kind: 'unknown' });
    });

    it('200 但 body 形状不完整/为空 → unknown（畸形响应，不能当作否定答案）', async () => {
      fetchDaemonIpcMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ sessionId: 'x' }) });
      expect(await queryCliSession(1234, 'ses_abc')).toEqual({ kind: 'unknown' });
      fetchDaemonIpcMock.mockResolvedValue({ ok: true, status: 200, json: async () => null });
      expect(await queryCliSession(1234, 'ses_abc')).toEqual({ kind: 'unknown' });
    });
  });

  describe('resolveCliSessionRoute（托管 service 显式反查，恰好一个完整命中才返回）', () => {
    const hit = (route: AdoptRoute = MOCK_ROUTE): CliSessionLookup => ({ kind: 'hit', route });
    const miss = (): CliSessionLookup => ({ kind: 'miss' });

    it('单个 daemon 恰好一个命中 → 返回反查结果', async () => {
      const result = await resolveCliSessionRoute({
        cliSessionId: 'ses_abc',
        listDaemons: () => [{ ipcPort: 1 }],
        queryDaemon: async (port, id) => {
          expect(port).toBe(1);
          expect(id).toBe('ses_abc');
          return hit();
        },
      });
      expect(result).toEqual(MOCK_ROUTE);
    });

    it('并发查询全部 daemon，恰一命中即返回', async () => {
      const result = await resolveCliSessionRoute({
        cliSessionId: 'ses_abc',
        listDaemons: () => [{ ipcPort: 1 }, { ipcPort: 2 }],
        queryDaemon: async (port) => (port === 2 ? hit() : miss()),
      });
      expect(result).toEqual(MOCK_ROUTE);
    });

    it('全部未命中 → null', async () => {
      const result = await resolveCliSessionRoute({
        cliSessionId: 'ses_abc',
        listDaemons: () => [{ ipcPort: 1 }, { ipcPort: 2 }],
        queryDaemon: async () => miss(),
      });
      expect(result).toBeNull();
    });

    it('query 挂起 → budget 封顶返回 null（不被无响应 daemon 卡住，且无法证明唯一）', async () => {
      const t0 = Date.now();
      const result = await resolveCliSessionRoute({
        cliSessionId: 'ses_abc',
        listDaemons: () => [{ ipcPort: 1 }],
        queryDaemon: () => new Promise<CliSessionLookup>(() => {}),
        budgetMs: 60,
      });
      expect(result).toBeNull();
      expect(Date.now() - t0).toBeLessThan(1000);
    });

    it('双 daemon 双命中（并发导入同一外部会话的重复绑定）→ null（歧义 fail closed）', async () => {
      const result = await resolveCliSessionRoute({
        cliSessionId: 'ses_abc',
        listDaemons: () => [{ ipcPort: 1 }, { ipcPort: 2 }],
        queryDaemon: async (port) => hit(
          port === 1 ? MOCK_ROUTE : { ...MOCK_ROUTE, sessionId: 'sess_dup_2' },
        ),
      });
      expect(result).toBeNull();
    });

    it('一命中 + 另一候选挂起 → budget 到期返回 null（无法证明唯一）', async () => {
      const result = await resolveCliSessionRoute({
        cliSessionId: 'ses_abc',
        listDaemons: () => [{ ipcPort: 1 }, { ipcPort: 2 }],
        queryDaemon: async (port) => (
          port === 1 ? hit() : new Promise<CliSessionLookup>(() => {})
        ),
        budgetMs: 60,
      });
      expect(result).toBeNull();
    });

    it('任一 daemon 报 conflict → null（重复绑定歧义）', async () => {
      const result = await resolveCliSessionRoute({
        cliSessionId: 'ses_abc',
        listDaemons: () => [{ ipcPort: 1 }, { ipcPort: 2 }],
        queryDaemon: async (port) => (port === 1 ? { kind: 'conflict' } : miss()),
      });
      expect(result).toBeNull();
    });

    it('任一候选 unknown（查询失败/超时）→ null（结果未知，fail closed）', async () => {
      const result = await resolveCliSessionRoute({
        cliSessionId: 'ses_abc',
        listDaemons: () => [{ ipcPort: 1 }, { ipcPort: 2 }],
        queryDaemon: async (port) => (port === 1 ? { kind: 'unknown' } : miss()),
      });
      expect(result).toBeNull();
    });

    it('任一候选查询异常抛错 → null（结果未知，fail closed）', async () => {
      const result = await resolveCliSessionRoute({
        cliSessionId: 'ses_abc',
        listDaemons: () => [{ ipcPort: 1 }, { ipcPort: 2 }],
        queryDaemon: async (port) => (
          port === 1 ? hit() : Promise.reject(new Error('ipc down'))
        ),
      });
      expect(result).toBeNull();
    });

    it('无在线 daemon → null', async () => {
      const result = await resolveCliSessionRoute({
        cliSessionId: 'ses_abc',
        listDaemons: () => [] as Array<{ ipcPort: number }>,
        queryDaemon: async () => hit(),
      });
      expect(result).toBeNull();
    });
  });

  it('无在线 daemon（listDaemons 返回空数组）→ 返回 null', async () => {
    const getAncestors = () => [100, 200];
    const listDaemons = () => [] as Array<{ ipcPort: number }>;
    const queryDaemon = async (): Promise<AdoptRoute | null> => MOCK_ROUTE;

    const result = await resolveAdoptRoute({
      startPid: 999,
      listDaemons,
      queryDaemon,
      getAncestors,
    });
    expect(result).toBeNull();
  });
});
