/**
 * The single identity decision (resolveIdentity) and the per-capability
 * "switch off => native" invariant of the generated wrappers.
 *
 * Run:  npx vitest run --project unit test/identity-policy.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { policyFromConfig, resolveIdentity } from '../src/core/identity-policy.js';
import { backgroundCredentialPolicyKey } from '../src/core/background-execution-policy.js';
import { computeInputHash } from '../src/utils/canonical-input-hash.js';
import {
  renderIdentityWrapper, writeSessionIdentity, prepareTriggerUserCliEnv, sessionIdentityBinDir,
} from '../src/core/cli-identity.js';
import {
  parseTriggerUserAuthConfig, type TriggerUserAuthCapability as Capability,
  type TriggerUserAuthCredentialSource,
} from '../src/services/trigger-user-auth.js';

describe('policyFromConfig', () => {
  it('maps legacy tools: lark-cli -> lark-user, bytedcli -> bytecloud + meego', () => {
    expect([...policyFromConfig({ enabled: true, tools: ['lark-cli'] }).capabilities]).toEqual(['lark-user']);
    expect([...policyFromConfig({ enabled: true, tools: ['bytedcli'] }).capabilities].sort()).toEqual(['bytecloud', 'meego']);
  });
  it('capabilities override tools', () => {
    const p = policyFromConfig({ enabled: true, tools: ['bytedcli'], capabilities: ['bytecloud'] });
    expect([...p.capabilities]).toEqual(['bytecloud']);
  });
  it('disabled or absent config yields no capability', () => {
    expect(policyFromConfig({ enabled: false, tools: ['bytedcli', 'lark-cli'] }).capabilities.size).toBe(0);
    expect(policyFromConfig(null).capabilities.size).toBe(0);
  });
});

describe('resolveIdentity credential-source table', () => {
  // [source, platformBound, platformGrant, localLogin] => decision
  const MATRIX: Array<[TriggerUserAuthCredentialSource, boolean, boolean | 'unavailable', boolean, object]> = [
    ['local', false, false, true, { kind: 'person', source: 'local' }],
    ['local', false, false, false, { kind: 'needs-auth', entry: 'private-link' }],
    // `local` never consults the platform, even when a grant would exist.
    ['local', true, true, false, { kind: 'needs-auth', entry: 'platform-page' }],
    ['auto', false, false, true, { kind: 'person', source: 'local' }],
    ['auto', false, false, false, { kind: 'needs-auth', entry: 'private-link' }],
    ['auto', true, true, true, { kind: 'person', source: 'platform' }],
    ['auto', true, true, false, { kind: 'person', source: 'platform' }],
    ['auto', true, false, true, { kind: 'person', source: 'local' }],
    ['auto', true, 'unavailable', true, { kind: 'person', source: 'local' }],
    ['auto', true, false, false, { kind: 'needs-auth', entry: 'platform-page' }],
    ['auto', true, 'unavailable', false, { kind: 'needs-auth', entry: 'platform-page' }],
    ['platform', false, false, true, { kind: 'needs-auth', entry: 'platform-page' }],
    ['platform', true, true, false, { kind: 'person', source: 'platform' }],
    ['platform', true, false, true, { kind: 'needs-auth', entry: 'platform-page' }],
    ['platform', true, 'unavailable', true, { kind: 'needs-auth', entry: 'platform-page' }],
  ];

  it('follows the table', () => {
    for (const [credentialSource, platformBound, platformGrant, localLogin, expected] of MATRIX) {
      expect(resolveIdentity(credentialSource, { platformBound, platformGrant, localLogin }),
        JSON.stringify([credentialSource, platformBound, platformGrant, localLogin])).toEqual(expected);
    }
  });
});

describe('wrappers: a switched-off capability runs the real binary natively', () => {
  let dir: string;
  let machineHome: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-policy-'));
    machineHome = join(dir, 'machine-home');
    mkdirSync(machineHome);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const probe = `printf "HOME=%s CLOUD=%s AIME=%s BITS=%s LINK=%s ARGS=%s" "$HOME" "\${BYTEDCLI_USER_CLOUD_JWT:-}" "\${AIME_USER_CLOUD_JWT:-}" "\${BITS_TOKEN:-}\${USER_CLOUD_JWT:-}\${AGENTBUDDY_USER_CLOUD_JWT:-}\${FLUX_USER_JWT:-}" "$([ -L "$HOME/.meegle" ] && echo yes || echo no)" "$*"`;
  function realBinary(name: string): string {
    const real = join(dir, `real-${name}.sh`);
    writeFileSync(real, `#!/bin/sh\n${probe}\n`);
    chmodSync(real, 0o755);
    return real;
  }
  function run(wrapper: string, args: string[], env: Record<string, string> = {}) {
    const r = spawnSync('/bin/sh', [wrapper, ...args], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: machineHome, SESSION_DATA_DIR: dir, BOTMUX_SESSION_ID: 'sess', ...env },
    });
    return { status: r.status, out: r.stdout, err: r.stderr };
  }
  const personHome = () => join(dir, 'person-home');
  const meegoHome = () => join(dir, 'person-meego');
  function publishPerson(extra: object = {}): void {
    for (const d of [personHome(), join(meegoHome(), '.meegle')]) mkdirSync(d, { recursive: true });
    writeSessionIdentity(dir, 'sess', {
      tool: 'bytedcli', cloudJwt: 'tok', home: personHome(), meegoHome: meegoHome(), openId: 'ou_1', ...extra,
    } as never, 'single');
  }
  const bytedcliWrapper = (native: { meego?: boolean; bytecloud?: boolean }) => {
    const wrapper = join(dir, 'bytedcli');
    writeFileSync(wrapper, renderIdentityWrapper('bytedcli', realBinary('bytedcli'), 'single', undefined, native));
    return wrapper;
  };
  const native = (args: string) => `HOME=${machineHome} CLOUD= AIME= BITS= LINK=no ARGS=${args}`;

  it('meego off, bytecloud on: a meego call is native (machine HOME, no JWT, no link, login not intercepted)', () => {
    publishPerson();
    const wrapper = bytedcliWrapper({ meego: true });
    expect(run(wrapper, ['meego', 'workitem', 'list']).out).toBe(native('meego workitem list'));
    expect(run(wrapper, ['--site', 'cn', 'meego', 'login']).out).toBe(native('--site cn meego login'));
    expect(existsSync(join(personHome(), '.meegle'))).toBe(false);
  });

  it('meego off, bytecloud on: other bytedcli calls still run as the person', () => {
    publishPerson();
    const out = run(bytedcliWrapper({ meego: true }), ['cloud', 'whoami']).out;
    expect(out).toContain(`HOME=${personHome()}`);
    expect(out).toContain('CLOUD=tok');
  });

  it('meego off: global flags before meego and --help still reach the real binary natively', () => {
    publishPerson();
    const wrapper = bytedcliWrapper({ meego: true });
    expect(run(wrapper, ['-j', 'meego', 'workitem']).out).toBe(native('-j meego workitem'));
    expect(run(wrapper, ['--jq', '.data', 'meego', 'workitem']).out).toBe(native('--jq .data meego workitem'));
    expect(run(wrapper, ['meego', '--help']).out).toBe(native('meego --help'));
  });

  it('an option of unknown arity keeps the call governed instead of guessing the first operand', () => {
    publishPerson();
    // meego off: `--mystery meego` could be a value followed by another command, so it is not native.
    const governed = run(bytedcliWrapper({ meego: true }), ['--mystery', 'meego', 'workitem']).out;
    expect(governed).toContain(`HOME=${personHome()}`);
    expect(governed).toContain('CLOUD=tok');
    // bytecloud off, nothing published: `--mystery cloud` is not native either, it is refused.
    expect(run(bytedcliWrapper({ bytecloud: true }), ['--mystery', 'cloud', 'whoami'], { BOTMUX_SESSION_ID: 'no-identity' }).status).toBe(77);
  });

  it('both on: a meego call goes through the person HOME with the Meego link', () => {
    publishPerson();
    const out = run(bytedcliWrapper({}), ['meego', 'workitem', 'list']).out;
    expect(out).toContain(`HOME=${personHome()}`);
    expect(out).toContain('CLOUD=tok');
    expect(out).toContain('LINK=yes');
  });

  it('bytecloud off, meego on: non-meego calls are native even with no identity published', () => {
    const wrapper = bytedcliWrapper({ bytecloud: true });
    expect(run(wrapper, ['cloud', 'whoami']).out).toBe(native('cloud whoami'));
    expect(run(wrapper, ['-j', 'auth', 'status']).out).toBe(native('-j auth status'));
  });

  it('bytecloud off, meego on: a meego call uses the Meego-only identity, linking the person store without a JWT', () => {
    publishPerson({ cloudJwt: '', meegoOnly: true });
    const out = run(bytedcliWrapper({ bytecloud: true }), ['meego', 'workitem', 'list'], { BYTEDCLI_USER_CLOUD_JWT: '' }).out;
    expect(out).toContain(`HOME=${personHome()}`);
    expect(out).toContain('CLOUD= ');
    expect(out).toContain('LINK=yes');
  });

  it('bytecloud off, meego on: a meego call with no identity published is refused, never run natively', () => {
    const r = run(bytedcliWrapper({ bytecloud: true }), ['meego', 'workitem', 'list']);
    expect(r.status).toBe(77);
    expect(r.out).toBe('');
  });

  describe.each(['bitscli', 'bits-cli'])('%s', name => {
    const bitsProbe = `printf "HOME=%s AIME=%s CLOUD=%s CODE=%s AMBIENT=%s ARGS=%s" "$HOME" "\${AIME_USER_CLOUD_JWT:-}" "\${CLOUD_JWT:-}" "\${CODEBASE_CLI_USER_JWT:-}" "\${BITS_TOKEN:-}\${USER_CLOUD_JWT:-}\${AGENTBUDDY_USER_CLOUD_JWT:-}\${FLUX_USER_JWT:-}\${BYTECLOUD_CLI_API_JWT_TOKEN_CN:-}\${CLOUD_JWT_CREATED_AT:-}\${CODEBASE_CLI_USER_PAT:-}\${CODEBASE_CLI_APP_ID:-}\${CODEBASE_CLI_APP_SECRET:-}" "$*"`;
    const install = () => {
      const real = join(dir, `real-${name}.sh`);
      writeFileSync(real, `#!/bin/sh\n${bitsProbe}\n`);
      chmodSync(real, 0o755);
      const wrapper = join(dir, name);
      writeFileSync(wrapper, renderIdentityWrapper('bitscli', real, 'single'));
      return wrapper;
    };

    it('runs under the person HOME with every Bits credential source set to theirs and the ambient ones cleared', () => {
      mkdirSync(personHome(), { recursive: true });
      writeSessionIdentity(dir, 'sess', {
        tool: 'bytedcli', cloudJwt: 'person-jwt', codeJwt: 'person-code', home: personHome(), openId: 'ou_1',
      }, 'single');
      const r = run(install(), ['devops', 'auth', 'whoami'], {
        BITS_TOKEN: 'a', USER_CLOUD_JWT: 'b', AGENTBUDDY_USER_CLOUD_JWT: 'c', FLUX_USER_JWT: 'd', AIME_USER_CLOUD_JWT: 'ambient',
        BYTECLOUD_CLI_API_JWT_TOKEN_CN: 'e', CLOUD_JWT: 'ambient', CLOUD_JWT_CREATED_AT: '1', CODEBASE_CLI_USER_PAT: 'f',
        CODEBASE_CLI_APP_ID: 'g', CODEBASE_CLI_APP_SECRET: 'h', CODEBASE_CLI_USER_JWT: 'ambient',
      });
      expect(r.out).toBe(`HOME=${personHome()} AIME=person-jwt CLOUD=person-jwt CODE=person-code AMBIENT= ARGS=devops auth whoami`);
    });

    it('without a Codebase JWT the machine\'s ambient Codebase JWT is not passed through', () => {
      mkdirSync(personHome(), { recursive: true });
      writeSessionIdentity(dir, 'sess', { tool: 'bytedcli', cloudJwt: 'person-jwt', home: personHome(), openId: 'ou_1' }, 'single');
      expect(run(install(), ['codebase', 'api'], { CODEBASE_CLI_USER_JWT: 'ambient' }).out).toContain('CODE= ');
    });

    it('a refused bytedcli identity refuses it without running it', () => {
      writeSessionIdentity(dir, 'sess', { tool: 'bytedcli', mode: 'denied', message: 'botmux: 需要授权 ByteCloud' }, 'single');
      const r = run(install(), ['devops', 'auth', 'whoami']);
      expect(r.status).toBe(77);
      expect(r.out).toBe('');
      expect(r.err).toContain('需要授权 ByteCloud');
    });
  });

  it('options after the subcommand never change routing', () => {
    publishPerson();
    // meego off, bytecloud on: a non-meego call with later options is the person's...
    const person = run(bytedcliWrapper({ meego: true }), ['tce', 'get-service', '--psm', 'foo', '-n', '5']).out;
    expect(person).toContain(`HOME=${personHome()}`);
    // ...and a meego call with later options is native.
    expect(run(bytedcliWrapper({ meego: true }), ['meego', 'workitem', 'get', '--id', '123', '-x']).out)
      .toBe(native('meego workitem get --id 123 -x'));
    // bytecloud off, meego on: the mirror image.
    expect(run(bytedcliWrapper({ bytecloud: true }), ['-j', 'tce', 'list', '-n', '5']).out).toBe(native('-j tce list -n 5'));
  });

  it('global options of every kind are skipped before the routing operand (meego off, bytecloud off)', () => {
    publishPerson();
    // The wrapper path is shared, so each call installs the variant it needs.
    const meegoNative = (args: string[]) => run(bytedcliWrapper({ meego: true }), args);
    const byteCloudNative = (args: string[]) => run(bytedcliWrapper({ bytecloud: true }), args);
    for (const lead of [['-dj'], ['--color'], ['--tls1.2'], ['--no-auto-upgrade'], ['--http-trace-file', 'meego'], ['--http-proxy', 'x', '--no-color'], ['--']]) {
      // meego off: a meego call is native however it is written.
      const m = [...lead, 'meego', 'workitem'];
      if (lead[0] !== '--http-trace-file') expect(meegoNative(m).out).toBe(native(m.join(' ')));
      // bytecloud off: any other call is native, and a meego call is not.
      const c = [...lead, 'tce', 'list'];
      expect(byteCloudNative(c).out).toBe(native(c.join(' ')));
    }
    // `--http-trace-file meego tce list`: meego is the option's value, the call is `tce list`.
    expect(meegoNative(['--http-trace-file', 'meego', 'tce', 'list']).out).toContain(`HOME=${personHome()}`);
    expect(byteCloudNative(['--http-trace-file', 'meego', 'tce', 'list']).out).toBe(native('--http-trace-file meego tce list'));
  });

  describe('bytecloud capability on', () => {
    // A fake `botmux auth request`: prints a message, exits with $FAKE_BOTMUX_RC, and for rc 0 swaps in the
    // identity a finished authorization would publish.
    function fakeBotmux(rc: number, authorized?: string): string {
      const bin = join(dir, 'fake-bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'botmux'), `#!/bin/sh\necho "$*" >> "${join(dir, 'botmux.calls')}"\n${authorized ? `cp "${authorized}" "${join(dir, 'cli-identity/sess.bin/.data/bytedcli.env')}"\n` : ''}echo BOTMUX-SAYS\nexit ${rc}\n`, { mode: 0o755 });
      return bin;
    }
    const denied = () => writeSessionIdentity(dir, 'sess', {
      tool: 'bytedcli', mode: 'denied', turnId: 't1', openId: 'ou_1', message: 'botmux: 需要授权 [reason=not_authorized]',
    }, 'single');
    const tools: Array<[string, string[]]> = [
      ['bytedcli', ['auth', 'login']], ['bytedcli', ['-j', 'auth', 'login']], ['bitscli', ['devops', 'auth', 'login']], ['bits-cli', ['auth', 'login']],
    ];

    it.each(tools)('%s %j never runs the real login: botmux is asked, no link reaches the agent', (name, args) => {
      publishPerson();
      const real = realBinary(name);
      const wrapper = join(dir, name);
      writeFileSync(wrapper, renderIdentityWrapper(name === 'bytedcli' ? 'bytedcli' : 'bitscli', real, 'single'));
      const r = run(wrapper, args, { PATH: `${fakeBotmux(3)}:/usr/bin:/bin` });
      expect(r.out).toBe('');
      expect(r.status).toBe(77);
      expect(r.err).toContain('BOTMUX-SAYS');
    });

    it.each(['bytedcli', 'codebase', 'bitscli'] as const)('%s: refused for want of authorization, then authorized: the same call goes on', name => {
      const real = realBinary(name);
      const wrapper = join(dir, name);
      writeFileSync(wrapper, renderIdentityWrapper(name, real, 'single'));
      const ready = mkdtempSync(join(tmpdir(), 'botmux-ready-'));
      mkdirSync(personHome(), { recursive: true });
      writeSessionIdentity(ready, 'sess', { tool: 'bytedcli', cloudJwt: 'person-jwt', codeJwt: 'person-code', home: personHome(), openId: 'ou_1', turnId: 't1' }, 'single');
      const file = join(ready, 'cli-identity/sess.bin/.data', name === 'bytedcli' ? 'bytedcli.env' : `${name}.env`);
      denied();
      // The fake only ever swaps bytedcli.env; the companions read their own file.
      const bin = fakeBotmux(0, name === 'bytedcli' ? file : undefined);
      if (name !== 'bytedcli') {
        writeFileSync(join(bin, 'botmux'), `#!/bin/sh\ncp "${file}" "${join(dir, `cli-identity/sess.bin/.data/${name}.env`)}"\necho "$*" >> "${join(dir, 'botmux.calls')}"\nexit 0\n`, { mode: 0o755 });
        writeSessionIdentity(dir, 'sess', { tool: 'bytedcli', mode: 'denied', turnId: 't1', openId: 'ou_1', message: 'botmux: 需要授权 [reason=not_authorized]' }, 'single');
      }
      const r = run(wrapper, ['x', 'y'], { PATH: `${bin}:/usr/bin:/bin` });
      rmSync(ready, { recursive: true, force: true });
      expect(r.status).toBe(0);
      expect(r.out).toContain('ARGS=x y');
      expect(readFileSync(join(dir, 'botmux.calls'), 'utf8')).toContain('auth request --provider bytedcli');
    });

    it.each(['platform_not_authorized', 'platform_consent_missing', 'platform_not_teammate', 'platform_forbidden'])(
      'a [reason=%s] refusal goes to botmux and its link-free answer is what the agent sees', reason => {
        writeSessionIdentity(dir, 'sess', { tool: 'bytedcli', mode: 'denied', turnId: 't1', openId: 'ou_1', message: `botmux: 平台没有签发 [reason=${reason}]` }, 'single');
        const r = run(installFor('bytedcli'), ['codebase', 'mr', 'list'], { PATH: `${fakeBotmux(3)}:/usr/bin:/bin` });
        expect(r.status).toBe(77);
        expect(r.out).toBe('');
        expect(r.err).toContain('BOTMUX-SAYS');
        expect(r.err).not.toContain('平台没有签发');
        expect(botmuxCalls()).toBe('auth request --provider bytedcli\n');
      });

    it('the platform will not issue for the person, who meanwhile finished the local entry botmux sent: the same call goes on', () => {
      const ready = mkdtempSync(join(tmpdir(), 'botmux-ready-'));
      mkdirSync(personHome(), { recursive: true });
      writeSessionIdentity(ready, 'sess', { tool: 'bytedcli', cloudJwt: 'person-jwt', codeJwt: 'person-code', home: personHome(), openId: 'ou_1', turnId: 't1' }, 'single');
      writeSessionIdentity(dir, 'sess', { tool: 'bytedcli', mode: 'denied', turnId: 't1', openId: 'ou_1', message: 'botmux: 平台不会签发 [reason=platform_not_teammate]' }, 'single');
      const r = run(installFor('bytedcli'), ['x', 'y'], { PATH: `${fakeBotmux(0, join(ready, 'cli-identity/sess.bin/.data/bytedcli.env'))}:/usr/bin:/bin` });
      rmSync(ready, { recursive: true, force: true });
      expect(r.status).toBe(0);
      expect(r.out).toContain('ARGS=x y');
      expect(r.out).toContain('CLOUD=person-jwt');
    });

    it('lark-cli: a platform refusal goes to botmux and its link-free answer is what the agent sees', () => {
      const wrapper = join(dir, 'lark-cli');
      writeFileSync(wrapper, renderIdentityWrapper('lark-cli', realBinary('lark-cli'), 'single'));
      writeSessionIdentity(dir, 'sess', { tool: 'lark-cli', mode: 'denied', turnId: 't1', openId: 'ou_1', message: 'botmux: 平台没有签发 [reason=platform_not_authorized]' }, 'single');
      const r = run(wrapper, ['contact', '+get-user'], { PATH: `${fakeBotmux(3)}:/usr/bin:/bin` });
      expect(r.status).toBe(77);
      expect(r.out).toBe('');
      expect(r.err).toContain('BOTMUX-SAYS');
      expect(r.err).not.toContain('平台没有签发');
      expect(botmuxCalls()).toBe('auth request --provider lark-cli\n');
    });

    it('a platform refusal with botmux unreachable prints the published text', () => {
      writeSessionIdentity(dir, 'sess', { tool: 'bytedcli', mode: 'denied', turnId: 't1', openId: 'ou_1', message: 'botmux: 平台没有签发 [reason=platform_not_authorized]' }, 'single');
      const r = run(installFor('bytedcli'), ['codebase', 'mr', 'list'], { PATH: `${fakeBotmux(1)}:/usr/bin:/bin` });
      expect(r.status).toBe(77);
      expect(r.err).toContain('平台没有签发');
    });

    describe('the browser-session login is no ByteCloud login', () => {
      it.each([
        [['--json', 'auth', 'login', '--begin', '--session', '--feishu']],
        [['auth', 'login', '--session-method=feishu']],
        [['auth', 'login', '--session-method', 'feishu']],
        [['auth', '--session-method', 'qr', 'login']],
      ])('attended %j runs the real binary under the person\'s HOME; botmux is never asked', args => {
        publishPerson();
        const wrapper = join(dir, 'bytedcli');
        writeFileSync(wrapper, renderIdentityWrapper('bytedcli', realBinary('bytedcli'), 'single'));
        const r = run(wrapper, args, { PATH: `${fakeBotmux(3)}:/usr/bin:/bin` });
        expect(r.status).toBe(0);
        expect(r.out).toContain(`HOME=${personHome()}`);
        expect(r.out).toContain(`ARGS=${args.join(' ')}`);
        expect(r.out + r.err).not.toMatch(/already authorized|BOTMUX-SAYS/);
        expect(existsSync(join(dir, 'botmux.calls'))).toBe(false);
      });
      it('the global --session-id is not the browser session: the ByteCloud login stays with botmux', () => {
        publishPerson();
        const wrapper = join(dir, 'bytedcli');
        writeFileSync(wrapper, renderIdentityWrapper('bytedcli', realBinary('bytedcli'), 'single'));
        const r = run(wrapper, ['--session-id', 's1', 'auth', 'login'], { PATH: `${fakeBotmux(3)}:/usr/bin:/bin` });
        expect(r.status).toBe(77);
        expect(r.out).toBe('');
        expect(r.err).toContain('BOTMUX-SAYS');
      });
      it('unattended it is refused with exit 77 and the real binary does not run', () => {
        mkdirSync(personHome(), { recursive: true });
        writeSessionIdentity(dir, 'sess', {
          tool: 'bytedcli', cloudJwt: 'creator-jwt', home: personHome(), openId: 'ou_1',
          turnId: 'schedule:abc:11111111-1111-1111-1111-111111111111',
        }, 'single');
        const wrapper = join(dir, 'bytedcli');
        writeFileSync(wrapper, renderIdentityWrapper('bytedcli', realBinary('bytedcli'), 'single'));
        const r = run(wrapper, ['auth', 'login', '--begin', '--session', '--feishu'], { PATH: `${fakeBotmux(3)}:/usr/bin:/bin` });
        expect(r.status).toBe(77);
        expect(r.out).toBe('');
        expect(r.err).toContain('无人值守');
        expect(existsSync(join(dir, 'botmux.calls'))).toBe(false);
      });
    });

    it('still refused after botmux answers 0 without a usable identity: exits 77 without running', () => {
      denied();
      const wrapper = join(dir, 'bytedcli');
      writeFileSync(wrapper, renderIdentityWrapper('bytedcli', realBinary('bytedcli'), 'single'));
      const r = run(wrapper, ['cloud', 'whoami'], { PATH: `${fakeBotmux(0)}:/usr/bin:/bin` });
      expect(r.status).toBe(77);
      expect(r.out).toBe('');
    });

    it.each([['bytedcli', '--help'], ['bytedcli', '--version'], ['bitscli', '--help'], ['bitscli', '--version']] as const)(
      '%s %s runs with no credential, no injected identity and not the machine HOME', (name, flag) => {
        const wrapper = join(dir, name);
        writeFileSync(wrapper, renderIdentityWrapper(name, realBinary(name), 'single'));
        const r = run(wrapper, [flag], { BITS_TOKEN: 'ambient', AIME_USER_CLOUD_JWT: 'ambient' });
        expect(r.status).toBe(0);
        expect(r.out).toContain(`ARGS=${flag}`);
        expect(r.out).not.toContain(`HOME=${machineHome}`);
        if (name === 'bitscli') expect(r.out).toContain('CLOUD= AIME= BITS= ');
        
      });

    const installFor = (name: 'bytedcli' | 'bitscli' | 'codebase') => {
      const wrapper = join(dir, name);
      writeFileSync(wrapper, renderIdentityWrapper(name, realBinary(name), 'single'));
      return wrapper;
    };
    const botmuxCalls = () => existsSync(join(dir, 'botmux.calls')) ? readFileSync(join(dir, 'botmux.calls'), 'utf8') : '';

    it('bare invocation and a single help flag run in a private throwaway HOME that is gone afterwards', () => {
      const wrapper = installFor('bytedcli');
      for (const args of [[], ['--help'], ['-V']]) {
        const out = run(wrapper, args, { XDG_RUNTIME_DIR: join(dir, 'agent-controlled') }).out;
        const home = /HOME=(\S+)/.exec(out)![1];
        expect(home).not.toBe(machineHome);
        expect(home).not.toContain('agent-controlled');
        expect(existsSync(home)).toBe(false);
      }
    });

    it.each([
      ['bytedcli', ['--http-trace-file', '-h', 'auth', 'login']],
      ['bitscli', ['--session-id', '-h', 'devops', 'auth', 'login']],
    ] as const)('%s %j: a help flag that is an option value or comes with other words cannot hide a login', (name, args) => {
      publishPerson();
      const r = run(installFor(name), [...args], { PATH: `${fakeBotmux(3)}:/usr/bin:/bin` });
      expect(r.status).toBe(77);
      expect(r.out).toBe('');
      expect(botmuxCalls()).toContain('auth request --provider bytedcli');
    });

    it.each([
      ['bytedcli', ['login']], ['bytedcli', ['codebase', 'auth', 'login']], ['bitscli', ['codebase', 'auth', 'login']],
      ['bytedcli', ['auth', '--site', 'cn', 'login']], ['bytedcli', ['auth', '--debug', 'login']],
      ['bytedcli', ['-dj', 'auth', 'login']], ['bytedcli', ['--', 'auth', 'login']],
      ['bytedcli', ['auth', '--verbose', 'login']], ['bytedcli', ['auth', '-x', 'login']], ['bitscli', ['--verbose', 'auth', 'login']],
      ['bytedcli', ['--http-trace-file', 'x', 'auth', 'login']],
    ] as const)('%s %j is a login and goes to botmux', (name, args) => {
      publishPerson();
      const r = run(installFor(name), [...args], { PATH: `${fakeBotmux(3)}:/usr/bin:/bin` });
      expect(r.status).toBe(77);
      expect(r.out).toBe('');
      expect(botmuxCalls()).toContain('auth request --provider bytedcli');
    });

    it.each([
      ['bytedcli', ['codebase', 'search', 'login']], ['bytedcli', ['codebase', 'issue', 'create', '--title', 'login']],
      ['bytedcli', ['codebase', 'issue', 'create', '--title=login']], ['bytedcli', ['foo', '--title', 'login']],
      ['bytedcli', ['config', 'set', 'login']],
      ['bytedcli', ['tce', 'list', 'login']], ['bitscli', ['codebase', 'search', 'login']],
      ['bitscli', ['pipeline', 'login']], ['bitscli', ['slardar-app', 'login']], ['bitscli', ['slardar-pc', 'login']],
      ['bytedcli', ['lark', 'login']], ['bytedcli', ['insearch', 'login']], ['bytedcli', ['mira', 'login']],
    ] as const)('%s %j: `login` that is no auth/meego login is an ordinary argument and runs as the person', (name, args) => {
      publishPerson();
      const out = run(installFor(name), [...args], { PATH: `${fakeBotmux(3)}:/usr/bin:/bin` }).out;
      expect(out).toContain(`ARGS=${args.join(' ')}`);
      expect(botmuxCalls()).toBe('');
    });

    it('meego workitem search login is a Meego call, not a login', () => {
      publishPerson();
      writeFileSync(join(meegoHome(), '.meegle', 'credentials.enc'), 'x');
      const out = run(installFor('bytedcli'), ['meego', 'workitem', 'search', 'login'], { PATH: `${fakeBotmux(3)}:/usr/bin:/bin` }).out;
      expect(out).toContain('ARGS=meego workitem search login');
      expect(botmuxCalls()).toBe('');
    });

    it('a login whose identity cannot be resolved still reaches botmux, which reports itself unreachable', () => {
      const wrapper = join(dir, 'bytedcli');
      writeFileSync(wrapper, renderIdentityWrapper('bytedcli', realBinary('bytedcli'), 'proven', ['/bin/false']));
      const r = run(wrapper, ['auth', 'login']);
      expect(r.status).toBe(77);
      expect(r.err).toContain('联系不上 botmux');
    });

    it('after botmux answers 0 and the identity is still denied, botmux\'s reply is printed, not the stale refusal', () => {
      denied();
      const r = run(installFor('bytedcli'), ['cloud', 'whoami'], { PATH: `${fakeBotmux(0)}:/usr/bin:/bin` });
      expect(r.status).toBe(77);
      expect(r.err).toContain('BOTMUX-SAYS');
      expect(r.err).not.toContain('需要授权');
    });

    it('an identity that names no turn or no person is never taken for the one that was refused', () => {
      for (const missing of ['turnId', 'openId']) {
        const ready = mkdtempSync(join(tmpdir(), 'botmux-ready-'));
        mkdirSync(personHome(), { recursive: true });
        writeSessionIdentity(ready, 'sess', { tool: 'bytedcli', cloudJwt: 'person-jwt', home: personHome(), openId: 'ou_1', turnId: 't1' }, 'single');
        writeSessionIdentity(dir, 'sess', {
          tool: 'bytedcli', mode: 'denied', message: 'botmux: 需要授权 [reason=not_authorized]',
          ...(missing === 'turnId' ? { openId: 'ou_1' } : { turnId: 't1' }),
        }, 'single');
        const file = join(ready, 'cli-identity/sess.bin/.data/bytedcli.env');
        const r = run(installFor('bytedcli'), ['cloud', 'whoami'], { PATH: `${fakeBotmux(0, file)}:/usr/bin:/bin` });
        rmSync(ready, { recursive: true, force: true });
        expect(r.status).toBe(77);
        expect(r.out).toBe('');
      }
    });

    it('a login command carrying a help flag takes the throwaway-HOME help path and requests nothing', () => {
      for (const args of [['auth', 'login', '--help'], ['codebase', 'auth', 'login', '-h']]) {
        const r = run(installFor('bytedcli'), args, { PATH: `${fakeBotmux(3)}:/usr/bin:/bin` });
        expect(r.status).toBe(0);
        expect(r.out).toContain(`ARGS=${args.join(' ')}`);
        expect(r.out).not.toContain(`HOME=${machineHome}`);
      }
      expect(botmuxCalls()).toBe('');
    });

    it('a word that is an option value is not an operand: --profile login runs the call as the person', () => {
      publishPerson();
      const out = run(installFor('bytedcli'), ['--profile', 'login', 'tce', 'list'], { PATH: `${fakeBotmux(3)}:/usr/bin:/bin` }).out;
      expect(out).toContain('ARGS=--profile login tce list');
      expect(botmuxCalls()).toBe('');
    });

    it('login of an already authorized person: botmux says so, the real login does not run, exit 0', () => {
      publishPerson();
      const r = run(installFor('bitscli'), ['devops', 'auth', 'login'], { PATH: `${fakeBotmux(0)}:/usr/bin:/bin` });
      expect(r.status).toBe(0);
      expect(r.out).toBe('');
      expect(r.err).toContain('BOTMUX-SAYS');
    });

    it('botmux unreachable during a login: refused, nothing real runs', () => {
      publishPerson();
      const r = run(installFor('bytedcli'), ['auth', 'login'], { PATH: '/usr/bin:/bin' });
      expect(r.status).toBe(77);
      expect(r.out).toBe('');
      expect(r.err).toContain('联系不上 botmux');
    });

    it('authorization that arrives for another turn is not taken over', () => {
      const ready = mkdtempSync(join(tmpdir(), 'botmux-other-turn-'));
      mkdirSync(personHome(), { recursive: true });
      writeSessionIdentity(ready, 'sess', { tool: 'bytedcli', cloudJwt: 'other-jwt', home: personHome(), openId: 'ou_1', turnId: 'turn-B' }, 'single');
      writeSessionIdentity(dir, 'sess', { tool: 'bytedcli', mode: 'denied', message: 'botmux: 需要授权 [reason=not_authorized]', turnId: 'turn-A', openId: 'ou_1' }, 'single');
      const r = run(installFor('bytedcli'), ['cloud', 'whoami'], {
        PATH: `${fakeBotmux(0, join(ready, 'cli-identity/sess.bin/.data/bytedcli.env'))}:/usr/bin:/bin`,
      });
      rmSync(ready, { recursive: true, force: true });
      expect(r.status).toBe(77);
      expect(r.out).toBe('');
    });

    it('a person who is someone else than the refused one is not taken over either', () => {
      const ready = mkdtempSync(join(tmpdir(), 'botmux-other-person-'));
      mkdirSync(personHome(), { recursive: true });
      writeSessionIdentity(ready, 'sess', { tool: 'bytedcli', cloudJwt: 'other-jwt', home: personHome(), openId: 'ou_2', turnId: 'turn-A' }, 'single');
      writeSessionIdentity(dir, 'sess', { tool: 'bytedcli', mode: 'denied', message: 'botmux: 需要授权 [reason=not_authorized]', turnId: 'turn-A', openId: 'ou_1' }, 'single');
      const r = run(installFor('bytedcli'), ['cloud', 'whoami'], {
        PATH: `${fakeBotmux(0, join(ready, 'cli-identity/sess.bin/.data/bytedcli.env'))}:/usr/bin:/bin`,
      });
      rmSync(ready, { recursive: true, force: true });
      expect(r.status).toBe(77);
    });

    it('bitscli sees only the allowlisted environment, the person HOME with XDG under it, and the injected identity', () => {
      const real = join(dir, 'real-env.sh');
      writeFileSync(real, '#!/bin/sh\nenv | sort\n', { mode: 0o755 });
      const wrapper = join(dir, 'bitscli');
      writeFileSync(wrapper, renderIdentityWrapper('bitscli', real, 'single'));
      mkdirSync(personHome(), { recursive: true });
      writeSessionIdentity(dir, 'sess', { tool: 'bytedcli', cloudJwt: 'person-jwt', codeJwt: 'person-code', home: personHome(), openId: 'ou_1' }, 'single');
      const seen = Object.fromEntries(run(wrapper, ['x'], {
        LANG: 'C.UTF-8', https_proxy: 'http://proxy.example:1', BITS_TOKEN: 'a', SOME_NEW_JWT_VAR: 'b', MY_SECRET: 'c', AWS_ACCESS_KEY_ID: 'd',
        BOTMUX_SESSION_ID_EXTRA: 'e', ANTHROPIC_API_KEY: 'f',
      }).out.trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
      delete seen.PWD; // set by the shell the fake binary runs in
      expect(Object.keys(seen).sort()).toEqual([
        'AIME_USER_CLOUD_JWT', 'BYTEDCLI_USER_CLOUD_JWT', 'CLOUD_JWT', 'CODEBASE_CLI_USER_JWT', 'HOME', 'LANG', 'PATH',
        'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'https_proxy',
      ].sort());
      expect(seen.HOME).toBe(personHome());
      expect(seen.XDG_CONFIG_HOME).toBe(`${personHome()}/.config`);
      expect(seen.CODEBASE_CLI_USER_JWT).toBe('person-code');
    });

    describe('unattended turns (scheduled and background) never start an authorization', () => {
      const unattendedIdentity = (extra: object = {}) => {
        mkdirSync(personHome(), { recursive: true });
        writeSessionIdentity(dir, 'sess', {
          tool: 'bytedcli', cloudJwt: 'creator-jwt', home: personHome(), openId: 'ou_1',
          turnId: 'schedule:abc:11111111-1111-1111-1111-111111111111', ...extra,
        }, 'single');
      };

      it('with the creator\'s credentials the governed call runs, and botmux is not asked anything', () => {
        unattendedIdentity();
        const out = run(installFor('bytedcli'), ['tce', 'list'], { PATH: `${fakeBotmux(3)}:/usr/bin:/bin` }).out;
        expect(out).toContain('CLOUD=creator-jwt');
        expect(botmuxCalls()).toBe('');
      });

      it.each([
        ['bytedcli', ['auth', 'login']], ['bitscli', ['devops', 'auth', 'login']], ['bits-cli', ['auth', 'login']],
      ] as const)('%s %j is refused with the unattended message: no flow, no link', (name, args) => {
        unattendedIdentity();
        const wrapper = join(dir, name);
        writeFileSync(wrapper, renderIdentityWrapper(name === 'bytedcli' ? 'bytedcli' : 'bitscli', realBinary(name), 'single'));
        const r = run(wrapper, [...args], { PATH: `${fakeBotmux(3)}:/usr/bin:/bin` });
        expect(r.status).toBe(77);
        expect(r.out).toBe('');
        expect(r.err).toContain('无人值守');
        expect(r.err).not.toContain('BOTMUX-SAYS');
        // Only the non-interactive notice request; it is not waited on and its answer never reaches the agent.
        expect(botmuxCalls()).toBe('auth request --provider bytedcli --unattended\n');
      });

      it.each([
        ['bytedcli', 'schedule:abc:11111111-1111-1111-1111-111111111111'], ['bytedcli', 'background:job-1'],
        ['bytedcli', 'trg_abc'], ['bytedcli', 'workflow-event:run-1'],
      ])('a refusal published for the unattended turn %s %s is printed as is after the one notice request', (_name, turnId) => {
        writeSessionIdentity(dir, 'sess', {
          tool: 'bytedcli', mode: 'denied', message: 'botmux: 无人值守 [reason=unattended]', turnId, openId: 'ou_1',
        }, 'single');
        const r = run(installFor('bytedcli'), ['tce', 'list'], { PATH: `${fakeBotmux(0)}:/usr/bin:/bin` });
        expect(r.status).toBe(77);
        expect(r.err).toContain('[reason=unattended]');
        expect(r.err).not.toContain('BOTMUX-SAYS');
        expect(botmuxCalls()).toBe('auth request --provider bytedcli --unattended\n');
      });

      it('an unattended notice that could not be delivered tells the agent so, with botmux\'s own text', () => {
        writeSessionIdentity(dir, 'sess', {
          tool: 'bytedcli', mode: 'denied', message: 'botmux: 无人值守 [reason=unattended]',
          turnId: 'schedule:abc:11111111-1111-1111-1111-111111111111', openId: 'ou_1',
        }, 'single');
        const r = run(installFor('bytedcli'), ['tce', 'list'], { PATH: `${fakeBotmux(5)}:/usr/bin:/bin` });
        expect(r.status).toBe(77);
        expect(r.err).toContain('BOTMUX-SAYS');
        expect(r.err).not.toContain('[reason=unattended]');
      });

      it('a platform that will not issue for the person in an unattended run asks botmux for nothing and keeps its text', () => {
        writeSessionIdentity(dir, 'sess', {
          tool: 'bytedcli', mode: 'denied', message: 'botmux: 不同团队 [reason=platform_not_teammate]',
          turnId: 'schedule:abc:11111111-1111-1111-1111-111111111111', openId: 'ou_1',
        }, 'single');
        const r = run(installFor('bytedcli'), ['tce', 'list'], { PATH: `${fakeBotmux(3)}:/usr/bin:/bin` });
        expect(r.status).toBe(77);
        expect(r.err).toContain('不同团队');
        expect(botmuxCalls()).toBe('');
      });

      it('a refusal that is not a lapse (platform unavailable) asks botmux for nothing', () => {
        writeSessionIdentity(dir, 'sess', {
          tool: 'bytedcli', mode: 'denied', message: 'botmux: 平台暂不可用 [reason=platform_unavailable]',
          turnId: 'schedule:abc:11111111-1111-1111-1111-111111111111', openId: 'ou_1',
        }, 'single');
        const r = run(installFor('bytedcli'), ['tce', 'list'], { PATH: `${fakeBotmux(0)}:/usr/bin:/bin` });
        expect(r.status).toBe(77);
        expect(botmuxCalls()).toBe('');
      });

      it('an unattended login says so: the credential is valid when botmux answers ready, missing otherwise', () => {
        unattendedIdentity();
        const ready = run(installFor('bytedcli'), ['auth', 'login'], { PATH: `${fakeBotmux(0)}:/usr/bin:/bin` });
        expect(ready.status).toBe(77);
        expect(ready.err).toContain('凭据有效');
        expect(ready.err).toContain('直接运行');
        const missing = run(installFor('bytedcli'), ['auth', 'login'], { PATH: `${fakeBotmux(3)}:/usr/bin:/bin` });
        expect(missing.err).toContain('授权缺失');
        expect(missing.err).not.toContain('凭据有效');
      });

      it('a Meego login inside an unattended run is refused and asks botmux only for the notice', () => {
        unattendedIdentity({ meegoHome: join(dir, 'person-meego') });
        mkdirSync(join(dir, 'person-meego', '.meegle'), { recursive: true });
        const r = run(bytedcliWrapper({}), ['meego', 'login'], { PATH: `${fakeBotmux(3)}:/usr/bin:/bin` });
        expect(r.status).toBe(77);
        expect(r.err).toContain('无人值守');
        // The only thing botmux is asked is the private, deduped notice; its answer never reaches the agent.
        expect(botmuxCalls()).toBe('auth request --provider meego --unattended\n');
        expect(r.err).not.toContain('BOTMUX-SAYS');
        expect(r.out).toBe('');
      });

      it('an unattended `--tenant dcar meego login` is refused before the tenant is saved', () => {
        unattendedIdentity({ meegoHome: join(dir, 'person-meego') });
        mkdirSync(join(dir, 'person-meego', '.meegle'), { recursive: true });
        const marker = join(dir, 'real-called');
        const real = join(dir, 'real-marker.sh');
        writeFileSync(real, `#!/bin/sh\necho "$@" >> ${marker}\n`, { mode: 0o755 });
        const wrapper = join(dir, 'bytedcli');
        writeFileSync(wrapper, renderIdentityWrapper('bytedcli', real, 'single', undefined, {}));
        const r = run(wrapper, ['--tenant', 'dcar', 'meego', 'login'], { PATH: `${fakeBotmux(3)}:/usr/bin:/bin` });
        expect(r.status).toBe(77);
        expect(existsSync(marker)).toBe(false);
      });
    });

    it('bitscli: every region token and slardar credential is scrubbed; slardar reads the person JWT', () => {
      const wrapper = join(dir, 'bitscli');
      const real = join(dir, 'real-env.sh');
      writeFileSync(real, '#!/bin/sh\nenv | grep -E "JWT|TOKEN" | sort\n', { mode: 0o755 });
      writeFileSync(wrapper, renderIdentityWrapper('bitscli', real, 'single'));
      mkdirSync(personHome(), { recursive: true });
      writeSessionIdentity(dir, 'sess', { tool: 'bytedcli', cloudJwt: 'person-jwt', home: personHome(), openId: 'ou_1' }, 'single');
      const out = run(wrapper, ['slardar'], {
        USER_JWT_TOKEN: 'a', SLARDAR_CLI_JWT: 'b', BYTECLOUD_CLI_API_JWT_TOKEN_CN: 'c', BYTECLOUD_CLI_API_JWT_TOKEN_I18N_TT: 'd',
        BYTECLOUD_CLI_API_JWT_TOKEN_US_TTP: 'e', BYTEDCLI_USER_CLOUD_JWT: 'ambient',
      }).out.trim().split('\n').sort();
      expect(out).toEqual(['AIME_USER_CLOUD_JWT=person-jwt', 'BYTEDCLI_USER_CLOUD_JWT=person-jwt', 'CLOUD_JWT=person-jwt']);
    });
  });

  describe('prepareTriggerUserCliEnv installs wrappers per capability', () => {
    function prepare(capabilities: Capability[]) {
      const bin = join(dir, 'real-bin');
      mkdirSync(bin, { recursive: true });
      for (const tool of ['lark-cli', 'bytedcli', 'codebase', 'bitscli', 'bits-cli']) writeFileSync(join(bin, tool), `#!/bin/sh\n${probe}\n`, { mode: 0o755 });
      const env: NodeJS.ProcessEnv = { HOME: machineHome, PATH: `${bin}:/usr/bin:/bin` };
      const tools = [
        ...(capabilities.includes('lark-user') ? ['lark-cli' as const] : []),
        ...(capabilities.includes('bytecloud') || capabilities.includes('meego') ? ['bytedcli' as const] : []),
      ];
      prepareTriggerUserCliEnv(env, dir, 'sess', { enabled: true, tools, capabilities }, () => {}, 'single');
      const wrapped = ['lark-cli', 'bytedcli', 'codebase', 'bitscli', 'bits-cli']
        .filter(tool => existsSync(join(sessionIdentityBinDir(dir, 'sess'), tool)));
      return { env, wrapped };
    }

    it('bytecloud wraps bytedcli, codebase and bitscli and installs git askpass', () => {
      const { env, wrapped } = prepare(['bytecloud']);
      expect(wrapped).toEqual(['bytedcli', 'codebase', 'bitscli', 'bits-cli']);
      expect(env.GIT_ASKPASS).toBeTruthy();
    });

    it('meego alone wraps bytedcli only: no companions, no git askpass; ByteCloud calls run natively', () => {
      const { env, wrapped } = prepare(['meego']);
      expect(wrapped).toEqual(['bytedcli']);
      expect(env.GIT_ASKPASS).toBeUndefined();
      const out = execFileSync('/bin/sh', [join(sessionIdentityBinDir(dir, 'sess'), 'bytedcli'), 'cloud', 'whoami'],
        { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: machineHome } });
      expect(out).toBe(native('cloud whoami'));
    });

    it('narrowing [bytecloud, meego] to [meego] removes the ByteCloud JWTs from the bytedcli identity file, keeping the Meego part', () => {
      prepare(['bytecloud', 'meego']);
      writeSessionIdentity(dir, 'sess', {
        tool: 'bytedcli', cloudJwt: 'secret-jwt', codeJwt: 'secret-code', regionalCloudJwts: { i18n: 'secret-i18n' },
        meegoHome: join(dir, 'person-meego'), openId: 'ou_1',
      }, 'single');
      const file = join(sessionIdentityBinDir(dir, 'sess'), '.data', 'bytedcli.env');
      expect(readFileSync(file, 'utf8')).toContain('secret-jwt');
      prepare(['meego']);
      const left = readFileSync(file, 'utf8');
      expect(left).not.toMatch(/secret-(jwt|code|i18n)/);
      expect(left).toContain('BOTMUX_MEEGO_HOME');
      expect(left).toContain("BOTMUX_IDENTITY_OPEN_ID='ou_1'");
    });

    it('turning ByteCloud off removes the companion and alias wrappers it left behind', () => {
      prepare(['bytecloud']);
      const { wrapped } = prepare(['lark-user']);
      expect(wrapped).toEqual(['lark-cli']);
    });

    it('lark-user alone wraps lark-cli only; ByteCloud capabilities off leave no wrapper behind', () => {
      expect(prepare(['lark-user']).wrapped).toEqual(['lark-cli']);
    });

    it('turning a capability off deletes the plaintext identity files it left in the session dir', () => {
      prepare(['bytecloud']);
      for (const tool of ['bytedcli', 'codebase', 'bitscli'] as const) {
        writeSessionIdentity(dir, 'sess', { tool: 'bytedcli', cloudJwt: 'secret-jwt', codeJwt: 'secret-code', openId: 'ou_1' }, 'single');
        void tool;
      }
      const dataDir = join(sessionIdentityBinDir(dir, 'sess'), '.data');
      expect(readdirSync(dataDir).filter(n => n.endsWith('.env')).sort()).toEqual(['bitscli.env', 'bytedcli.env', 'codebase.env']);
      prepare(['lark-user']);
      expect(readdirSync(dataDir).filter(n => n.endsWith('.env') && n !== 'lark-cli.env')).toEqual([]);
    });

    it('no capability on installs nothing', () => {
      expect(prepare([]).wrapped).toEqual([]);
    });
  });
});

describe('background credential policy key', () => {
  const botWith = (raw: unknown) => ({ triggerUserAuth: parseTriggerUserAuthConfig(raw) ?? undefined, larkToolBinding: true } as any);
  const key = (raw: unknown) => backgroundCredentialPolicyKey(botWith(raw));
  // Computed on upstream/master before this change (parsed policy incl. `fallback`).
  const GOLDEN: Array<[string, unknown, string]> = [
    ['absent', undefined, 'sha256:ce75c188ee86e0e48855d917e51cf94cd53edfecc50da3b4f8ee27abb4b77f8a'],
    ['disabled', { enabled: false }, 'sha256:103bf3ffe541474f25543c698c1a564c7b1801743cc6f32e5c2528a0162e637c'],
    ['lark-cli', { enabled: true, tools: ['lark-cli'] }, 'sha256:caca2dcf7d529573fda3ce3256fa177f8c2fd528a7be695db219f8b9f6af5ac5'],
    ['bytedcli', { enabled: true, tools: ['bytedcli'] }, 'sha256:b642188a8c92ee19579b0f385f7373e61dbbdd076b062a01bfb5239142a1c44b'],
    ['bytedcli fallback bot-identity', { enabled: true, tools: ['bytedcli'], fallback: 'bot-identity' }, 'sha256:b642188a8c92ee19579b0f385f7373e61dbbdd076b062a01bfb5239142a1c44b'],
    ['bytedcli fallback none', { enabled: true, tools: ['bytedcli'], fallback: 'none' }, 'sha256:3dbfb35387bc37643c738018195196e354041c2baca8244335d0c9537dbad6ae'],
    ['both', { enabled: true, tools: ['lark-cli', 'bytedcli'] }, 'sha256:667d6b0e4fd2d5d095bf87838af5c004f022571783d60b4767145dfa0c5c3778'],
    ['all (tools omitted)', { enabled: true }, 'sha256:667d6b0e4fd2d5d095bf87838af5c004f022571783d60b4767145dfa0c5c3778'],
    ['empty tools', { enabled: true, tools: [] }, 'sha256:734659f68793735f01a83f0ac95962c1b69a54da94d8fde0fc33100f7629005c'],
  ];
  it.each(GOLDEN)('legacy config "%s" keeps its upstream key', (_name, raw, golden) => {
    expect(key(raw)).toBe(golden);
  });

  it('capabilities change the key, their order does not', () => {
    expect(key({ enabled: true, capabilities: ['bytecloud'] })).not.toBe(GOLDEN[3][2]);
    expect(key({ enabled: true, capabilities: ['bytecloud'] })).not.toBe(key({ enabled: true, capabilities: ['meego'] }));
    expect(key({ enabled: true, capabilities: ['bytecloud', 'meego'] })).toBe(key({ enabled: true, capabilities: ['meego', 'bytecloud'] }));
  });
});
