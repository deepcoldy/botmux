import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { fleetProcessIdentityRuntime } from '../src/core/fleet-process-identity.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import { startWecomManagedCore, type WecomManagedCoreOptions } from '../src/im/wecom/gateway/managed-core.js';
import { readWecomCoreGeneration, WecomCoreReclaimError } from '../src/im/wecom/gateway/core-generation.js';
import { spawnTsEval, spawnTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';
import { releaseWecomCorePorts, reserveWecomCorePort } from './helpers/wecom-core-port.js';

/**
 * A gateway killed without its shutdown (SIGKILL) leaves its core running on
 * the fixed core port. The next gateway of the same configuration must stop
 * exactly that core — and nothing else — before it starts its own.
 */

const roots: string[] = [];
const children: ChildProcess[] = [];
const handles: { stop(): Promise<void> }[] = [];
/** Port holders started by an orphan core: not our children, so tracked by pid and birth. */
const holders: PortHolder[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    await handle.stop().catch(() => undefined);
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  for (const holder of holders.splice(0)) {
    if (holderAlive(holder)) {
      try {
        process.kill(holder.pid, 'SIGKILL');
      } catch {
        /* exited in between */
      }
    }
  }
  await releaseWecomCorePorts();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'wecom-orphan-'));
  roots.push(root);
  const port = await reserveWecomCorePort();
  const config = {
    managedCore: {
      botId: 'local_wecom_orphan',
      cli: 'codex',
      backend: 'pty' as const,
      workingDirectory: root,
      stateDir: join(root, 'state'),
      port,
    },
  };
  return { root, port, config, file: join(root, 'managed-core-config-a.json'), configId: 'config-a' };
}

const READY = `console.log('[core-only] listening on 127.0.0.1:'+process.env.BOTMUX_API_PORT+' (bot '+process.env.BOTMUX_API_ONLY_BOT+', cli '+process.env.BOTMUX_CORE_CLI+')'); setInterval(()=>{},1000);`;

function readyCore(observed: { child?: ChildProcess }): NonNullable<WecomManagedCoreOptions['spawn']> {
  return (_command, _args, options: SpawnOptions) => {
    const child = spawnTsEval(READY, options);
    observed.child = child;
    children.push(child);
    return child;
  };
}

