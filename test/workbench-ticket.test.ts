/**
 * 工作台入口短时票据（P2-1）——mint / 验票 / 过期 / prune / 重启恢复，以及
 * `GET /workbench-ticket/<ticket>` 兑换端点的契约。
 *
 * 核心不变量：
 *  - 长期 Dashboard token 不再进持久化卡片；卡片链接里只有 30 分钟 TTL 的票据。
 *  - 落盘文件只存 hash(ticket) + 过期时间，绝无明文——拿到文件也还原不出票据。
 *  - 票据非一次性（同一张卡片 PC/手机多端可开），到期即死。
 *  - dashboard 重启（进程内 Map 清空）后靠文件恢复验票，刚发的卡不作废。
 *  - 兑换端点：验票通过 → 与 ?t= 流程同款 legacy cookie + 302 进工作台；
 *    无效/过期 → 无凭据中文提示页，全程 no-store。
 *
 * Run: pnpm vitest run test/workbench-ticket.test.ts
 */
import { createServer, type Server } from 'node:http';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  WORKBENCH_TICKET_EXPIRED_MESSAGE,
  WORKBENCH_TICKET_TTL_MS,
  handleWorkbenchTicketRedemption,
  hashWorkbenchTicket,
  mintWorkbenchTicket,
  pruneExpiredWorkbenchTickets,
  resetWorkbenchTicketStoreForTests,
  verifyWorkbenchTicket,
} from '../src/dashboard/workbench-ticket.js';
import { buildSetCookie } from '../src/dashboard/auth.js';
import { workbenchTicketRedeemUrl } from '../src/core/dashboard-url.js';

let homeDir: string;
let savedHome: string | undefined;

const ticketsFile = () => join(homeDir, '.botmux', '.workbench-tickets.json');

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'botmux-wbticket-'));
  // secure-host-file 要求凭证目录 0700 且属当前用户；mkdirSync 的 mode 会被
  // umask 削减，显式 chmod 钉死。
  mkdirSync(join(homeDir, '.botmux'), { mode: 0o700 });
  chmodSync(join(homeDir, '.botmux'), 0o700);
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

  it('persists ONLY the hash + expiry — never the ticket plaintext — in a 0600 file', () => {
    const now = 1_700_000_000_000;
    const ticket = mintWorkbenchTicket(now);
    const raw = readFileSync(ticketsFile(), 'utf8');
    expect(raw).not.toContain(ticket);
    const entries = JSON.parse(raw) as Array<{ h: string; exp: number }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].h).toBe(hashWorkbenchTicket(ticket));
    expect(entries[0].exp).toBe(now + WORKBENCH_TICKET_TTL_MS);
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

const ACTIVE_TOKEN = 'active-mgmt-token-fixture';

let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
});

async function startRedemptionServer(activeToken: string | null): Promise<string> {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://dashboard.test');
    if (!handleWorkbenchTicketRedemption(req, res, url, { activeToken: () => activeToken })) {
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
    const ticket = mintWorkbenchTicket();
    const base = await startRedemptionServer(null);
    const res = await fetch(`${base}/workbench-ticket/${ticket}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/#/agent-workbench');
    expect(res.headers.get('set-cookie')).toBeNull();
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
