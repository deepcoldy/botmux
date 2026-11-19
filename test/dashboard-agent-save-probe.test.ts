import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentSaveProbePlan, probeAgentSaveAvailability } from '../src/dashboard/agent-save-probe.js';
import { botOneShotEnv, botOneShotProbeEnv } from '../src/core/session-env-resolve.js';
import { modelCatalogProbeContext } from '../src/dashboard/model-catalog-request.js';
import { cliAvailabilityRevision } from '../src/dashboard/web/cli-availability.js';
import type { BotConfig } from '../src/bot-registry.js';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const bot = { larkAppId: 'app', cliId: 'codex', wrapperCli: 'aiden x codex', env: { PATH: '/bot/bin' } } as BotConfig;

describe('save probe input identity', () => {
  it('preserves the locked custom wrapper for same-selection old clients', () => {
    const plan = agentSaveProbePlan(bot, 'aiden-x-codex', {}, {});
    expect(plan.selection.wrapperCli).toBe(bot.wrapperCli);
    expect(agentSaveProbePlan({ ...bot }, 'aiden-x-codex', {}, {}).fingerprint).toBe(plan.fingerprint);
    expect(agentSaveProbePlan({ ...bot, env: { PATH: '/other/bin' } }, 'aiden-x-codex', {}, {}).fingerprint).not.toBe(plan.fingerprint);
    expect(agentSaveProbePlan({ ...bot, cliPathOverride: '/other/tool' }, 'aiden-x-codex', {}, {}).fingerprint).not.toBe(plan.fingerprint);
    const custom = { ...bot, wrapperCli: 'custom-launcher codex' };
    expect(agentSaveProbePlan({ ...custom, wrapperCli: 'custom-launcher --changed codex' }, 'codex', {}, {}).fingerprint)
      .not.toBe(agentSaveProbePlan(custom, 'codex', {}, {}).fingerprint);
  });

  it('rejects incompatible runtime selections before executing a probe', () => {
    expect(() => agentSaveProbePlan(bot, 'traex', { cliRuntime: { id: 'custom', executable: '/tool' } }, {})).toThrow('runtime_requires_codex');
    expect(() => agentSaveProbePlan(bot, 'aiden-x-codex', { cliRuntime: { id: 'custom', executable: '/tool' } }, {})).toThrow('runtime_wrapper_conflict');
  });

  it('uses the same global-layer result for payload identity and the actual probe env', async () => {
    const root = mkdtempSync(join(tmpdir(), 'probe-env-')); dirs.push(root);
    vi.stubEnv('BOTMUX_GLOBAL_CONFIG_FILE', join(root, 'config.json'));
    writeFileSync(join(root, 'config.json'), JSON.stringify({ sessionEnv: { set: { GLOBAL_SETTING: 'global' }, unset: ['REMOVE_FROM_HOST'] } }));
    const entry = { ...bot, cliId: 'traex', wrapperCli: undefined, backendType: 'pty', env: { PATH: '/a' } } as BotConfig;
    const base = { REMOVE_FROM_HOST: 'host', RETAINED: 'yes' };
    const env = botOneShotProbeEnv(base, entry);
    const context = modelCatalogProbeContext('traex', entry, base);
    expect(context.fingerprint).toBe(env.fingerprint);
    expect(context.probeEnv).toEqual(env.env);
    expect(botOneShotEnv(base, entry)).toEqual(env.env);
    expect(env.env.GLOBAL_SETTING).toBe('global');
    expect(env.env).not.toHaveProperty('REMOVE_FROM_HOST');
    const sameKeys = botOneShotProbeEnv(base, { ...entry, env: { PATH: '/b' } });
    expect(sameKeys.fingerprint).not.toBe(env.fingerprint);
    expect(botOneShotProbeEnv(base, { ...entry, envPolicy: { mode: 'strict' } }).fingerprint).not.toBe(env.fingerprint);
    expect(botOneShotProbeEnv(base, { ...entry, backendType: 'mojo' }).fingerprint).not.toBe(env.fingerprint);
    writeFileSync(join(root, 'config.json'), '{}');
    expect(botOneShotProbeEnv(base, { ...entry, backendType: 'mojo' }).fingerprint).toBe(botOneShotProbeEnv(base, entry).fingerprint);
  });

  it('uses only the effective server env hash in the client revision', () => {
    const first = { cliId: 'traex', envRevision: 'hash' };
    expect(cliAvailabilityRevision({ ...first })).toBe(cliAvailabilityRevision(first));
    expect(cliAvailabilityRevision({ ...first, envRevision: 'different' })).not.toBe(cliAvailabilityRevision(first));
    expect(cliAvailabilityRevision({ ...first, cliRuntime: { executable: '/custom' } })).not.toBe(cliAvailabilityRevision(first));
  });

  it('finds a wrapper supplied by the login shell without running it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wrapper-rc-probe-')); dirs.push(root);
    const bin = join(root, 'bin'); mkdirSync(bin);
    const tool = join(bin, 'aiden'); writeFileSync(tool, '#!/bin/sh\nexit 72\n'); chmodSync(tool, 0o755);
    writeFileSync(join(root, '.bash_profile'), `export PATH='${bin}:/usr/bin:/bin'\n`);
    writeFileSync(join(root, '.bashrc'), `export PATH='${bin}:/usr/bin:/bin'\n`);
    const entry = { ...bot, env: { HOME: root, SHELL: '/bin/bash', PATH: '/usr/bin:/bin' } };
    const result = await probeAgentSaveAvailability(agentSaveProbePlan(entry, 'aiden-x-codex', {}, {}));
    expect(result.availability).toMatchObject({ status: 'available', command: 'aiden', resolvedPath: tool });
  });
});
