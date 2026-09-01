/**
 * 工作台入口短时票据（P2-1）——mint / 验票 / 过期 / prune / 重启恢复，以及
 * `GET /workbench-ticket/<ticket>` 兑换端点的契约。
 *
 * 核心不变量：
 *  - 长期 Dashboard token 不再进持久化卡片；卡片链接里只有 30 分钟 TTL 的票据。
 *  - 落盘文件只存 hash(ticket) + 过期时间 + generation 标签，绝无明文——拿到文件
 *    也还原不出票据，更还原不出 token。
 *  - 票据非一次性（同一张卡片 PC/手机多端可开），到期即死。
 *  - dashboard 重启（进程内 Map 清空）后靠文件恢复验票，刚发的卡不作废。
 *  - 兑换端点：验票通过 → 与 ?t= 流程同款 legacy cookie + 302 进工作台；
 *    无效/过期 → 无凭据中文提示页，全程 no-store。
 *  - P1-6：票据钉住 mint 时的 token generation。`dashboard rotate` 之后，之前
 *    泄漏的票据一律 410，绝不兑出新管理 cookie；同一 generation 内多端可重复兑。
 *  - P1-10：兑换端点在 auth gate 之前放行，所以自带每 IP + 全局限流、落盘快照与
 *    负缓存——伪造票据洪水不能把同步磁盘 I/O 打成 event loop 卡死。
 *
 * Run: pnpm vitest run test/workbench-ticket.test.ts
 */
import { createServer, type Server } from 'node:http';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  WORKBENCH_TICKET_EXPIRED_MESSAGE,
  WORKBENCH_TICKET_MAX_GLOBAL_PER_WINDOW,
  WORKBENCH_TICKET_MAX_PER_IP_PER_WINDOW,
  WORKBENCH_TICKET_NO_TOKEN_GENERATION,
  WORKBENCH_TICKET_RATE_LIMITED_MESSAGE,
  WORKBENCH_TICKET_TTL_MS,
  currentWorkbenchTokenGeneration,
  handleWorkbenchTicketRedemption,
  hashWorkbenchTicket,
  mintWorkbenchTicket,
  pruneExpiredWorkbenchTickets,
  resetWorkbenchTicketStoreForTests,
  revokeWorkbenchTicketsOutsideGeneration,
  verifyWorkbenchTicket,
  workbenchTicketGeneration,
  workbenchTicketStoreStatsForTests,
} from '../src/dashboard/workbench-ticket.js';
import { buildSetCookie, rotatePersistedToken } from '../src/dashboard/auth.js';
import { workbenchTicketRedeemUrl } from '../src/core/dashboard-url.js';

let homeDir: string;
let savedHome: string | undefined;

/** 兑换端点测试里的「当前活跃管理 token」。beforeEach 会把它写进
 *  `~/.botmux/.dashboard-token`，让 mint 侧（daemon）与验票侧（dashboard）看到
 *  同一代 token——这正是生产里两个进程的交接方式。 */
const ACTIVE_TOKEN = 'active-mgmt-token-fixture';

const ticketsFile = () => join(homeDir, '.botmux', '.workbench-tickets.json');
const tokenFile = () => join(homeDir, '.botmux', '.dashboard-token');

/** 落盘一份「当前活跃 token」。secure-host-file 要求叶子严格 0600。 */
function setActiveTokenOnDisk(token: string): void {
  writeFileSync(tokenFile(), token, { mode: 0o600 });
  chmodSync(tokenFile(), 0o600);
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'botmux-wbticket-'));
  // secure-host-file 要求凭证目录 0700 且属当前用户；mkdirSync 的 mode 会被
  // umask 削减，显式 chmod 钉死。
  mkdirSync(join(homeDir, '.botmux'), { mode: 0o700 });
  chmodSync(join(homeDir, '.botmux'), 0o700);
  setActiveTokenOnDisk(ACTIVE_TOKEN);
  savedHome = process.env.HOME;
  process.env.HOME = homeDir;
  resetWorkbenchTicketStoreForTests();
});

