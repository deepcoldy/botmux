import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRpcEngine } from '../src/codex-rpc-engine.js';
import { isLinuxZombie } from '../src/utils/process-identity.js';

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A real subprocess app-server stand-in (HTTP /readyz + JSON-RPC WS on one port).
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-codex-rpc-server.mjs', import.meta.url));
beforeAll(() => { chmodSync(FIXTURE, 0o755); });

type EngineDependencies = NonNullable<ConstructorParameters<typeof CodexRpcEngine>[1]>;

// The fixture is spawned `detached` + `unref()`ed, so only engine.stop() kills it.
// Tests call stop() on their last line; if an assertion throws first, the fake
// app-server outlives vitest as an orphan holding a port. Stop every engine after
// each test regardless of outcome (stop() is idempotent).
const liveEngines = new Set<CodexRpcEngine>();
afterEach(() => {
  for (const engine of liveEngines) engine.stop();
  liveEngines.clear();
});

function makeEngine(
  over: Partial<ConstructorParameters<typeof CodexRpcEngine>[0]> = {},
  dependencies?: EngineDependencies,
) {
  const engine = new CodexRpcEngine({
    cliBin: FIXTURE, cwd: tmpdir(), env: process.env,
    sessionId: `test-${Math.round(performance.now())}-${over.sessionId ?? ''}`,
    ...over,
  }, dependencies);
  liveEngines.add(engine);
  return engine;
}
const owner = (turnId: string, dispatchAttempt?: number) => ({
  turnId,
  ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
});