/** A process whose command line is a core-only entry, holding the core port like a real core. */
async function startOrphanCore(root: string, port: number, ignoreTerm = false): Promise<ChildProcess> {
  const dir = join(root, 'orphan-build');
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'index-core-only.ts');
  writeFileSync(script, [
    "import { createServer } from 'node:net';",
    'const server = createServer();',
    "server.listen(Number(process.env.ORPHAN_PORT), '127.0.0.1', () => console.log('orphan-listening'));",
    "process.on('SIGTERM', () => { if (process.env.ORPHAN_IGNORE_TERM === '1') return; server.close(); process.exit(0); });",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const child = spawnTsScript(script, [], {
    env: { ...process.env, ORPHAN_PORT: String(port), ORPHAN_IGNORE_TERM: ignoreTerm ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
  let output = '';
  await new Promise<void>((done, fail) => {
    child.stdout!.on('data', chunk => {
      output += chunk;
      if (output.includes('orphan-listening')) {
        done();
      }
    });
    child.once('exit', () => fail(new Error('orphan exited early')));
  });
  return child;
}

interface PortHolder {
  pid: number;
  start: string | undefined;
}

/** Still the very process that was started: a reused pid never counts. */
function holderAlive(holder: PortHolder): boolean {
  return holder.start !== undefined && readProcessStartIdentity(holder.pid) === holder.start;
}

/**
 * An orphan core (command line: a core-only entry) that does not listen itself:
 * a child of it holds the core port, and lets it go `linger` ms after the orphan
 * exits (its stdin, a pipe from the orphan, ends then) — or never. So the core
 * is gone a known while before its port is free, on every platform.
 */
async function startOrphanCoreWithPortHolder(
  root: string,
  port: number,
  linger: number | 'never',
): Promise<{ orphan: ChildProcess; holder: PortHolder }> {
  const dir = join(root, 'orphan-holder-build');
  mkdirSync(dir, { recursive: true });
  const holderScript = join(dir, 'port-holder.ts');
  writeFileSync(holderScript, [
    "import { createServer } from 'node:net';",
    '// Fallback only: never outlive the test, whatever happens to it.',
    'setTimeout(() => process.exit(0), 20_000);',
    'const server = createServer();',
    "server.listen({ host: '127.0.0.1', port: Number(process.env.ORPHAN_PORT), exclusive: true }, () => console.log('holding'));",
    "process.stdin.on('end', () => {",
    "  if (process.env.HOLDER_LINGER_MS !== 'never') setTimeout(() => process.exit(0), Number(process.env.HOLDER_LINGER_MS));",
    '});',
    'process.stdin.resume();',
  ].join('\n'));
  const script = join(dir, 'index-core-only.ts');
  writeFileSync(script, [
    "import { spawn } from 'node:child_process';",
    'const [command, ...args] = JSON.parse(process.env.HOLDER_SPAWN);',
    "const holder = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });",
    'let holding = false;',
    "holder.stdout.on('data', chunk => {",
    "  if (!holding && String(chunk).includes('holding')) {",
    '    holding = true;',
    "    console.log('orphan-listening ' + holder.pid);",
    '  }',
    '});',
    "holder.once('exit', () => { if (!holding) process.exit(1); });",
    "process.on('SIGTERM', () => process.exit(0));",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const runner = tsRunnerPrefix();
  const child = spawnTsScript(script, [], {
    env: {
      ...process.env,
      ORPHAN_PORT: String(port),
      HOLDER_LINGER_MS: String(linger),
      HOLDER_SPAWN: JSON.stringify([runner.command, ...runner.prefixArgs, holderScript]),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
  let output = '';
  const pid = await new Promise<number>((done, fail) => {
    child.stdout!.on('data', chunk => {
      output += chunk;
      const match = /orphan-listening (\d+)/.exec(output);
      if (match) {
        done(Number(match[1]));
      }
    });
    child.once('exit', () => fail(new Error('orphan exited early')));
  });
  const holder = { pid, start: readProcessStartIdentity(pid) };
  holders.push(holder);
  return { orphan: child, holder };
}

/** Birth identity of a gateway process that has since exited. */
async function deadGatewayBirth() {
  const child = spawnTsEval('setInterval(()=>{},1000)');
  await new Promise(done => setTimeout(done, 100));
  const processStart = fleetProcessIdentityRuntime.readIdentity(child.pid!)!;
  child.kill('SIGKILL');
  await once(child, 'exit');
  return { pid: child.pid!, processStart };
}

function birthOf(pid: number) {
  return { pid, processStart: fleetProcessIdentityRuntime.readIdentity(pid)! };
}

function writeRecord(
  file: string,
  fields: { configId: string; gateway: { pid: number; processStart: string }; core: { pid: number; processStart: string }; port: number; stateDir: string },
) {
  writeFileSync(file, JSON.stringify({
    version: 1,
    configId: fields.configId,
    gateway: fields.gateway,
    core: fields.core,
    coreBotId: 'local_wecom_orphan',
    port: fields.port,
    stateDir: resolve(fields.stateDir),
    spawnedAt: Date.now(),
  }));
}

function writeDescriptor(stateDir: string, descriptor: Record<string, unknown>) {
  mkdirSync(join(stateDir, 'dashboard-daemons'), { recursive: true });
  writeFileSync(join(stateDir, 'dashboard-daemons', 'local_wecom_orphan.json'), JSON.stringify(descriptor));
}

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

describe('WeCom managed core: reclaiming a previous generation', () => {
  it('stops the core a killed gateway left behind, then starts and records its own', async () => {
    const { root, port, config, file, configId } = await setup();
    const orphan = await startOrphanCore(root, port);
    writeRecord(file, { configId, gateway: await deadGatewayBirth(), core: birthOf(orphan.pid!), port, stateDir: config.managedCore.stateDir });
    writeDescriptor(config.managedCore.stateDir, {
      pid: orphan.pid,
      processStartIdentity: readProcessStartIdentity(orphan.pid!),
      ipcPort: port,
    });
    const observed: { child?: ChildProcess } = {};
    const orphanExit = once(orphan, 'exit');

    const handle = await startWecomManagedCore(config, {
      spawn: readyCore(observed),
      generation: { file, configId },
      shutdownTimeoutMs: 3000,
      killWaitMs: 3000,
    });
    handles.push(handle);

    const [code, signal] = await orphanExit;
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(readWecomCoreGeneration(file)?.core.pid).toBe(observed.child!.pid);
    expect(readWecomCoreGeneration(file)?.gateway.pid).toBe(process.pid);

    await handle.stop();
    expect(existsSync(file)).toBe(false);
  });

  it('kills a previous core that ignores SIGTERM once its grace window runs out', async () => {
    const { root, port, config, file, configId } = await setup();
    const orphan = await startOrphanCore(root, port, true);
    writeRecord(file, { configId, gateway: await deadGatewayBirth(), core: birthOf(orphan.pid!), port, stateDir: config.managedCore.stateDir });
    const orphanExit = once(orphan, 'exit');

    const handle = await startWecomManagedCore(config, {
      spawn: readyCore({}),
      generation: { file, configId },
      shutdownTimeoutMs: 500,
      killWaitMs: 3000,
    });
    handles.push(handle);

    const [, signal] = await orphanExit;
    expect(signal).toBe('SIGKILL');
  });

  it('starts once the port comes free a moment after the previous core is gone', async () => {
    const { root, port, config, file, configId } = await setup();
    // The port outlives the core by far more than the reclaim's polling: when
    // the reclaim reports the core gone, its port is still taken.
    const { orphan } = await startOrphanCoreWithPortHolder(root, port, 600);
    writeRecord(file, { configId, gateway: await deadGatewayBirth(), core: birthOf(orphan.pid!), port, stateDir: config.managedCore.stateDir });
    const orphanExit = once(orphan, 'exit');
    const observed: { child?: ChildProcess } = {};

    const handle = await startWecomManagedCore(config, {
      spawn: readyCore(observed),
      generation: { file, configId },
      shutdownTimeoutMs: 3000,
      killWaitMs: 3000,
    });
    handles.push(handle);

    await orphanExit;
    expect(observed.child).toBeDefined();
    expect(readWecomCoreGeneration(file)?.core.pid).toBe(observed.child!.pid);
  });

  it('gives up without starting a core when the port stays taken after the previous core is gone', async () => {
    const { root, port, config, file, configId } = await setup();
    const { orphan, holder } = await startOrphanCoreWithPortHolder(root, port, 'never');
    writeRecord(file, { configId, gateway: await deadGatewayBirth(), core: birthOf(orphan.pid!), port, stateDir: config.managedCore.stateDir });
    const orphanExit = once(orphan, 'exit');
    let spawned = false;

    const starting = startWecomManagedCore(config, {
      spawn: (...args) => {
        spawned = true;
        return readyCore({})(...args);
      },
      generation: { file, configId },
      shutdownTimeoutMs: 3000,
      killWaitMs: 500,
    });
    await expect(starting).rejects.toBeInstanceOf(Error);
    await expect(starting).rejects.not.toBeInstanceOf(WecomCoreReclaimError);

    await orphanExit;
    expect(spawned).toBe(false);
    expect(holderAlive(holder)).toBe(true);
  });

  it('never signals a reused pid: a live core-like process whose birth identity differs from the record', async () => {
    const { root, port, config, file, configId } = await setup();
    // Even its command line looks like a core: only the birth identity tells them apart.
    const unrelated = await startOrphanCore(root, await reserveWecomCorePort());
    writeRecord(file, {
      configId,
      gateway: await deadGatewayBirth(),
      core: { pid: unrelated.pid!, processStart: 'birth-of-the-previous-core' },
      port,
      stateDir: config.managedCore.stateDir,
    });
    const observed: { child?: ChildProcess } = {};

    const handle = await startWecomManagedCore(config, { spawn: readyCore(observed), generation: { file, configId } });
    handles.push(handle);

    expect(alive(unrelated)).toBe(true);
    expect(readWecomCoreGeneration(file)?.core.pid).toBe(observed.child!.pid);
  });

  it('never signals a live process with the recorded identity whose command line is not a core', async () => {
    const { port, config, file, configId } = await setup();
    const unrelated = spawnTsEval('setInterval(()=>{},1000)');
    children.push(unrelated);
    await new Promise(done => setTimeout(done, 100));
    writeRecord(file, { configId, gateway: await deadGatewayBirth(), core: birthOf(unrelated.pid!), port, stateDir: config.managedCore.stateDir });

    const handle = await startWecomManagedCore(config, { spawn: readyCore({}), generation: { file, configId } });
    handles.push(handle);

    expect(alive(unrelated)).toBe(true);
  });

  it('leaves the core alone and fails retryably while the recording gateway is still alive', async () => {
    const { root, port, config, file, configId } = await setup();
    const orphan = await startOrphanCore(root, port);
    const liveGateway = spawnTsEval('setInterval(()=>{},1000)');
    children.push(liveGateway);
    await new Promise(done => setTimeout(done, 100));
    writeRecord(file, { configId, gateway: birthOf(liveGateway.pid!), core: birthOf(orphan.pid!), port, stateDir: config.managedCore.stateDir });
    let spawned = false;

    await expect(startWecomManagedCore(config, {
      spawn: (...args) => {
        spawned = true;
        return readyCore({})(...args);
      },
      generation: { file, configId },
    })).rejects.toBeInstanceOf(WecomCoreReclaimError);

    expect(alive(orphan)).toBe(true);
    expect(spawned).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  it('refuses when the core descriptor names the recorded pid and identity but another port', async () => {
    const { root, port, config, file, configId } = await setup();
    const orphan = await startOrphanCore(root, port);
    writeRecord(file, { configId, gateway: await deadGatewayBirth(), core: birthOf(orphan.pid!), port, stateDir: config.managedCore.stateDir });
    writeDescriptor(config.managedCore.stateDir, {
      pid: orphan.pid,
      processStartIdentity: readProcessStartIdentity(orphan.pid!),
      ipcPort: port + 1,
    });
    let spawned = false;

    await expect(startWecomManagedCore(config, {
      spawn: (...args) => {
        spawned = true;
        return readyCore({})(...args);
      },
      generation: { file, configId },
      shutdownTimeoutMs: 3000,
    })).rejects.toBeInstanceOf(WecomCoreReclaimError);

    expect(alive(orphan)).toBe(true);
    expect(spawned).toBe(false);
  });

  it('refuses when the core descriptor names the recorded pid with another identity', async () => {
    const { root, port, config, file, configId } = await setup();
    const orphan = await startOrphanCore(root, port);
    writeRecord(file, { configId, gateway: await deadGatewayBirth(), core: birthOf(orphan.pid!), port, stateDir: config.managedCore.stateDir });
    writeDescriptor(config.managedCore.stateDir, { pid: orphan.pid, processStartIdentity: 'another-process', ipcPort: port });

    await expect(startWecomManagedCore(config, { spawn: readyCore({}), generation: { file, configId } }))
      .rejects.toBeInstanceOf(WecomCoreReclaimError);

    expect(alive(orphan)).toBe(true);
  });

  it('ignores a record written for another configuration and leaves its core alone', async () => {
    const { root, port, config, file } = await setup();
    const orphan = await startOrphanCore(root, port);
    writeRecord(file, { configId: 'config-b', gateway: await deadGatewayBirth(), core: birthOf(orphan.pid!), port, stateDir: config.managedCore.stateDir });

    let spawned = false;
    await expect(startWecomManagedCore(config, {
      spawn: (...args) => {
        spawned = true;
        return readyCore({})(...args);
      },
      generation: { file, configId: 'config-a' },
    })).rejects.toThrow(/端口已占用/);

    expect(alive(orphan)).toBe(true);
    expect(spawned).toBe(false);
  });
});
