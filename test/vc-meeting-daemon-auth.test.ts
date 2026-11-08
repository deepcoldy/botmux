import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authorizeVcMeetingDaemonControlRequest,
  ensureVcMeetingDaemonAuthToken,
  readVcMeetingDaemonAuthToken,
  VC_MEETING_DAEMON_AUTH_HEADER,
  vcMeetingDaemonAuthTokenPath,
  withVcMeetingDaemonAuthHeader,
} from '../src/services/vc-meeting-daemon-auth.js';

describe('VC meeting daemon-to-daemon auth', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-vc-daemon-auth-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates one stable random 0600 token per target larkAppId', () => {
    expect(readVcMeetingDaemonAuthToken(dir, 'listener-a')).toBeUndefined();
    const first = ensureVcMeetingDaemonAuthToken(dir, 'listener-a');
    const replay = ensureVcMeetingDaemonAuthToken(dir, 'listener-a');
    const other = ensureVcMeetingDaemonAuthToken(dir, 'listener-b');
    expect(first).toBe(replay);
    expect(first).toMatch(/^vcda_[0-9a-f]{64}$/);
    expect(other).toMatch(/^vcda_[0-9a-f]{64}$/);
    expect(other).not.toBe(first);
    expect(readVcMeetingDaemonAuthToken(dir, 'listener-a')).toBe(first);

    const fp = vcMeetingDaemonAuthTokenPath(dir, 'listener-a');
    expect(readFileSync(fp, 'utf8').trim()).toBe(first);
    if (process.platform !== 'win32') {
      expect(statSync(fp).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'vc-meeting-daemon-auth')).mode & 0o777).toBe(0o700);
    }
    // No descriptor/outbox/env side channel is produced by token creation.
    expect(readdirSync(dir)).toEqual(['vc-meeting-daemon-auth']);
    expect(Object.values(process.env)).not.toContain(first);
  });

  it('uses a digest filename and rejects invalid app identities', () => {
    const fp = vcMeetingDaemonAuthTokenPath(dir, '../../listener/with spaces');
    expect(fp).toMatch(/vc-meeting-daemon-auth\/[0-9a-f]{64}\.token$/);
    expect(fp).not.toContain('listener/with spaces');
    expect(() => ensureVcMeetingDaemonAuthToken(dir, '')).toThrow('invalid larkAppId');
    expect(() => ensureVcMeetingDaemonAuthToken(dir, 'x'.repeat(513))).toThrow('invalid larkAppId');
  });

  it('fails closed on a corrupt token instead of silently rotating it', () => {
    const fp = vcMeetingDaemonAuthTokenPath(dir, 'listener-a');
    mkdirSync(join(dir, 'vc-meeting-daemon-auth'), { recursive: true });
    writeFileSync(fp, 'attacker-controlled\n', { mode: 0o600 });
    expect(() => ensureVcMeetingDaemonAuthToken(dir, 'listener-a')).toThrow('invalid VC daemon auth token');
    expect(authorizeVcMeetingDaemonControlRequest(dir, 'listener-a', {
      [VC_MEETING_DAEMON_AUTH_HEADER]: 'attacker-controlled',
    })).toMatchObject({
      ok: false,
      status: 401,
      body: { errorCode: 'vc_daemon_auth_required' },
    });
  });

  it('accepts only the exact target token and rejects missing, wrong, or duplicate headers', () => {
    const token = ensureVcMeetingDaemonAuthToken(dir, 'listener-a');
    expect(authorizeVcMeetingDaemonControlRequest(dir, 'listener-a', {})).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(authorizeVcMeetingDaemonControlRequest(dir, 'listener-a', {
      [VC_MEETING_DAEMON_AUTH_HEADER]: `${token}x`,
    }).ok).toBe(false);
    expect(authorizeVcMeetingDaemonControlRequest(dir, 'listener-a', {
      [VC_MEETING_DAEMON_AUTH_HEADER]: [token, token],
    }).ok).toBe(false);
    expect(authorizeVcMeetingDaemonControlRequest(dir, 'listener-b', {
      [VC_MEETING_DAEMON_AUTH_HEADER]: token,
    }).ok).toBe(false);
    expect(authorizeVcMeetingDaemonControlRequest(dir, 'listener-a', {
      [VC_MEETING_DAEMON_AUTH_HEADER]: token,
    })).toEqual({ ok: true });
    expect(authorizeVcMeetingDaemonControlRequest(
      dir,
      'listener-a',
      new Headers({ [VC_MEETING_DAEMON_AUTH_HEADER]: token }),
    )).toEqual({ ok: true });
  });

  it('adds the target credential without mutating or trusting caller headers', () => {
    const original = new Headers({
      'content-type': 'application/json',
      [VC_MEETING_DAEMON_AUTH_HEADER]: 'spoofed',
    });
    const headers = withVcMeetingDaemonAuthHeader(dir, 'listener-a', original);
    const token = ensureVcMeetingDaemonAuthToken(dir, 'listener-a');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get(VC_MEETING_DAEMON_AUTH_HEADER)).toBe(token);
    expect(original.get(VC_MEETING_DAEMON_AUTH_HEADER)).toBe('spoofed');
  });
});