describe('CodexRpcEngine — happy-path lifecycle against a fake app-server', () => {
  it.skipIf(process.platform !== 'linux')('waits for an ordinary tool descendant after its app-server leader exits', async () => {
    const childFile = join(tmpdir(), `rpc-ordinary-tool-${process.pid}-${Date.now()}`);
    const sid = `ordinary-tool-${process.pid}-${Date.now()}`;
    const marker = join(homedir(), '.botmux', 'data', 'codex-rpc-app-servers', sid + '.pid');
    const engine = makeEngine({ sessionId: sid, env: { ...process.env, FAKE_GROUP_CHILD_PID_FILE: childFile } });
    let leader: number | undefined;
    let tool: number | undefined;
    try {
      await engine.start();
      leader = engine.appServerPid!;
      await vi.waitFor(() => {
        tool = Number(readFileSync(childFile, 'utf8').trim());
        expect(tool).toBeGreaterThan(0);
      });
      expect(readFileSync(`/proc/${tool}/cmdline`, 'utf8')).not.toContain('app-server');
      await expect(engine.stopAndWait()).resolves.toBe(true);
      await vi.waitFor(() => expect(isAlive(tool!) && !isLinuxZombie(tool!)).toBe(false));
      expect(existsSync(marker)).toBe(false);
      const successor = makeEngine({ sessionId: sid });
      await successor.start();
      await successor.stopAndWait();
    } finally {
      if (leader) { try { process.kill(-leader, 'SIGKILL'); } catch { /* gone */ } }
      rmSync(childFile, { force: true });
      rmSync(marker, { force: true });
    }
  }, 10_000);

  it.skipIf(process.platform !== 'linux')('recovers a retained marker with an ordinary descendant after the leader dies', async () => {
    const childFile = join(tmpdir(), `rpc-stale-tool-${process.pid}-${Date.now()}`);
    const sid = `stale-tool-${process.pid}-${Date.now()}`;
    const marker = join(homedir(), '.botmux', 'data', 'codex-rpc-app-servers', sid + '.pid');
    const engine = makeEngine({ sessionId: sid, env: { ...process.env, FAKE_GROUP_CHILD_PID_FILE: childFile } });
    let leader: number | undefined;
    let tool: number | undefined;
    try {
      await engine.start();
      leader = engine.appServerPid!;
      await vi.waitFor(() => {
        tool = Number(readFileSync(childFile, 'utf8').trim());
        expect(tool).toBeGreaterThan(0);
      });
      expect(JSON.parse(readFileSync(marker, 'utf8').split('\n')[2]).members
        .some((member: { pid: number }) => member.pid === tool)).toBe(true);
      process.kill(leader, 'SIGKILL');
      await vi.waitFor(() => expect(isAlive(leader!)).toBe(false));
      expect(existsSync(marker)).toBe(true);
      const successor = makeEngine({ sessionId: sid });
      await successor.start();
      expect(isAlive(tool!) && !isLinuxZombie(tool!)).toBe(false);
      expect(readFileSync(marker, 'utf8').split('\n')[0]).toBe(String(successor.appServerPid));
      await successor.stopAndWait();
    } finally {
      if (leader) { try { process.kill(-leader, 'SIGKILL'); } catch { /* gone */ } }
      rmSync(childFile, { force: true });
      rmSync(marker, { force: true });
    }
  }, 10_000);

  it.skipIf(process.platform !== 'linux')('starts past a legacy marker whose leader died and whose group cannot be verified', async () => {
    const markerDir = join(homedir(), '.botmux', 'data', 'codex-rpc-app-servers');
    mkdirSync(markerDir, { recursive: true });
    const sid = `legacy-orphan-${process.pid}-${Date.now()}`;
    const marker = join(markerDir, sid + '.pid');
    const childFile = join(tmpdir(), `legacy-orphan-child-${process.pid}-${Date.now()}`);
    // A detached leader exits after spawning an ordinary child that inherited
    // the group: the marker names a dead pid whose group is still alive, and a
    // legacy marker carries no member identity.
    const orphan = spawn(process.execPath, ['-e',
      `const {spawn}=require('node:child_process');const fs=require('node:fs');`
      + `const c=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});`
      + `fs.writeFileSync(${JSON.stringify(childFile)},String(c.pid));setTimeout(()=>process.exit(0),50);`,
    ], { detached: true, stdio: 'ignore' });
    const groupPid = orphan.pid!;
    let tool: number | undefined;
    try {
      await vi.waitFor(() => expect(isAlive(groupPid)).toBe(false));
      await vi.waitFor(() => {
        tool = Number(readFileSync(childFile, 'utf8').trim());
        expect(tool).toBeGreaterThan(0);
      });
      writeFileSync(marker, `${groupPid}\nws://127.0.0.1:1`, { mode: 0o600 });

      const engine = makeEngine({ sessionId: sid });
      await engine.start();
      expect(readFileSync(marker, 'utf8').split('\n')[0]).toBe(String(engine.appServerPid));
      // Unverifiable evidence means "never signal": the orphan survives, but the
      // session is not permanently blocked from engaging RPC.
      expect(isAlive(tool!) && !isLinuxZombie(tool!)).toBe(true);
      await engine.stopAndWait();
    } finally {
      try { process.kill(-groupPid, 'SIGKILL'); } catch { /* gone */ }
      rmSync(childFile, { force: true });
      rmSync(marker, { force: true });
    }
  }, 15_000);

  it.skipIf(process.platform !== 'linux')('does not fail teardown when a post-start child is outside the recorded identity', async () => {
    const childFile = join(tmpdir(), `rpc-late-tool-${process.pid}-${Date.now()}`);
    const sid = `late-tool-${process.pid}-${Date.now()}`;
    const marker = join(homedir(), '.botmux', 'data', 'codex-rpc-app-servers', sid + '.pid');
    const engine = makeEngine({
      sessionId: sid,
      env: { ...process.env, FAKE_GROUP_CHILD_PID_FILE: childFile, FAKE_GROUP_CHILD_ON_SIGNAL: '1' },
    });
    let leader: number | undefined;
    let tool: number | undefined;
    try {
      await engine.start();
      leader = engine.appServerPid!;
      process.kill(leader, 'SIGUSR2');
      await vi.waitFor(() => {
        tool = Number(readFileSync(childFile, 'utf8').trim());
        expect(tool).toBeGreaterThan(0);
      }, { timeout: 10_000 });
      const captured = JSON.parse(readFileSync(marker, 'utf8').split('\n')[2]);
      expect(captured.members.some((member: { pid: number }) => member.pid === tool)).toBe(false);
      process.kill(leader, 'SIGKILL');
      await vi.waitFor(() => expect(isAlive(leader!)).toBe(false));

      // A child spawned after the identity snapshot cannot be proven to belong
      // to this app-server: teardown must fail closed (leave the marker) without
      // throwing, so the next incarnation can still start.
      await expect(engine.stopAndWait()).resolves.toBe(false);
      expect(existsSync(marker)).toBe(true);
      const successor = makeEngine({ sessionId: sid });
      await successor.start();
      expect(readFileSync(marker, 'utf8').split('\n')[0]).toBe(String(successor.appServerPid));
      await successor.stopAndWait();
    } finally {
      if (leader) { try { process.kill(-leader, 'SIGKILL'); } catch { /* gone */ } }
      rmSync(childFile, { force: true });
      rmSync(marker, { force: true });
    }
  }, 20_000);

  it.skipIf(process.platform !== 'linux')('refreshes the recorded group identity at turn boundaries for late tool children', async () => {
    const childFile = join(tmpdir(), `rpc-turn-refresh-${process.pid}-${Date.now()}`);
    const sid = `turn-refresh-${process.pid}-${Date.now()}`;
    const marker = join(homedir(), '.botmux', 'data', 'codex-rpc-app-servers', sid + '.pid');
    const engine = makeEngine({
      sessionId: sid,
      env: { ...process.env, FAKE_GROUP_CHILD_PID_FILE: childFile, FAKE_GROUP_CHILD_ON_SIGNAL: '1' },
    });
    let leader: number | undefined;
    let tool: number | undefined;
    try {
      await engine.start();
      leader = engine.appServerPid!;
      process.kill(leader, 'SIGUSR2');
      await vi.waitFor(() => {
        tool = Number(readFileSync(childFile, 'utf8').trim());
        expect(tool).toBeGreaterThan(0);
      }, { timeout: 10_000 });
      // The start()-time snapshot predates the explicitly released tool child.
      expect(JSON.parse(readFileSync(marker, 'utf8').split('\n')[2]).members
        .some((member: { pid: number }) => member.pid === tool)).toBe(false);
      await engine.startThread();
      await engine.sendTurn('refresh identity at the turn boundary', owner('turn-refresh-1', 1));
      // The turn/start ack (and turn completion) must re-snapshot membership so a
      // later leader crash still leaves the successor provable group members.
      expect(JSON.parse(readFileSync(marker, 'utf8').split('\n')[2]).members
        .some((member: { pid: number }) => member.pid === tool)).toBe(true);
      await engine.stopAndWait();
    } finally {
      if (leader) { try { process.kill(-leader, 'SIGKILL'); } catch { /* gone */ } }
      rmSync(childFile, { force: true });
      rmSync(marker, { force: true });
    }
  }, 20_000);

  it.skipIf(process.platform !== 'linux')('fails start when a verified stale group survives its bounded cleanup', async () => {
    const childFile = join(tmpdir(), `rpc-unkillable-${process.pid}-${Date.now()}`);
    const sid = `unkillable-${process.pid}-${Date.now()}`;
    const marker = join(homedir(), '.botmux', 'data', 'codex-rpc-app-servers', sid + '.pid');
    const engine = makeEngine({ sessionId: sid, env: { ...process.env, FAKE_GROUP_CHILD_PID_FILE: childFile } });
    let leader: number | undefined;
    let tool: number | undefined;
    try {
      await engine.start();
      leader = engine.appServerPid!;
      await vi.waitFor(() => {
        tool = Number(readFileSync(childFile, 'utf8').trim());
        expect(tool).toBeGreaterThan(0);
      });
      // Leader crash with a verified ordinary descendant keeping the group alive.
      process.kill(leader, 'SIGKILL');
      await vi.waitFor(() => expect(isAlive(leader!)).toBe(false));
      expect(existsSync(marker)).toBe(true);
      const successor = makeEngine({ sessionId: sid }, {
        // Simulate a group SIGKILL cannot remove: identity is verified, so the
        // reaper must treat survival after bounded cleanup as fatal, not silently
        // drop the marker and spawn a second app-server on top of the survivor.
        killProcessGroup: () => { /* signal swallowed */ },
      });
      await expect(successor.start()).rejects.toThrow(/still alive after bounded cleanup/);
      expect(existsSync(marker)).toBe(true);
      expect(isAlive(tool!) && !isLinuxZombie(tool!)).toBe(true);
    } finally {
      if (leader) { try { process.kill(-leader, 'SIGKILL'); } catch { /* gone */ } }
      rmSync(childFile, { force: true });
      rmSync(marker, { force: true });
    }
  }, 15_000);

  it.skipIf(process.platform !== 'linux')('refreshes group identity on the FIRST turn ack before any turn/completed event', async () => {
    const childFile = join(tmpdir(), `rpc-first-turn-${process.pid}-${Date.now()}`);
    const sid = `first-turn-${process.pid}-${Date.now()}`;
    const marker = join(homedir(), '.botmux', 'data', 'codex-rpc-app-servers', sid + '.pid');
    // The tool child appears only after the start()-time identity snapshot, and
    // the leader is killed before any turn/completed event can fire: the
    // sendFirstTurn ack path is the last chance to record it.
    const engine = makeEngine({
      sessionId: sid,
      env: {
        ...process.env, FAKE_GROUP_CHILD_PID_FILE: childFile,
        FAKE_GROUP_CHILD_ON_SIGNAL: '1', FAKE_NO_TURN_TERMINAL: '1',
      },
    });
    let leader: number | undefined;
    try {
      await engine.start();
      leader = engine.appServerPid!;
      process.kill(leader, 'SIGUSR2');
      await vi.waitFor(() => {
        const tool = Number(readFileSync(childFile, 'utf8').trim());
        expect(tool).toBeGreaterThan(0);
      });
      const tool = Number(readFileSync(childFile, 'utf8').trim());
      const recordedPids = () => JSON.parse(readFileSync(marker, 'utf8').split('\n')[2]).members
        .map((member: { pid: number }) => member.pid);
      expect(recordedPids()).not.toContain(tool);
      await engine.startThread();
      const outcome = await engine.sendFirstTurn('first turn', owner('first-turn-1', 1), async () => false);
      expect(outcome.outcome).toBe('accepted');
      expect(recordedPids()).toContain(tool);
      await engine.stopAndWait();
    } finally {
      if (leader) { try { process.kill(-leader, 'SIGKILL'); } catch { /* gone */ } }
      rmSync(childFile, { force: true });
      rmSync(marker, { force: true });
    }
  }, 20_000);

  it.skipIf(process.platform !== 'linux')('fails start and keeps the marker when signalling a verified stale group throws', async () => {
    const childFile = join(tmpdir(), `rpc-eperm-${process.pid}-${Date.now()}`);
    const sid = `eperm-${process.pid}-${Date.now()}`;
    const marker = join(homedir(), '.botmux', 'data', 'codex-rpc-app-servers', sid + '.pid');
    const engine = makeEngine({ sessionId: sid, env: { ...process.env, FAKE_GROUP_CHILD_PID_FILE: childFile } });
    let leader: number | undefined;
    let tool: number | undefined;
    try {
      await engine.start();
      leader = engine.appServerPid!;
      await vi.waitFor(() => {
        tool = Number(readFileSync(childFile, 'utf8').trim());
        expect(tool).toBeGreaterThan(0);
      });
      process.kill(leader, 'SIGKILL');
      await vi.waitFor(() => expect(isAlive(leader!)).toBe(false));
      expect(existsSync(marker)).toBe(true);
      const successor = makeEngine({ sessionId: sid }, {
        spawnProcess: (command, args, options) => spawn(command, args, options),
        // Identity is verified first; the subsequent group signal then fails the
        // way an EPERM would against a peer-owned group. The reaper must fail
        // closed rather than swallow the error and overwrite the live marker.
        killProcessGroup: () => {
          const error = new Error('kill Eperm') as Error & { code?: string };
          error.code = 'EPERM';
          throw error;
        },
      });
      await expect(successor.start()).rejects.toThrow(/EPERM|Eperm/);
      // No second app-server was spawned and the orphan's marker is retained.
      expect(successor.appServerPid).toBeUndefined();
      expect(Number(readFileSync(marker, 'utf8').split('\n')[0])).toBe(leader);
      expect(isAlive(tool!) && !isLinuxZombie(tool!)).toBe(true);
    } finally {
      if (leader) { try { process.kill(-leader, 'SIGKILL'); } catch { /* gone */ } }
      rmSync(childFile, { force: true });
      rmSync(marker, { force: true });
    }
  }, 15_000);

  it('passes the permitted hook-trust flag before the app-server subcommand', async () => {
    const launches: string[][] = [];
    const engine = makeEngine({ bypassHookTrust: true }, {
      spawnProcess(command, args, options) {
        launches.push([...args]);
        return spawn(command, args, options);
      },
    });
    await engine.start();
    expect(launches[0].slice(0, 2)).toEqual(['--dangerously-bypass-hook-trust', 'app-server']);
    await engine.stopAndWait();
  });

  it('runs a strict app-server with approved auth and identity but no unknown host credential', async () => {
    const { buildSessionChildEnv, botInjectedEnv } = await import('../src/core/env-policy.js');
    const { applySessionOwnerEnv } = await import('../src/utils/child-env.js');
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'rpc-env-probe-'));
    const path = join(dir, 'report');
    const policy = { mode: 'strict' as const };
    const env = { ...buildSessionChildEnv({ PATH: process.env.PATH, HOME: dir, UNLISTED_CLOUD_CREDENTIAL: 'host-sentinel' }, policy),
      ...botInjectedEnv({ OPENAI_API_KEY: 'rpc-sentinel' }, policy), CODEX_HOME: '/test/rpc/codex', FAKE_ENV_PROBE_PATH: path };
    applySessionOwnerEnv(env, 'ou_rpc');
    const engine = makeEngine({ env });
    try {
      await engine.start();
      for (const [key, ok] of Object.entries(JSON.parse(readFileSync(path, 'utf8')))) expect(ok, key).toBe(true);
    } finally { engine.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('passes exact argv and env to the model-owning app-server through a portable spawn seam', async () => {
    const launches: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
    const childEnv = { ...process.env, BOTMUX_SESSION_ID: 'rpc-spawn-capture' };
    const cwd = tmpdir();
    const engine = makeEngine({
      cwd,
      env: childEnv,
      appServerFeatures: ['feature-a', 'feature-b'],
      appServerConfig: ['config-a', 'hooks.PreToolUse=[{matcher="spawn_agent",hooks=[]}]'],
    }, {
      spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess {
        launches.push({ command, args: [...args], options });
        return spawn(command, args, options);
      },
    });
    try {
      await engine.start();
      expect(launches).toHaveLength(1);
      expect(launches[0]).toEqual({
        command: FIXTURE,
        args: [
          'app-server',
          '--enable', 'feature-a',
          '--enable', 'feature-b',
          '-c', 'config-a',
          '-c', 'hooks.PreToolUse=[{matcher="spawn_agent",hooks=[]}]',
          '--listen', engine.wsUrl,
        ],
        options: {
          cwd,
          env: childEnv,
          stdio: ['ignore', 'ignore', 'pipe'],
          detached: true,
        },
      });
    } finally {
      engine.stop();
    }
  }, 20_000);

  it('keeps the same runtime authority on every turn in one thread', async () => {
    const turnFile = join(tmpdir(), `fake-turn-cfg-${Math.round(performance.now())}.jsonl`);
    const engine = makeEngine({
      env: { ...process.env, FAKE_TURN_CONFIG_FILE: turnFile },
    });
    await engine.start();
    await engine.startThread();
    await engine.sendTurn('continue with inherited authority', owner('continuation-1', 1));
    await engine.sendTurn('ordinary user turn', owner('ordinary-2', 2));
    engine.stop();
    const turns = readFileSync(turnFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    rmSync(turnFile, { force: true });
    for (const turn of turns) {
      expect(turn).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      });
      expect(turn.environments).toBeUndefined();
      expect(turn.runtimeWorkspaceRoots).toBeUndefined();
      expect(turn.capabilities).toBeUndefined();
      expect(turn.multiAgentMode).toBeUndefined();
    }
  }, 20_000);

  it('start (spawn → /readyz → connect → initialize) then startThread → sendTurn → stop', async () => {
    const engine = makeEngine();
    await engine.start();
    const tid = await engine.startThread();
    expect(tid).toBe('thread-fake-1');
    expect(engine.activeThreadId).toBe('thread-fake-1');
    expect(engine.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    await expect(engine.sendTurn('hello world', owner('turn-1', 1)))
      .resolves.toEqual({ nativeTurnId: 'turn-fake-1' });
    await engine.waitForThreadPreview();
    await engine.setThreadName('[BotMux·Lark] hello world');
    engine.stop();
  }, 20_000);

  it('waits for a delayed first-message preview before allowing the final title write', async () => {
    const engine = makeEngine({
      sessionId: 'delayed-preview',
      env: { ...process.env, FAKE_PREVIEW_DELAY_READS: '2' },
    });
    await engine.start();
    await engine.startThread();
    expect(await engine.waitForThreadPreview()).toBe('<botmux_routing> first message preview');
    await engine.setThreadName('[BotMux·Lark] final title');
    engine.stop();
  }, 20_000);

  it('sets the final title when the first-message preview remains unavailable', async () => {
    const engine = makeEngine({
      sessionId: 'missing-preview',
      env: { ...process.env, FAKE_PREVIEW_DELAY_READS: '999999' },
    });
    await engine.start();
    await engine.startThread();
    expect(await engine.waitForThreadPreview(200)).toBeUndefined();
    await engine.setThreadName('[BotMux·Lark] final title');
    expect((await engine.readThreadMetadata()).name).toBe('[BotMux·Lark] final title');
    engine.stop();
  }, 20_000);

  it('forwards model + reasoningEffort (ultra verbatim) into thread/start config', async () => {
    // Guards the PR-A consumption gap codex caught: the engine must actually put
    // model + model_reasoning_effort on thread/start config, and the new highest
    // menu value must not be downgraded.
    const cfgFile = join(tmpdir(), `fake-thread-cfg-${Math.round(performance.now())}.json`);
    const engine = makeEngine({
      sessionId: 'effort-wiring',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'ultra',
      env: { ...process.env, FAKE_THREAD_CONFIG_FILE: cfgFile },
    });
    await engine.start();
    await engine.startThread();
    engine.stop();
    const params = JSON.parse(readFileSync(cfgFile, 'utf8'));
    rmSync(cfgFile, { force: true });
    expect(params.config?.model).toBe('gpt-5.6-terra');
    expect(params.config?.model_reasoning_effort).toBe('ultra');
  }, 20_000);

  it('forwards serviceTier top-level on start AND resume while resume still suppresses model/effort', async () => {
    const startFile = join(tmpdir(), `fake-tier-start-${Math.round(performance.now())}.json`);
    const resumeFile = join(tmpdir(), `fake-tier-resume-${Math.round(performance.now())}.json`);
    const engine = makeEngine({
      sessionId: 'tier-wiring',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh',
      serviceTier: 'priority',
      env: { ...process.env, FAKE_THREAD_CONFIG_FILE: startFile, FAKE_RESUME_CONFIG_FILE: resumeFile },
    }, {
      spawnProcess: spawn,
      validateServiceTier: async input => {
        expect(input).toMatchObject({ cliBin: FIXTURE, model: 'gpt-5.6-terra', serviceTier: 'priority' });
        return { ok: true };
      },
    });
    await engine.start();
    await engine.startThread();
    await engine.resumeThread('thread-fake-1');
    engine.stop();
    const startParams = JSON.parse(readFileSync(startFile, 'utf8'));
    const resumeParams = JSON.parse(readFileSync(resumeFile, 'utf8'));
    rmSync(startFile, { force: true });
    rmSync(resumeFile, { force: true });
    // serviceTier is a thread-level field: top-level on both request shapes.
    expect(startParams.serviceTier).toBe('priority');
    expect(startParams.config?.serviceTier).toBeUndefined();
    expect(resumeParams.serviceTier).toBe('priority');
    // Carrying the tier must not reopen the model/effort resume-drift hole.
    expect(resumeParams.config?.model).toBeUndefined();
    expect(resumeParams.config?.model_reasoning_effort).toBeUndefined();
  }, 20_000);

  it('fails closed before spawning when the model does not support serviceTier', async () => {
    const engine = makeEngine({ model: 'gpt-5.6-terra', serviceTier: 'priority' }, {
      spawnProcess(): ChildProcess {
        throw new Error('spawn must not run');
      },
      validateServiceTier: async () => ({ ok: false, error: 'not_supported_by_model' }),
    });
    await expect(engine.start()).rejects.toThrow('Codex service tier rejected: not_supported_by_model');
    engine.stop();
  });

  it('forwards backend variant on fresh thread/start and suppresses it on resume', async () => {
    const startFile = join(tmpdir(), `fake-variant-start-${Math.round(performance.now())}.json`);
    const resumeFile = join(tmpdir(), `fake-variant-resume-${Math.round(performance.now())}.json`);
    const engine = makeEngine({
      sessionId: 'variant-wiring',
      modelBackendVariant: 'max',
      env: { ...process.env, FAKE_THREAD_CONFIG_FILE: startFile, FAKE_RESUME_CONFIG_FILE: resumeFile },
    });
    await engine.start();
    await engine.startThread();
    await engine.resumeThread('thread-fake-1');
    engine.stop();
    const startParams = JSON.parse(readFileSync(startFile, 'utf8'));
    const resumeParams = JSON.parse(readFileSync(resumeFile, 'utf8'));
    rmSync(startFile, { force: true });
    rmSync(resumeFile, { force: true });
    expect(startParams.config?.model_backend_variant).toBe('max');
    expect(resumeParams.config?.model_backend_variant).toBeUndefined();
  }, 20_000);

  it('SUPPRESSES model + reasoningEffort on thread/resume (start keeps both) — no resume drift', async () => {
    // Regression lock for the PR #639 P2: a cold resume must send NEITHER
    // config.model NOR config.model_reasoning_effort, or the app-server's
    // model-resume-override short-circuit drops the persisted {model, provider,
    // effort} triple to the current default. Fresh start still stamps both.
    // Asserts start-keeps AND resume-drops in ONE engine lifecycle so the two
    // paths can't silently converge. This locks the full-override face; the
    // model-only and effort-only faces are locked independently below (each is a
    // distinct short-circuit trigger, so no single test subsumes the others).
    const startFile = join(tmpdir(), `fake-start-cfg-${Math.round(performance.now())}.json`);
    const resumeFile = join(tmpdir(), `fake-resume-cfg-${Math.round(performance.now())}.json`);
    const engine = makeEngine({
      sessionId: 'resume-suppress',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh',
      env: { ...process.env, FAKE_THREAD_CONFIG_FILE: startFile, FAKE_RESUME_CONFIG_FILE: resumeFile },
    });
    await engine.start();
    await engine.startThread();
    await engine.resumeThread('thread-fake-1');
    engine.stop();
    const startParams = JSON.parse(readFileSync(startFile, 'utf8'));
    const resumeParams = JSON.parse(readFileSync(resumeFile, 'utf8'));
    rmSync(startFile, { force: true });
    rmSync(resumeFile, { force: true });
    // start (positive): both present, xhigh verbatim
    expect(startParams.config?.model).toBe('gpt-5.6-terra');
    expect(startParams.config?.model_reasoning_effort).toBe('xhigh');
    // resume (negative): NEITHER present — the whole point of the fix
    expect(resumeParams.config?.model).toBeUndefined();
    expect(resumeParams.config?.model_reasoning_effort).toBeUndefined();
  }, 20_000);

  it('SUPPRESSES a stable configured model on thread/resume (pre-existing shared-engine face)', async () => {
    // Covers the pre-existing model-only drift the same fix closes: even a model
    // that never changes (a TraeX/codex bot's configured model, no per-turn
    // effort) must NOT be re-sent on resume, else provider drifts. engine has no
    // cliId — this one assertion covers both codex and TraeX.
    const resumeFile = join(tmpdir(), `fake-resume-model-only-${Math.round(performance.now())}.json`);
    const engine = makeEngine({
      sessionId: 'resume-model-only',
      model: 'gpt-5.6-terra', // configured model, no reasoningEffort
      env: { ...process.env, FAKE_RESUME_CONFIG_FILE: resumeFile },
    });
    await engine.start();
    await engine.resumeThread('thread-fake-1');
    engine.stop();
    const resumeParams = JSON.parse(readFileSync(resumeFile, 'utf8'));
    rmSync(resumeFile, { force: true });
    expect(resumeParams.config?.model).toBeUndefined();
    expect(resumeParams.config?.model_reasoning_effort).toBeUndefined();
    // sanity: resume still carries the non-model params it must (env policy)
    expect(resumeParams.config?.shell_environment_policy).toBeTruthy();
  }, 20_000);

  it('SUPPRESSES an effort-only override on thread/resume (the exact entry PR #639 newly activated)', async () => {
    // The combination-sensitive face codex asked to lock independently: model
    // ABSENT, reasoningEffort SET. This is the path PR #639 opened (worker.ts:709
    // first fed effort into the engine), and it is a DISTINCT short-circuit
    // trigger from model-only — the app-server early-returns on ANY single
    // model-related key, so sending only model_reasoning_effort still drifts. The
    // full-override and model-only tests above do NOT subsume it (both set model).
    const resumeFile = join(tmpdir(), `fake-resume-effort-only-${Math.round(performance.now())}.json`);
    const engine = makeEngine({
      sessionId: 'resume-effort-only',
      reasoningEffort: 'xhigh', // effort set, model deliberately left unset
      env: { ...process.env, FAKE_RESUME_CONFIG_FILE: resumeFile },
    });
    await engine.start();
    await engine.resumeThread('thread-fake-1');
    engine.stop();
    const resumeParams = JSON.parse(readFileSync(resumeFile, 'utf8'));
    rmSync(resumeFile, { force: true });
    expect(resumeParams.config?.model).toBeUndefined();
    expect(resumeParams.config?.model_reasoning_effort).toBeUndefined();
    // sanity: resume still carries the non-model params it must (env policy)
    expect(resumeParams.config?.shell_environment_policy).toBeTruthy();
  }, 20_000);

  it('waits for resumed-thread metadata to advance before restoring its title', async () => {
    const engine = makeEngine({
      sessionId: 'resume-title',
      env: {
        ...process.env,
        FAKE_UPDATED_DELAY_READS: '2',
        FAKE_UPDATED_BEFORE: '100',
        FAKE_UPDATED_AFTER: '101',
      },
    });
    await engine.start();
    await engine.resumeThread('thread-resumed-title');
    expect((await engine.readThreadMetadata()).updatedAt).toBe(100);
    await engine.waitForThreadUpdatedAfter(100);
    await engine.setThreadName('[BotMux·Lark] resumed title');
    engine.stop();
  }, 20_000);

  it('resumeThread returns the resumed (persisted) thread id — resume-survival path', async () => {
    const engine = makeEngine({ sessionId: 'resume' });
    await engine.start();
    const tid = await engine.resumeThread('thread-persisted-42');
    expect(tid).toBe('thread-persisted-42');
    engine.stop();
  }, 20_000);

  it('bridges requestUserInput server requests to the host callback', async () => {
    let received: unknown;
    let resolveReceived!: () => void;
    const receivedPromise = new Promise<void>(resolve => { resolveReceived = resolve; });
    const engine = makeEngine({
      env: { ...process.env, FAKE_REQUEST_USER_INPUT: '1', FAKE_USER_INPUT_STRING_ID: '1' },
      appServerFeatures: ['default_mode_request_user_input'],
      onRequestUserInput: async params => {
        received = params;
        resolveReceived();
        return { answers: { choice: { answers: ['Yes'] } } };
      },
    });
    await engine.start();
    await engine.startThread();
    await engine.sendTurn('ask me', owner('request-user-input', 1));
    await receivedPromise;
    expect(received).toMatchObject({
      questions: [{ id: 'choice', question: 'Continue?' }],
    });
    engine.stop();
  }, 20_000);

  it('does not spend the transport timeout while waiting for a human before the turn/start response', async () => {
    let ready!: () => void;
    const asked = new Promise<void>(resolve => { ready = resolve; });
    let answer!: (value: unknown) => void;
    const engine = makeEngine({ env: { ...process.env, FAKE_REQUEST_USER_INPUT: '1' },
      requestTimeoutMs: 300,
      onRequestUserInput: async () => { ready(); return new Promise(resolve => { answer = resolve; }); },
    });
    await engine.start(); await engine.startThread();
    const turn = engine.sendTurn('ask me', owner('human-wait', 1));
    await asked;
    await new Promise(resolve => setTimeout(resolve, 650));
    answer({ answers: { choice: { answers: ['Yes'] } } });
    await expect(turn).resolves.toEqual({ nativeTurnId: 'turn-fake-1' });
  }, 20_000);

  it.each(['completed', 'stopped', 'dead'] as const)('cancels native question waiters on %s and ignores late answers', async event => {
    let signal!: AbortSignal;
    let resolveAnswer!: (answer: unknown) => void;
    const engine = makeEngine({ onRequestUserInput: async (_params, abortSignal) => {
      signal = abortSignal;
      return new Promise(resolve => { resolveAnswer = resolve; });
    } });
    const sent: unknown[] = [];
    (engine as any).respond = (_id: number, answer: unknown) => { sent.push(answer); };
    (engine as any).handleOrdinaryServerRequest({ id: 'native-question', method: 'item/tool/requestUserInput',
      params: { turnId: 'question-turn' } });
    await Promise.resolve();
    expect(signal.aborted).toBe(false);
    // A different turn's completion must not dismiss this question.
    (engine as any).onMessage(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'other-turn' } } }));
    expect(signal.aborted).toBe(false);
    if (event === 'completed') (engine as any).onMessage(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'question-turn' } } }));
    else if (event === 'stopped') engine.stop();
    else (engine as any).failAll(new Error('connection lost'));
    expect(signal.aborted).toBe(true);
    resolveAnswer({ answers: { choice: { answers: ['Yes'] } } });
    await Promise.resolve(); await Promise.resolve();
    expect(sent).toEqual([]);
  });

  it('interrupts the turn (not a benign reply) when the input bridge rejects', async () => {
    // The blocker fix. Verified against real traex 0.200.19: replying to
    // requestUserInput with empty answers OR a JSON-RPC error is normalized to
    // {answers:{}} and the turn still COMPLETES, silently skipping the ask. Only
    // `turn/interrupt` actually stops the turn. So on bridge rejection the engine
    // must send turn/interrupt — asserted here via the engine log + the fixture
    // resolving turn/start as an interrupted turn rather than a completed one.
    const logs: string[] = [];
    const engine = makeEngine({
      env: { ...process.env, FAKE_REQUEST_USER_INPUT: '1' },
      appServerFeatures: ['default_mode_request_user_input'],
      log: (m: string) => logs.push(m),
      onRequestUserInput: async () => { throw new Error('cannot represent as ask card'); },
    });
    await engine.start();
    await engine.startThread();
    // turn/start resolves (interrupted), so sendTurn does not throw here; the
    // point is that the turn was stopped, not silently completed.
    await engine.sendTurn('ask me', owner('request-user-input-rejected', 1));
    // Give the async interrupt round-trip a moment to log its result.
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(logs.some(l => l.includes('interrupting turn'))).toBe(true);
    expect(logs.some(l => l.includes('turn interrupted after requestUserInput failure'))).toBe(true);
    engine.stop();
  }, 20_000);

  it('declares the engine dead when turn/interrupt itself fails (no permanently wedged turn)', async () => {
    // The interrupt is the last lever we have on bridge failure. If it errors or
    // times out, the turn stays stuck — so the engine must fire onDead so the
    // worker restarts the pane, rather than only logging and leaking the hang.
    let deadCount = 0;
    const engine = makeEngine({
      sessionId: 'interrupt-fail',
      env: { ...process.env, FAKE_REQUEST_USER_INPUT: '1', FAKE_INTERRUPT_ERROR: '1' },
      appServerFeatures: ['default_mode_request_user_input'],
      onRequestUserInput: async () => { throw new Error('cannot represent as ask card'); },
      onDead: () => { deadCount++; },
    });
    await engine.start();
    await engine.startThread();
    // failAll rejects the still-pending turn/start, so sendTurn rejects here —
    // that is the visible failure, not a silent hang. We only care that onDead fired.
    await engine.sendTurn('ask me', owner('request-user-input-interrupt-failed', 1)).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(deadCount).toBe(1);
    engine.stop();
  }, 20_000);

  it('maps an ultra-fast turn/completed to the exact Botmux attempt', async () => {
    const terminals: any[] = [];
    const engine = makeEngine({
      sessionId: 'terminal-map',
      onTurnTerminal: terminal => terminals.push(terminal),
    });
    await engine.start();
    await engine.startThread();
    await engine.sendTurn('fast', owner('botmux-fast', 7));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(terminals).toEqual([expect.objectContaining({
      identity: { turnId: 'botmux-fast', dispatchAttempt: 7 },
      nativeTurnId: 'turn-fake-1',
      status: 'completed',
    })]);
    engine.stop();
  }, 20_000);

  it('maps turn/completed that arrives before turn/start response without resurrecting the turn', async () => {
    const terminals: any[] = [];
    const engine = makeEngine({
      sessionId: 'terminal-before-response',
      env: { ...process.env, FAKE_TERMINAL_BEFORE_RESPONSE: '1' },
      onTurnTerminal: terminal => terminals.push(terminal),
    });
    await engine.start();
    await engine.startThread();
    await expect(engine.sendTurn('fastest', owner('before-response', 8)))
      .resolves.toEqual({ nativeTurnId: 'turn-fake-1' });
    expect(terminals).toEqual([expect.objectContaining({
      identity: { turnId: 'before-response', dispatchAttempt: 8 },
      nativeTurnId: 'turn-fake-1',
      status: 'completed',
    })]);

    // If response binding resurrected the already-terminal native id, stop()
    // would attempt another terminal callback. Native-terminal de-dupe masks
    // that callback, so assert the internal active ownership is actually empty.
    expect((engine as any).turnOwners.size).toBe(0);
    engine.stop();
  }, 20_000);

  it('deduplicates duplicate native terminal notifications', async () => {
    const terminals: any[] = [];
    const engine = makeEngine({
      sessionId: 'duplicate-terminal',
      env: { ...process.env, FAKE_DUPLICATE_TERMINAL: '1' },
      onTurnTerminal: terminal => terminals.push(terminal),
    });
    await engine.start();
    await engine.startThread();
    await engine.sendTurn('once', owner('dedupe', 9));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toEqual(expect.objectContaining({
      identity: { turnId: 'dedupe', dispatchAttempt: 9 },
      status: 'completed',
    }));
    engine.stop();
  }, 20_000);

  it('keeps the first terminal buffered for an unowned native turn', () => {
    const engine = makeEngine({ sessionId: 'unowned-first-terminal-wins' });
    (engine as any).emitTurnTerminal('unowned-native', 'failed', 'first_failure');
    (engine as any).emitTurnTerminal('unowned-native', 'completed');
    expect((engine as any).deferredUnownedTerminals.get('unowned-native')).toEqual({
      status: 'failed',
      errorCode: 'first_failure',
    });
    engine.stop();
  });

  it('keeps sequential resume/typeahead attempts isolated by native turn id', async () => {
    const terminals: any[] = [];
    const engine = makeEngine({
      sessionId: 'terminal-sequential',
      onTurnTerminal: terminal => terminals.push(terminal),
    });
    await engine.start();
    await engine.resumeThread('thread-persisted');
    await engine.sendTurn('one', owner('same-logical', 1));
    await engine.sendTurn('two', owner('same-logical', 2));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(terminals.map(t => [t.nativeTurnId, t.identity.dispatchAttempt])).toEqual([
      ['turn-fake-1', 1],
      ['turn-fake-2', 2],
    ]);
    engine.stop();
  }, 20_000);
});

