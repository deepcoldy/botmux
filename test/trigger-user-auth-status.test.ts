/**
 * Per-person trigger-user status: the three stores, assembled without
 * credential material and without starting a login.
 *
 * Run: bun run test test/trigger-user-auth-status.test.ts
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const statuses = new Map<string, { code: number; stdout?: string }>();
const spawned: string[][] = [];

vi.mock('node:child_process', () => ({
  spawn: vi.fn((_cmd: string, args: string[], opts: { env?: Record<string, string> }) => {
    spawned.push(args);
    const reply = statuses.get(opts?.env?.HOME ?? '') ?? { code: 0, stdout: '{"status":"success","data":{"authenticated":false}}\n' };
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (reply.stdout) child.stdout.emit('data', reply.stdout);
      child.emit('close', reply.code);
    });
    return child;
  }),
}));

const APP = 'cli_statusprobe';
const ALICE = 'ou_statusalice';
const BOB = 'ou_statusbob';
const CAROL = 'ou_statuscarol';
const ACCESS = 'probe-access-token-do-not-leak';
const REFRESH = 'probe-refresh-token-do-not-leak';
const ENC = 'enc-secret-bytes-do-not-leak';
const JWT = 'cloud-jwt-do-not-leak';

let root: string;
let queryTriggerUserAuthStatus: typeof import('../src/services/trigger-user-auth-status.js').queryTriggerUserAuthStatus;
let bytedcliHomeFor: (openId: string) => string;
let larkCliHomeFor: (openId: string) => string;
let setLarkRoot: (root: string | null) => void;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'botmux-tua-status-'));
  vi.stubEnv('HOME', root);
  vi.resetModules();
  ({ queryTriggerUserAuthStatus } = await import('../src/services/trigger-user-auth-status.js'));
  ({ bytedcliHomeFor } = await import('../src/services/bytedcli-auth.js'));
  const lark = await import('../src/services/lark-cli-auth.js');
  larkCliHomeFor = lark.larkCliHomeFor;
  setLarkRoot = lark.__setLarkCliHomeRootForTest;
  setLarkRoot(join(root, 'lark-homes'));
});

afterAll(() => {
  setLarkRoot?.(null);
  if (root) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function tokenFile(openId: string, extra: Record<string, unknown>) {
  const dir = join(root, '.botmux', 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `user-token-${APP}-${openId}.json`), JSON.stringify({
    access_token: ACCESS, refresh_token: REFRESH, token_type: 'Bearer',
    expires_at: '2099-01-01T00:00:00.000Z', refresh_expires_at: '2099-06-01T00:00:00.000Z',
    scope: 'im:message:readonly', appId: APP, brand: 'feishu', openId, ...extra,
  }));
}

function larkLogin(openId: string) {
  const home = larkCliHomeFor(openId);
  const dataDir = join(home, '.local', 'share', 'lark-cli');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(home, '.lark-cli'), { recursive: true });
  writeFileSync(join(home, '.lark-cli', 'config.json'), JSON.stringify({ apps: [] }));
  writeFileSync(join(dataDir, `${APP}_${openId}.enc`), ENC);
}

describe('queryTriggerUserAuthStatus', () => {
  it('reports each store for the asked person and nobody else', async () => {
    tokenFile(ALICE, {});
    tokenFile(BOB, {
      access_token: 'bob-access-token',
      expires_at: '2000-01-01T00:00:00.000Z',
      refresh_expires_at: '2000-02-01T00:00:00.000Z',
    });
    tokenFile(CAROL, {
      access_token: 'carol-access-token',
      expires_at: '2098-01-01T00:00:00.000Z',
      refresh_expires_at: '2098-06-01T00:00:00.000Z',
    });
    larkLogin(ALICE);
    const home = bytedcliHomeFor(ALICE);
    mkdirSync(home, { recursive: true });
    statuses.set(home, {
      code: 0,
      stdout: `${JSON.stringify({
        status: 'success',
        data: {
          authenticated: true,
          bytecloud_auth: { authType: 'user', expires_at: '2030-01-01T00:00:00.000Z' },
          access_token: JWT,
        },
      })}\n`,
    });
    spawned.length = 0;

    const alice = await queryTriggerUserAuthStatus({ appId: APP, brand: 'feishu', openId: ALICE });
    const bob = await queryTriggerUserAuthStatus({ appId: APP, brand: 'feishu', openId: BOB });
    const carol = await queryTriggerUserAuthStatus({ appId: APP, brand: 'feishu', openId: CAROL });

    expect(alice).toEqual({
      openId: ALICE,
      coverage: 'local-stores',
      tools: {
        bytedcli: { state: 'authorized', basis: 'provider-probe', expiresAt: '2030-01-01T00:00:00.000Z' },
        'lark-cli': { state: 'authorized', basis: 'file-present' },
        'user-token': {
          state: 'authorized',
          basis: 'expiry-check',
          expiresAt: '2099-01-01T00:00:00.000Z',
          refreshExpiresAt: '2099-06-01T00:00:00.000Z',
        },
      },
    });
    expect(bob).toEqual({
      openId: BOB,
      coverage: 'local-stores',
      tools: {
        bytedcli: { state: 'needs-login', basis: 'provider-probe' },
        'lark-cli': { state: 'needs-login', basis: 'file-present' },
        'user-token': {
          state: 'needs-login',
          basis: 'expiry-check',
          expiresAt: '2000-01-01T00:00:00.000Z',
          refreshExpiresAt: '2000-02-01T00:00:00.000Z',
        },
      },
    });
    // No device-login file, but a still-usable legacy user token: the turn
    // path injects that token for lark-cli, so this status must not say
    // needs-login.
    expect(carol).toEqual({
      openId: CAROL,
      coverage: 'local-stores',
      tools: {
        bytedcli: { state: 'needs-login', basis: 'provider-probe' },
        'lark-cli': {
          state: 'authorized',
          basis: 'expiry-check',
          expiresAt: '2098-01-01T00:00:00.000Z',
          refreshExpiresAt: '2098-06-01T00:00:00.000Z',
        },
        'user-token': {
          state: 'authorized',
          basis: 'expiry-check',
          expiresAt: '2098-01-01T00:00:00.000Z',
          refreshExpiresAt: '2098-06-01T00:00:00.000Z',
        },
      },
    });
    const packed = JSON.stringify({ alice, bob, carol });
    expect(packed).not.toContain(ACCESS);
    expect(packed).not.toContain(REFRESH);
    expect(packed).not.toContain(ENC);
    expect(packed).not.toContain(JWT);
    expect(packed).not.toContain('bob-access-token');
    expect(packed).not.toContain('carol-access-token');
    expect(spawned).toEqual([['auth', 'status', '--json']]);
  });
});
