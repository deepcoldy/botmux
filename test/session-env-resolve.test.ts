/**
 * Spawn-time resolution (core/session-env-resolve.ts): what the daemon hands a
 * worker, the legacy-equivalence guarantee for bots that never touched the new
 * fields, and the stamp a running session is compared against.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackendType } from '../src/adapters/backend/types.js';
import { botInjectedEnv, buildSessionChildEnv, type EnvPolicy } from '../src/core/env-policy.js';
import { applyGlobalSessionEnvOps, invalidateGlobalConfigCache, readGlobalConfig } from '../src/global-config.js';
import { botOneShotEnv, resolveSessionEnv, sessionEnvLockContextForBot } from '../src/core/session-env-resolve.js';
import { emptyEnvLayer } from '../src/core/session-env.js';
import { readSessionEnvStamp, sessionEnvFingerprint, writeSessionEnvStamp } from '../src/services/session-env-stamp.js';

let dir: string;
let prevConfig: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'session-env-resolve-'));
  prevConfig = process.env.BOTMUX_GLOBAL_CONFIG_FILE;
  process.env.BOTMUX_GLOBAL_CONFIG_FILE = join(dir, 'config.json');
  invalidateGlobalConfigCache();
});
afterEach(() => {
  if (prevConfig === undefined) delete process.env.BOTMUX_GLOBAL_CONFIG_FILE;
  else process.env.BOTMUX_GLOBAL_CONFIG_FILE = prevConfig;
  invalidateGlobalConfigCache();
  rmSync(dir, { recursive: true, force: true });
});

const ALL_BACKENDS: BackendType[] = ['pty', 'tmux', 'zellij', 'zmx', 'herdr', 'riff', 'mojo', 'remote-runner'];

describe('legacy bots compose to exactly the old env', () => {
  // The legacy pipeline was: init.env = botCfg.env; worker childEnv =
  // buildSessionChildEnv(process.env, policy) + botInjectedEnv(env, policy).
  const legacyEnvs: Array<Record<string, string> | undefined> = [
    undefined,
    { ANTHROPIC_BASE_URL: 'https://glm', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_MODEL: 'glm-4.6' },
    { HTTPS_PROXY: 'http://p:7890', HTTP_PROXY: 'http://p:7890', ALL_PROXY: 'socks5://p:7891' },
    { PATH: '/opt/bin:/usr/bin', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '200000', EMPTY: '' },
  ];
  const policies: Array<EnvPolicy | undefined> = [undefined, { mode: 'inherit' }, { mode: 'strict', inherit: ['HTTPS_PROXY'] }];
  const host: NodeJS.ProcessEnv = {
    PATH: '/usr/bin', HOME: '/home/u', LANG: 'C', HTTPS_PROXY: 'http://host', BYTECLOUD_AUTH_AS: 'user',
    GITHUB_TOKEN: 'gh', LARK_APP_SECRET: 's', BOTMUX_SESSION_ID: 'stale',
  };

  for (const backendType of ALL_BACKENDS) {
    for (const env of legacyEnvs) {
      for (const envPolicy of policies) {
        it(`${backendType} · ${env ? Object.keys(env).join('+') : 'no env'} · ${envPolicy?.mode ?? 'default'}`, () => {
          const bot = { env, envPolicy, backendType };
          const r = resolveSessionEnv({ bot, backendType });
          expect(r.env).toEqual(env && Object.keys(env).length ? env : undefined);
          expect(r.envUnset).toBeUndefined();
          const legacyChild = { ...buildSessionChildEnv(host, envPolicy), ...botInjectedEnv(env, envPolicy) };
          const newChild = { ...buildSessionChildEnv(host, envPolicy, r.envUnset), ...botInjectedEnv(r.env, envPolicy) };
          expect(newChild).toEqual(legacyChild);
          expect(botOneShotEnv(host, bot)).toEqual(legacyChild);
        });
      }
    }
  }
});

describe('resolveSessionEnv', () => {
  it('layers the global config under the bot config', () => {
    applyGlobalSessionEnvOps([
      { op: 'set', key: 'HTTPS_PROXY', value: 'http://global' },
      { op: 'set', key: 'NO_PROXY', value: 'localhost' },
      { op: 'unset', key: 'BYTECLOUD_AUTH_AS' },
    ]);
    const r = resolveSessionEnv({
      bot: { env: { HTTPS_PROXY: 'http://bot' }, envUnset: ['NO_PROXY'] },
      backendType: 'tmux',
    });
    expect(r.env).toEqual({ HTTPS_PROXY: 'http://bot' });
    expect(r.envUnset).toEqual(['BYTECLOUD_AUTH_AS', 'NO_PROXY']);
  });

  it('a session started right after a save already sees it (no read cache)', () => {
    readGlobalConfig();   // warm the 2s cache
    applyGlobalSessionEnvOps([{ op: 'unset', key: 'FOO' }]);
    expect(resolveSessionEnv({ bot: {}, backendType: 'pty' }).envUnset).toEqual(['FOO']);
  });

  it('/cli-selected sessions get no bot set but keep every removal', () => {
    applyGlobalSessionEnvOps([{ op: 'set', key: 'G', value: '1' }]);
    const r = resolveSessionEnv({ bot: { env: { ANTHROPIC_BASE_URL: 'x' }, envUnset: ['B'] }, backendType: 'pty', skipBotSet: true });
    expect(r.env).toEqual({ G: '1' });
    expect(r.envUnset).toEqual(['B']);
  });

  it('riff / mojo keep the bot-env-only contract', () => {
    applyGlobalSessionEnvOps([{ op: 'set', key: 'G', value: '1' }, { op: 'unset', key: 'H' }]);
    for (const backendType of ['riff', 'mojo'] as const) {
      const r = resolveSessionEnv({ bot: { env: { A: '1' }, envUnset: ['B'] }, backendType });
      expect(r.env).toEqual({ A: '1' });
      expect(r.envUnset).toBeUndefined();
    }
  });

  it('drops identity-wrapper names from the bot env while the wrapper is on', () => {
    const env = { ZDOTDIR: '/mine', GIT_CONFIG_COUNT: '1', OTHER: 'x' };
    // lark tool binding is on by default for a local bot
    expect(resolveSessionEnv({ bot: { env }, backendType: 'tmux' }).env).toEqual({ GIT_CONFIG_COUNT: '1', OTHER: 'x' });
    expect(resolveSessionEnv({ bot: { env, larkToolBinding: false }, backendType: 'tmux' }).env).toEqual(env);
    expect(resolveSessionEnv({ bot: { env, larkToolBinding: false, triggerUserAuth: { enabled: true } }, backendType: 'tmux' }).env)
      .toEqual({ OTHER: 'x' });
  });

  it('locks identity names only where the worker really wraps the launch', () => {
    const env = { ZDOTDIR: '/mine', BASH_ENV: '/mine/b', OTHER: 'x' };
    // one-shots and v3 workflow workers are never wrapped → legacy env verbatim
    expect(resolveSessionEnv({ bot: { env }, backendType: 'tmux', facts: { unwrapped: true } }).env).toEqual(env);
    expect(resolveSessionEnv({ bot: { env, triggerUserAuth: { enabled: true } }, backendType: 'tmux', facts: { unwrapped: true } }).env).toEqual(env);
    // HTTP virtual chat / external App Server: binding off, trigger-user auth still wraps
    expect(resolveSessionEnv({ bot: { env }, backendType: 'tmux', facts: { larkBindingOff: true } }).env).toEqual(env);
    expect(resolveSessionEnv({ bot: { env, triggerUserAuth: { enabled: true } }, backendType: 'tmux', facts: { larkBindingOff: true } }).env).toEqual({ OTHER: 'x' });
    expect(botOneShotEnv({}, { env })).toMatchObject(env);
  });

  it('lock context follows the bot flags', () => {
    expect(sessionEnvLockContextForBot({})).toEqual({ identityShell: true, identityGit: false });
    expect(sessionEnvLockContextForBot({ apiOnly: true })).toEqual({ identityShell: false, identityGit: false });
    expect(sessionEnvLockContextForBot({ backendType: 'riff' })).toEqual({ identityShell: false, identityGit: false });
  });
});

describe('fingerprint + stamp', () => {
  const fp = (set: Record<string, string>, unset: string[] = [], policy?: EnvPolicy) => sessionEnvFingerprint({ set, unset }, policy);

  it('changes with any value, removal or policy, and ignores key order', () => {
    const base = fp({ A: '1', B: '2' });
    expect(fp({ B: '2', A: '1' })).toBe(base);
    expect(fp({ A: '1', B: '3' })).not.toBe(base);
    expect(fp({ A: '1', B: '2' }, ['C'])).not.toBe(base);
    expect(fp({ A: '1', B: '2' }, [], { mode: 'strict' })).not.toBe(base);
  });

  it('never contains the values', () => {
    expect(fp({ TOKEN: 'secret-sentinel' })).not.toContain('secret');
  });

  it('is stored per session and read back', () => {
    expect(readSessionEnvStamp(dir, 's1')).toBeUndefined();
    writeSessionEnvStamp(dir, 's1', 'abc');
    expect(readSessionEnvStamp(dir, 's1')).toBe('abc');
  });

  it('resolveSessionEnv fingerprints what it returns', () => {
    const a = resolveSessionEnv({ bot: { env: { A: '1' } }, backendType: 'pty', global: emptyEnvLayer() });
    const b = resolveSessionEnv({ bot: { env: { A: '1' }, envUnset: ['X'] }, backendType: 'pty', global: emptyEnvLayer() });
    expect(a.fingerprint).toBe(sessionEnvFingerprint(a.composed));
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});
