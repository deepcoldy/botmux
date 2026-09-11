/** Independent acceptance: real files and subprocesses, no real account or live daemon. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotConfig } from '../src/bot-registry.js';
import {
  codexInstanceEnv,
  codexInstanceIdentity,
  newSessionCodexInstanceState,
  normalizeCodexInstancePool,
  selectWeightedCodexInstance,
  validateCodexInstanceHome,
  clearCodexInstanceBots,
  registerCodexInstanceBot,
  type CodexInstancePool,
  type SessionCreationSource,
} from '../src/services/codex-instance-pool.js';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';
import * as sessionStore from '../src/services/session-store.js';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync, spawnSync } from 'node:child_process';
import { assertCodexInstanceConfigWrite } from '../src/services/codex-instance-config-guard.js';
import { resolveCliRuntime, snapshotCliRuntime } from '../src/adapters/cli/runtime.js';

const storePaths = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return storePaths.dataDir; } } } }));

let root: string;
let a: string;
let b: string;
function accountHome(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens: { account_id: `fake-${name}`, access_token: 'NOT-A-REAL-TOKEN' } }), { mode: 0o600 });
  return realpathSync(dir);
}
function pool(): CodexInstancePool {
  return {
    enabled: true, defaultInstanceId: 'a', scope: 'ordinary-feishu', strategy: 'random',
    instances: [{ id: 'a', codexHome: a, weight: 3 }, { id: 'b', codexHome: b, weight: 1 }],
  };
}
function bot(overrides: Partial<CodexInstancePool> = {}): BotConfig {
  return { larkAppId: 'acceptance-app', cliId: 'codex', backendType: 'tmux', codexInstancePool: { ...pool(), ...overrides } } as BotConfig;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-instance-acceptance-')));
  a = accountHome('a');
  b = accountHome('b');
  storePaths.dataDir = join(root, 'store');
  clearCodexInstanceBots();
});
afterEach(() => {
  sessionStore.__testOnly_setBeforeRowPersist(undefined);
  clearCodexInstanceBots();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('A1: deterministic weighted allocation', () => {
  it('defaults omitted weights to equal intervals', () => {
    const candidates = [{ id: 'a' }, { id: 'b' }];
    for (const [r, id] of [[0, 'a'], [0.499999, 'a'], [0.5, 'b'], [0.999999, 'b']] as const) {
      expect(selectWeightedCodexInstance(candidates, () => r).id).toBe(id);
    }
    const normalized = normalizeCodexInstancePool({ ...pool(), instances: candidates.map(i => ({ ...i, codexHome: i.id === 'a' ? a : b })) }, bot());
    expect(normalized?.instances.map(i => i.weight)).toEqual([1, 1]);
  });
  it('uses the 3:1 boundary rather than round robin', () => {
    for (const [r, id] of [[0, 'a'], [0.749999, 'a'], [0.75, 'b'], [0.999999, 'b']] as const) {
      expect(newSessionCodexInstanceState(bot(), 'ordinary-feishu', () => r).cliInstanceBinding?.instanceId).toBe(id);
    }
  });
  it.each([0, -1, 0.5, NaN, Infinity, '3', null])('rejects invalid configured weight %s', weight => {
    const p = pool();
    (p.instances[0] as unknown as { weight: unknown }).weight = weight;
    expect(() => normalizeCodexInstancePool(p, bot())).toThrow();
  });
});

describe('A2/A3/A7: explicit home, default and scope', () => {
  it('requires a real default ID and explicit absolute directories', () => {
    expect(() => normalizeCodexInstancePool({ ...pool(), defaultInstanceId: 'missing' }, bot())).toThrow();
    for (const codexHome of ['', './a', '~/a', '$HOME/a']) {
      expect(() => normalizeCodexInstancePool({ ...pool(), instances: [{ id: 'a', codexHome }] }, bot())).toThrow();
    }
  });
  it('rejects duplicate and nested homes and world-readable credentials', () => {
    for (const home of [a, join(a, 'nested')]) {
      expect(() => normalizeCodexInstancePool({ ...pool(), instances: [{ id: 'a', codexHome: a }, { id: 'b', codexHome: home }] }, bot())).toThrow();
    }
    chmodSync(join(a, 'auth.json'), 0o644);
    expect(() => validateCodexInstanceHome(a)).toThrow();
  });
  it('rejects leaf symlinks and does not create a missing home on launch', () => {
    const alias = join(root, 'alias');
    symlinkSync(a, alias);
    expect(() => validateCodexInstanceHome(alias)).toThrow();
    const missing = join(root, 'missing');
    const cfg = bot({ instances: [{ id: 'a', codexHome: missing }] });
    expect(() => newSessionCodexInstanceState(cfg, 'ordinary-feishu')).toThrow();
    expect(existsSync(missing)).toBe(false);
  });
  it('rejects canonical aliasing even on the default route', () => {
    const link = join(root, 'alias-parent');
    symlinkSync(root, link);
    const cfg = bot({ instances: [{ id: 'a', codexHome: a }, { id: 'b', codexHome: join(link, 'a') }] });
    expect(() => newSessionCodexInstanceState(cfg, 'http')).toThrow();
  });
  it('management preflight allows absent auth but still rejects unsafe existing credentials', () => {
    const auth = join(a, 'auth.json');
    chmodSync(auth, 0o644);
    expect(() => validateCodexInstanceHome(a, { requireAuth: false })).toThrow();
    rmSync(auth);
    symlinkSync(join(b, 'auth.json'), auth);
    expect(() => validateCodexInstanceHome(a, { requireAuth: false })).toThrow();
    rmSync(auth);
    expect(validateCodexInstanceHome(a, { requireAuth: false })).toBe(a);
  });
  it.each<SessionCreationSource>(['schedule', 'http', 'workflow', 'other'])('uses the default for %s even when RNG would choose B', source => {
    const result = newSessionCodexInstanceState(bot(), source, () => { throw new Error('default must not draw'); });
    expect(result.cliInstanceBinding).toMatchObject({ source: 'default', instanceId: 'a', codexHome: a });
    expect(result.creationSource).toBe(source);
  });
  it('stops random allocation without revoking the default or mutating existing bindings', () => {
    const cfg = bot();
    const original = newSessionCodexInstanceState(cfg, 'ordinary-feishu', () => 0.99);
    const saved = JSON.stringify(original);
    cfg.codexInstancePool!.enabled = false;
    cfg.codexInstancePool!.instances.forEach(i => { i.enabled = false; });
    expect(newSessionCodexInstanceState(cfg, 'ordinary-feishu').cliInstanceBinding?.instanceId).toBe('a');
    cfg.codexInstancePool!.enabled = true;
    expect(() => newSessionCodexInstanceState(cfg, 'ordinary-feishu')).toThrow();
    expect(newSessionCodexInstanceState(cfg, 'schedule').cliInstanceBinding?.instanceId).toBe('a');
    expect(JSON.stringify(original)).toBe(saved);
  });
  it('does not fall back when the explicit default is unavailable', () => {
    rmSync(join(a, 'auth.json'));
    expect(() => newSessionCodexInstanceState(bot(), 'http')).toThrow();
    expect(newSessionCodexInstanceState(bot(), 'ordinary-feishu', () => 0).cliInstanceBinding?.instanceId).toBe('b');
  });
  it('keeps unconfigured CLI setups unchanged', () => {
    for (const cliId of ['codex', 'claude-code', 'traex'] as const) {
      expect(newSessionCodexInstanceState({ cliId } as BotConfig, 'ordinary-feishu')).toEqual({});
    }
  });
  it('early runtime freezing preserves the bot reasoning effort for new sessions', () => {
    const configured = { ...bot(), reasoningEffort: 'high' as const };
    const created = newSessionCodexInstanceState(configured, 'http');
    expect(created.agentFrozen).toBe(true);
    expect(created.reasoningEffort).toBe('high');
  });
});

describe('A6: isolated process and transcript roots', () => {
  it('pins each child environment and preserves the parent and both auth files', () => {
    const stateA = newSessionCodexInstanceState(bot(), 'ordinary-feishu', () => 0);
    const stateB = newSessionCodexInstanceState(bot(), 'ordinary-feishu', () => 0.99);
    const parent = { ...process.env, CODEX_HOME: join(root, 'wrong'), OPENAI_API_KEY: 'fake-inherited-key' };
    const beforeParent = { ...parent };
    const authBefore = [a, b].map(home => readFileSync(join(home, 'auth.json'), 'utf8'));
    for (const state of [stateA, stateB]) {
      const env = codexInstanceEnv(parent, state.cliInstanceBinding);
      expect(env.OPENAI_API_KEY).toBeUndefined();
      const result = spawnSyncTsEvalWithRepoImports(`
        import { codexHome, codexHistoryPath } from './src/services/codex-paths.js';
        import { appendFileSync } from 'node:fs';
        appendFileSync(codexHistoryPath(), JSON.stringify({ home: codexHome() }) + '\\n');
        process.stdout.write(JSON.stringify({ home: codexHome(), history: codexHistoryPath() }));
      `, { cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000 });
      expect(result.error).toBeUndefined();
      expect(result.status, String(result.stderr)).toBe(0);
      expect(JSON.parse(String(result.stdout))).toEqual({ home: state.cliInstanceBinding!.codexHome, history: join(state.cliInstanceBinding!.codexHome, 'history.jsonl') });
    }
    expect(parent).toEqual(beforeParent);
    expect(existsSync(join(root, 'wrong'))).toBe(false);
    expect([a, b].map(home => readFileSync(join(home, 'auth.json'), 'utf8'))).toEqual(authBefore);
    expect(readFileSync(join(a, 'history.jsonl'), 'utf8')).not.toContain(b);
    expect(readFileSync(join(b, 'history.jsonl'), 'utf8')).not.toContain(a);
  });
  it('the actual shell wrapper overrides rcfile credentials only for an instance launch', async () => {
    const { buildBotmuxEnvAssignments, shellWrapperScript } = await import('../src/adapters/backend/tmux-backend.js');
    const rc = join(root, 'fake.bashrc');
    writeFileSync(rc, 'export OPENAI_API_KEY=fake-rc-key\nexport CODEX_HOME=/wrong-from-rc\n');
    const binding = newSessionCodexInstanceState(bot(), 'http').cliInstanceBinding!;
    const env = { ...codexInstanceEnv(process.env, binding), BOTMUX_CODEX_INSTANCE_BINDING: 'acceptance-marker' };
    const run = (instance: boolean) => {
      const assignments = buildBotmuxEnvAssignments(instance ? env : { ...env, BOTMUX_CODEX_INSTANCE_BINDING: undefined });
      return spawnSync('/bin/bash', ['--rcfile', rc, '-i', '-c', shellWrapperScript(join(root, 'bin'), 'bash'), '_', root,
        ...assignments, process.execPath, '-e', 'process.stdout.write(JSON.stringify({home:process.env.CODEX_HOME,key:process.env.OPENAI_API_KEY??null}))'],
      { env: { ...process.env }, encoding: 'utf8', timeout: 10_000 });
    };
    const scoped = run(true);
    expect(scoped.error).toBeUndefined();
    expect(scoped.status, scoped.stderr).toBe(0);
    expect(JSON.parse(scoped.stdout)).toEqual({ home: a, key: null });
    const unscoped = run(false);
    expect(unscoped.status, unscoped.stderr).toBe(0);
    expect(JSON.parse(unscoped.stdout).key).toBe('fake-rc-key');
  });
});

describe('A8: persistent tmux identity gate', () => {
  it.skipIf(process.platform === 'win32' || spawnSync('tmux', ['-V'], { timeout: 3000 }).status !== 0)('rejects a different binding without killing or changing the existing pane', async () => {
    const { TmuxBackend } = await import('../src/adapters/backend/tmux-backend.js');
    // Keep the socket path short on macOS; never contact the user's default server.
    const socketRoot = mkdtempSync('/tmp/bmx-instance-acceptance-');
    vi.stubEnv('TMUX_TMPDIR', socketRoot);
    const env = { ...process.env, HOME: root, TMUX: undefined, TMUX_PANE: undefined };
    const tmux = (args: string[]) => execFileSync('tmux', args, { env, encoding: 'utf8', timeout: 5000 });
    const name = 'acceptance-instance';
    try {
      tmux(['-f', '/dev/null', 'new-session', '-d', '-s', name, '-e', 'BOTMUX_CODEX_INSTANCE_BINDING=binding-a', '/bin/sleep', '60']);
      const pid = tmux(['display-message', '-p', '-t', name, '#{pane_pid}']).trim();
      expect(() => TmuxBackend.assertInstanceIdentity(name, 'binding-a')).not.toThrow();
      expect(() => TmuxBackend.assertInstanceIdentity(name, 'binding-b')).toThrow(/preserved/);
      expect(tmux(['display-message', '-p', '-t', name, '#{pane_pid}']).trim()).toBe(pid);
      tmux(['set-environment', '-u', '-t', name, 'BOTMUX_CODEX_INSTANCE_BINDING']);
      expect(() => TmuxBackend.assertInstanceIdentity(name, 'binding-a')).toThrow(/preserved/);
      expect(tmux(['display-message', '-p', '-t', name, '#{pane_pid}']).trim()).toBe(pid);
    } finally {
      spawnSync('tmux', ['kill-server'], { env, timeout: 5000 });
      const probe = spawnSync('tmux', ['has-session', '-t', name], { env, encoding: 'utf8', timeout: 5000 });
      rmSync(socketRoot, { recursive: true, force: true });
      expect(probe.status).not.toBe(0);
    }
  });
});

describe('A10: actual management commands with a fake login executable', () => {
  it('initializes only the selected home, logs in there and reports unverified identity without exposing credentials', () => {
    const home = join(root, 'managed-a');
    const cli = join(root, 'fake-instance-cli');
    const observation = join(root, 'fake-login.jsonl');
    writeFileSync(cli, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(${JSON.stringify(observation)}, JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME,key:process.env.OPENAI_API_KEY??null})+'\\n');
fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),JSON.stringify({tokens:{access_token:'ACCEPTANCE-SECRET-NOT-REAL'}}),{mode:0o600});
`, { mode: 0o755 });
    const configured = { ...bot({ instances: [{ id: 'a', codexHome: home }, { id: 'b', codexHome: b }] }), apiOnly: true, cliPathOverride: cli,
      cliRuntime: { id: 'fixture-codex', executable: cli, update: { provider: 'none' } } };
    const configFile = join(root, 'bots.json');
    writeFileSync(configFile, JSON.stringify([configured]), { mode: 0o600 });
    const run = (action: string, extra: string[] = []) => spawnSyncTsEvalWithRepoImports(`
      import { runCodexInstancesCommand } from './src/cli/codex-instances.js';
      await runCodexInstancesCommand(${JSON.stringify([action, '--bot', 'acceptance-app', '--instance', 'a', ...extra])});
    `, { cwd: process.cwd(), env: { ...process.env, HOME: root, BOTS_CONFIG: configFile, SESSION_DATA_DIR: storePaths.dataDir,
      CODEX_HOME: b, OPENAI_API_KEY: 'wrong-parent-key' }, encoding: 'utf8', timeout: 10_000 });
    const init = run('init');
    expect(init.status, String(init.stderr)).toBe(0);
    const originalConfig = readFileSync(join(home, 'config.toml'), 'utf8');
    expect(existsSync(join(home, 'auth.json'))).toBe(false);
    expect(run('init').status).toBe(0);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(originalConfig);
    const login = run('login');
    expect(login.status, String(login.stderr)).toBe(0);
    expect(JSON.parse(readFileSync(observation, 'utf8').trim())).toEqual({ args: ['login', '--device-auth'], home, key: null });
    const refused = run('login');
    expect(refused.status).not.toBe(0);
    expect(String(refused.stderr)).toContain('--reauth');
    expect(run('login', ['--reauth']).status).toBe(0);
    expect(readFileSync(observation, 'utf8').trim().split('\n')).toHaveLength(2);
    const check = run('check');
    expect(check.status, String(check.stderr)).toBe(0);
    expect(String(check.stdout)).toContain('"accountIdentity": "unverified"');
    expect(String(check.stdout)).toContain('"default": true');
    expect([login, refused, check].map(result => String(result.stdout) + String(result.stderr)).join('')).not.toContain('ACCEPTANCE-SECRET-NOT-REAL');
    expect(readFileSync(join(b, 'auth.json'), 'utf8')).not.toContain('ACCEPTANCE-SECRET-NOT-REAL');
  }, 30_000);
});

describe('instance identity stability', () => {
  it('normalizes reordered runtime config keys before freezing the identity', () => {
    const binding = newSessionCodexInstanceState(bot(), 'http').cliInstanceBinding!;
    const runtime = { id: 'fixture', displayName: 'Fixture', executable: '/opt/bin/fixture',
      update: { provider: 'npm' as const, packageName: '@example/fixture' } };
    const reordered = { update: { packageName: '@example/fixture', provider: 'npm' as const },
      executable: runtime.executable, displayName: runtime.displayName, id: runtime.id };
    const freeze = (cliRuntime: typeof runtime) => snapshotCliRuntime(resolveCliRuntime({ cliId: 'codex', cliRuntime }));
    expect(codexInstanceIdentity(binding, freeze(reordered))).toBe(codexInstanceIdentity(binding, freeze(runtime)));
  });

  it('keeps identity across an in-place CLI version upgrade but rejects a different runtime path or home', () => {
    const binding = newSessionCodexInstanceState(bot(), 'http').cliInstanceBinding!;
    const executable = join(root, 'fixture-cli');
    const freeze = () => snapshotCliRuntime(resolveCliRuntime({ cliId: 'codex', cliPathOverride: executable }))!;
    writeFileSync(executable, '#!/bin/sh\nprintf "codex-cli 0.1.0\\n"\n', { mode: 0o755 });
    expect(execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim()).toBe('codex-cli 0.1.0');
    const before = freeze();
    const identity = codexInstanceIdentity(binding, before);
    writeFileSync(executable, '#!/bin/sh\nprintf "codex-cli 0.1.1\\n"\n');
    expect(execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim()).toBe('codex-cli 0.1.1');
    expect(codexInstanceIdentity(binding, freeze())).toBe(identity);
    expect(codexInstanceIdentity(binding, { ...before, executable: join(root, 'different-cli') })).not.toBe(identity);
    expect(codexInstanceIdentity({ ...binding, codexHome: b }, before)).not.toBe(identity);
  });
});

describe('A4/A5: actual durable session store', () => {
  function initialize() {
    registerCodexInstanceBot(bot());
    sessionStore.init('acceptance-app');
  }
  function create(source: SessionCreationSource = 'ordinary-feishu') {
    return sessionStore.createSession('oc_acceptance', 'om_acceptance', 'acceptance', 'group', 'thread', { source });
  }
  it('publishes complete binding and runtime in the row before returning', () => {
    initialize();
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const session = create();
    const db = new DatabaseSync(join(storePaths.dataDir, 'session-stores', 'acceptance-app', 'sessions.db'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT row FROM sessions WHERE session_id = ?').all(session.sessionId) as Array<{ row: string }>;
      expect(rows).toHaveLength(1);
      const persisted = JSON.parse(rows[0].row);
      expect(persisted.cliInstanceBinding).toMatchObject({ instanceId: 'b', codexHome: b, source: 'pool' });
      expect(persisted.agentFrozen).toBe(true);
      expect(persisted.cliRuntime).toBeDefined();
    } finally { db.close(); }
  });
  it('does not publish a newly created row when persistence fails', () => {
    initialize();
    let failedId = '';
    sessionStore.__testOnly_setBeforeRowPersist(id => { failedId = id; throw new Error('injected-write-failure'); });
    expect(() => create()).toThrow('injected-write-failure');
    sessionStore.__testOnly_setBeforeRowPersist(undefined);
    expect(failedId).not.toBe('');
    expect(sessionStore.getSession(failedId)).toBeUndefined();
    expect(sessionStore.getSessionFresh(failedId)).toBeUndefined();
  });
  it('recovers the binding in a fresh process without parent memory or bot configuration', () => {
    initialize();
    const session = create('http');
    const result = spawnSyncTsEvalWithRepoImports(`
      import * as store from './src/services/session-store.js';
      import { codexInstanceIdentity } from './src/services/codex-instance-pool.js';
      store.init('acceptance-app', { owner: false });
      const row = store.getSessionFresh(${JSON.stringify(session.sessionId)});
      process.stdout.write('ACCEPTANCE_ROW=' + JSON.stringify(row?.cliInstanceBinding) + '\\n');
      process.stdout.write('ACCEPTANCE_IDENTITY=' + codexInstanceIdentity(row.cliInstanceBinding, row.cliRuntime) + '\\n');
    `, { cwd: process.cwd(), env: { ...process.env, SESSION_DATA_DIR: storePaths.dataDir }, encoding: 'utf8', timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, String(result.stderr)).toBe(0);
    const line = String(result.stdout).split('\n').find(line => line.startsWith('ACCEPTANCE_ROW='));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice('ACCEPTANCE_ROW='.length))).toEqual(session.cliInstanceBinding);
    const identityLine = String(result.stdout).split('\n').find(line => line.startsWith('ACCEPTANCE_IDENTITY='));
    expect(identityLine).toBe('ACCEPTANCE_IDENTITY=' + codexInstanceIdentity(session.cliInstanceBinding!, session.cliRuntime));
  });
  it('preserves an original home after restart, changed default/path/weights and fork', () => {
    initialize();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const session = create();
    const binding = structuredClone(session.cliInstanceBinding);
    const replacement = accountHome('a-replacement');
    const changed = bot({ defaultInstanceId: 'b', instances: [{ id: 'a', codexHome: replacement, weight: 1 }, { id: 'b', codexHome: b, weight: 99 }] });
    registerCodexInstanceBot(changed);
    sessionStore.init('acceptance-app');
    const restored = sessionStore.getSessionFresh(session.sessionId)!;
    expect(restored.cliInstanceBinding).toEqual(binding);
    const fork = sessionStore.createSession('oc_acceptance', 'om_fork', 'fork', 'group', 'thread', { source: 'fork', inherit: restored });
    expect(fork.cliInstanceBinding).toEqual(binding);
    expect(create('http').cliInstanceBinding?.instanceId).toBe('b');
    expect(create().cliInstanceBinding?.codexHome).toBe(replacement);
    expect(sessionStore.getSessionFresh(session.sessionId)?.cliInstanceBinding).toEqual(binding);
  });
  it('prevents an old whole-row object from deleting or replacing the binding', () => {
    initialize();
    const session = create('http');
    const original = structuredClone(session.cliInstanceBinding);
    const stale = { ...session, cliInstanceBinding: undefined, cliRuntime: undefined, agentFrozen: undefined, title: 'updated title' };
    sessionStore.updateSession(stale);
    expect(sessionStore.getSessionFresh(session.sessionId)?.cliInstanceBinding).toEqual(original);
    expect(sessionStore.getSession(session.sessionId)?.cliInstanceBinding).toEqual(original);
    expect(() => sessionStore.updateSession({ ...session, cliInstanceBinding: { ...original!, codexHome: b } })).toThrow();
    expect(sessionStore.getSessionFresh(session.sessionId)?.cliInstanceBinding).toEqual(original);
  });
  it('does not leave the live cached object rebound after a rejected in-place update', () => {
    initialize();
    const session = create('http');
    const original = structuredClone(session.cliInstanceBinding);
    const cached = sessionStore.getSession(session.sessionId)!;
    cached.cliInstanceBinding = { ...original!, codexHome: b };
    expect(() => sessionStore.updateSession(cached)).toThrow();
    expect(sessionStore.getSession(session.sessionId)?.cliInstanceBinding).toEqual(original);
    expect(sessionStore.getSessionFresh(session.sessionId)?.cliInstanceBinding).toEqual(original);
  });
  it('daemon transcript lookup stays inside the durable instance, including misses and app mismatch', async () => {
    initialize();
    const session = create('http');
    const cliSessionId = '019dd80d-d922-7a11-8339-0208d8c5b4ee';
    const paths = [a, b].map(home => {
      const dir = join(home, 'sessions', '2026', '09', '08');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `rollout-test-${cliSessionId}.jsonl`);
      writeFileSync(path, '{}\n');
      return path;
    });
    vi.stubEnv('CODEX_HOME', b);
    const { resolveSessionTranscriptPath, __resetTranscriptResolverCacheForTest } = await import('../src/services/transcript-resolver.js');
    __resetTranscriptResolverCacheForTest();
    const query = { cliId: 'codex' as const, sessionId: session.sessionId, cliSessionId, larkAppId: 'acceptance-app', fresh: true };
    expect(resolveSessionTranscriptPath(query)?.path).toBe(paths[0]);
    rmSync(paths[0]);
    expect(resolveSessionTranscriptPath(query)).toBeNull();
    expect(resolveSessionTranscriptPath({ ...query, larkAppId: 'unrelated-app' })).toBeNull();
  });
  it('refuses removing a referenced instance even after its session is closed', () => {
    initialize();
    const session = create('http');
    sessionStore.closeSession(session.sessionId);
    const replacement = bot({ defaultInstanceId: 'b', instances: [{ id: 'b', codexHome: b }] });
    expect(() => assertCodexInstanceConfigWrite([bot()], [replacement])).toThrow(/referenced/);
    expect(() => assertCodexInstanceConfigWrite([bot()], [])).toThrow(/referenced/);
  });
  it('allows removing a legacy-only pool without unbinding migrated sessions', () => {
    sessionStore.init('acceptance-app');
    const old = create('other');
    old.cliId = 'codex';
    sessionStore.updateSession(old);
    registerCodexInstanceBot(bot());
    const migrated = sessionStore.listSessionsStrict().find(row => row.sessionId === old.sessionId)!;
    expect(migrated.cliInstanceBinding).toMatchObject({ source: 'legacy', instanceId: null });
    expect(migrated.agentFrozen).toBe(true);
    expect(migrated.cliRuntime).toBeDefined();
    const withoutPool = { ...bot(), cliId: 'traex' as const, codexInstancePool: undefined };
    expect(() => assertCodexInstanceConfigWrite([bot()], [withoutPool])).not.toThrow();
    clearCodexInstanceBots();
    sessionStore.init('acceptance-app');
    expect(sessionStore.getSessionFresh(old.sessionId)).toMatchObject({
      cliId: 'codex', agentFrozen: true, cliRuntime: migrated.cliRuntime, cliInstanceBinding: migrated.cliInstanceBinding,
    });
    expect(create('http').cliInstanceBinding).toBeUndefined();
  });

  it('rolls back every legacy backfill row on a mid-migration failure, then retries without random allocation', () => {
    sessionStore.init('acceptance-app');
    const first = create('other');
    const second = create('other');
    for (const session of [first, second]) {
      session.cliId = 'codex';
      session.larkAppId = 'acceptance-app';
      sessionStore.updateSession(session);
    }
    sessionStore.closeSession(second.sessionId);
    registerCodexInstanceBot(bot());
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('legacy migration must not draw'); });
    let writes = 0;
    sessionStore.__testOnly_setBeforeRowPersist(() => { if (++writes === 2) throw new Error('migration-failed'); });
    expect(() => sessionStore.listSessionsStrict()).toThrow('migration-failed');
    const db = new DatabaseSync(join(storePaths.dataDir, 'session-stores', 'acceptance-app', 'sessions.db'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT row FROM sessions').all() as Array<{ row: string }>;
      expect(rows).toHaveLength(2);
      expect(rows.every(row => !JSON.parse(row.row).cliInstanceBinding)).toBe(true);
    } finally { db.close(); }
    sessionStore.__testOnly_setBeforeRowPersist(undefined);
    const restored = sessionStore.listSessionsStrict();
    expect(restored).toHaveLength(2);
    expect(restored.every(row => row.cliInstanceBinding?.source === 'legacy')).toBe(true);
    expect(restored.every(row => row.cliInstanceBinding?.instanceId === null)).toBe(true);
    expect(restored.find(row => row.sessionId === second.sessionId)?.status).toBe('closed');
  });
  it('allows disabling and changing a configured home without changing old session bindings', () => {
    initialize();
    const session = create('http');
    const replacement = accountHome('replacement');
    const next = bot({ enabled: false, instances: [{ id: 'a', codexHome: replacement, enabled: false }, { id: 'b', codexHome: b }] });
    expect(() => assertCodexInstanceConfigWrite([bot()], [next])).not.toThrow();
    expect(sessionStore.getSessionFresh(session.sessionId)?.cliInstanceBinding?.codexHome).toBe(a);
  });
  it('rejects cross-bot duplicate homes and permits unrelated private homes', () => {
    const second = { ...bot(), larkAppId: 'other-app' };
    expect(() => assertCodexInstanceConfigWrite([], [bot(), second])).toThrow(/different bots/);
    second.codexInstancePool = { ...pool(), instances: [{ id: 'a', codexHome: accountHome('c') }] };
    expect(() => assertCodexInstanceConfigWrite([], [bot(), second])).not.toThrow();
  });
});
