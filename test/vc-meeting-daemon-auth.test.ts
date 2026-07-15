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

  function between(start: string, end: string): string {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    expect(from, `missing daemon source marker: ${start}`).toBeGreaterThanOrEqual(0);
    expect(to, `missing daemon source marker: ${end}`).toBeGreaterThan(from);
    return source.slice(from, to);
  }

  function expectGuardBefore(block: string, protectedOperation: string): void {
    const guardAt = block.indexOf('guardVcMeetingDaemonControlRoute(req, res)');
    const operationAt = block.indexOf(protectedOperation);
    expect(guardAt, 'route is missing VC daemon auth guard').toBeGreaterThanOrEqual(0);
    expect(operationAt, `route is missing protected operation ${protectedOperation}`).toBeGreaterThan(guardAt);
  }

  function singleRoute(start: string): string {
    const from = source.indexOf(start);
    const to = source.indexOf('\n});', from + start.length);
    expect(from, `missing daemon route marker: ${start}`).toBeGreaterThanOrEqual(0);
    expect(to, `unterminated daemon route: ${start}`).toBeGreaterThan(from);
    return source.slice(from, to + 4);
  }

  it('authenticates register/update before reading ownerEpoch-bearing JSON', () => {
    const block = between(
      "for (const path of ['/api/vc-meetings/members/register'",
      "ipcRoute('POST', '/api/vc-meetings/deliver'",
    );
    expectGuardBefore(block, 'readJsonBody(req)');
    expect(block).toContain('registerVcMeetingMember(body');
  });

  it('authenticates deliver before recovery state, body reads, or store mutation', () => {
    const block = between(
      "ipcRoute('POST', '/api/vc-meetings/deliver'",
      "ipcRoute('GET', '/api/vc-meetings/deliveries/:deliveryKey'",
    );
    expectGuardBefore(block, 'readJsonBody(req)');
    expectGuardBefore(block, 'validateVcMeetingDeliveryRequest(body)');
    expectGuardBefore(block, 'receiveVcMeetingDelivery(body');
  });

  it('authenticates delivery status, retry and abandon before any receiver operation/body read', () => {
    const status = between(
      "ipcRoute('GET', '/api/vc-meetings/deliveries/:deliveryKey'",
      "ipcRoute('POST', '/api/vc-meetings/deliveries/:deliveryKey/retry'",
    );
    expectGuardBefore(status, 'getVcMeetingDeliveryStatus(');

    const retry = between(
      "ipcRoute('POST', '/api/vc-meetings/deliveries/:deliveryKey/retry'",
      "ipcRoute('POST', '/api/vc-meetings/deliveries/:deliveryKey/abandon'",
    );
    expectGuardBefore(retry, 'retryPoisonedVcMeetingDelivery(');

    const abandon = between(
      "ipcRoute('POST', '/api/vc-meetings/deliveries/:deliveryKey/abandon'",
      "ipcRoute('POST', '/api/vc-meetings/output-request'",
    );
    expectGuardBefore(abandon, 'readJsonBody<Record<string, unknown>>(req)');
    expectGuardBefore(abandon, 'abandonPoisonedVcMeetingDelivery(');
  });

  it('adds auth in the shared daemon fetch helper without guarding the agent-facing output route', () => {
    const fetchHelper = between(
      'async function fetchVcMeetingDaemonJson(',
      'async function triggerVcMeetingConsumerTurn(',
    );
    expect(fetchHelper).toContain('withVcMeetingDaemonAuthHeader(');
    const outputRoute = singleRoute("ipcRoute('POST', '/api/vc-meetings/output-request'");
    expect(outputRoute).not.toContain('guardVcMeetingDaemonControlRoute');
    const catchUpRoute = singleRoute("ipcRoute('POST', '/api/vc-meetings/consumer-catch-up'");
    expectGuardBefore(catchUpRoute, 'readJsonBody<Record<string, unknown>>(req)');
    expectGuardBefore(catchUpRoute, 'injectVcMeetingConsumerSession(');
  });
});
