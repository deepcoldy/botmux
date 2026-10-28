import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderIdentityWrapper, writeSessionIdentity, publishActiveTurn,
  prepareTriggerUserCliEnv, sessionIdentityBinDir, sessionIdentityPath,
  clearSessionIdentity, identityToolsFor, renderIdentityEnv,
} from '../src/core/cli-identity.js';
import { buildFsPolicy, accessForPath, type FsPolicyContext } from '../src/adapters/cli/fs-policy.js';
import { enumerateScratchSecretPaths } from '../src/adapters/backend/scratch-credentials.js';

let root: string, real: string, wrapper: string;
const sid = 'test-session';
const policy = { enabled: true, tools: ['bytedcli'] as const, fallback: 'none' as const };
const token = (who: string, exp = Math.floor(Date.now() / 1000) + 300) =>
  [Buffer.from('{"alg":"test"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: who, exp })).toString('base64url'), 'testsignature'].join('.');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ecop-identity-'));
  real = join(root, "real ecop 'tool'");
  writeFileSync(real, `#!/usr/bin/env node
const fs = require('node:fs');
const raw = process.env.USER_CLOUD_JWT;
console.log(JSON.stringify({principal:raw ? JSON.parse(Buffer.from(raw.split('.')[1], 'base64url')).sub : 'HOST_FALLBACK',
cache:process.env.ECOP_CLI_DATA_DIR, args:process.argv.slice(2), cwd:process.cwd(), input:fs.readFileSync(0,'utf8'),
code:process.env.BYTEDCLI_USER_CODE_JWT ?? null, aime:process.env.AIME_USER_CLOUD_JWT ?? null}));
console.error('real-stderr');
process.exitCode = process.argv.includes('--fail') ? 7 : 0;
`, { mode: 0o755 });
  wrapper = join(root, 'ecop');
  writeFileSync(wrapper, renderIdentityWrapper('ecop', real, 'single'), { mode: 0o755 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function grant(who = 'user-a', turn = 'turn-a', session = sid, jwt = token(who)) {
  writeSessionIdentity(root, session, { tool: 'bytedcli', cloudJwt: jwt, openId: who, turnId: turn }, 'single');
  publishActiveTurn(root, session, turn, undefined, who);
}
function run(args: string[] = ['login', '--json'], extra: NodeJS.ProcessEnv = {}, entry = wrapper) {
  return spawnSync('/bin/sh', [entry, ...args], { cwd: root, encoding: 'utf8', input: 'input-data',
    env: { ...process.env, SESSION_DATA_DIR: root, BOTMUX_SESSION_ID: sid,
      USER_CLOUD_JWT: token('host-account'), BYTEDCLI_USER_CODE_JWT: 'host-code',
      AIME_USER_CLOUD_JWT: token('another-account'), ECOP_CLI_DATA_DIR: '/untrusted/cache', ...extra } });
}

describe('managed ECOP companion', () => {
  it('executes as the turn caller and preserves argv, cwd, streams and exit status', () => {
    grant();
    const r = run(['api', 'GET', '/somewhere', 'spaces and quotes "here"', '--fail']);
    expect(r.status).toBe(7);
    expect(r.stderr).toBe('real-stderr\n');
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ principal: 'user-a', cwd: root, input: 'input-data', code: null, aime: null });
    expect(out.args).toEqual(['api', 'GET', '/somewhere', 'spaces and quotes "here"', '--fail']);
    expect(out.cache).toContain(join(root, 'ecop-runtime', sid, 'user-a'));
    expect(existsSync(sessionIdentityPath(root, sid, 'ecop'))).toBe(false);
  });

  it('re-reads the current user without freezing the first caller', () => {
    grant(); const a = JSON.parse(run().stdout);
    grant('user-b', 'turn-b'); const b = JSON.parse(run().stdout);
    expect(a.principal).toBe('user-a'); expect(b.principal).toBe('user-b');
    expect(a.cache).not.toBe(b.cache);
    grant('user-a', 'turn-c'); expect(JSON.parse(run().stdout).cache).toBe(a.cache);
  });

  it('isolates concurrent session directories and explicit environments', () => {
    grant(); const a = JSON.parse(run().stdout);
    grant('user-b', 'turn-b', 'other-session');
    const b = JSON.parse(run([], { BOTMUX_SESSION_ID: 'other-session' }).stdout);
    expect(b.principal).toBe('user-b'); expect(b.cache).not.toBe(a.cache);
    const boe = JSON.parse(run(['--boe', 'login']).stdout);
    expect(boe.cache).not.toBe(a.cache);
  });

  it('denies absent identity even when inherited credentials exist', () => {
    const r = run(); expect(r.status).toBe(77); expect(r.stdout).toBe('');
  });

  it('propagates a platform authorization denial without executing the real tool', () => {
    grant();
    writeSessionIdentity(root, sid, { tool: 'bytedcli', mode: 'denied', turnId: 'turn-a', message: "authorize at https://example.test/credentials\nIt's required" }, 'single');
    const r = run(); expect(r.status).toBe(77); expect(r.stdout).toBe('');
    expect(r.stderr).toContain('https://example.test/credentials');
    expect(r.stderr).toContain("It's required");
  });

  it.each(['', ' \t ', 'bad.jwt', token('user-a', 1)])('denies unusable credentials without host fallback (%#)', jwt => {
    grant('user-a', 'turn-a', sid, jwt);
    const r = run(); expect(r.status).toBe(77); expect(r.stdout).toBe('');
  });

  it('denies a mismatched turn or caller, including forged inherited markers', () => {
    grant(); publishActiveTurn(root, sid, 'turn-b', undefined, 'user-b');
    const r = run([], { BOTMUX_IDENTITY_OPEN_ID: 'user-a', BOTMUX_IDENTITY_TURN: 'turn-a' });
    expect(r.status).toBe(77); expect(r.stdout).toBe('');
  });

  it('denies unbound identities and withdrawn grants', () => {
    grant(); publishActiveTurn(root, sid, undefined);
    expect(run().status).toBe(77);
    grant(); clearSessionIdentity(root, sid, 'bytedcli', undefined, 'single');
    expect(run().status).toBe(77);
  });

  it.each([
    ['--user-cloud-jwt', 'override', 'login'], ['--user-cloud-jwt=override', 'login'],
    ['--fake-user=x', 'api', 'GET', '/'], ['--fake-user', 'x', 'api', 'GET', '/'],
    ['fake-user', '--json', 'auth'], ['login', 'begin'], ['login', '--begin'],
    ['login', '--complete=challenge'], ['login', '--complete', 'challenge'],
  ])('rejects identity overrides or SSO acquisition: %j', (...args) => {
    grant(); const r = run(args); expect(r.status).toBe(77); expect(r.stdout).toBe('');
  });

  it('never evaluates credential-file shell code', () => {
    grant();
    const marker = join(root, 'executed');
    writeFileSync(sessionIdentityPath(root, sid, 'bytedcli'), `BOTMUX_IDENTITY_MODE=$(touch ${marker})\n`, { mode: 0o600 });
    expect(run().status).toBe(77); expect(existsSync(marker)).toBe(false);
  });

  it('blocks a CLI installed after session creation until the entry is refreshed', () => {
    const bins = join(root, 'late-bin'); mkdirSync(bins);
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: bins + ':/usr/bin:/bin' };
    prepareTriggerUserCliEnv(env, root, sid, { ...policy, tools: [...policy.tools] }, () => {}, 'single');
    const installed = join(sessionIdentityBinDir(root, sid), 'ecop');
    writeFileSync(join(bins, 'ecop'), readFileSync(real), { mode: 0o755 });
    grant();
    expect(run([], env, installed).status).toBe(127);
    prepareTriggerUserCliEnv(env, root, sid, { ...policy, tools: [...policy.tools] }, () => {}, 'single');
    expect(JSON.parse(run([], env, installed).stdout).principal).toBe('user-a');
  });

  it('uses proven bytedcli credentials without disk material and never falls back on proof failure', () => {
    const resolver = join(root, 'proof.cjs');
    const body = renderIdentityEnv({ tool: 'bytedcli', cloudJwt: token('proven-user'), openId: 'proven-user', turnId: 'proof-turn' });
    writeFileSync(resolver, `if (process.argv.at(-1) !== 'bytedcli') process.exit(9); process.stdout.write(${JSON.stringify(body)});`);
    writeFileSync(wrapper, renderIdentityWrapper('ecop', real, 'proven', ['node', resolver]), { mode: 0o755 });
    expect(JSON.parse(run().stdout).principal).toBe('proven-user');
    expect(existsSync(sessionIdentityPath(root, sid, 'bytedcli'))).toBe(false);
    grant('legacy-user', 'legacy-turn');
    writeFileSync(resolver, 'process.exit(77);');
    expect(run().status).toBe(77);
    expect(run().stdout).toBe('');
    expect(() => renderIdentityWrapper('ecop', real, 'proven')).toThrow();
  });

  it('installs and restores the companion only with bytedcli policy', () => {
    const bins = join(root, 'real-bin'); mkdirSync(bins);
    const ecop = join(bins, 'ecop'); writeFileSync(ecop, readFileSync(real), { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: bins + ':' + process.env.PATH };
    prepareTriggerUserCliEnv(env, root, sid, { ...policy, tools: [...policy.tools] }, () => {}, 'single');
    const installed = join(sessionIdentityBinDir(root, sid), 'ecop');
    expect(existsSync(installed)).toBe(true);
    expect(existsSync(join(root, 'ecop-runtime', sid))).toBe(true);
    grant(); expect(JSON.parse(run([], env, installed).stdout).principal).toBe('user-a');
    prepareTriggerUserCliEnv(env, root, sid, { ...policy, tools: [...policy.tools] }, () => {}, 'single');
    grant('user-b', 'turn-b'); expect(JSON.parse(run([], env, installed).stdout).principal).toBe('user-b');
    expect(identityToolsFor(['lark-cli'])).not.toContain('ecop');
    prepareTriggerUserCliEnv(env, root, sid, { ...policy, enabled: false, tools: [...policy.tools] }, () => {}, 'single');
    expect(existsSync(installed)).toBe(false);
    const off = 'policy-off';
    prepareTriggerUserCliEnv({ ...env }, root, off, { ...policy, enabled: false, tools: [...policy.tools] }, () => {}, 'single');
    expect(existsSync(join(sessionIdentityBinDir(root, off), 'ecop'))).toBe(false);
  });
});

