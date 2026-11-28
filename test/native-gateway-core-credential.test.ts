/**
 * The credential a native gateway shares with its dedicated core
 * (core/native-gateway-credential.ts), on the core's real IPC server:
 *  - with it, the core trusts a request signed with either that credential or
 *    the Dashboard secret, and the routes only the gateway calls
 *    (NATIVE_GATEWAY_EXCLUSIVE_ROUTE_PATTERNS) with the credential alone —
 *    including the core-only control routes (trigger, its result, exact-turn
 *    interrupt, insight, host facts), which then need a signature as well,
 *    and still answer 503 before any authentication while the core restores;
 *  - a Feishu daemon, a bare core-only service and a native core started
 *    without one decide every request exactly as before: by the Dashboard
 *    secret only, apart from the core-only control routes a core-only service
 *    serves unsigned;
 *  - the core entry takes it out of its environment at start, and neither a
 *    worker's nor a CLI's environment carries it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __testOnly_resetBotRegistry,
  parseBotConfigsFromText,
  registerBot,
} from '../src/bot-registry.js';
import {
  __testOnly_setNativeGatewayCoreCredential,
  NATIVE_GATEWAY_CORE_CREDENTIAL_ENV,
  nativeGatewayCoreCredential,
  takeNativeGatewayCoreCredential,
} from '../src/core/native-gateway-credential.js';
import {
  NATIVE_GATEWAY_TRIGGER_PATH,
  nativeGatewayAskCallbackPath,
  nativeGatewayAsksPath,
  nativeGatewayCoreProfilePath,
  nativeGatewayInterruptPath,
  nativeGatewayProgressPath,
  nativeGatewayReminderStatePath,
  nativeGatewaySourceIdentityPath,
  nativeGatewayTriggerResultPath,
} from '../src/core/native-gateway-contract.js';
import {
  __testOnly_resetCoreOnlyReadiness,
  armCoreOnlyReadinessGate,
  setCoreOnlyReady,
  setIpcAuthSecret,
  setLarkAppId,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { sessionEnvWorkerBase } from '../src/core/worker-pool.js';
import { redactChildEnv } from '../src/utils/child-env.js';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';

const BOT = 'local_credential_fixture';
const DASHBOARD = randomBytes(32).toString('base64url');
const GATEWAY = randomBytes(32).toString('base64url');
const OTHER = randomBytes(32).toString('base64url');
const MODE_KEYS = ['BOTMUX_CORE_ONLY', 'BOTMUX_NATIVE_GATEWAY_CORE', NATIVE_GATEWAY_CORE_CREDENTIAL_ENV];
const saved = new Map<string, string | undefined>();
const dirs: string[] = [];
let server: IpcServerHandle | undefined;

beforeEach(() => {
  for (const key of MODE_KEYS) saved.set(key, process.env[key]);
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  __testOnly_resetCoreOnlyReadiness();
  setIpcAuthSecret(null);
  setLarkAppId('');
  __testOnly_setNativeGatewayCoreCredential(undefined);
  __testOnly_resetBotRegistry();
  for (const key of MODE_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Form = 'native-with-credential' | 'native-without-credential' | 'bare-core-only' | 'feishu';

async function serve(form: Form, ready?: Promise<void>): Promise<void> {
  for (const key of MODE_KEYS) delete process.env[key];
  if (form !== 'feishu') process.env.BOTMUX_CORE_ONLY = '1';
  if (form.startsWith('native')) process.env.BOTMUX_NATIVE_GATEWAY_CORE = '1';
  // The core entry's own step: whatever the form, the variable is taken out.
  process.env[NATIVE_GATEWAY_CORE_CREDENTIAL_ENV] = GATEWAY;
  if (form === 'native-without-credential') delete process.env[NATIVE_GATEWAY_CORE_CREDENTIAL_ENV];
  takeNativeGatewayCoreCredential(process.env);
  expect(process.env[NATIVE_GATEWAY_CORE_CREDENTIAL_ENV]).toBeUndefined();
  __testOnly_resetBotRegistry();
  registerBot(parseBotConfigsFromText(JSON.stringify([{ larkAppId: BOT, apiOnly: true, cliId: 'codex' }]))[0]!);
  setIpcAuthSecret(DASHBOARD);
  setLarkAppId(BOT);
  server = await startIpcServer({
    port: 0,
    host: '127.0.0.1',
    authRequired: true,
    coreOnlyPublicRoutes: form !== 'feishu',
    ...(ready ? { ready } : {}),
  });
}

type Decision = 'passed' | 'unauthorized' | 'gateway_only' | 'restoring';

/** `secret` undefined: an unsigned request. */
async function send(method: 'GET' | 'POST', path: string, secret: string | undefined, headers?: Headers): Promise<{ decision: Decision; headers: Headers }> {
  const base = { 'content-type': 'application/json' };
  const signed = headers ?? (secret === undefined
    ? new Headers(base)
    : daemonIpcAuthHeaders({ secret, port: server!.port, method, path, headers: base }));
  const response = await fetch(`http://127.0.0.1:${server!.port}${path}`, {
    method,
    headers: signed,
    ...(method === 'POST' ? { body: '{}' } : {}),
    // A request held back (e.g. on the restore barrier) fails here instead of hanging the test.
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json() as { error?: string; status?: string };
  const decision: Decision = response.status === 401 ? 'unauthorized'
    : response.status === 403 && body.error === 'native_gateway_credential_required' ? 'gateway_only'
      : response.status === 503 && body.status === 'starting' ? 'restoring'
        : 'passed';
  return { decision, headers: signed };
}

const EXCLUSIVE: Array<['GET' | 'POST', string]> = [
  ['GET', nativeGatewayAsksPath('session', 'turn')],
  ['POST', nativeGatewayAskCallbackPath('session')],
  ['GET', nativeGatewayProgressPath('session', 'turn')],
  ['GET', nativeGatewayReminderStatePath('session', 'turn')],
  ['POST', nativeGatewayCoreProfilePath()],
];
const ORDINARY: Array<['GET' | 'POST', string]> = [
  ['GET', nativeGatewaySourceIdentityPath()],
  ['GET', '/api/sessions'],
];
/**
 * The core-only control routes (served unsigned by a core-only service without
 * the credential). Only the gateway stops a turn of its core — the Dashboard
 * asks the gateway; the gateway and `botmux headless` (Dashboard secret) both
 * trigger and read results, and the Dashboard reads insight directly.
 */
const CORE_ONLY_GATEWAY_ONLY: Array<['GET' | 'POST', string]> = [
  ['POST', nativeGatewayInterruptPath('session', 'turn')],
];
const CORE_ONLY_ORDINARY: Array<['GET' | 'POST', string]> = [
  ['POST', NATIVE_GATEWAY_TRIGGER_PATH],
  ['GET', nativeGatewayTriggerResultPath('session', 'turn')],
  ['GET', '/api/sessions/session/insight'],
  ['GET', '/api/sessions/session/host-facts'],
];
const CORE_ONLY = [...CORE_ONLY_GATEWAY_ONLY, ...CORE_ONLY_ORDINARY];
const KEYS = { gateway: GATEWAY, dashboard: DASHBOARD, other: OTHER, unsigned: undefined } as const;
type Key = keyof typeof KEYS;
const ALL_KEYS = Object.keys(KEYS) as Key[];

describe('a native gateway core started with its gateway\'s credential', () => {
  it('admits the gateway\'s credential everywhere, the Dashboard secret everywhere but the gateway-only routes, nothing else', async () => {
    await serve('native-with-credential');
    expect(nativeGatewayCoreCredential()).toBe(GATEWAY);
    for (const [method, path] of [...EXCLUSIVE, ...CORE_ONLY_GATEWAY_ONLY]) {
      expect((await send(method, path, KEYS.gateway)).decision, `gateway ${path}`).toBe('passed');
      expect((await send(method, path, KEYS.dashboard)).decision, `dashboard ${path}`).toBe('gateway_only');
      expect((await send(method, path, KEYS.other)).decision, `other ${path}`).toBe('unauthorized');
      expect((await send(method, path, KEYS.unsigned)).decision, `unsigned ${path}`).toBe('unauthorized');
    }
    for (const [method, path] of [...ORDINARY, ...CORE_ONLY_ORDINARY]) {
      expect((await send(method, path, KEYS.gateway)).decision, `gateway ${path}`).toBe('passed');
      // Verified after the credential failed: that failure recorded no nonce.
      expect((await send(method, path, KEYS.dashboard)).decision, `dashboard ${path}`).toBe('passed');
      expect((await send(method, path, KEYS.other)).decision, `other ${path}`).toBe('unauthorized');
      expect((await send(method, path, KEYS.unsigned)).decision, `unsigned ${path}`).toBe('unauthorized');
    }
  });

  it('answers the core-only control routes 503 while it restores, before authenticating and without waiting', async () => {
    let restored!: () => void;
    const ready = new Promise<void>(resolve => { restored = resolve; });
    await serve('native-with-credential', ready);
    armCoreOnlyReadinessGate();
    for (const [method, path] of CORE_ONLY) {
      for (const key of ALL_KEYS) {
        expect((await send(method, path, KEYS[key])).decision, `${key} ${path}`).toBe('restoring');
      }
    }
    // Restore done (in the daemon's order): authenticated as above again.
    restored();
    setCoreOnlyReady();
    for (const [method, path] of CORE_ONLY) {
      expect((await send(method, path, KEYS.gateway)).decision, `gateway ${path}`).toBe('passed');
      expect((await send(method, path, KEYS.unsigned)).decision, `unsigned ${path}`).toBe('unauthorized');
    }
  });

  it('refuses a replayed request, whichever key signed it', async () => {
    await serve('native-with-credential');
    for (const secret of [GATEWAY, DASHBOARD]) {
      const first = await send('GET', nativeGatewaySourceIdentityPath(), secret);
      expect(first.decision).toBe('passed');
      expect((await send('GET', nativeGatewaySourceIdentityPath(), secret, first.headers)).decision).toBe('unauthorized');
    }
  });
});

describe('every other process decides by the Dashboard secret alone, as before', () => {
  // The rule before the credential existed: trusted when, and only when, the
  // Dashboard secret signed it — except the core-only control routes, which a
  // core-only service serves to anyone.
  const before = (form: Form, route: 'core-only' | 'other', key: Key): Decision =>
    route === 'core-only' && form !== 'feishu' ? 'passed'
      : key === 'dashboard' ? 'passed' : 'unauthorized';

  it.each(['feishu', 'bare-core-only', 'native-without-credential'] as const)('%s', async form => {
    await serve(form);
    expect(nativeGatewayCoreCredential()).toBeUndefined();
    const routes = [
      ...[...EXCLUSIVE, ...ORDINARY].map(([method, path]) => [method, path, 'other'] as const),
      ...CORE_ONLY.map(([method, path]) => [method, path, 'core-only'] as const),
    ];
    for (const [method, path, route] of routes) {
      for (const key of ALL_KEYS) {
        expect((await send(method, path, KEYS[key])).decision, `${key} ${path}`).toBe(before(form, route, key));
      }
    }
  });

  it.each(['bare-core-only', 'native-without-credential'] as const)('%s answers the core-only control routes 503 while it restores', async form => {
    await serve(form, new Promise<void>(() => {}));
    armCoreOnlyReadinessGate();
    for (const [method, path] of CORE_ONLY) {
      for (const key of ALL_KEYS) {
        expect((await send(method, path, KEYS[key])).decision, `${key} ${path}`).toBe('restoring');
      }
    }
  });
});

describe('the credential never reaches a child', () => {
  it('the core entry removes it from its environment at start and keeps it in memory only', () => {
    const home = mkdtempSync(join(tmpdir(), 'core-credential-entry-'));
    dirs.push(home);
    const credentialModule = new URL('../src/core/native-gateway-credential.js', import.meta.url).href;
    const entry = new URL('../src/index-core-only.js', import.meta.url).href;
    const result = spawnSyncTsEvalWithRepoImports([
      "import { writeSync } from 'node:fs';",
      `import { nativeGatewayCoreCredential } from ${JSON.stringify(credentialModule)};`,
      `const name = ${JSON.stringify(NATIVE_GATEWAY_CORE_CREDENTIAL_ENV)};`,
      `const expected = ${JSON.stringify(GATEWAY)};`,
      // An invalid port ends the entry right after its boot-time environment steps.
      "process.on('exit', () => writeSync(1, JSON.stringify({ inEnvironment: name in process.env, held: nativeGatewayCoreCredential() === expected })));",
      `await import(${JSON.stringify(entry)});`,
    ].join('\n'), {
      // The repo root, where the TypeScript loader resolves; the entry uses HOME and the state dir.
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        BOTMUX_API_PORT: 'invalid',
        BOTMUX_CORE_SKIP_DOTENV: '1',
        BOTMUX_CORE_ONLY: '1',
        BOTMUX_NATIVE_GATEWAY_CORE: '1',
        BOTMUX_CORE_STATE_DIR: join(home, 'state'),
        [NATIVE_GATEWAY_CORE_CREDENTIAL_ENV]: GATEWAY,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(String(result.stdout), String(result.stderr)).toBe(JSON.stringify({ inEnvironment: false, held: true }));
  }, 90_000);

  it('a worker fork environment and a CLI environment drop it even if a process still had it', () => {
    process.env.BOTMUX_CORE_ONLY = '1';
    process.env.BOTMUX_NATIVE_GATEWAY_CORE = '1';
    process.env[NATIVE_GATEWAY_CORE_CREDENTIAL_ENV] = GATEWAY;
    expect(sessionEnvWorkerBase()[NATIVE_GATEWAY_CORE_CREDENTIAL_ENV]).toBeUndefined();
    expect(sessionEnvWorkerBase({ mode: 'strict', inherit: [] })[NATIVE_GATEWAY_CORE_CREDENTIAL_ENV]).toBeUndefined();
    expect(redactChildEnv(process.env)[NATIVE_GATEWAY_CORE_CREDENTIAL_ENV]).toBeUndefined();
  });

  it('a malformed value, or one handed to a core that is not a native gateway\'s, is not kept', () => {
    takeNativeGatewayCoreCredential({ BOTMUX_CORE_ONLY: '1', [NATIVE_GATEWAY_CORE_CREDENTIAL_ENV]: GATEWAY });
    expect(nativeGatewayCoreCredential()).toBeUndefined();
    process.env.BOTMUX_CORE_ONLY = '1';
    process.env.BOTMUX_NATIVE_GATEWAY_CORE = '1';
    takeNativeGatewayCoreCredential({ BOTMUX_CORE_ONLY: '1', BOTMUX_NATIVE_GATEWAY_CORE: '1', [NATIVE_GATEWAY_CORE_CREDENTIAL_ENV]: 'short' });
    expect(nativeGatewayCoreCredential()).toBeUndefined();
  });
});