afterEach(() => {
  resetWorkbenchTicketStoreForTests();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(homeDir, { recursive: true, force: true });
});

describe('mintWorkbenchTicket', () => {
  it('mints an unpredictable ≥32-char base64url ticket, distinct per call', () => {
    const a = mintWorkbenchTicket();
    const b = mintWorkbenchTicket();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(a).not.toBe(b);
  });

  it('persists ONLY hash + expiry + generation — never the ticket or token plaintext — in a 0600 file', () => {
    const now = 1_700_000_000_000;
    const ticket = mintWorkbenchTicket(now);
    const raw = readFileSync(ticketsFile(), 'utf8');
    expect(raw).not.toContain(ticket);
    expect(raw).not.toContain(ACTIVE_TOKEN);
    const entries = JSON.parse(raw) as Array<{ h: string; exp: number; g: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].h).toBe(hashWorkbenchTicket(ticket));
    expect(entries[0].exp).toBe(now + WORKBENCH_TICKET_TTL_MS);
    // P1-6：条目钉住 mint 当时 token 的 generation 标签。
    expect(entries[0].g).toBe(workbenchTicketGeneration(ACTIVE_TOKEN));
    expect(statSync(ticketsFile()).mode & 0o777).toBe(0o600);
  });

  it('mint prunes already-expired entries from the file instead of hoarding them', () => {
    const t0 = 1_700_000_000_000;
    const old = mintWorkbenchTicket(t0);
    // 第二次 mint 发生在第一张票过期之后：文件里不应再保留旧 hash。
    const later = t0 + WORKBENCH_TICKET_TTL_MS + 1;
    mintWorkbenchTicket(later);
    const raw = readFileSync(ticketsFile(), 'utf8');
    expect(raw).not.toContain(hashWorkbenchTicket(old));
    expect(JSON.parse(raw)).toHaveLength(1);
  });
});

describe('verifyWorkbenchTicket', () => {
  it('accepts a freshly minted ticket — repeatedly (multi-device, NOT one-shot)', () => {
    const ticket = mintWorkbenchTicket();
    expect(verifyWorkbenchTicket(ticket)).toBe(true);
    // 同一张卡片在 PC 和手机各点一次：第二次必须仍然可用。
    expect(verifyWorkbenchTicket(ticket)).toBe(true);
  });

  it('rejects garbage, malformed shapes, and unknown well-formed tickets', () => {
    mintWorkbenchTicket();
    expect(verifyWorkbenchTicket('')).toBe(false);
    expect(verifyWorkbenchTicket('short')).toBe(false);
    expect(verifyWorkbenchTicket('!!!not-base64url-at-all-###############')).toBe(false);
    // 形状对但从未签发过。
    expect(verifyWorkbenchTicket('A'.repeat(32))).toBe(false);
  });

  it('expires exactly after the 30-minute TTL', () => {
    const now = 1_700_000_000_000;
    const ticket = mintWorkbenchTicket(now);
    expect(verifyWorkbenchTicket(ticket, now + WORKBENCH_TICKET_TTL_MS - 1)).toBe(true);
    expect(verifyWorkbenchTicket(ticket, now + WORKBENCH_TICKET_TTL_MS)).toBe(false);
    expect(verifyWorkbenchTicket(ticket, now + WORKBENCH_TICKET_TTL_MS + 1)).toBe(false);
  });

  it('survives a dashboard restart: in-memory store cleared, file alone verifies', () => {
    const ticket = mintWorkbenchTicket();
    resetWorkbenchTicketStoreForTests(); // 模拟 dashboard 重启（文件保留）
    expect(verifyWorkbenchTicket(ticket)).toBe(true);
  });

  it('fails closed when the store is unreadable (unsafe dir shape)', () => {
    const ticket = mintWorkbenchTicket();
    resetWorkbenchTicketStoreForTests();
    chmodSync(join(homeDir, '.botmux'), 0o777); // 组/其它可写 → secure-host fail closed
    expect(verifyWorkbenchTicket(ticket)).toBe(false);
    chmodSync(join(homeDir, '.botmux'), 0o700); // 恢复以便 afterEach 清理
  });
});

