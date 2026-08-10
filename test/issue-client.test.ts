import { describe, it, expect, vi } from 'vitest';
import {
  bindIssue,
  claimIssue,
  fetchIssues,
  fetchTeams,
  isRetriable,
  isPermanentFailure,
  writeIssueStatus,
  type IssueClientOptions,
} from '../src/platform/issue-client.js';

const BINDING = {
  platformUrl: 'https://platform.example',
  machineToken: 'mt-secret',
  machineId: 'm-1',
};

/** 记录请求并按脚本返回响应的假 HTTP 层。 */
function fakeHttp(responses: Array<{ status: number; json: unknown } | Error>) {
  const calls: Array<{ method: string; url: string; body?: unknown; headers?: Record<string, string> }> = [];
  let i = 0;
  const next = () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(r);
  };
  return {
    calls,
    http: {
      get: ((url: string, opts: any) => {
        calls.push({ method: 'GET', url, headers: opts?.headers });
        return next();
      }) as any,
      post: ((url: string, body: unknown, opts: any) => {
        calls.push({ method: 'POST', url, body, headers: opts?.headers });
        return next();
      }) as any,
    },
  };
}

function opts(responses: Array<{ status: number; json: unknown } | Error>): {
  o: IssueClientOptions;
  calls: ReturnType<typeof fakeHttp>['calls'];
} {
  const f = fakeHttp(responses);
  return { o: { binding: BINDING, http: f.http }, calls: f.calls };
}