describe('VC meeting daemon control route wiring', () => {
  const source = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');

  /** Route body from its registration marker up to the next ipcRoute registration (or its own close). */
  function routeBody(marker: string): string {
    const from = source.indexOf(marker);
    expect(from, `missing daemon route marker: ${marker}`).toBeGreaterThanOrEqual(0);
    const next = source.indexOf('\nipcRoute(', from + marker.length);
    const to = next >= 0 ? next : source.indexOf('\n});', from + marker.length);
    expect(to, `unterminated daemon route: ${marker}`).toBeGreaterThan(from);
    return source.slice(from, to);
  }

  // 源码结构护栏(K2)：这些 daemon 间控制路由在 daemon.ts 顶层直接 ipcRoute 注册，没有可在单测里起的 HTTP seam；
  // authorizeVcMeetingDaemonControlRequest 本身的判定由本文件上方的行为用例覆盖。这里守的是：每条控制路由都先过
  // guardVcMeetingDaemonControlRoute，再读请求体、碰接收端状态或改写投递存储——少一处就静默开出一个未鉴权的跨 daemon
  // 写入口（#470）。只断言 guard 与特权操作的相对顺序，不钉整句写法。
  it.each([
    ["for (const path of ['/api/vc-meetings/members/register'", ['readJsonBody', 'registerVcMeetingMember(']],
    ["ipcRoute('POST', '/api/vc-meetings/deliver'", ['readJsonBody', 'validateVcMeetingDeliveryRequest(', 'receiveVcMeetingDelivery(']],
    ["ipcRoute('GET', '/api/vc-meetings/deliveries/:deliveryKey'", ['getVcMeetingDeliveryStatus(']],
    ["ipcRoute('POST', '/api/vc-meetings/deliveries/:deliveryKey/retry'", ['retryPoisonedVcMeetingDelivery(']],
    ["ipcRoute('POST', '/api/vc-meetings/deliveries/:deliveryKey/abandon'", ['readJsonBody', 'abandonPoisonedVcMeetingDelivery(']],
    ["ipcRoute('POST', '/api/vc-meetings/consumer-catch-up'", ['readJsonBody', 'injectVcMeetingConsumerSession(']],
  ] as const)('authenticates %s before body reads, receiver operations or store mutation', (marker, operations) => {
    const body = routeBody(marker);
    const guardAt = body.indexOf('guardVcMeetingDaemonControlRoute(');
    expect(guardAt, 'route is missing VC daemon auth guard').toBeGreaterThanOrEqual(0);
    for (const operation of operations) {
      expect(body.indexOf(operation), `route is missing protected operation ${operation}`).toBeGreaterThan(guardAt);
    }
  });
});
