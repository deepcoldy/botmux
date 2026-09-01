// P1-5: the view-link URL capability is short-lived, identity-bound, pinned to
// one worker boot, and consumable ONLY through the central front proxy.
// These helpers are what the dashboard uses to REPLACE the worker's unbound
// per-boot token in /api/sessions/:id/view-link responses, and what the front
// proxy uses to map a presented capability back to its auth session.
import { describe, expect, it } from 'bun:test';
import {
  deriveWorkerViewGeneration,
  issueTerminalControlGrant,
  signTerminalViewForward,
  verifyTerminalControlGrant,
  verifyTerminalViewForward,
} from '../src/core/terminal-control-grant.js';
import {
  TERMINAL_VIEW_CAPABILITY_TTL_MS,
  centralViewLinkPath,
  mintTerminalViewCapability,
  terminalViewCapabilityAuthSession,
  terminalViewForwardProof,
  upstreamWorkerViewGeneration,
} from '../src/dashboard/terminal-view-capability.js';

const SECRET = 'view-capability-test-secret';
const NOW = 1_755_000_000_000;
/** What the daemon's own view-link answer looks like: the worker's per-boot
 *  card token on the terminal reverse proxy's OWN port. */
const UPSTREAM_URL = 'http://10.0.0.7:8801/s/s1/?viewToken=worker-boot-token';
const GENERATION = deriveWorkerViewGeneration(SECRET, 'worker-boot-token')!;

const h5Identity = {
  userId: 'ou_h5_viewer',
  authSessionId: 'h5-auth-1',
  expiresAt: NOW + 30 * 60_000,
};

describe('mintTerminalViewCapability', () => {
  it('mints a central-audience READ grant bound to session + auth session + worker boot', () => {
    const minted = mintTerminalViewCapability(SECRET, 's1', h5Identity, GENERATION, NOW);
    expect(minted).not.toBeNull();
    // 身份还有 30 分钟，但能力必须按短 TTL 截断——URL capability 只许短命。
    expect(minted!.expiresAt).toBe(NOW + TERMINAL_VIEW_CAPABILITY_TTL_MS);
    const verified = verifyTerminalControlGrant(SECRET, minted!.token, 's1', NOW);
    expect(verified).toEqual({
      ok: true,
      claims: expect.objectContaining({
        scope: 'read',
        sessionId: 's1',
        userId: 'ou_h5_viewer',
        authSessionId: 'h5-auth-1',
        expiresAt: minted!.expiresAt,
        // 只有中央前门能消费；且钉死在签发时那一代 worker 上。
        audience: 'central',
        workerGeneration: GENERATION,
      }),
    });
    // 换个 session 立即失效：能力不能跨会话挪用。
    expect(verifyTerminalControlGrant(SECRET, minted!.token, 's2', NOW)).toEqual({
      ok: false, reason: 'session_mismatch',
    });
    // 到期即拒：过期重连拿同一条 URL 必然 403。
    expect(verifyTerminalControlGrant(SECRET, minted!.token, 's1', minted!.expiresAt)).toEqual({
      ok: false, reason: 'expired',
    });
  });

  it('never outlives the requesting authentication and fails closed on a dead identity', () => {
    const shortLived = { ...h5Identity, expiresAt: NOW + 90_000 };
    expect(mintTerminalViewCapability(SECRET, 's1', shortLived, GENERATION, NOW)!.expiresAt)
      .toBe(NOW + 90_000);
    expect(mintTerminalViewCapability(SECRET, 's1', { ...h5Identity, expiresAt: NOW }, GENERATION, NOW)).toBeNull();
    expect(mintTerminalViewCapability(SECRET, 's1', { ...h5Identity, expiresAt: NOW - 1 }, GENERATION, NOW)).toBeNull();
    // 身份字段出界（空 userId）宁可失败也不回退到任何稳定 token。
    expect(mintTerminalViewCapability(SECRET, 's1', { ...h5Identity, userId: '' }, GENERATION, NOW)).toBeNull();
    // 没有 generation 就不签：签出来的能力会活过它本该跟随的那一代 worker。
    expect(mintTerminalViewCapability(SECRET, 's1', h5Identity, '', NOW)).toBeNull();
    expect(mintTerminalViewCapability(SECRET, 's1', h5Identity, 'too-short', NOW)).toBeNull();
  });

  it('refuses to mint a write-scope capability for the browser at all', () => {
    // 兜底不变式：带 audience 的 grant 只能是 read。写能力永远不许进 URL。
    expect(() => issueTerminalControlGrant(SECRET, {
      scope: 'write',
      sessionId: 's1',
      userId: 'ou_h5_viewer',
      authSessionId: 'h5-auth-1',
      issuedAt: NOW,
      expiresAt: NOW + 60_000,
      audience: 'central',
      workerGeneration: GENERATION,
    })).toThrow(/invalid terminal control grant claims/);
  });
});

