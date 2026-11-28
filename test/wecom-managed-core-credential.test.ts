/**
 * Every start of a managed core hands it a credential of its own
 * (gateway/managed-core.ts, core/native-gateway-credential.ts): a fresh value
 * each time, never one from the gateway's own environment, and never part of
 * the environment the Dashboard derives from the same configuration.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { startWecomManagedCore } from '../src/im/wecom/gateway/managed-core.js';
import { wecomManagedCoreEnvironment } from '../src/im/wecom/config/managed-core-env.js';
import { NATIVE_GATEWAY_CORE_CREDENTIAL_ENV } from '../src/core/native-gateway-credential.js';
import { releaseWecomCorePorts, reserveWecomCorePort } from './helpers/wecom-core-port.js';

const roots: string[] = [];
afterEach(async () => {
  await releaseWecomCorePorts();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function config() {
  const root = mkdtempSync(join(tmpdir(), 'wecom-core-credential-'));
  roots.push(root);
  return {
    managedCore: {
      botId: 'local_wecom_credential',
      cli: 'codex',
      backend: 'pty' as const,
      workingDirectory: root,
      stateDir: join(root, 'state'),
      port: await reserveWecomCorePort(),
    },
  };
}

/** The environment of one start; the fake child has already exited, so no process ever runs. */
async function spawnedEnv(baseEnv: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  let env: NodeJS.ProcessEnv | undefined;
  const spawn = (_command: string, _args: string[], options: SpawnOptions) => {
    env = options.env;
    return Object.assign(new EventEmitter(), { exitCode: 1, signalCode: null, pid: undefined }) as unknown as ChildProcess;
  };
  await startWecomManagedCore(await config(), { spawn, env: baseEnv }).catch(() => undefined);
  return env!;
}

describe('the credential a managed core is started with', () => {
  it('is fresh for every start and replaces a same-named variable of the gateway\'s environment', async () => {
    const planted = 'p'.repeat(43);
    const base = { PATH: process.env.PATH, [NATIVE_GATEWAY_CORE_CREDENTIAL_ENV]: planted };
    const first = (await spawnedEnv(base))[NATIVE_GATEWAY_CORE_CREDENTIAL_ENV];
    const second = (await spawnedEnv(base))[NATIVE_GATEWAY_CORE_CREDENTIAL_ENV];
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    expect([first, second]).not.toContain(planted);
  });

  it('is not part of the environment derived from the configuration alone', async () => {
    const env = wecomManagedCoreEnvironment(await config(), { PATH: process.env.PATH, [NATIVE_GATEWAY_CORE_CREDENTIAL_ENV]: 'p'.repeat(43) });
    expect(env[NATIVE_GATEWAY_CORE_CREDENTIAL_ENV]).toBeUndefined();
  });
});
