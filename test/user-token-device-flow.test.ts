import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const APP = 'cli_device_test';
const USER = 'ou_requester';
const DEVICE_CODE = 'private-device-code';
const TOKEN = 'test-user-access-token';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('user authorization device flow', () => {
  let root: string;
  let tokenDir: string;
  let current: boolean;
  let grantedScope: string;
  let device: Record<string, unknown>;
  let tokenBody: Record<string, unknown>;
  let userBody: Record<string, unknown>;
  let tokenFetch: (init: RequestInit) => Promise<Response>;
  let userFetch: (init: RequestInit) => Promise<Response>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let requestUserAuthorization: typeof import('../src/utils/user-token.js').requestUserAuthorization;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-user-device-'));
    tokenDir = join(root, '.botmux', 'data');
    mkdirSync(tokenDir, { recursive: true });
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-19T00:00:00Z'));
    vi.resetModules();
    ({ requestUserAuthorization } = await import('../src/utils/user-token.js'));
    current = true;
    device = {
      device_code: DEVICE_CODE,
      verification_uri_complete: 'https://example.com/device?user_code=ABCD',
      expires_in: 600,
      interval: 5,
    };
    tokenBody = {
      access_token: TOKEN, refresh_token: 'test-refresh-token', token_type: 'Bearer',
      expires_in: 7200, refresh_token_expires_in: 604800,
    };
    userBody = { code: 0, data: { open_id: USER, name: 'Requester' } };
    tokenFetch = async () => json({ scope: grantedScope, ...tokenBody }, tokenBody.error ? 400 : 200);
    userFetch = async () => json(userBody);
    fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/device_authorization')) {
        grantedScope = new URLSearchParams(init.body as URLSearchParams).get('scope')!;
        return json(device);
      }
      if (url.endsWith('/oauth/token')) return tokenFetch(init);
      if (url.endsWith('/user_info')) return userFetch(init);
      throw new Error('unexpected endpoint');
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function advance(seconds: number): void {
    vi.setSystemTime(Date.now() + seconds * 1000);
  }

  it.each([
    ['feishu', 'https://accounts.feishu.cn', 'https://open.feishu.cn'],
    ['lark', 'https://accounts.larksuite.com', 'https://open.larksuite.com'],
  ] as const)('authorizes and stores the verified user for %s', async (brand, accounts, openApi) => {
    const auth = await requestUserAuthorization(APP, 'app-secret', brand, ['im:chat:read', 'im:chat:read'], USER, () => current);
    expect(auth.authUrl).toBe(device.verification_uri_complete);
    expect(auth.expiresIn).toBe(300);
    expect(auth.scopes).toContain('offline_access');
    expect(auth.scopes.filter(scope => scope === 'im:chat:read')).toHaveLength(1);
    expect(JSON.stringify(auth)).not.toContain(DEVICE_CODE);
    expect(readdirSync(tokenDir)).toEqual([]);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0];
    expect(requestUrl).toBe(`${accounts}/oauth/v1/device_authorization`);
    expect(requestInit.headers.Authorization).toBe(`Basic ${Buffer.from(`${APP}:app-secret`).toString('base64')}`);
    expect(Object.fromEntries(requestInit.body)).toEqual({ client_id: APP, scope: auth.scopes.join(' ') });
    expect(await auth.poll()).toEqual({ status: 'pending' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    advance(5);
    expect(await auth.poll()).toEqual({ status: 'ready', token: TOKEN });
    expect(fetchMock.mock.calls[1][0]).toBe(`${openApi}/open-apis/authen/v2/oauth/token`);
    expect(Object.fromEntries(fetchMock.mock.calls[1][1].body)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: DEVICE_CODE,
      client_id: APP, client_secret: 'app-secret',
    });
    expect(fetchMock.mock.calls[2][0]).toBe(`${openApi}/open-apis/authen/v1/user_info`);
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const path = join(tokenDir, `user-token-${APP}-${USER}.json`);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      access_token: TOKEN, appId: APP, brand, openId: USER, userName: 'Requester', scope: grantedScope,
    });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(tokenDir)).toEqual([`user-token-${APP}-${USER}.json`]);
    expect(await auth.poll()).toEqual({ status: 'ready', token: TOKEN });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('shares concurrent polls and waits for the provider interval after pending', async () => {
    const auth = await requestUserAuthorization(APP, 'secret', 'feishu', [], USER, () => current);
    let release!: (response: Response) => void;
    tokenFetch = () => new Promise(resolve => { release = resolve; });
    advance(5);
    const first = auth.poll();
    const second = auth.poll();
    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    release(json({ error: 'authorization_pending' }, 400));
    expect(await first).toEqual({ status: 'pending' });
    advance(4);
    expect(await auth.poll()).toEqual({ status: 'pending' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('increases the interval by five seconds after slow_down', async () => {
    const auth = await requestUserAuthorization(APP, 'secret', 'feishu', [], USER, () => current);
    tokenBody = { error: 'slow_down' };
    advance(5);
    expect(await auth.poll()).toEqual({ status: 'pending' });
    advance(9);
    expect(await auth.poll()).toEqual({ status: 'pending' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    tokenBody = { error: 'authorization_pending' };
    advance(1);
    expect(await auth.poll()).toEqual({ status: 'pending' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['access_denied', 'access_denied'],
    ['expired_token', 'expired_token'],
    ['invalid_grant', 'expired_token'],
    ['server_error', 'authorization_token_failed'],
  ])('reports %s without storing credentials', async (error, expected) => {
    const auth = await requestUserAuthorization(APP, 'secret', 'feishu', [], USER, () => current);
    tokenBody = { error, error_description: DEVICE_CODE };
    advance(5);
    expect(await auth.poll()).toEqual({ status: 'failed', error: expected });
    expect(readdirSync(tokenDir)).toEqual([]);
  });

  it.each(['user', 'scope', 'identity'] as const)('rejects unverified %s before saving', async failure => {
    const auth = await requestUserAuthorization(APP, 'secret', 'feishu', ['im:chat:read'], USER, () => current);
    if (failure === 'user') userBody = { code: 0, data: { open_id: 'ou_someone_else' } };
    if (failure === 'scope') tokenBody.scope = grantedScope.replace('im:chat:read', '');
    if (failure === 'identity') userBody = { code: 999, data: {} };
    advance(5);
    const expected = failure === 'identity' ? 'authorization_identity_unverified' : `authorization_${failure}_mismatch`;
    expect(await auth.poll()).toEqual({
      status: 'failed', error: failure === 'scope' ? 'authorization_scope_missing' : expected,
    });
    expect(readdirSync(tokenDir)).toEqual([]);
  });

  it('rechecks the current turn after user identity lookup', async () => {
    const auth = await requestUserAuthorization(APP, 'secret', 'feishu', [], USER, () => current);
    let release!: (response: Response) => void;
    let started!: () => void;
    const userLookupStarted = new Promise<void>(resolve => { started = resolve; });
    userFetch = () => {
      started();
      return new Promise(resolve => { release = resolve; });
    };
    advance(5);
    const poll = auth.poll();
    await userLookupStarted;
    current = false;
    release(json(userBody));
    expect(await poll).toEqual({ status: 'failed', error: 'authorization_origin_changed' });
    expect(readdirSync(tokenDir)).toEqual([]);
  });

  it('expires at the shorter provider deadline without polling again', async () => {
    device.expires_in = 30;
    const auth = await requestUserAuthorization(APP, 'secret', 'feishu', [], USER, () => current);
    expect(auth.expiresIn).toBe(30);
    advance(30);
    expect(await auth.poll()).toEqual({ status: 'failed', error: 'expired_token' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readdirSync(tokenDir)).toEqual([]);
  });

  it('terminates a timed-out token request with a safe error', async () => {
    const auth = await requestUserAuthorization(APP, 'secret', 'feishu', [], USER, () => current);
    tokenFetch = ({ signal }) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    });
    advance(5);
    expect(await auth.poll()).toEqual({ status: 'failed', error: 'authorization_timeout' });
    expect(existsSync(join(tokenDir, `user-token-${APP}-${USER}.json`))).toBe(false);
  });

  it('requires a complete verification link and a current requester', async () => {
    delete device.verification_uri_complete;
    await expect(requestUserAuthorization(APP, 'secret', 'feishu', [], USER, () => current))
      .rejects.toThrow('invalid_device_authorization_response');
    current = false;
    await expect(requestUserAuthorization(APP, 'secret', 'feishu', [], USER, () => current))
      .rejects.toThrow('authorization_origin_changed');
    expect(readdirSync(tokenDir)).toEqual([]);
  });
});