describe('ECOP cache sandbox boundary', () => {
  it.each(['linux', 'darwin'] as const)('grants only own cache writable and identity read-only on %s', platform => {
    const ctx: FsPolicyContext = { platform, homeDir: '/home/u', botmuxHome: '/home/u/.botmux',
      sessionDataDir: '/home/u/.botmux/data', sessionId: sid, workingDir: '/home/u/work',
      currentAppId: 'app', botHome: '/home/u/.botmux/bots/app', redirectedCliData: true };
    const p = buildFsPolicy(ctx);
    expect(accessForPath(p.rules, '/home/u/.botmux/data/ecop-runtime/' + sid + '/user/cache').access).toBe('readWrite');
    expect(accessForPath(p.rules, '/home/u/.botmux/data/ecop-runtime/another/cache').access).toBe('none');
    expect(accessForPath(p.rules, '/home/u/.botmux/data/cli-identity/' + sid + '.bin/.data/bytedcli.env').access).toBe('readOnly');
  });

  it('masks sibling scratch caches and carves only own cache writable', () => {
    const runtime = join(root, 'ecop-runtime');
    mkdirSync(join(runtime, sid), { recursive: true }); mkdirSync(join(runtime, 'other'));
    const result = enumerateScratchSecretPaths({ botmuxHomes: [], dataDirs: [root], homeDir: root, sessionId: sid });
    expect(result.denyPaths).toContain(runtime);
    expect(result.writableCarvePaths).toEqual([join(runtime, sid)]);
    expect(result.readOnlyCarvePaths).not.toContain(join(runtime, sid));
  });
});
