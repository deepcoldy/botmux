// A WeCom session snapshot re-reads each source after its core answered, and a
// source that stopped being registered meanwhile does not publish what its core
// said. The recheck reads only that source's own files (plus the registry), so
// it must still notice the registration going away.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WecomDashboardSessions, wecomCoreIdentity } from '../src/dashboard/wecom/sessions.js';
import { registerWecomConfig, wecomConfigId } from '../src/im/wecom/config/discovery.js';
import { wecomBotRoot } from '../src/im/wecom/config/runtime.js';
import { createControlledWecomCore, privateUnifiedSessionRow } from './helpers/wecom-controlled-core.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Two managed-core sources, each with one session its gateway knows about. */
async function twoSources() {
  const root = mkdtempSync(join(tmpdir(), 'wecom-session-recheck-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const births = new Map<number, string>();
  const parents = new Map<number, number>();
  const sources = [];
  for (let n = 0; n < 2; n += 1) {
    const corePid = 500 + n, gatewayPid = 700 + n, botId = `wecom-${n}`, coreBotId = `local_core_${n}`, boot = `boot-${n}`;
    births.set(corePid, `core-birth-${n}`);
    births.set(gatewayPid, `gateway-birth-${n}`);
    parents.set(corePid, gatewayPid);
    const row = { ...privateUnifiedSessionRow(`sid-${n}`, coreBotId), title: `session of source ${n}` };
    const core = await createControlledWecomCore({
      health: { ok: true },
      sessions: [row],
      reply: call => (call.path === '/api/core/source-identity'
        ? { body: { coreOnly: true, coreBotId, bootInstanceId: boot, pid: corePid, processStart: births.get(corePid) } }
        : undefined) as any,
    });
    cleanup.push(() => core.close());
    const file = join(root, n ? 'second.json' : 'config.json');
    const stateDir = join(root, `bridge-${n}`), coreState = join(root, `core-${n}`);
    const config = { botId, secretEnv: 'FAKE', coreUrl: core.url, allowedUsers: ['u'], stateDir,
      managedCore: { cli: 'codex', backend: 'pty' as const, workingDirectory: root, port: core.port, stateDir: coreState, botId: coreBotId } };
    writeFileSync(file, JSON.stringify(config));
    if (n) await registerWecomConfig(file, root);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ version: 1, botId, connectionId: wecomConfigId(file), coreIdentity: wecomCoreIdentity(config),
      tasks: { t: { sessionId: `sid-${n}`, triggerId: 'turn', delivered: true, message: { chatType: 'single', text: 'hi' } } }, sessionLocks: {} }));
    mkdirSync(wecomBotRoot(botId, root), { recursive: true });
    writeFileSync(join(wecomBotRoot(botId, root), 'runtime.json'), JSON.stringify({ version: 1, configId: wecomConfigId(file), instanceId: `gw-${n}`,
      pid: gatewayPid, processStart: births.get(gatewayPid), connection: 'connected', phase: 'running', updatedAt: Date.now() }));
    mkdirSync(join(coreState, 'dashboard-daemons'), { recursive: true });
    writeFileSync(join(coreState, 'dashboard-daemons', `${coreBotId}.json`), JSON.stringify({ larkAppId: coreBotId, ipcPort: core.port, pid: corePid,
      bootInstanceId: boot, lastHeartbeat: Date.now() }));
    sources.push({ core, file });
  }
  const service = new WecomDashboardSessions({
    root,
    runtime: { readIdentity: pid => births.get(pid), readCommandLine: () => undefined, readPidNamespace: () => undefined, pidExists: pid => births.has(pid) },
    readParentPid: pid => parents.get(pid),
    fetchCore: (port, path, init) => fetch(`http://127.0.0.1:${port}${path}`, init),
  });
  return { root, sources, service };
}

describe('WeCom session snapshot recheck', () => {
  it('publishes both sources while both stay registered', async () => {
    const f = await twoSources();
    const snapshot = await f.service.snapshot();
    expect(snapshot.complete).toBe(true);
    expect(snapshot.sessions.map(row => row.title).sort()).toEqual(['session of source 0', 'session of source 1']);
  });

  it('drops what a source\'s core said when the source was unregistered while the core answered', async () => {
    const f = await twoSources();
    const second = f.sources[1];
    second.core.hold();
    const pending = f.service.snapshot();
    for (let i = 0; i < 100 && second.core.calls.length === 0; i += 1) await new Promise(done => setTimeout(done, 10));
    expect(second.core.calls.length).toBeGreaterThan(0);

    const registry = join(f.root, 'config-registry.json');
    const listed = JSON.parse(readFileSync(registry, 'utf8'));
    writeFileSync(registry, JSON.stringify({ ...listed, paths: listed.paths.filter((path: string) => path !== second.file) }));
    second.core.release();
    const snapshot = await pending;

    expect(snapshot.sessions.map(row => row.title)).toEqual(['session of source 0']);
    expect(snapshot.complete).toBe(false);
  });
});