describe('CodexRpcEngine — failure/recovery paths', () => {
  it('runs onDispatch only once the turn/start frame is on the socket', async () => {
    const engine = makeEngine({ sessionId: 'turn-dispatch-hook' });
    await engine.start();
    await engine.startThread();
    const onDispatch = vi.fn();
    await expect(engine.sendTurn('hello', owner('om_dispatched', 1), { onDispatch }))
      .resolves.toEqual({ nativeTurnId: 'turn-fake-1' });
    expect(onDispatch).toHaveBeenCalledTimes(1);

    const notDispatched = vi.fn();
    (engine as any).ws = undefined; // send() throws before the frame leaves
    await expect(engine.sendTurn('never left', owner('om_not_dispatched', 1), { onDispatch: notDispatched }))
      .rejects.toMatchObject({ deliveryDisposition: 'not_sent' });
    expect(notDispatched).not.toHaveBeenCalled();
    engine.stop();
  }, 20_000);

  it('reports native context compaction for the thread, ignoring other items', () => {
    const onContextCompacted = vi.fn();
    const engine = makeEngine({ sessionId: 'context-compaction', onContextCompacted });
    (engine as any).threadId = 'thread-compacting';
    const notify = (method: string, params: unknown) =>
      (engine as any).onMessage(JSON.stringify({ jsonrpc: '2.0', method, params }));
    notify('thread/compacted', { threadId: 'thread-compacting', turnId: 'native-9' });
    notify('item/completed', { threadId: 'thread-compacting', turnId: 'native-9', item: { type: 'contextCompaction', id: 'c1' } });
    notify('item/completed', { threadId: 'thread-compacting', turnId: 'native-9', item: { type: 'agentMessage', id: 'm1' } });
    expect(onContextCompacted.mock.calls).toEqual([['thread-compacting'], ['thread-compacting']]);
    engine.stop();
  });

  it('classifies a call before thread start as definitely not sent', async () => {
    const engine = makeEngine();
    await expect(engine.sendTurn('never dispatched', owner('om_no_thread', 1))).rejects.toMatchObject({
      name: 'CodexRpcDeliveryError', code: 'rpc_turn_start_not_sent', deliveryDisposition: 'not_sent',
    });
    engine.stop();
  });

  it('P1-5: a wedged turn/start times out → onDead fires (fatal recovery, not a silent hang)', async () => {
    let deadCount = 0;
    const engine = makeEngine({
      sessionId: 'hang',
      env: { ...process.env, FAKE_HANG_TURN: '1' },
      requestTimeoutMs: 400,
      onDead: () => { deadCount++; },
    });
    await engine.start();
    await engine.startThread();
    await expect(engine.sendTurn('never answered', owner('turn-hang', 1))).rejects.toThrow(/timed out/);
    expect(deadCount).toBe(1); // failAll → onDead exactly once
    engine.stop();
  }, 20_000);

  it('does not guess a lost follow-up response from an unowned native terminal', async () => {
    let deadCount = 0;
    const terminals: any[] = [];
    const engine = makeEngine({
      sessionId: 'followup-lost-ack-terminal',
      env: {
        ...process.env,
        FAKE_HANG_TURN: '1',
        FAKE_HANG_TURN_NOTIFY: '1',
      },
      requestTimeoutMs: 400,
      onDead: () => { deadCount++; },
      onTurnTerminal: terminal => terminals.push(terminal),
    });
    await engine.start();
    await engine.startThread();
    await expect(engine.sendTurn('completed despite lost ack', owner('followup-proof', 4)))
      .rejects.toThrow(/timed out/);
    expect(deadCount).toBe(1);
    expect(terminals).toEqual([]);
    engine.stop();
  }, 20_000);

  it('does not bind an unrelated pre-response turn/started when the request response rejects', async () => {
    const terminals: any[] = [];
    const engine = makeEngine({
      sessionId: 'followup-response-error-after-started',
      env: { ...process.env, FAKE_ERROR_AFTER_STARTED: '1' },
      onTurnTerminal: terminal => terminals.push(terminal),
    });
    await engine.start();
    await engine.startThread();
    await expect(engine.sendTurn('started before response error', owner('started-proof', 5)))
      .rejects.toThrow(/fake response failure/);
    expect((engine as any).turnOwners.size).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(terminals).toEqual([]);
    expect((engine as any).turnOwners.size).toBe(0);
    engine.stop();
  }, 20_000);

  it('app-server crash → onDead fires so the worker can restart the pane', async () => {
    let dead = false;
    const engine = makeEngine({
      sessionId: 'crash',
      env: { ...process.env, FAKE_DIE_AFTER_MS: '600' },
      onDead: () => { dead = true; },
    });
    await engine.start();
    await engine.startThread();
    await new Promise((r) => setTimeout(r, 1500)); // let the fixture exit(1)
    expect(dead).toBe(true);
    engine.stop();
  }, 20_000);

  it('P1-2: reapStaleAppServer refuses to kill a REUSED pid that is not our app-server', async () => {
    // Simulate a marker left by a SIGKILLed worker whose pid was reused by an
    // unrelated process (a harmless `sleep`, NOT an app-server). A broken guard
    // would kill it; the identity check (argv has no `app-server`) must spare it.
    const sid = `reuse-guard-${Math.round(performance.now())}`;
    const dir = join(homedir(), '.botmux', 'data', 'codex-rpc-app-servers');
    mkdirSync(dir, { recursive: true });
    const marker = join(dir, `${sid}.pid`);
    const sleeper = spawn('sleep', ['30'], { detached: true });
    sleeper.unref();
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(marker, `${sleeper.pid}\nws://127.0.0.1:59999`); // reused pid + a url it can't have

    const engine = makeEngine({ sessionId: sid });
    await engine.start();            // triggers reapStaleAppServer(sid)
    expect(isAlive(sleeper.pid!)).toBe(true); // NOT mis-killed
    engine.stop();
    try { process.kill(-sleeper.pid!, 'SIGKILL'); } catch { /* */ }
  }, 20_000);

  it('P1-1 sendFirstTurn: ack received → accepted (rollout probe not needed)', async () => {
    let probed = false;
    const engine = makeEngine({ sessionId: 'first-ok' });
    await engine.start();
    await engine.startThread();
    const outcome = await engine.sendFirstTurn('hello', owner('turn-1', 1), async () => { probed = true; return false; });
    expect(outcome).toEqual({ outcome: 'accepted', nativeTurnId: 'turn-fake-1' });
    expect(probed).toBe(false); // ack answered → no need to consult the rollout
    engine.stop();
  }, 20_000);

  it('P1-1 sendFirstTurn: frame NOT dispatched (ws down) → not-sent (safe paste)', async () => {
    const engine = makeEngine({ sessionId: 'first-notsent' });
    await engine.start();
    await engine.startThread();
    (engine as any).ws = undefined; // simulate ws not open → send() throws before the frame leaves
    const outcome = await engine.sendFirstTurn('hello', owner('turn-1', 1), async () => true);
    expect(outcome).toEqual({ outcome: 'not-sent' });
    engine.stop();
  }, 20_000);

  it('P1-1 sendFirstTurn: dispatched, accepted+persisted but NO response, rollout HIT → accepted (0 paste)', async () => {
    const engine = makeEngine({ sessionId: 'first-amb-hit', env: { ...process.env, FAKE_HANG_TURN: '1' }, requestTimeoutMs: 400 });
    await engine.start();
    await engine.startThread();
    // frame dispatched, no ack within 400ms, but the rollout shows the user turn.
    const outcome = await engine.sendFirstTurn('hello', owner('turn-1', 1), async () => true);
    expect(outcome).toEqual({ outcome: 'accepted' }); // positive evidence → never resend
    engine.stop();
  }, 20_000);

  it('uses rollout evidence, not a sole pending request, when first-turn response is lost', async () => {
    const terminals: any[] = [];
    const engine = makeEngine({
      sessionId: 'first-lost-ack-native',
      env: {
        ...process.env,
        FAKE_HANG_TURN: '1',
        FAKE_HANG_TURN_NOTIFY: '1',
      },
      requestTimeoutMs: 400,
      onTurnTerminal: terminal => terminals.push(terminal),
    });
    await engine.start();
    await engine.startThread();
    const outcome = await engine.sendFirstTurn(
      'hello',
      owner('first-native', 3),
      async () => true,
    );
    expect(outcome).toEqual({ outcome: 'accepted', nativeTurnId: undefined });
    expect(terminals).toEqual([]);
    engine.stop();
  }, 20_000);

  it('does not treat an uncorrelated turn/started as first-turn delivery evidence', async () => {
    let probed = false;
    const engine = makeEngine({
      sessionId: 'first-lost-ack-started',
      env: {
        ...process.env,
        FAKE_HANG_TURN: '1',
        FAKE_HANG_TURN_NOTIFY: '1',
        FAKE_NO_TURN_TERMINAL: '1',
      },
      requestTimeoutMs: 400,
    });
    await engine.start();
    await engine.startThread();
    const outcome = await engine.sendFirstTurn(
      'hello',
      owner('first-started', 5),
      async () => { probed = true; return false; },
    );
    expect(outcome).toEqual({ outcome: 'ambiguous' });
    expect(probed).toBe(true);
    engine.stop();
  }, 20_000);

  it('keeps an acked first turn accepted (and its nativeTurnId) when identity capture fails', async () => {
    let probed = false;
    const engine = makeEngine({ sessionId: 'first-ack-capture-fault' }, {
      spawnProcess: (command, args, options) => spawn(command, args, options),
      groupIdentityScanError: Object.assign(new Error('EACCES reading /proc'), { code: 'EACCES' }),
    });
    await engine.start();
    await engine.startThread();
    const outcome = await engine.sendFirstTurn('hello', owner('turn-1', 1), async () => { probed = true; return false; });
    // A clean ack is already accepted: a bookkeeping fault must not reroute it
    // into the lost-ack branch (which would consult rollout and downgrade to
    // ambiguous), nor drop the bound native turn id.
    expect(outcome).toEqual({ outcome: 'accepted', nativeTurnId: 'turn-fake-1' });
    expect(probed).toBe(false);
    engine.stop();
  }, 20_000);

  it('stays accepted without escaping to paste fallback when capture fails after a rollout hit', async () => {
    let probed = false;
    const engine = makeEngine(
      {
        sessionId: 'first-rollout-capture-fault',
        env: { ...process.env, FAKE_HANG_TURN: '1' },
        requestTimeoutMs: 400,
      },
      {
        spawnProcess: (command, args, options) => spawn(command, args, options),
        groupIdentityScanError: Object.assign(new Error('EACCES reading /proc'), { code: 'EACCES' }),
      },
    );
    await engine.start();
    await engine.startThread();
    // The frame is dispatched, the ack is lost, and rollout positively proves it
    // persisted. An escaping capture throw here previously made engageCodexRpc
    // fall back to paste and re-submit the persisted prompt; sendFirstTurn must
    // instead resolve accepted (the worker only pastes on not-engaged/ambiguous).
    const outcome = await engine.sendFirstTurn('hello', owner('turn-1', 1), async () => { probed = true; return true; });
    expect(probed).toBe(true);
    expect(outcome).toEqual({ outcome: 'accepted' });
    engine.stop();
  }, 20_000);

  it.skipIf(process.platform !== 'linux')('records a late tool child on the rollout-hit accepted path before any ack', async () => {
    const childFile = join(tmpdir(), `rpc-rollout-refresh-${process.pid}-${Date.now()}`);
    const sid = `rollout-refresh-${process.pid}-${Date.now()}`;
    const marker = join(homedir(), '.botmux', 'data', 'codex-rpc-app-servers', sid + '.pid');
    // Hanging turn/start means no turn/completed terminal fires, so the rollout
    // branch's capture is the only remaining chance to record this tool child.
    const engine = makeEngine({
      sessionId: sid,
      env: { ...process.env, FAKE_GROUP_CHILD_PID_FILE: childFile, FAKE_GROUP_CHILD_ON_SIGNAL: '1', FAKE_HANG_TURN: '1' },
      requestTimeoutMs: 400,
    });
    let leader: number | undefined;
    try {
      await engine.start();
      leader = engine.appServerPid!;
      process.kill(leader, 'SIGUSR2');
      await vi.waitFor(() => {
        const tool = Number(readFileSync(childFile, 'utf8').trim());
        expect(tool).toBeGreaterThan(0);
      });
      const tool = Number(readFileSync(childFile, 'utf8').trim());
      const recordedPids = () => JSON.parse(readFileSync(marker, 'utf8').split('\n')[2]).members
        .map((member: { pid: number }) => member.pid);
      expect(recordedPids()).not.toContain(tool); // start() snapshot predates the tool
      await engine.startThread();
      const outcome = await engine.sendFirstTurn('hello', owner('rollout-1', 1), async () => true);
      expect(outcome).toEqual({ outcome: 'accepted' });
      expect(recordedPids()).toContain(tool);
      engine.stop();
    } finally {
      if (leader) { try { process.kill(-leader, 'SIGKILL'); } catch { /* gone */ } }
      rmSync(childFile, { force: true });
      rmSync(marker, { force: true });
    }
  }, 20_000);

  it.each([
    ['aborted', 'aborted', undefined],
    ['failed', 'failed', 'fake_failed'],
  ] as const)('maps native %s completion to worker terminal %s', async (nativeStatus, expectedStatus, errorCode) => {
    const terminals: any[] = [];
    const engine = makeEngine({
      sessionId: `terminal-${nativeStatus}`,
      env: { ...process.env, FAKE_TURN_STATUS: nativeStatus },
      onTurnTerminal: terminal => terminals.push(terminal),
    });
    await engine.start();
    await engine.startThread();
    await engine.sendTurn(nativeStatus, owner(`turn-${nativeStatus}`, 6));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(terminals).toEqual([expect.objectContaining({
      identity: { turnId: `turn-${nativeStatus}`, dispatchAttempt: 6 },
      status: expectedStatus,
      ...(errorCode ? { errorCode } : {}),
    })]);
    engine.stop();
  }, 20_000);

  it('recognises the exact output-limit message even when a generic code is also present', async () => {
    const terminals: any[] = [];
    const engine = makeEngine({
      sessionId: 'terminal-output-limit',
      env: {
        ...process.env,
        FAKE_TURN_STATUS: 'failed',
        FAKE_TURN_ERROR_CODE: 'generic_turn_failed',
        FAKE_TURN_ERROR_MESSAGE: 'model output limit exceeded: max_output_tokens',
      },
      onTurnTerminal: terminal => terminals.push(terminal),
    });
    await engine.start();
    await engine.startThread();
    await engine.sendTurn('output limit', owner('turn-output-limit', 7));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(terminals).toEqual([expect.objectContaining({
      identity: { turnId: 'turn-output-limit', dispatchAttempt: 7 },
      status: 'failed',
      errorCode: 'codex_output_limit_exceeded',
    })]);
    engine.stop();
  }, 20_000);

  it('classifies a native capacity failure independently of a generic error code', async () => {
    const terminals: any[] = [];
    const engine = makeEngine({
      sessionId: 'terminal-capacity',
      env: { ...process.env, FAKE_TURN_STATUS: 'failed', FAKE_TURN_ERROR_CODE: 'generic_turn_failed',
        FAKE_TURN_ERROR_MESSAGE: 'Selected model is at capacity. Please try a different model.' },
      onTurnTerminal: terminal => terminals.push(terminal),
    });
    try {
      await engine.start();
      await engine.startThread();
      await engine.sendTurn('continue task', owner('turn-capacity', 7));
      await vi.waitFor(() => expect(terminals).toEqual([expect.objectContaining({
        identity: { turnId: 'turn-capacity', dispatchAttempt: 7 },
        status: 'failed', errorCode: 'codex_capacity_exceeded',
      })]));
    } finally { engine.stop(); }
  }, 20_000);

  it('P1-1 sendFirstTurn: dispatched, no ack, NO rollout evidence → ambiguous (never downgraded to safe)', async () => {
    const engine = makeEngine({ sessionId: 'first-amb', env: { ...process.env, FAKE_HANG_TURN: '1' }, requestTimeoutMs: 400 });
    await engine.start();
    await engine.startThread();
    const outcome = await engine.sendFirstTurn('hello', owner('turn-1', 1), async () => false);
    expect(outcome).toEqual({ outcome: 'ambiguous' }); // absence of evidence stays ambiguous → 0 auto-paste
    engine.stop();
  }, 20_000);

  it('P1-1 sendFirstTurn: rollout probe failure stays ambiguous instead of falling back to paste', async () => {
    const engine = makeEngine({
      sessionId: 'first-probe-error',
      env: { ...process.env, FAKE_HANG_TURN: '1' },
      requestTimeoutMs: 400,
    });
    await engine.start();
    await engine.startThread();
    const outcome = await engine.sendFirstTurn(
      'hello',
      owner('turn-probe-error', 2),
      async () => { throw new Error('rollout unavailable'); },
    );
    expect(outcome).toEqual({ outcome: 'ambiguous' });
    engine.stop();
  }, 20_000);

  it('P1-2 ABA: an old engine\'s late child-exit does NOT delete a marker another engine now owns', async () => {
    const sid = `aba-${Math.round(performance.now())}`;
    const dir = join(homedir(), '.botmux', 'data', 'codex-rpc-app-servers');
    mkdirSync(dir, { recursive: true });
    const marker = join(dir, `${sid}.pid`);
    const engine = makeEngine({ sessionId: sid });
    await engine.start(); // writes marker = A's pid + A's wsUrl
    expect(existsSync(marker)).toBe(true);
    // Engine B took over: overwrite the marker with a different owner.
    writeFileSync(marker, `999999\nws://127.0.0.1:1`);
    engine.stop(); // A's SIGTERM → child exits → removeMarkerIfOwned reads B's marker → owner mismatch → keeps it
    await new Promise((r) => setTimeout(r, 2600)); // let the bounded SIGKILL + exit handler run
    expect(existsSync(marker)).toBe(true); // B's marker survived A's late exit (no orphan)
    try { rmSync(marker, { force: true }); } catch { /* */ }
  }, 20_000);

  it('stop() is idempotent and does NOT fire onDead (expected teardown)', async () => {
    let dead = false;
    const engine = makeEngine({ sessionId: 'stop', onDead: () => { dead = true; } });
    await engine.start();
    await engine.startThread();
    engine.stop();
    engine.stop();
    await new Promise((r) => setTimeout(r, 300));
    expect(dead).toBe(false);
  }, 20_000);

  it('stop releases every still-active native turn with its exact owner', async () => {
    const terminals: any[] = [];
    const engine = makeEngine({
      sessionId: 'stop-active',
      env: { ...process.env, FAKE_NO_TURN_TERMINAL: '1' },
      onTurnTerminal: terminal => terminals.push(terminal),
    });
    await engine.start();
    await engine.startThread();
    await engine.sendTurn('keep running', owner('active-stop', 11));
    engine.stop();
    expect(terminals).toEqual([expect.objectContaining({
      identity: { turnId: 'active-stop', dispatchAttempt: 11 },
      status: 'stopped',
      errorCode: 'rpc_engine_stopped',
    })]);
  }, 20_000);

  it('engine death releases every still-active native turn before onDead recovery', async () => {
    const order: string[] = [];
    const engine = makeEngine({
      sessionId: 'death-active',
      env: {
        ...process.env,
        FAKE_NO_TURN_TERMINAL: '1',
        FAKE_DIE_AFTER_MS: '600',
      },
      onTurnTerminal: terminal => order.push(`terminal:${terminal.identity.turnId}:${terminal.status}`),
      onDead: () => order.push('dead'),
    });
    await engine.start();
    await engine.startThread();
    await engine.sendTurn('active on crash', owner('active-dead', 12));
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(order).toEqual(['terminal:active-dead:engine-dead', 'dead']);
    engine.stop();
  }, 20_000);
});