describe('未绑定平台', () => {
  it('所有调用直接 unbound，不发任何请求', async () => {
    const f = fakeHttp([{ status: 200, json: {} }]);
    const r = await fetchTeams({ binding: null, http: f.http });
    expect(r).toEqual({ ok: false, reason: 'unbound' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('请求构造', () => {
  it('带 Bearer machineToken，URL 拼在 platformUrl 之后', async () => {
    const { o, calls } = opts([{ status: 200, json: { teams: [{ teamId: 't1', teamName: 'T' }] } }]);
    const r = await fetchTeams(o);
    expect(r).toEqual({ ok: true, value: [{ teamId: 't1', teamName: 'T' }] });
    expect(calls[0].url).toBe('https://platform.example/v1/machine/teams');
    expect(calls[0].headers?.authorization).toBe('Bearer mt-secret');
  });

  it('platformUrl 尾部斜杠不会拼出双斜杠', async () => {
    const f = fakeHttp([{ status: 200, json: { teams: [] } }]);
    await fetchTeams({ binding: { ...BINDING, platformUrl: 'https://platform.example/' }, http: f.http });
    expect(f.calls[0].url).toBe('https://platform.example/v1/machine/teams');
  });

  it('teamId 走 URL 编码', async () => {
    const { o, calls } = opts([{ status: 200, json: { sections: {} } }]);
    await fetchIssues('a b&c', o);
    expect(calls[0].url).toContain('teamId=a%20b%26c');
  });

  // machineId 由平台按 token 决定；这里传了反而可能撞 403 machine_mismatch。
  it('claim 请求体不带 machineId', async () => {
    const { o, calls } = opts([{ status: 200, json: { claim: {}, issue: {} } }]);
    await claimIssue('iss-1', { claimId: 'c1', expectedStateRev: 3 }, o);
    expect(calls[0].url).toBe('https://platform.example/v1/machine/issues/iss-1/claim');
    expect(calls[0].body).toEqual({ claimId: 'c1', expectedStateRev: 3 });
    expect(calls[0].body).not.toHaveProperty('machineId');
  });

  it('bind / status 打到各自子路径', async () => {
    const { o, calls } = opts([
      { status: 200, json: { issue: {} } },
      { status: 200, json: { issue: {} } },
    ]);
    await bindIssue('iss-1', { claimId: 'c1', localTaskRef: 'cli_a::s-1', expectedStateRev: 4 }, o);
    await writeIssueStatus(
      'iss-1',
      { claimId: 'c1', claimEpoch: 1, sourceSeq: 1, status: 'in_progress', expectedStateRev: 5 },
      o,
    );
    expect(calls[0].url).toBe('https://platform.example/v1/machine/issues/iss-1/bind');
    expect(calls[1].url).toBe('https://platform.example/v1/machine/issues/iss-1/status');
    expect((calls[1].body as any).sourceSeq).toBe(1);
  });
});

describe('错误分型', () => {
  // 分型决定 pump 的行为：网络/5xx 退避重投，401/403 停手，409 要先重新投影。
  it('网络异常 → network（可重试）', async () => {
    const { o } = opts([new Error('ECONNRESET')]);
    const r = await fetchTeams(o);
    expect(r).toMatchObject({ ok: false, reason: 'network' });
    expect(isRetriable(r as any)).toBe(true);
  });

  it('401/403 → forbidden（不可重试）', async () => {
    for (const status of [401, 403]) {
      const { o } = opts([{ status, json: { error: 'machine_revoked' } }]);
      const r = await fetchTeams(o);
      expect(r).toMatchObject({ ok: false, reason: 'forbidden', status, error: 'machine_revoked' });
      expect(isRetriable(r as any)).toBe(false);
    }
  });

  it('409 → conflict（要重新投影，不是盲重试）', async () => {
    const { o } = opts([{ status: 409, json: { error: 'state_rev_conflict' } }]);
    const r = await writeIssueStatus(
      'iss-1',
      { claimId: 'c1', claimEpoch: 1, sourceSeq: 1, status: 'done', expectedStateRev: 1 },
      o,
    );
    expect(r).toMatchObject({ ok: false, reason: 'conflict', error: 'state_rev_conflict' });
    expect(isRetriable(r as any)).toBe(false);
  });

  it('5xx → server（可重试）', async () => {
    const { o } = opts([{ status: 503, json: { error: 'store_unavailable' } }]);
    const r = await fetchIssues('t1', o);
    expect(r).toMatchObject({ ok: false, reason: 'server', status: 503 });
    expect(isRetriable(r as any)).toBe(true);
  });

  it('错误体没有 error 字段时回落到 http_<status>', async () => {
    const { o } = opts([{ status: 502, json: '<html>bad gateway</html>' }]);
    const r = await fetchTeams(o);
    expect(r).toMatchObject({ ok: false, reason: 'server', error: 'http_502' });
  });

  // 4xx 单列 client 类：既不是鉴权问题（别把排查方向带偏），也绝不能重试——
  // 混进可重试一类的话，pump 会对着一个永远不会成功的请求指数退避到天荒地老。
  it('404 → client（不当鉴权吞掉，也不可重试）', async () => {
    const { o } = opts([{ status: 404, json: { error: 'not_found' } }]);
    const r = await fetchTeams(o);
    expect(r).toMatchObject({ ok: false, reason: 'client', status: 404, error: 'not_found' });
    expect(isRetriable(r as any)).toBe(false);
  });

  it('400 → client（不可重试）', async () => {
    const { o } = opts([{ status: 400, json: { error: 'invalid' } }]);
    const r = await claimIssue('iss-1', { claimId: 'c1', expectedStateRev: 1 }, o);
    expect(r).toMatchObject({ ok: false, reason: 'client', status: 400 });
    expect(isRetriable(r as any)).toBe(false);
  });

  it('只有 network 与真正的 5xx 可重试', async () => {
    for (const status of [500, 502, 503]) {
      const { o } = opts([{ status, json: {} }]);
      expect(isRetriable((await fetchTeams(o)) as any)).toBe(true);
    }
  });
});

describe('响应解析', () => {
  it('teams 缺失/非数组时回落空数组，不抛', async () => {
    const { o } = opts([{ status: 200, json: { teams: 'nope' } }]);
    expect(await fetchTeams(o)).toEqual({ ok: true, value: [] });
  });

  it('sections 缺失时回落五个空段', async () => {
    const { o } = opts([{ status: 200, json: {} }]);
    const r = await fetchIssues('t1', o);
    expect(r).toMatchObject({ ok: true });
    expect((r as any).value.todo).toEqual([]);
    expect((r as any).value.needsAttention).toEqual([]);
  });

  it('200 正常时原样透传 issue', async () => {
    const issue = { _id: 'iss-1', status: 'claimed', stateRev: 2 };
    const { o } = opts([{ status: 200, json: { issue } }]);
    const r = await bindIssue('iss-1', { claimId: 'c1', localTaskRef: 'a::b', expectedStateRev: 1 }, o);
    expect((r as any).value.issue).toEqual(issue);
  });
});

// isPermanentFailure **不是** !isRetriable：两者的补集差着 conflict 与 unbound 两类，
// 混用会把完全正常的行判死（409 是竞争、unbound 是本机暂时没绑平台）。
describe('永久失败判定', () => {
  const f = (o: any) => o as any;
  it('只有 forbidden / client 算永久失败', () => {
    expect(isPermanentFailure(f({ ok: false, reason: 'forbidden', status: 403, error: 'x' }))).toBe(true);
    expect(isPermanentFailure(f({ ok: false, reason: 'client', status: 404, error: 'x' }))).toBe(true);
  });

  it('conflict / unbound / network / server 都不判死', () => {
    expect(isPermanentFailure(f({ ok: false, reason: 'conflict', status: 409, error: 'x' }))).toBe(false);
    expect(isPermanentFailure(f({ ok: false, reason: 'unbound' }))).toBe(false);
    expect(isPermanentFailure(f({ ok: false, reason: 'network', error: 'x' }))).toBe(false);
    expect(isPermanentFailure(f({ ok: false, reason: 'server', status: 503, error: 'x' }))).toBe(false);
  });

  // 这两个谓词各管各的一端，中间那段（409 / unbound）刻意两边都不属于：既不盲重试、也不判死。
  it('与 isRetriable 不是互补关系', () => {
    const conflict = f({ ok: false, reason: 'conflict', status: 409, error: 'x' });
    expect(isRetriable(conflict)).toBe(false);
    expect(isPermanentFailure(conflict)).toBe(false);
  });
});
