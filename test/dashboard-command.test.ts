import { describe, expect, it, vi } from 'vitest';
import {
  DASHBOARD_COMMAND_USAGE,
  DASHBOARD_LINK_SAFETY_HINT,
  DASHBOARD_LOCAL_TOKEN_FLAG,
  executeDashboardCommand,
  formatDashboardFallbackFailure,
  formatDashboardSuccessLines,
} from '../src/cli/dashboard-command.js';
import type { DashboardEndpoint } from '../src/cli/dashboard-endpoint.js';

describe('executeDashboardCommand', () => {
  it.each([['--help'], ['-h'], ['help']])('%s is non-mutating', async (...args) => {
    const callEndpoint = vi.fn();
    expect(await executeDashboardCommand(args, callEndpoint)).toEqual({ kind: 'help' });
    expect(callEndpoint).not.toHaveBeenCalled();
  });

  it.each([
    { args: ['--help', 'rotate'] },
    { args: ['rotate', '--help'] },
    { args: ['current', 'unexpected', '-h'] },
    { args: ['unexpected', 'help', 'rotate'] },
  ])('treats help anywhere in $args as non-mutating help', async ({ args }) => {
    const callEndpoint = vi.fn();
    expect(await executeDashboardCommand(args, callEndpoint)).toEqual({ kind: 'help' });
    expect(callEndpoint).not.toHaveBeenCalled();
  });

  it.each([{ args: [] }, { args: ['current'] }])('$args gets or creates the current URL and never calls rotate', async ({ args }) => {
    const callEndpoint = vi.fn(async (path: DashboardEndpoint) => path === '/__cli/current'
      ? { ok: false as const, reason: 'no-active-token' as const }
      : { ok: true as const, url: 'https://dashboard.test/?t=synthetic-created-token' });
    const result = await executeDashboardCommand(args, callEndpoint);
    expect(callEndpoint.mock.calls.map(([path]) => path)).toEqual([
      '/__cli/current',
      '/__cli/ensure',
    ]);
    expect(result).toEqual({
      kind: 'endpoint',
      action: 'current',
      result: { ok: true, url: 'https://dashboard.test/?t=synthetic-created-token' },
      showLocalTokenLink: false,
    });
  });

  it('returns an existing current URL without touching a token-writing endpoint', async () => {
    const callEndpoint = vi.fn(async () => ({
      ok: true as const,
      url: 'https://dashboard.test/?t=synthetic-current-token',
    }));

    const result = await executeDashboardCommand(['current'], callEndpoint);

    expect(callEndpoint).toHaveBeenCalledOnce();
    expect(callEndpoint).toHaveBeenCalledWith('/__cli/current');
    expect(result).toMatchObject({
      kind: 'endpoint',
      action: 'current',
      result: { ok: true, url: 'https://dashboard.test/?t=synthetic-current-token' },
    });
  });

  it.each([
    { ok: false as const, reason: 'unreachable' as const },
    { ok: false as const, reason: 'auth-failed' as const },
    { ok: false as const, reason: 'wrong-service' as const },
  ])('does not touch a token-writing endpoint when current fails with $reason', async (currentFailure) => {
    const callEndpoint = vi.fn(async () => currentFailure);

    const result = await executeDashboardCommand(['current'], callEndpoint);

    expect(callEndpoint).toHaveBeenCalledOnce();
    expect(callEndpoint).toHaveBeenCalledWith('/__cli/current');
    expect(result).toEqual({
      kind: 'endpoint', action: 'current', result: currentFailure, showLocalTokenLink: false,
    });
  });

  it('falls back to legacy rotate only after current confirms a dashboard with no token and ensure is missing', async () => {
    const callEndpoint = vi.fn(async (path: DashboardEndpoint) => {
      if (path === '/__cli/current') {
        return { ok: false as const, reason: 'no-active-token' as const };
      }
      if (path === '/__cli/ensure') {
        return {
          ok: false as const,
          reason: 'wrong-service' as const,
          detail: '404 {"error":"not_found","path":"/__cli/ensure"}',
        };
      }
      if (path === '/__cli/rotate') {
        return { ok: true as const, url: 'https://dashboard.test/?t=legacy-token' };
      }
      throw new Error(`unexpected endpoint: ${path}`);
    });

    const result = await executeDashboardCommand(['current'], callEndpoint);

    expect(callEndpoint.mock.calls.map(([path]) => path)).toEqual([
      '/__cli/current',
      '/__cli/ensure',
      '/__cli/current',
      '/__cli/rotate',
    ]);
    expect(result).toEqual({
      kind: 'endpoint',
      action: 'current',
      result: { ok: true, url: 'https://dashboard.test/?t=legacy-token' },
      showLocalTokenLink: false,
    });
  });

  it('recognizes the legacy token-gate response for an unsupported ensure route', async () => {
    const callEndpoint = vi.fn(async (path: DashboardEndpoint) => {
      if (path === '/__cli/current') {
        return { ok: false as const, reason: 'no-active-token' as const };
      }
      if (path === '/__cli/ensure') {
        return {
          ok: false as const,
          reason: 'http-error' as const,
          detail: '401 <h1>Token expired</h1><p>Run <code>botmux dashboard</code> to get a fresh URL.</p>',
        };
      }
      if (path === '/__cli/rotate') {
        return { ok: true as const, url: 'https://dashboard.test/?t=legacy-token' };
      }
      throw new Error(`unexpected endpoint: ${path}`);
    });

    const result = await executeDashboardCommand([], callEndpoint);

    expect(callEndpoint.mock.calls.map(([path]) => path)).toEqual([
      '/__cli/current',
      '/__cli/ensure',
      '/__cli/current',
      '/__cli/rotate',
    ]);
    expect(result).toMatchObject({
      kind: 'endpoint',
      action: 'current',
      result: { ok: true, url: 'https://dashboard.test/?t=legacy-token' },
    });
  });

  it('rechecks current before legacy rotation so a concurrently-created token survives', async () => {
    let currentCalls = 0;
    const callEndpoint = vi.fn(async (path: DashboardEndpoint) => {
      if (path === '/__cli/current') {
        currentCalls += 1;
        return currentCalls === 1
          ? { ok: false as const, reason: 'no-active-token' as const }
          : { ok: true as const, url: 'https://dashboard.test/?t=concurrent-token' };
      }
      if (path === '/__cli/ensure') {
        return { ok: false as const, reason: 'wrong-service' as const };
      }
      throw new Error(`unexpected endpoint: ${path}`);
    });

    const result = await executeDashboardCommand(['current'], callEndpoint);

    expect(callEndpoint.mock.calls.map(([path]) => path)).toEqual([
      '/__cli/current',
      '/__cli/ensure',
      '/__cli/current',
    ]);
    expect(result).toMatchObject({
      kind: 'endpoint',
      action: 'current',
      result: { ok: true, url: 'https://dashboard.test/?t=concurrent-token' },
    });
  });

  it('does not rotate when the new ensure route fails closed', async () => {
    const ensureFailure = {
      ok: false as const,
      reason: 'http-error' as const,
      detail: '500 {"error":"token_persist_failed"}',
    };
    const callEndpoint = vi.fn(async (path: DashboardEndpoint) => path === '/__cli/current'
      ? { ok: false as const, reason: 'no-active-token' as const }
      : ensureFailure);

    const result = await executeDashboardCommand(['current'], callEndpoint);

    expect(callEndpoint.mock.calls.map(([path]) => path)).toEqual([
      '/__cli/current',
      '/__cli/ensure',
    ]);
    expect(result).toEqual({
      kind: 'endpoint', action: 'current', result: ensureFailure, showLocalTokenLink: false,
    });
  });

  it('rotates only when explicitly requested', async () => {
    const callEndpoint = vi.fn(async () => ({
      ok: true as const,
      url: 'https://dashboard.test/?t=synthetic-rotated-token',
    }));
    const result = await executeDashboardCommand(['rotate'], callEndpoint);
    expect(callEndpoint).toHaveBeenCalledTimes(1);
    expect(callEndpoint).toHaveBeenCalledWith('/__cli/rotate');
    expect(result).toMatchObject({ kind: 'endpoint', action: 'rotate' });
  });

  it.each([
    { args: ['current', 'unexpected'] },
    { args: ['rotate', 'unexpected'] },
    { args: ['current', 'rotate'] },
    { args: ['rotate', 'current'] },
  ])('rejects extra argv in $args without touching either endpoint', async ({ args }) => {
    const callEndpoint = vi.fn();
    expect(await executeDashboardCommand(args, callEndpoint)).toEqual({
      kind: 'invalid',
      argument: args.join(' '),
    });
    expect(callEndpoint).not.toHaveBeenCalled();
  });

  it('rejects unknown subcommands without touching either endpoint', async () => {
    const callEndpoint = vi.fn();
    expect(await executeDashboardCommand(['wat'], callEndpoint)).toEqual({
      kind: 'invalid',
      argument: 'wat',
    });
    expect(callEndpoint).not.toHaveBeenCalled();
  });
});

