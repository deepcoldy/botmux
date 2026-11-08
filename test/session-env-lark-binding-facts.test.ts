/**
 * The daemon composes a session's env with the same lark-tool binding decision
 * the worker spawns with. When the worker installs the managed wrapper it owns
 * ZDOTDIR/BASH_ENV, so the daemon must neither hand the user's values to the
 * worker nor list them for removal; when the worker does not, the user's values
 * must reach the CLI unchanged.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveSessionEnvForSession } from '../src/core/worker-pool.js';
import { usesLarkToolBinding } from '../src/core/lark-tool-binding.js';
import { invalidateGlobalConfigCache } from '../src/global-config.js';
import { headlessChatId } from '../src/services/headless-session-store.js';

const HEADLESS_ID = 'hl_bindingfacts01';
const IDENTITY_KEYS = ['ZDOTDIR', 'BASH_ENV'] as const;

let cfgDir: string;
let previousConfigFile: string | undefined;
beforeAll(() => {
  cfgDir = mkdtempSync(join(tmpdir(), 'session-env-binding-facts-'));
  previousConfigFile = process.env.BOTMUX_GLOBAL_CONFIG_FILE;
  process.env.BOTMUX_GLOBAL_CONFIG_FILE = join(cfgDir, 'config.json');
  invalidateGlobalConfigCache();
});
afterAll(() => {
  if (previousConfigFile === undefined) delete process.env.BOTMUX_GLOBAL_CONFIG_FILE;
  else process.env.BOTMUX_GLOBAL_CONFIG_FILE = previousConfigFile;
  invalidateGlobalConfigCache();
  rmSync(cfgDir, { recursive: true, force: true });
});

interface Shape {
  chatId: string;
  headless?: { id: string; source: 'cli'; createdAt: string };
  adoptedFrom?: unknown;
  existingAppServerEndpoint?: string;
  backendType?: string;
}

const headless = { id: HEADLESS_ID, source: 'cli' as const, createdAt: '2026-11-08T00:00:00.000Z' };
const validHeadless: Shape = { chatId: headlessChatId(HEADLESS_ID), headless };

function sessionFor(shape: Shape): any {
  return {
    chatId: shape.chatId,
    larkAppId: 'cli_bindingfacts',
    session: {
      sessionId: 'binding-facts-session',
      backendType: shape.backendType ?? 'pty',
      ...(shape.headless ? { headless: shape.headless } : {}),
      ...(shape.adoptedFrom ? { adoptedFrom: shape.adoptedFrom } : {}),
      ...(shape.existingAppServerEndpoint ? { existingAppServerEndpoint: shape.existingAppServerEndpoint } : {}),
    },
  };
}

function botWith(env: { env?: Record<string, string>; envUnset?: string[] }): any {
  return { larkAppId: 'cli_bindingfacts', cliId: 'claude-code', backendType: 'pty', ...env };
}

/** What the worker decides from the init config the daemon sends for this shape. */
function workerBinds(shape: Shape): boolean {
  return usesLarkToolBinding({
    sessionId: 'binding-facts-session',
    larkAppId: 'cli_bindingfacts',
    chatId: shape.chatId,
    headless: shape.headless,
    adoptMode: !!shape.adoptedFrom,
    existingAppServerEndpoint: shape.existingAppServerEndpoint,
    backendType: (shape.backendType ?? 'pty') as any,
  });
}

const botConfigs = {
  'env sets the identity keys': { env: { ZDOTDIR: '/home/u/zdot', BASH_ENV: '/home/u/bash_env' } },
  'envUnset removes the identity keys': { envUnset: ['ZDOTDIR', 'BASH_ENV'] },
  'env and envUnset together': { env: { ZDOTDIR: '/home/u/zdot', BASH_ENV: '/home/u/bash_env' }, envUnset: ['ZDOTDIR', 'BASH_ENV'] },
};

describe('daemon session env follows the worker lark-tool binding decision', () => {
  it.each(Object.entries(botConfigs))('verified headless session: %s → botmux owns ZDOTDIR/BASH_ENV', (_label, envCfg) => {
    expect(workerBinds(validHeadless)).toBe(true);
    const { composed } = resolveSessionEnvForSession(sessionFor(validHeadless), botWith(envCfg));
    for (const key of IDENTITY_KEYS) {
      expect(composed.set).not.toHaveProperty(key);
      expect(composed.unset).not.toContain(key);
    }
  });

  const bindingOff: Record<string, Shape> = {
    'headless + adopt': { ...validHeadless, adoptedFrom: { tmuxTarget: 'adopted:0.0' } },
    'headless + external app-server': { ...validHeadless, existingAppServerEndpoint: 'ws://127.0.0.1:4500' },
    'headless + remote backend frozen on the session': { ...validHeadless, backendType: 'remote-runner' },
    'headless id that does not own the chat': { chatId: headlessChatId('hl_someoneelse01'), headless },
    'HTTP virtual chat': { chatId: 'http_async_bindingfacts' },
  };
  it.each(Object.entries(bindingOff))('%s → the user value reaches the CLI', (_label, shape) => {
    expect(workerBinds(shape)).toBe(false);
    const { composed } = resolveSessionEnvForSession(sessionFor(shape), botWith(botConfigs['env sets the identity keys']));
    expect(composed.set.ZDOTDIR).toBe('/home/u/zdot');
    expect(composed.set.BASH_ENV).toBe('/home/u/bash_env');
  });

  it('agrees with the worker for every session shape', () => {
    const shapes: Shape[] = [validHeadless, ...Object.values(bindingOff), { chatId: 'oc_bindingfacts' }];
    for (const shape of shapes) {
      const { composed } = resolveSessionEnvForSession(sessionFor(shape), botWith(botConfigs['env sets the identity keys']));
      expect({ shape, daemonLocks: !('ZDOTDIR' in composed.set) }).toEqual({ shape, daemonLocks: workerBinds(shape) });
    }
  });
});
