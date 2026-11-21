/**
 * 决策看板后台巡检查 PR 合没合：GitHub REST `GET /repos/{owner}/{repo}/pulls/{n}`。
 *
 *   - 只有合入是终态：查到就一直缓存，不再请求（关掉的 PR 还能重开，按开着的一样隔一阵再查）；
 *   - 开着 / 关着的：同一个 PR 至少隔 {@link OPEN_RECHECK_MS} 才再查，并带 ETag（304 不占已认证的频率配额）；
 *   - 查不到的（404 / 403 没权限）同样隔 {@link OPEN_RECHECK_MS} 再试，不每轮白白占配额；
 *   - 认证：GITHUB_TOKEN / GH_TOKEN / ~/.botmux/.env，没有时再试 `gh auth token`（异步、5 秒超时，结果缓存
 *     一小时，不阻塞 daemon 事件循环）；都没有就匿名（每小时 60 次，整机共用，所以上面的缓存是必须的）；
 *   - 查不到（404 = 不是 GitHub 上的仓库或没权限、频控、网络错误）返回 undefined，巡检这轮不下结论；
 *     频控（含 403 + retry-after 的二级频控）时到重置时间之前不再请求。
 *
 * 不发项目代码或用户数据：请求里只有 PR 引用本身（owner/repo#n），与 Dashboard 关联链接指向的是同一个地址。
 */
import { execFile } from 'node:child_process';
import { githubAuthHeaders } from '../github-auth.js';
import type { PrMergeState } from './hints.js';

/** 还开着的 PR 隔多久再查一次。巡检 5 分钟一轮，合入之后最晚十来分钟出提示，够用；也压住匿名配额。 */
export const OPEN_RECHECK_MS = 10 * 60_000;
const GH_TOKEN_TTL_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface PrStateLookupDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** 环境变量 / .env 里的 token 头；测试注入。 */
  authHeaders?: () => Record<string, string>;
  /** `gh auth token`；测试注入。返回 null = 没有。 */
  ghToken?: () => Promise<string | null>;
  log?: (message: string) => void;
}

interface CacheEntry { state: PrMergeState; checkedAt: number; etag?: string }

function defaultGhToken(): Promise<string | null> {
  return new Promise(resolve => {
    try {
      execFile('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 5_000, encoding: 'utf8' }, (error, stdout) => {
        resolve(error ? null : String(stdout).trim() || null);
      });
    } catch {
      resolve(null);
    }
  });
}

export function createPrStateLookup(deps: PrStateLookupDeps = {}): (ref: string) => Promise<PrMergeState | undefined> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const authHeaders = deps.authHeaders ?? (() => githubAuthHeaders());
  const ghToken = deps.ghToken ?? defaultGhToken;
  const cache = new Map<string, CacheEntry>();
  /** 查不到的 PR → 上次失败的时间（隔一阵再试）。 */
  const misses = new Map<string, number>();
  let gh: { token: string | null; at: number } | undefined;
  let rateLimitedUntil = 0;

  const headers = async (): Promise<Record<string, string>> => {
    const fromEnv = authHeaders();
    if (fromEnv.Authorization) return fromEnv;
    if (!gh || now() - gh.at > GH_TOKEN_TTL_MS) gh = { token: await ghToken().catch(() => null), at: now() };
    return gh.token ? { Authorization: `Bearer ${gh.token}` } : {};
  };

  return async (ref: string) => {
    const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(ref);
    if (!m) return undefined;
    const cached = cache.get(ref);
    if (cached?.state === 'merged') return cached.state;
    if (cached && now() - cached.checkedAt < OPEN_RECHECK_MS) return cached.state;
    const missedAt = misses.get(ref);
    if (!cached && missedAt !== undefined && now() - missedAt < OPEN_RECHECK_MS) return undefined;
    if (now() < rateLimitedUntil) return cached?.state;
    const miss = (): PrMergeState | undefined => {
      if (cached) cached.checkedAt = now();
      else misses.set(ref, now());
      return cached?.state;
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${m[1]}/${m[2]}/pulls/${m[3]}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'botmux-decision-board',
          ...(await headers()),
          ...(cached?.etag ? { 'If-None-Match': cached.etag } : {}),
        },
        signal: controller.signal,
      });
      if (res.status === 304 && cached) {
        cached.checkedAt = now();
        return cached.state;
      }
      if (res.status === 403 || res.status === 429) {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const retryAfter = Number(res.headers.get('retry-after'));
        const remaining = res.headers.get('x-ratelimit-remaining');
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          rateLimitedUntil = now() + retryAfter * 1000;
        } else if (res.status === 429 || remaining === '0') {
          rateLimitedUntil = Number.isFinite(reset) && reset * 1000 > now() ? reset * 1000 : now() + OPEN_RECHECK_MS;
        }
        if (rateLimitedUntil > now()) {
          deps.log?.(`[decision-board] GitHub rate limited; PR checks paused until ${new Date(rateLimitedUntil).toISOString()}`);
          return cached?.state;
        }
        return miss();
      }
      if (!res.ok) return miss();
      const body = await res.json() as { state?: unknown; merged?: unknown; merged_at?: unknown };
      const state: PrMergeState | undefined = body.merged === true || (typeof body.merged_at === 'string' && body.merged_at)
        ? 'merged'
        : body.state === 'closed' ? 'closed' : body.state === 'open' ? 'open' : undefined;
      if (!state) return miss();
      const etag = res.headers.get('etag') ?? undefined;
      misses.delete(ref);
      cache.set(ref, { state, checkedAt: now(), ...(etag ? { etag } : {}) });
      return state;
    } catch {
      // 网络错误 / 超时：不记失败时间，下一轮照常再试（可能只是一时不通）。
      return cached?.state;
    } finally {
      clearTimeout(timer);
    }
  };
}