describe('formatDashboardFallbackFailure', () => {
  it.each([
    {
      failure: { ok: false as const, reason: 'auth-failed' as const },
      expected: 'Dashboard lookup failed: auth-failed',
    },
    {
      failure: { ok: false as const, reason: 'http-error' as const, detail: '500 upstream error' },
      expected: 'Dashboard lookup failed: 500 upstream error',
    },
    {
      failure: {
        ok: false as const,
        reason: 'http-error' as const,
        detail: 'malformed response (no url)',
      },
      expected: 'Dashboard lookup failed: malformed response (no url)',
    },
  ])('labels current failures as a lookup failure: $failure', ({ failure, expected }) => {
    const message = formatDashboardFallbackFailure('current', failure);
    expect(message).toBe(expected);
    expect(message).not.toContain('Rotation');
  });

  it('retains the rotation-specific label for rotate failures', () => {
    expect(formatDashboardFallbackFailure('rotate', {
      ok: false,
      reason: 'http-error',
      detail: '500 upstream error',
    })).toBe('Rotation failed: 500 upstream error');
  });
});

// ─── 隐藏参数的解析（新增行为）────────────────────────────────────────────────
describe('executeDashboardCommand + the hidden local-token flag', () => {
  const okCurrent = async () => ({
    ok: true as const,
    url: 'https://m-abc.platform.test/?t=tok-abc',
    localUrl: 'http://10.0.0.7:7891/?t=tok-abc',
  });

  it('defaults to NOT showing the token link', async () => {
    const r = await executeDashboardCommand([], okCurrent);
    expect(r).toMatchObject({ kind: 'endpoint', showLocalTokenLink: false });
  });

  it('sets the opt-in when the exact flag is passed', async () => {
    const r = await executeDashboardCommand([DASHBOARD_LOCAL_TOKEN_FLAG], okCurrent);
    expect(r).toMatchObject({ kind: 'endpoint', action: 'current', showLocalTokenLink: true });
  });

  // 回归：flag 必须在「至多一个 positional」检查之前被摘掉，否则这条安全参数会把
  // 它本该守护的命令直接判成 invalid。
  it.each(['current', 'rotate'])('combines with the %s subcommand instead of becoming invalid', async (sub) => {
    const calls: string[] = [];
    const r = await executeDashboardCommand([sub, DASHBOARD_LOCAL_TOKEN_FLAG], async (path) => {
      calls.push(path);
      return { ok: true as const, url: 'https://d.test/?t=x' };
    });
    expect(r.kind).toBe('endpoint');
    expect(r).toMatchObject({ action: sub, showLocalTokenLink: true });
    expect(calls[0]).toBe(sub === 'rotate' ? '/__cli/rotate' : '/__cli/current');
  });

  it('accepts the flag before the subcommand too', async () => {
    const r = await executeDashboardCommand([DASHBOARD_LOCAL_TOKEN_FLAG, 'rotate'], async () => ({
      ok: true as const, url: 'https://d.test/?t=x',
    }));
    expect(r).toMatchObject({ kind: 'endpoint', action: 'rotate', showLocalTokenLink: true });
  });

  // 近似拼写不能静默放行 token —— 宁可报 invalid 让人看见，也不要「差不多就给」。
  it('rejects a near-miss spelling rather than silently printing the token', async () => {
    const callEndpoint = vi.fn();
    const r = await executeDashboardCommand(['--i-am-the-owner-show-token-links'], callEndpoint);
    expect(r.kind).toBe('invalid');
    expect(callEndpoint).not.toHaveBeenCalled();
  });

  it('help still wins over the flag, and reaches no endpoint', async () => {
    const callEndpoint = vi.fn();
    expect(await executeDashboardCommand(
      [DASHBOARD_LOCAL_TOKEN_FLAG, '--help'], callEndpoint,
    )).toEqual({ kind: 'help' });
    expect(callEndpoint).not.toHaveBeenCalled();
  });
});