describe('upstreamWorkerViewGeneration', () => {
  it('converts the daemon-built URL into a one-way worker boot generation', () => {
    expect(upstreamWorkerViewGeneration(SECRET, UPSTREAM_URL)).toBe(GENERATION);
    // 一代一值：worker 重启换新 boot token ⇒ 换 generation ⇒ 旧能力自然失效。
    expect(upstreamWorkerViewGeneration(SECRET, 'http://10.0.0.7:8801/s/s1/?viewToken=next-boot-token'))
      .not.toBe(GENERATION);
    // generation 不可反推回 boot token（它本身就是一把只读能力）。
    expect(GENERATION).not.toContain('worker-boot-token');
  });

  it('fails closed instead of minting an unpinned capability', () => {
    expect(upstreamWorkerViewGeneration(SECRET, 'http://10.0.0.7:8801/s/s1/')).toBeNull();
    expect(upstreamWorkerViewGeneration(SECRET, 'not a url')).toBeNull();
    expect(upstreamWorkerViewGeneration(SECRET, 'javascript:alert(1)?viewToken=x')).toBeNull();
    expect(upstreamWorkerViewGeneration(SECRET, undefined)).toBeNull();
    // 上游要是已经给了签名 grant，说明链路被人接过手：不拿它当 boot token 续签。
    const grant = mintTerminalViewCapability(SECRET, 's1', h5Identity, GENERATION, NOW)!.token;
    expect(upstreamWorkerViewGeneration(
      SECRET,
      `http://10.0.0.7:8801/s/s1/?viewToken=${encodeURIComponent(grant)}`,
    )).toBeNull();
  });
});

describe('centralViewLinkPath', () => {
  it('returns a CENTRAL same-origin path — the daemon/worker origin never reaches the browser', () => {
    const path = centralViewLinkPath('s1', 'bound-capability');
    expect(path).toBe('/s/s1/?viewToken=bound-capability');
    // 相对路径连 origin 都表达不出来：既不可能指向 daemon 反代端口，也不可能被
    // 伪造的 Host 头改指到别处——绕过中央吊销的那条路在协议层就没了。
    expect(path!.startsWith('/s/')).toBe(true);
    expect(path).not.toContain('8801');
    expect(path).not.toContain('//');
    expect(() => new URL(path!)).toThrow();
    // 上游的 per-boot token 一个字节都不许透出去。
    expect(path).not.toContain('worker-boot-token');
  });

  it('escapes the session id and fails closed on out-of-shape inputs', () => {
    expect(centralViewLinkPath('a/b', 'cap')).toBe('/s/a%2Fb/?viewToken=cap');
    expect(centralViewLinkPath('s1', 'a b&c=d')).toBe('/s/s1/?viewToken=a%20b%26c%3Dd');
    expect(centralViewLinkPath('', 'cap')).toBeNull();
    expect(centralViewLinkPath('s1', '')).toBeNull();
    expect(centralViewLinkPath('s1\r\nX-Evil: 1', 'cap')).toBeNull();
  });
});

describe('terminalViewCapabilityAuthSession', () => {
  it('resolves the auth session only for a valid bound READ capability of this session', () => {
    const minted = mintTerminalViewCapability(SECRET, 's1', h5Identity, GENERATION, NOW)!;
    expect(terminalViewCapabilityAuthSession(SECRET, 's1', minted.token, NOW)).toBe('h5-auth-1');
    // 过期、跨 session、随机字符串、worker 每 boot token 一律不算 bound capability。
    expect(terminalViewCapabilityAuthSession(SECRET, 's1', minted.token, minted.expiresAt)).toBeNull();
    expect(terminalViewCapabilityAuthSession(SECRET, 's2', minted.token, NOW)).toBeNull();
    expect(terminalViewCapabilityAuthSession(SECRET, 's1', 'random-per-boot-token', NOW)).toBeNull();
    expect(terminalViewCapabilityAuthSession(SECRET, 's1', null, NOW)).toBeNull();
  });

  it('never blesses an INTERNAL loopback grant that was not minted for the browser', () => {
    // 无 audience 的 read grant 是 dashboard→worker 环回跳的内部凭证。它要是能被
    // 前门当 view capability 认下并盖章，等于给内部凭证开了一条浏览器通道。
    const internal = issueTerminalControlGrant(SECRET, {
      scope: 'read',
      sessionId: 's1',
      userId: 'ou_h5_viewer',
      authSessionId: 'h5-auth-1',
      issuedAt: NOW,
      expiresAt: NOW + 60_000,
    });
    expect(verifyTerminalControlGrant(SECRET, internal, 's1', NOW).ok).toBe(true);
    expect(terminalViewCapabilityAuthSession(SECRET, 's1', internal, NOW)).toBeNull();
  });
});

describe('terminalViewForwardProof', () => {
  it('countersigns exactly one capability and is unforgeable without the host secret', () => {
    const minted = mintTerminalViewCapability(SECRET, 's1', h5Identity, GENERATION, NOW)!;
    const other = mintTerminalViewCapability(SECRET, 's1', h5Identity, GENERATION, NOW + 1)!;
    const proof = terminalViewForwardProof(SECRET, minted.token)!;
    expect(proof).toBeTruthy();
    expect(verifyTerminalViewForward(SECRET, minted.token, proof)).toBe(true);
    // 盖的是「这一条」能力：换一条能力、换一把 secret 都对不上。
    expect(verifyTerminalViewForward(SECRET, other.token, proof)).toBe(false);
    expect(verifyTerminalViewForward('another-host-secret', minted.token, proof)).toBe(false);
    expect(signTerminalViewForward('another-host-secret', minted.token)).not.toBe(proof);
    // 缺头 / 空头 / 数组头都算没盖章。
    expect(verifyTerminalViewForward(SECRET, minted.token, undefined)).toBe(false);
    expect(verifyTerminalViewForward(SECRET, minted.token, '')).toBe(false);
    expect(verifyTerminalViewForward(SECRET, minted.token, [proof])).toBe(false);
    // 证明本身不含能力明文，也不含 secret。
    expect(proof).not.toContain(minted.token);
    expect(proof).not.toContain(SECRET);
  });
});
