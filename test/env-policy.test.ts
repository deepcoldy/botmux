import { describe, it, expect } from 'vitest';
import { buildBotWorkerEnv, buildSessionChildEnv, botInjectedEnv, inheritBotEnv, normalizeEnvPolicy } from '../src/core/env-policy.js';
import { applySessionOwnerEnv } from '../src/utils/child-env.js';
import { envPolicyId, envPolicyRequiresColdStart, readEnvPolicyStamp, writeEnvPolicyStamp } from '../src/services/env-policy-stamp.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const strict = { mode: 'strict' as const, inherit: ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'TOOLCHAIN_ROOT'] };
const host = { HOME: '/test/home', PATH: '/usr/bin', LANG: 'C.UTF-8',
  UNLISTED_CLOUD_CREDENTIAL: 'host-sentinel', BOTMUX_UNKNOWN_CREDENTIAL: 'host-sentinel',
  OPENAI_API_KEY: 'sibling-sentinel', HTTPS_PROXY: 'proxy-sentinel', NODE_EXTRA_CA_CERTS: 'ca-sentinel',
  TOOLCHAIN_ROOT: 'tool-sentinel', GITHUB_TOKEN: 'daemon-sentinel', LARK_APP_SECRET: 'im-sentinel',
  BASH_ENV: '/test/poison', BOTMUX_DASHBOARD_FEISHU_H5_FUTURE: 'h5-sentinel',
};