describe('formatDashboardSuccessLines', () => {
  // 无 `localUrl` = 没有远程基址（未绑平台、无自建反代）。那时 token 是唯一入口，
  // 必须原样保留 —— 去掉它，`http://ip:port/` 只是静态壳，SPA 探 /api/settings 拿
  // 401，而 401 上的登录出口 `x-botmux-login-url` 未绑定时根本不生成。
  it('LOCAL-ONLY: keeps the token — it is the only way in when no platform is bound', () => {
    const lines = formatDashboardSuccessLines({
      ok: true,
      url: 'http://10.0.0.7:7891/?t=tok-abc',
    });

    expect(lines[0]).toBe('http://10.0.0.7:7891/?t=tok-abc');
    // 有 token 时用无 fragment 的 /workbench（复制粘贴不会被截断）。
    expect(lines[1]).toBe('工作台: http://10.0.0.7:7891/workbench?t=tok-abc');
    // 没有远程基址 ⇒ 没有「本地直连」这一行可隐藏。
    expect(lines.some(l => l.includes('本地直连'))).toBe(false);
  });

  it('keeps line 0 a bare URL — the scripting contract (`botmux dashboard | head -1`)', () => {
    const lines = formatDashboardSuccessLines({
      ok: true,
      url: 'https://m-abc.platform.test/?t=tok-abc',
      localUrl: 'http://10.0.0.7:7891/?t=tok-abc',
    });

    // No label, no prefix, and parseable as-is.
    expect(() => new URL(lines[0])).not.toThrow();
    expect(lines[0]).not.toContain('工作台');
    expect(lines[0]).not.toContain(' ');
  });

  // ─── 绑定中心化平台 / 自建反代后：主链接不带 token ────────────────────────
  // `localUrl` 有值就是「远程基址已生效」这一位（见 dashboard-url.ts）。走平台时
  // token 被 request-identity 压制成 undefined、对访问零贡献，只剩泄漏价值。
  it('PLATFORM-HOSTED: strips ?t= from the primary link and from the workbench entry', () => {
    const lines = formatDashboardSuccessLines({
      ok: true,
      url: 'https://m-abc.platform.test/?t=tok-abc',
      localUrl: 'http://10.0.0.7:7891/?t=tok-abc',
    }, false, true);

    expect(lines[0]).toBe('https://m-abc.platform.test/');
    // 无凭证形态必须走 hash 路由：`/workbench` 不在静态壳白名单里，token-free
    // 访问是 401 死链（实测平台身份下同样 401）。
    expect(lines[1]).toBe('工作台: https://m-abc.platform.test/#/agent-workbench');
    // 整段输出里不得再出现 token —— 这是本次改动的核心断言。
    expect(lines.join('\n')).not.toContain('tok-abc');
  });

  it('PLATFORM-HOSTED: hides the token-bearing local link behind the explicit flag', () => {
    const result = {
      ok: true as const,
      url: 'https://m-abc.platform.test/?t=tok-abc',
      localUrl: 'http://10.0.0.7:7891/?t=tok-abc',
    };

    const hidden = formatDashboardSuccessLines(result, false, true);
    const local = hidden.find(l => l.includes('本地直连'));
    // 该行仍在（人需要知道存在这条路），但链接本体不打印，且提示了参数名。
    expect(local).toBeDefined();
    expect(local).not.toContain('tok-abc');
    expect(local).toContain(DASHBOARD_LOCAL_TOKEN_FLAG);

    const shown = formatDashboardSuccessLines(result, true, true);
    expect(shown).toContain('本地直连(平台异常时可用): http://10.0.0.7:7891/?t=tok-abc');
    // 显式索取时也要挨一句警告。
    expect(shown.join('\n')).toContain('等同管理员密码');
  });

  // ─── 回归：判据必须是「中心平台托管」，不是「有远程基址」 ──────────────────
  // 第一版用 `localUrl !== undefined` 当「平台已生效」的等价判据，这是错的：
  // `remotePublicBase()` 有三个来源，只有中心平台会注入身份 + 走 SSO。自建反代
  // (BOTMUX_PUBLIC_URL) 与 Devbox 短链同样会产生 localUrl，但没有人注入身份 ——
  // 实测那两条路 token-free 请求拿 401、带 ?t= 才 302，而 401 上的登录出口由
  // `buildPlatformDashboardLoginUrl()` 生成，它要求 remoteAccess + platform.json，
  // 反代/短链都拿不到 ⟹ 去掉 token 等于把唯一入口堵死。
  it('REVERSE-PROXY / DEVBOX: keeps the token even though localUrl exists', () => {
    // 形态与平台托管**完全一致**（有 localUrl），唯一区别是 platformHosted=false。
    const lines = formatDashboardSuccessLines({
      ok: true,
      url: 'https://botmux.mycorp.example/?t=tok-abc',
      localUrl: 'http://10.0.0.7:7891/?t=tok-abc',
    }, false, false);

    // token 必须留着 —— 它是这条路上唯一的凭证。
    expect(lines[0]).toBe('https://botmux.mycorp.example/?t=tok-abc');
    // 有 token ⇒ 工作台用无 fragment 的 /workbench（它会 302，不是死链）。
    expect(lines[1]).toBe('工作台: https://botmux.mycorp.example/workbench?t=tok-abc');
  });

  // fail-safe 方向：判据取不到时保留 token。少一次「去 token」只是维持现状；
  // 多一次却可能让 owner 完全进不去。
  it('defaults to KEEPING the token when platformHosted is not supplied', () => {
    const lines = formatDashboardSuccessLines({
      ok: true,
      url: 'https://m-abc.platform.test/?t=tok-abc',
      localUrl: 'http://10.0.0.7:7891/?t=tok-abc',
    });
    expect(lines[0]).toContain('?t=tok-abc');
  });

  // platformHosted=true 但没有 localUrl（理论上不该出现：平台托管必然有本地兜底）。
  // 仍要 fail-safe：宁可留 token，也不要凭一个不自洽的输入去摘凭证。
  it('keeps the token when platformHosted is claimed but there is no localUrl', () => {
    const lines = formatDashboardSuccessLines({
      ok: true,
      url: 'http://10.0.0.7:7891/?t=tok-abc',
    }, false, true);
    expect(lines[0]).toBe('http://10.0.0.7:7891/?t=tok-abc');
  });

  it('always appends the AI-facing safety hint, naming both leak conditions', () => {
    for (const result of [
      { ok: true as const, url: 'http://10.0.0.7:7891/?t=tok-abc' },
      { ok: true as const, url: 'https://m-abc.platform.test/?t=tok-abc', localUrl: 'http://10.0.0.7:7891/?t=tok-abc' },
    ]) {
      const text = formatDashboardSuccessLines(result).join('\n');
      expect(text).toContain(DASHBOARD_LINK_SAFETY_HINT);
      expect(text).toContain('owner');
      expect(text).toContain('多人群');
    }
  });

  // 隐藏参数不进 help：写进去等于邀请模型「既然有这个参数那就加上」。
  it('keeps the token-link flag OUT of the usage text', () => {
    expect(DASHBOARD_COMMAND_USAGE).not.toContain(DASHBOARD_LOCAL_TOKEN_FLAG);
    expect(DASHBOARD_COMMAND_USAGE).not.toContain('token-link');
  });

  it('omits the workbench line rather than printing a half-built link', () => {
    const lines = formatDashboardSuccessLines({ ok: true, url: 'not-a-url' });
    expect(lines[0]).toBe('not-a-url');
    expect(lines.some(l => l.startsWith('工作台'))).toBe(false);
  });
});
