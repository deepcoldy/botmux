// The Dashboard's WeCom session list: when a source's core cannot be read, its
// sessions come from the core's session store on disk, projected with the
// bridge state as re-read at that moment; and a source counts as live exactly
// while its runtime record is fresh by the shared freshness rule.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WecomDashboardSessions, wecomCoreIdentity } from '../src/dashboard/wecom/sessions.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import { isFreshWecomRuntime, wecomBotRoot, WECOM_RUNTIME_EVIDENCE_MS } from '../src/im/wecom/config/runtime.js';
import { nativeGatewaySourceIdentityPath } from '../src/core/native-gateway-contract.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { privateUnifiedSessionRow } from './helpers/wecom-controlled-core.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CORE_PID = 500, GATEWAY_PID = 700, BOOT = 'boot-1', CORE_BOT = 'local_fallback', BOT = 'wecom-fallback';
const births = new Map([[CORE_PID, 'core-birth'], [GATEWAY_PID, 'gateway-birth']]);

/** One managed-core source with one session its gateway knows about; the core is reached only through `fetchCore`. */
function source(options: { now: number; runtimeAge?: number; listSessions?: (state: (tasks: object, locks?: object) => void) => Response }) {
  const root = mkdtempSync(join(tmpdir(), 'wecom-session-fallback-'));
  roots.push(root);
  const file = join(root, 'config.json'), stateDir = join(root, 'bridge'), coreState = join(root, 'core'), port = 19_999;
  const config = { botId: BOT, secretEnv: 'FAKE', coreUrl: `http://127.0.0.1:${port}`, allowedUsers: ['u'], stateDir,
    managedCore: { cli: 'codex', backend: 'pty' as const, workingDirectory: root, port, stateDir: coreState, botId: CORE_BOT } };
  writeFileSync(file, JSON.stringify(config));
  mkdirSync(stateDir, { recursive: true });
  const writeState = (tasks: object, locks: object = {}) => writeFileSync(join(stateDir, 'state.json'), JSON.stringify({
    version: 1, botId: BOT, connectionId: wecomConfigId(file), coreIdentity: wecomCoreIdentity(config), tasks, sessionLocks: locks,
  }));
  writeState({ t1: { sessionId: 'sid', triggerId: 'turn-1', delivered: true, message: { chatType: 'single', text: 'first question' } } });
  const updatedAt = options.now - (options.runtimeAge ?? 0);
  mkdirSync(wecomBotRoot(BOT, root), { recursive: true });
  writeFileSync(join(wecomBotRoot(BOT, root), 'runtime.json'), JSON.stringify({ version: 1, configId: wecomConfigId(file), instanceId: 'gw',
    pid: GATEWAY_PID, processStart: births.get(GATEWAY_PID), connection: 'connected', phase: 'running', updatedAt }));
  mkdirSync(join(coreState, 'dashboard-daemons'), { recursive: true });
  writeFileSync(join(coreState, 'dashboard-daemons', `${CORE_BOT}.json`), JSON.stringify({ larkAppId: CORE_BOT, ipcPort: port, pid: CORE_PID,
    bootInstanceId: BOOT, lastHeartbeat: options.now }));
  const row = privateUnifiedSessionRow('sid', CORE_BOT);
  seedPersistedSessionRows(coreState, CORE_BOT, { sid: row });
  const service = new WecomDashboardSessions({
    root,
    now: () => options.now,
    runtime: { readIdentity: pid => births.get(pid), readCommandLine: () => undefined, readPidNamespace: () => undefined, pidExists: pid => births.has(pid) },
    readParentPid: pid => (pid === CORE_PID ? GATEWAY_PID : undefined),
    fetchCore: async (_port, path) => {
      if (path === nativeGatewaySourceIdentityPath()) {
        return Response.json({ coreOnly: true, coreBotId: CORE_BOT, bootInstanceId: BOOT, pid: CORE_PID, processStart: births.get(CORE_PID) });
      }
      if (path === '/api/sessions') {
        return options.listSessions?.(writeState) ?? Response.json({ sessions: [row] });
      }
      return Response.json({ ok: false }, { status: 404 });
    },
  });
  return { service, updatedAt };
}

describe('WeCom session list', () => {
  // Mutation: projecting the disk rows with the scope read before the core was asked (tasks and locks of
  // the older state) instead of the re-read one turns this red.
  it('projects disk rows with the bridge state as re-read when the core cannot list sessions', async () => {
    const f = source({
      now: Date.now(),
      // While the core is asked, the user sends another message and a management action pends on the session.
      listSessions: writeState => {
        writeState({
          t1: { sessionId: 'sid', triggerId: 'turn-1', delivered: true, message: { chatType: 'single', text: 'first question' } },
          t2: { sessionId: 'sid', triggerId: 'turn-2', delivered: false, message: { chatType: 'single', text: 'second question' } },
        }, { sid: 'pending' });
        return Response.json({ ok: false }, { status: 503 });
      },
    });
    const snapshot = await f.service.snapshot();
    expect(snapshot.complete).toBe(true);
    expect(snapshot.sessions).toHaveLength(1);
    const [row] = snapshot.sessions;
    expect(row.offline).toBe(true);
    expect(row.previewUserText).toBe('second question');
    expect(row.controlGeneration).toBe('turn-2');
    expect(row.managementState).toBe('pending');
  });

  // Mutation: going back to a hand-written `age > 10000` bound in live() turns the boundary age red.
  it.each([WECOM_RUNTIME_EVIDENCE_MS - 1, WECOM_RUNTIME_EVIDENCE_MS, WECOM_RUNTIME_EVIDENCE_MS + 1, -1])(
    'counts a source live exactly while its runtime record is fresh (record age %i ms)',
    async age => {
      const now = Date.now();
      const f = source({ now, runtimeAge: age });
      const [row] = (await f.service.snapshot()).sessions;
      expect(row.offline).toBe(!isFreshWecomRuntime({ updatedAt: f.updatedAt }, now));
    },
  );
});
