/**
 * Which command and which environment a live model probe runs with.
 *
 * Feishu Bot probes keep their long-standing behaviour: coco / opencode /
 * mimocode resolve the command through the login shell and run in this
 * (Dashboard) process's environment (doubao's probe already runs in the
 * supplied environment for every caller); zcode reads this process's provider
 * config; Aiden runs `aiden x models` in this process's environment. Only a
 * caller probing for a separately launched core (`isolatedProbeEnv`, the WeCom
 * managed core) runs the probe inside the supplied environment instead.
 *
 * child_process is mocked: spawnSync answers the login-shell resolver with a
 * recognisable absolute path, execFile records the command and environment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileCalls: Array<{ file: string; env: NodeJS.ProcessEnv | undefined }> = [];

vi.mock('node:child_process', () => {
  const actual = require('node:child_process') as typeof import('node:child_process');
  return {
    ...actual,
    spawnSync: (command: string, args: readonly string[], options: unknown) => {
      if (args.includes('botmux-resolve-command')) {
        return { status: 0, stdout: `/login-shell/bin/${args[args.length - 1]}\n`, stderr: '' };
      }
      return actual.spawnSync(command, args as string[], options as never);
    },
    execFile: (
      file: string,
      args: string[],
      opts: { env?: NodeJS.ProcessEnv },
      cb: (err: Error | null, result?: { stdout: string; stderr: string } | string, stderr?: string) => void,
    ) => {
      execFileCalls.push({ file, env: opts.env });
      if (args.includes('__botmux_model_probe__')) {
        // doubao lists its models on an unsupported --model and exits non-zero.
        cb(new Error('exit 1'), 'Available models: doubao-seed-live.\n', '');
        return;
      }
      if (args.includes('debug')) {
        cb(null, { stdout: JSON.stringify({ models: [{ slug: 'coco-live', visibility: 'list' }] }), stderr: '' });
        return;
      }
      cb(null, { stdout: 'provider/live-model\n', stderr: '' });
    },
  };
});

import { createModelCatalog } from '../src/services/model-catalog.js';

const BOT_ENV: NodeJS.ProcessEnv = { PATH: '/bot-core/bin', PROBE_SOURCE: 'bot-core' };
const PROCESS_MARKER = 'BOTMUX_TEST_PROBE_PROCESS_MARKER';

beforeEach(() => {
  execFileCalls.length = 0;
  vi.stubEnv(PROCESS_MARKER, 'dashboard-process');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The environment a probe child actually receives (absent = inherited). */
function childEnv(call: { env: NodeJS.ProcessEnv | undefined }): NodeJS.ProcessEnv {
  return call.env ?? process.env;
}

describe('adapter model probes', () => {
  it.each([
    ['coco', '/login-shell/bin/coco'],
    ['opencode', '/login-shell/bin/opencode'],
    ['mimocode', '/login-shell/bin/mimo'],
  ])('%s: a Feishu Bot probe runs the login-shell command in this process environment', async (key, command) => {
    const models = await createModelCatalog().detectModels(key, { probeEnv: BOT_ENV, runtimeContext: `feishu:${key}` });

    expect(models?.length).toBeGreaterThan(0);
    expect(execFileCalls).toHaveLength(1);
    expect(execFileCalls[0]!.file).toBe(command);
    const env = childEnv(execFileCalls[0]!);
    expect(env[PROCESS_MARKER]).toBe('dashboard-process');
    expect(env.PROBE_SOURCE).toBeUndefined();
  });

  it.each([
    ['coco', '/login-shell/bin/coco'],
    ['opencode', '/login-shell/bin/opencode'],
    ['mimocode', '/login-shell/bin/mimo'],
  ])('%s: an isolated probe runs in the supplied environment only', async (key, command) => {
    const models = await createModelCatalog().detectModels(key, {
      probeEnv: BOT_ENV, runtimeContext: `isolated:${key}`, isolatedProbeEnv: true,
    });

    expect(models?.length).toBeGreaterThan(0);
    expect(execFileCalls).toHaveLength(1);
    expect(execFileCalls[0]!.file).toBe(command);
    const env = childEnv(execFileCalls[0]!);
    expect(env.PROBE_SOURCE).toBe('bot-core');
    expect(env.PATH).toBe('/bot-core/bin');
    expect(env[PROCESS_MARKER]).toBeUndefined();
  });
});

describe('zcode provider catalog', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'zcode-probe-env-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function providerFile(name: string, providerId: string): string {
    const file = join(root, name);
    writeFileSync(file, JSON.stringify({
      config: { providerConfigRules: { providerRules: [{ providerId, config: { personalModelIds: ['model'] } }] } },
    }));
    return file;
  }

  it('a Feishu Bot probe reads this process provider config; an isolated probe reads the supplied one', async () => {
    vi.stubEnv('ZCODE_PERSONAL_PROVIDER_CONFIG_FILE', providerFile('ambient.json', 'ambient'));
    const probeEnv = { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: providerFile('core.json', 'core') };

    const feishu = await createModelCatalog().detectModels('zcode', { probeEnv, runtimeContext: 'feishu:zcode' });
    const isolated = await createModelCatalog().detectModels('zcode', {
      probeEnv, runtimeContext: 'isolated:zcode', isolatedProbeEnv: true,
    });

    expect(feishu).toEqual(['ambient/model']);
    expect(isolated).toEqual(['core/model']);
  });
});

describe('Aiden catalog', () => {
  it('a Feishu Bot probe uses this process environment; an isolated probe receives the supplied one', async () => {
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    const aidenCodexDetector = async (env?: NodeJS.ProcessEnv) => { seen.push(env); return ['aiden-live']; };

    await createModelCatalog().detectModels('aiden-x-codex', { probeEnv: BOT_ENV, aidenCodexDetector });
    await createModelCatalog().detectModels('aiden-x-codex', { probeEnv: BOT_ENV, aidenCodexDetector, isolatedProbeEnv: true });

    expect(seen).toEqual([undefined, BOT_ENV]);
  });
});