describe('per-bot environment policy', () => {
  it('defaults to historical inheritance plus mandatory redaction', () => {
    const env = buildSessionChildEnv(host);
    expect(env.UNLISTED_CLOUD_CREDENTIAL === host.UNLISTED_CLOUD_CREDENTIAL).toBe(true);
    expect(env.OPENAI_API_KEY === host.OPENAI_API_KEY).toBe(true);
    expect('GITHUB_TOKEN' in env).toBe(false);
    expect('LARK_APP_SECRET' in env).toBe(false);
    expect('BOTMUX_DASHBOARD_FEISHU_H5_FUTURE' in env).toBe(false);
    expect(buildSessionChildEnv(host, { mode: 'inherit' })).toEqual(env);
  });
  it('excludes unknown credentials at worker and CLI boundaries, grants exact names only', () => {
    const worker = buildBotWorkerEnv(host, strict);
    const env = buildSessionChildEnv(worker, strict);
    for (const key of ['UNLISTED_CLOUD_CREDENTIAL', 'BOTMUX_UNKNOWN_CREDENTIAL', 'OPENAI_API_KEY', 'BASH_ENV', 'GITHUB_TOKEN', 'LARK_APP_SECRET']) expect(key in env, key).toBe(false);
    expect('UNLISTED_CLOUD_CREDENTIAL' in worker).toBe(false);
    expect('BOTMUX_UNKNOWN_CREDENTIAL' in worker).toBe(false);
    for (const key of ['HOME', 'PATH', 'LANG', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'TOOLCHAIN_ROOT']) expect(env[key] === host[key as keyof typeof host], key).toBe(true);
    expect(host.UNLISTED_CLOUD_CREDENTIAL === 'host-sentinel').toBe(true);
  });
  it('config injections win without cross-bot auth or host-controlled identity overrides', () => {
    const base = buildSessionChildEnv(host, strict);
    const a = { ...base, ...botInjectedEnv({ OPENAI_API_KEY: 'a-sentinel', BOTMUX_OWNER_OPEN_ID: 'ou_other', __OWNER_OPEN_ID: 'ou_other', CODEX_HOME: '/wrong', GITHUB_TOKEN: 'blocked' }, strict) };
    const b = { ...base, ...botInjectedEnv({ ANTHROPIC_AUTH_TOKEN: 'b-sentinel' }, strict) };
    applySessionOwnerEnv(a, 'ou_owner');
    applySessionOwnerEnv(b, undefined);
    expect(a.OPENAI_API_KEY === 'a-sentinel').toBe(true);
    expect('OPENAI_API_KEY' in b).toBe(false);
    expect('ANTHROPIC_AUTH_TOKEN' in a).toBe(false);
    expect(b.ANTHROPIC_AUTH_TOKEN === 'b-sentinel').toBe(true);
    expect(a.BOTMUX_OWNER_OPEN_ID === 'ou_owner').toBe(true);
    for (const key of ['BOTMUX_OWNER_OPEN_ID', '__OWNER_OPEN_ID', 'GITHUB_TOKEN', 'CODEX_HOME']) expect(key in b, key).toBe(false);
    expect('CODEX_HOME' in a).toBe(false);
    expect('GITHUB_TOKEN' in a).toBe(false);
  });
  it('preserves host worker controls and the workflow kill switch without widening CLI inheritance', () => {
    const base = { BOTMUX_WORKFLOW_ENABLED: 'false', BOTMUX_REQUIRE_MENTION_DECISION: 'true',
      WEB_HOST: '127.0.0.1', STUCK_DETECTOR_TIMEOUT_MS: '45000', UNKNOWN_CREDENTIAL: 'secret-sentinel' };
    const worker = buildBotWorkerEnv(base, { mode: 'strict' });
    for (const key of Object.keys(base).filter(key => key !== 'UNKNOWN_CREDENTIAL')) expect(worker[key]).toBe(base[key as keyof typeof base]);
    const child = buildSessionChildEnv(worker, { mode: 'strict' });
    for (const key of Object.keys(base)) expect(key in child, key).toBe(false);
  });
  it('preserves per-session homes and workflows after trusted injection', () => {
    const env = buildSessionChildEnv({ ...host, CODEX_HOME: '/test/bot/codex', BOTMUX_WORKFLOW: '1', BOTMUX_GOAL_PATH: '/test/goal', SESSION_DATA_DIR: '/test/data' }, strict);
    expect(env.CODEX_HOME === '/test/bot/codex').toBe(true);
    expect(env.BOTMUX_GOAL_PATH === '/test/goal').toBe(true);
    expect(env.BOTMUX_WORKFLOW === '1').toBe(true);
  });
  it('carries the durable primary classification and owning daemon port through strict mode', () => {
    const worker = buildBotWorkerEnv({
      BOTMUX_COORDINATION_MODE: 'primary',
      BOTMUX_DAEMON_IPC_PORT: '7951',
      BOTMUX_REMOTE_RUNNER_STATE_ROOT: '/srv/botmux/remote-runner',
    }, strict);
    const child = buildSessionChildEnv(worker, strict);
    expect(worker.BOTMUX_COORDINATION_MODE).toBe('primary');
    expect(child.BOTMUX_COORDINATION_MODE).toBe('primary');
    expect(child.BOTMUX_DAEMON_IPC_PORT).toBe('7951');
    expect(child.BOTMUX_REMOTE_RUNNER_STATE_ROOT).toBe('/srv/botmux/remote-runner');
  });
  it.each([null, [], 'strict', { mode: 'strcit' }, { mode: 'strict', inherit: ['*'] }, { mode: 'strict', inherit: ['KEY=value-sentinel'] }, { mode: 'strict', inherit: ['BOTMUX_OWNER_OPEN_ID'] }, { mode: 'strict', inherit: ['CODEX_HOME'] }, { mode: 'strict', inherit: ['GH_TOKEN'] }, { mode: 'strict', extra: 'secret-sentinel' }, { mode: 'inherit', inherit: ['AUTH'] }].map(raw => ({ raw })))('rejects invalid policies without echoing user input (%#)', ({ raw }) => {
    let error = '';
    try { normalizeEnvPolicy(raw); } catch (e) { error = String(e); }
    expect(Boolean(error)).toBe(true);
    expect(error.includes('sentinel')).toBe(false);
  });
  it('normalizes a secret-free name list without mutating config', () => {
    expect(normalizeEnvPolicy({ mode: 'strict', inherit: ['HTTPS_PROXY', 'PATH', 'HTTPS_PROXY'] })).toEqual({ mode: 'strict', inherit: ['HTTPS_PROXY', 'PATH'] });
    expect(normalizeEnvPolicy(undefined)).toBeUndefined();
    expect(inheritBotEnv(host, { mode: 'strict' }).OPENAI_API_KEY === undefined).toBe(true);
  });
  it('forces cold start for old, unreadable or differently granted persistent generations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-stamp-'));
    try {
      expect(envPolicyRequiresColdStart(undefined, strict)).toBe(true);
      expect(envPolicyRequiresColdStart('unreadable', strict)).toBe(true);
      writeEnvPolicyStamp(dir, 'session', strict);
      const stamp = readEnvPolicyStamp(dir, 'session');
      expect(stamp === envPolicyId(strict)).toBe(true);
      expect(envPolicyRequiresColdStart(stamp, strict)).toBe(false);
      expect(envPolicyRequiresColdStart(stamp, { mode: 'strict', inherit: ['OPENAI_API_KEY'] })).toBe(true);
      expect(envPolicyRequiresColdStart(undefined, undefined)).toBe(false);
      expect(readFileSync(join(dir, 'sessions/session.env-policy'), 'utf8').includes('sentinel')).toBe(false);
      writeEnvPolicyStamp(dir, 'session', undefined);
      expect(readEnvPolicyStamp(dir, 'session')).toBeUndefined();
      expect(envPolicyRequiresColdStart(readEnvPolicyStamp(dir, 'session'), strict)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