describe('pruneExpiredWorkbenchTickets', () => {
  it('drops expired entries from the persisted file, keeps live ones', () => {
    const now = 1_700_000_000_000;
    const dead = mintWorkbenchTicket(now);
    const alive = mintWorkbenchTicket(now + WORKBENCH_TICKET_TTL_MS - 1_000);
    pruneExpiredWorkbenchTickets(now + WORKBENCH_TICKET_TTL_MS + 1);
    const raw = readFileSync(ticketsFile(), 'utf8');
    expect(raw).not.toContain(hashWorkbenchTicket(dead));
    expect(raw).toContain(hashWorkbenchTicket(alive));
    // prune 后活票仍可验，死票不可。
    resetWorkbenchTicketStoreForTests();
    expect(verifyWorkbenchTicket(alive, now + WORKBENCH_TICKET_TTL_MS + 2)).toBe(true);
    expect(verifyWorkbenchTicket(dead, now + WORKBENCH_TICKET_TTL_MS + 2)).toBe(false);
  });

  it('is a no-op (no rewrite, no throw) when nothing expired or file absent', () => {
    expect(() => pruneExpiredWorkbenchTickets()).not.toThrow(); // 文件还不存在
    const now = 1_700_000_000_000;
    mintWorkbenchTicket(now);
    const before = statSync(ticketsFile()).mtimeMs;
    pruneExpiredWorkbenchTickets(now + 1_000); // 无过期条目 → 不重写
    expect(statSync(ticketsFile()).mtimeMs).toBe(before);
  });
});

describe('workbenchTicketRedeemUrl', () => {
  it('builds <base>/workbench-ticket/<ticket> and strips query + hash', () => {
    expect(workbenchTicketRedeemUrl('http://10.0.0.7:7891/?t=leaky#/x', 'tick-abc'))
      .toBe('http://10.0.0.7:7891/workbench-ticket/tick-abc');
  });

  it('returns null on unparsable or non-http input', () => {
    expect(workbenchTicketRedeemUrl('not a url', 'tick')).toBeNull();
    expect(workbenchTicketRedeemUrl('ftp://x/', 'tick')).toBeNull();
    expect(workbenchTicketRedeemUrl('http://x:1/', '')).toBeNull();
  });
});

// ─── GET /workbench-ticket/<ticket> 兑换端点 ────────────────────────────────

let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
});

async function startRedemptionServer(
  activeToken: string | null,
  trustedProxyHops = 0,
): Promise<string> {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://dashboard.test');
    if (!handleWorkbenchTicketRedemption(req, res, url, {
      activeToken: () => activeToken,
      trustedProxyHops,
    })) {
      res.writeHead(404); res.end();
    }
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
}

describe('GET /workbench-ticket/<ticket>', () => {
  it('valid ticket → same legacy cookie as the ?t= flow + 302 into the workbench, no-store', async () => {
    const ticket = mintWorkbenchTicket();
    const base = await startRedemptionServer(ACTIVE_TOKEN);
    const res = await fetch(`${base}/workbench-ticket/${ticket}`, { redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/#/agent-workbench');
    // 与 ?t= 流程逐字同款的 cookie（HttpOnly / SameSite=Lax / Path=/）。
    expect(res.headers.get('set-cookie')).toBe(buildSetCookie(ACTIVE_TOKEN));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('the same ticket redeems again from a second device within TTL', async () => {
    const ticket = mintWorkbenchTicket();
    const base = await startRedemptionServer(ACTIVE_TOKEN);
    const first = await fetch(`${base}/workbench-ticket/${ticket}`, { redirect: 'manual' });
    const second = await fetch(`${base}/workbench-ticket/${ticket}`, { redirect: 'manual' });
    expect(first.status).toBe(302);
    expect(second.status).toBe(302);
    expect(second.headers.get('set-cookie')).toBe(buildSetCookie(ACTIVE_TOKEN));
  });

  it('invalid / expired ticket → credential-free Chinese notice page, no-store, no cookie', async () => {
    const now = 1_700_000_000_000;
    const expired = mintWorkbenchTicket(now - WORKBENCH_TICKET_TTL_MS - 1);
    const base = await startRedemptionServer(ACTIVE_TOKEN);

    for (const bad of [expired, 'B'.repeat(32), 'garbage']) {
      const res = await fetch(`${base}/workbench-ticket/${bad}`, { redirect: 'manual' });
      expect(res.status).toBe(410);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('set-cookie')).toBeNull();
      const body = await res.text();
      expect(body).toContain(WORKBENCH_TICKET_EXPIRED_MESSAGE);
      // 零凭据、零回显：正文既无活跃 token，也不把来访票据 echo 回去。
      expect(body).not.toContain(ACTIVE_TOKEN);
      expect(body).not.toContain(bad);
    }
  });

  it('valid ticket but no active token → login-wall redirect WITHOUT minting a cookie', async () => {
    // dashboard 从未发过号：mint 与兑换看到的是同一个「无 token」代。
    rmSync(tokenFile(), { force: true });
    const ticket = mintWorkbenchTicket();
    const base = await startRedemptionServer(null);
    const res = await fetch(`${base}/workbench-ticket/${ticket}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/#/agent-workbench');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('a ticket minted while there was NO token does not redeem once the first token exists', async () => {
    rmSync(tokenFile(), { force: true });
    const ticket = mintWorkbenchTicket();
    // dashboard 随后第一次发号：这张票绑的是「无 token」代，不该顺势兑出新凭证。
    setActiveTokenOnDisk(ACTIVE_TOKEN);
    const base = await startRedemptionServer(ACTIVE_TOKEN);
    const res = await fetch(`${base}/workbench-ticket/${ticket}`, { redirect: 'manual' });
    expect(res.status).toBe(410);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).not.toContain(ACTIVE_TOKEN);
  });

  it('non-GET and non-matching paths fall through to the router (fail closed)', async () => {
    const ticket = mintWorkbenchTicket();
    const base = await startRedemptionServer(ACTIVE_TOKEN);
    expect((await fetch(`${base}/workbench-ticket/${ticket}`, { method: 'POST', redirect: 'manual' })).status).toBe(404);
    expect((await fetch(`${base}/workbench-ticket/`, { redirect: 'manual' })).status).toBe(404);
    expect((await fetch(`${base}/workbench-ticket`, { redirect: 'manual' })).status).toBe(404);
    expect((await fetch(`${base}/workbench-ticket/a/b`, { redirect: 'manual' })).status).toBe(404);
  });

  it('redeems a URL-encoded ticket segment (defensive decode)', async () => {
    const ticket = mintWorkbenchTicket();
    const base = await startRedemptionServer(ACTIVE_TOKEN);
    const res = await fetch(`${base}/workbench-ticket/${encodeURIComponent(ticket)}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
  });
});

// ─── P1-6：票据绑定 token generation，rotate 后旧票即死 ─────────────────────

describe('票据 ↔ token generation 绑定', () => {
  it('a ticket minted BEFORE `dashboard rotate` stops verifying the moment the token changes', () => {
    const ticket = mintWorkbenchTicket();
    expect(verifyWorkbenchTicket(ticket)).toBe(true);

    const rotated = rotatePersistedToken(tokenFile());
    expect(rotated).not.toBe(ACTIVE_TOKEN);
    // 进程内缓存里还留着这张票（rotate 发生在别的路径），但 generation 已经变了。
    expect(verifyWorkbenchTicket(ticket)).toBe(false);
    // 重启（清进程缓存）之后从文件恢复，同样验不过。
    resetWorkbenchTicketStoreForTests();
    expect(verifyWorkbenchTicket(ticket)).toBe(false);
  });

  it('redeeming a pre-rotation ticket returns 410 and NEVER hands out the freshly minted token', async () => {
    const leaked = mintWorkbenchTicket();
    const rotated = rotatePersistedToken(tokenFile());
    // 兑换端点看到的是 rotate 之后的新 token（生产里 dashboard 每请求现读）。
    const base = await startRedemptionServer(rotated);
    const res = await fetch(`${base}/workbench-ticket/${leaked}`, { redirect: 'manual' });

    expect(res.status).toBe(410);
    expect(res.headers.get('set-cookie')).toBeNull();
    const body = await res.text();
    expect(body).toContain(WORKBENCH_TICKET_EXPIRED_MESSAGE);
    expect(body).not.toContain(rotated);
    expect(body).not.toContain(ACTIVE_TOKEN);
  });

  it('keeps the multi-device semantics INSIDE one generation (still not one-shot)', async () => {
    const ticket = mintWorkbenchTicket();
    const base = await startRedemptionServer(ACTIVE_TOKEN);
    for (const _device of ['pc', 'phone', 'ipad']) {
      const res = await fetch(`${base}/workbench-ticket/${ticket}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('set-cookie')).toBe(buildSetCookie(ACTIVE_TOKEN));
    }
  });

  it('a ticket minted AFTER the rotation redeems normally against the new token', async () => {
    mintWorkbenchTicket(); // rotate 之前的那张，之后应当消失
    const rotated = rotatePersistedToken(tokenFile());
    const fresh = mintWorkbenchTicket();
    const base = await startRedemptionServer(rotated);
    const res = await fetch(`${base}/workbench-ticket/${fresh}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('set-cookie')).toBe(buildSetCookie(rotated));
  });

  it('revokeWorkbenchTicketsOutsideGeneration sweeps the dead rows out of the shared file', () => {
    const stale = mintWorkbenchTicket();
    const staleHash = hashWorkbenchTicket(stale);
    const rotated = rotatePersistedToken(tokenFile());
    // rotate 只换 token 文件，票据文件此刻还留着上一代的条目。
    expect(readFileSync(ticketsFile(), 'utf8')).toContain(staleHash);

    revokeWorkbenchTicketsOutsideGeneration(workbenchTicketGeneration(rotated));
    expect(readFileSync(ticketsFile(), 'utf8')).not.toContain(staleHash);

    // 清理是保洁：清过之后新一代的票照常发照常兑，旧票本来就已经因 generation
    // 不符而死。
    const kept = mintWorkbenchTicket();
    resetWorkbenchTicketStoreForTests();
    expect(verifyWorkbenchTicket(kept)).toBe(true);
    expect(verifyWorkbenchTicket(stale)).toBe(false);
  });

  it('the shared file self-heals on the next mint even if nothing ever called revoke', () => {
    const stale = mintWorkbenchTicket();
    rotatePersistedToken(tokenFile());
    const fresh = mintWorkbenchTicket();
    const raw = readFileSync(ticketsFile(), 'utf8');
    expect(raw).not.toContain(hashWorkbenchTicket(stale));
    expect(raw).toContain(hashWorkbenchTicket(fresh));
  });

  it('is a no-op when there is no ticket file at all (never creates one)', () => {
    expect(() => revokeWorkbenchTicketsOutsideGeneration(workbenchTicketGeneration(ACTIVE_TOKEN)))
      .not.toThrow();
    expect(() => readFileSync(ticketsFile(), 'utf8')).toThrow();
  });
});

describe('currentWorkbenchTokenGeneration', () => {
  it('normalizes "no token yet", tracks the live token, and fails closed on an unsafe store', () => {
    rmSync(tokenFile(), { force: true });
    expect(currentWorkbenchTokenGeneration()).toBe(WORKBENCH_TICKET_NO_TOKEN_GENERATION);

    setActiveTokenOnDisk(ACTIVE_TOKEN);
    expect(currentWorkbenchTokenGeneration()).toBe(workbenchTicketGeneration(ACTIVE_TOKEN));

    chmodSync(join(homeDir, '.botmux'), 0o777); // 组/其它可写 → 读不出来
    expect(currentWorkbenchTokenGeneration()).toBeNull();
    // 读不出 generation 就不发票：卡片退化成无凭证登录链接，而不是发一张绑不上
    // 任何 token 的票。
    expect(() => mintWorkbenchTicket()).toThrow();
    chmodSync(join(homeDir, '.botmux'), 0o700);
  });
});

// ─── P1-10：公开兑换端点的同步磁盘 DoS ─────────────────────────────────────

/** 形状合法但从未签发过的票据（攻击者能无限造）。 */
const unknownTicket = (seed: number) => `zz${String(seed).padStart(30, '0')}`;

/** 兑换端点传给验票的第三个参数：它手上已经有「即将下发的那份 token」，所以请求
 *  路径**不应该**再为此读一次 token 文件。下面的打盘计数把两份凭证文件一起算，
 *  正是为了盯住这一点。 */
const activeGeneration = () => workbenchTicketGeneration(ACTIVE_TOKEN);

describe('兑换端点的 DoS 面', () => {
  it('rate-limits a flood from one IP: 429 + Retry-After + credential-free notice', async () => {
    const ticket = mintWorkbenchTicket();
    const base = await startRedemptionServer(ACTIVE_TOKEN);

    for (let i = 0; i < WORKBENCH_TICKET_MAX_PER_IP_PER_WINDOW; i++) {
      const res = await fetch(`${base}/workbench-ticket/${unknownTicket(i)}`, { redirect: 'manual' });
      expect(res.status).toBe(410); // 名额之内：正常拒票
      await res.text();
    }
    const limited = await fetch(`${base}/workbench-ticket/${unknownTicket(999)}`, { redirect: 'manual' });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(limited.headers.get('cache-control')).toBe('no-store');
    const body = await limited.text();
    expect(body).toContain(WORKBENCH_TICKET_RATE_LIMITED_MESSAGE);
    expect(body).not.toContain(ACTIVE_TOKEN);
    expect(body).not.toContain(unknownTicket(999));

    // 限流在验票之前：额度用尽后连合法票据也进不来（这正是它挡住磁盘 I/O 的原因）。
    const good = await fetch(`${base}/workbench-ticket/${ticket}`, { redirect: 'manual' });
    expect(good.status).toBe(429);
    expect(good.headers.get('set-cookie')).toBeNull();
  });

  it('a forged x-forwarded-for cannot buy a fresh per-IP budget (trustedProxyHops=0)', async () => {
    const base = await startRedemptionServer(ACTIVE_TOKEN);
    for (let i = 0; i < WORKBENCH_TICKET_MAX_PER_IP_PER_WINDOW; i++) {
      const res = await fetch(`${base}/workbench-ticket/${unknownTicket(i)}`, {
        redirect: 'manual',
        headers: { 'x-forwarded-for': `203.0.113.${i}` },
      });
      expect(res.status).toBe(410);
      await res.text();
    }
    const spoofed = await fetch(`${base}/workbench-ticket/${unknownTicket(500)}`, {
      redirect: 'manual',
      headers: { 'x-forwarded-for': '198.51.100.77' },
    });
    expect(spoofed.status).toBe(429);
    await spoofed.text();
  });

  it('swapping source addresses does not lift the endpoint-wide ceiling (trustedProxyHops=1)', async () => {
    const base = await startRedemptionServer(ACTIVE_TOKEN, 1);
    // 每个请求换一个「可信代理写下的」客户端地址：每 IP 额度永远用不完，全局
    // 天花板才是拦住洪水的那道闸。
    let refusedAt = -1;
    for (let i = 0; i < WORKBENCH_TICKET_MAX_GLOBAL_PER_WINDOW + 1; i++) {
      const res = await fetch(`${base}/workbench-ticket/${unknownTicket(i)}`, {
        redirect: 'manual',
        headers: { 'x-forwarded-for': `198.51.100.${i % 250}` },
      });
      await res.text();
      if (res.status === 429) { refusedAt = i; break; }
      expect(res.status).toBe(410);
    }
    expect(refusedAt).toBe(WORKBENCH_TICKET_MAX_GLOBAL_PER_WINDOW);
  });

  it('repeated unknown tickets stop hitting the disk AND stop rescanning the table', () => {
    const now = 1_800_000_000_000;
    mintWorkbenchTicket(now);
    const before = workbenchTicketStoreStatsForTests().diskReads;

    const probe = unknownTicket(7);
    for (let i = 0; i < 200; i++) expect(verifyWorkbenchTicket(probe, now, activeGeneration())).toBe(false);

    const stats = workbenchTicketStoreStatsForTests();
    // 200 次探测最多打一次盘：磁盘只跟时间走，不跟请求量走。
    expect(stats.diskReads - before).toBeLessThanOrEqual(1);
    // 除第一次外全部被负缓存吸收，不再进 timingSafeEqual 全表扫。
    expect(stats.negativeHits).toBeGreaterThanOrEqual(199);
  });

  it('a flood of DISTINCT unknown tickets still costs one disk read per snapshot window', () => {
    const now = 1_800_000_000_000;
    mintWorkbenchTicket(now);
    const before = workbenchTicketStoreStatsForTests().diskReads;

    for (let i = 0; i < 500; i++) {
      expect(verifyWorkbenchTicket(unknownTicket(i), now, activeGeneration())).toBe(false);
    }
    expect(workbenchTicketStoreStatsForTests().diskReads - before).toBeLessThanOrEqual(1);

    // 时间推进到快照窗口之外才允许再打一次盘（新鲜度仍然有界）。
    expect(verifyWorkbenchTicket(unknownTicket(1_000), now + 1_000, activeGeneration())).toBe(false);
    expect(workbenchTicketStoreStatsForTests().diskReads - before).toBeLessThanOrEqual(2);
  });

  it('the cached snapshot still surfaces another process’s ticket, and the negative cache never outlives it', () => {
    const now = 1_800_000_000_000;
    mintWorkbenchTicket(now);
    // 一次未知票据的验证把落盘内容读进快照（生产兑换路径每次都会走到这一步）。
    expect(verifyWorkbenchTicket(unknownTicket(1), now, activeGeneration())).toBe(false);

    // 模拟 daemon 进程刚 mint 的一张票（我们这个进程的缓存里完全不知道它）。
    const foreign = unknownTicket(42);
    writeFileSync(ticketsFile(), JSON.stringify([
      { h: hashWorkbenchTicket(foreign), exp: now + WORKBENCH_TICKET_TTL_MS, g: workbenchTicketGeneration(ACTIVE_TOKEN) },
    ]), { mode: 0o600 });
    chmodSync(ticketsFile(), 0o600);

    // 快照窗口内：还看不到（这正是磁盘读被合并的可观测证据）。
    expect(verifyWorkbenchTicket(foreign, now + 100, activeGeneration())).toBe(false);
    // 窗口之外：重新读盘看到了；上一步写下的负缓存不会盖住它（内容变 → 版本推进）。
    expect(verifyWorkbenchTicket(foreign, now + 1_000, activeGeneration())).toBe(true);
  });

  it('a storage read failure fails closed WITHOUT poisoning the negative cache', () => {
    const now = 1_800_000_000_000;
    const ticket = mintWorkbenchTicket(now);
    resetWorkbenchTicketStoreForTests();

    chmodSync(join(homeDir, '.botmux'), 0o777); // 组/其它可写 → secure-host fail closed
    expect(verifyWorkbenchTicket(ticket, now)).toBe(false);
    expect(workbenchTicketStoreStatsForTests().negativeEntries).toBe(0);

    chmodSync(join(homeDir, '.botmux'), 0o700); // 恢复：好票必须立刻重新可兑
    expect(verifyWorkbenchTicket(ticket, now + 1_000)).toBe(true);
  });
});
