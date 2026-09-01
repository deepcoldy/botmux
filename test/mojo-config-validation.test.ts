/**
 * Tests for the shared mojo config validator and the frozen control-plane
 * identity.
 *
 * Type strictness here is a SECURITY property, not tidiness. `localDaemon:
 * "false"` used to satisfy the sandbox check's `!== true` (so the local sandbox
 * was bypassed) while being truthy where the child env is built (so
 * AGENT_LOCAL_DAEMON=1). That combination skips isolation AND enables host
 * execution — the strictBoolean rule exists to make it unreachable.
 *
 * Run:  pnpm vitest run test/mojo-config-validation.test.ts
 */
import { describe, expect, it, vi } from 'bun:test';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  deriveMojoExecutionMode,
  diffMojoSessionIdentity,
  findReservedMojoCliFlags,
  MOJO_CONTROL_ENV_KEYS,
  MOJO_IDENTITY_KEYS,
  MOJO_LIVE_PATCH_KEYS,
  normalizeMojoConfig,
  normalizeMojoLivePatch,
  pickMojoLivePatch,
  pickMojoSessionIdentity,
} from '../src/adapters/backend/mojo-types.js';
import { isMojoFullyRemote, localSandboxApplies } from '../src/adapters/backend/sandbox.js';

describe('normalizeMojoConfig', () => {
  it('accepts a well-formed block unchanged', () => {
    const raw = {
      cloud: true,
      localDaemon: false,
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      idleTimeoutSec: 30,
      stream: false,
      systemPrompt: 'be brief',
      jwt: 'token',
      jwtEnv: 'MY_JWT',
      baseUrl: 'https://mojo.example.com',
      ppeEnv: 'ppe-1',
      env: { FOO: 'bar' },
    };
    const r = normalizeMojoConfig(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(raw);
  });

  it('treats an absent block as an empty config', () => {
    for (const raw of [undefined, null]) {
      const r = normalizeMojoConfig(raw);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({});
    }
  });

  it('REJECTS a stringified boolean (the sandbox fail-open)', () => {
    // The concrete attack shape: strict `!== true` in the sandbox check said
    // "not local, safe to bypass", while a truthy check said "local execution on".
    const r = normalizeMojoConfig({ cloud: true, localDaemon: 'false' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join('\n')).toContain('localDaemon');
      expect(r.errors.join('\n')).toContain('boolean');
    }
  });

  it('rejects stringified booleans on every boolean field', () => {
    for (const key of ['cloud', 'localDaemon', 'stream']) {
      for (const bad of ['true', 'false', 1, 0, null]) {
        const r = normalizeMojoConfig({ [key]: bad });
        expect(r.ok, `${key}=${JSON.stringify(bad)} must be rejected`).toBe(false);
      }
    }
  });

  it('rejects an unknown key so a typo cannot silently disable the cloud sandbox', () => {
    // `cluod: true` would leave cloud unset — tools run on the host while the
    // operator believes they are sandboxed.
    const r = normalizeMojoConfig({ cluod: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('cluod');
  });

  it('rejects internal launch-identity keys, naming the top-level owner', () => {
    const r = normalizeMojoConfig({ bin: '/x/mojo', wrapperCli: 'env A=1 mojo' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const text = r.errors.join('\n');
      expect(text).toContain('cliPathOverride');
      expect(text).toContain('wrapperCli');
    }
  });

  it('validates idleTimeoutSec as a positive integer', () => {
    for (const bad of ['abc', 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '30']) {
      expect(normalizeMojoConfig({ idleTimeoutSec: bad }).ok, String(bad)).toBe(false);
    }
    expect(normalizeMojoConfig({ idleTimeoutSec: 30 }).ok).toBe(true);
  });

  it('validates env as a string→string map', () => {
    for (const bad of ['oops', ['a'], { A: 1 }, { A: null }, { A: { nested: 'x' } }]) {
      expect(normalizeMojoConfig({ env: bad }).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(normalizeMojoConfig({ env: { A: 'b' } }).ok).toBe(true);
  });

  it('validates baseUrl as an http(s) URL', () => {
    for (const bad of ['not a url', 'ftp://x/y', '', 'example.com']) {
      expect(normalizeMojoConfig({ baseUrl: bad }).ok, bad).toBe(false);
    }
    expect(normalizeMojoConfig({ baseUrl: 'https://a.example.com/x' }).ok).toBe(true);
  });

  it('validates jwtEnv as an env var name', () => {
    for (const bad of ['1BAD', 'has-dash', 'has space', '']) {
      expect(normalizeMojoConfig({ jwtEnv: bad }).ok, bad).toBe(false);
    }
    expect(normalizeMojoConfig({ jwtEnv: 'X_JWT_TOKEN' }).ok).toBe(true);
  });

  it('rejects a jwtEnv naming a reserved or control-plane key (P0-1)', () => {
    // buildEnv() deletes env[jwtEnv] before re-deriving the credential, so the
    // name doubles as a deletion primitive. `BOTMUX_MOJO_TREE_NONCE` is the
    // containment tree nonce — the only signal that survives setsid + reparent —
    // and erasing it blinds the termination proof while every close still
    // reports clean. Reserved botmux keys and frozen control-plane keys must
    // therefore be rejected by name, exactly like `mojo.env` already does.
    for (const bad of [
      'BOTMUX_MOJO_TREE_NONCE',
      'BOTMUX_SESSION_ID',
      'LARK_APP_SECRET',
      'AGENT_BASE_URL',
      'AGENT_LOCAL_DAEMON',
      'MOJO_PPE_ENV',
    ]) {
      const r = normalizeMojoConfig({ jwtEnv: bad });
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.errors.join(' '), bad).toMatch(/must not name/);
    }
    // A custom credential variable stays allowed — the rule is about names
    // botmux owns, not about custom names in general.
    expect(normalizeMojoConfig({ jwtEnv: 'MY_COMPANY_JWT' }).ok).toBe(true);
  });

  it('rejects a non-object block', () => {
    for (const bad of ['x', 5, true, ['a']]) {
      expect(normalizeMojoConfig(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('reports every problem at once so one fix does not reveal the next', () => {
    const r = normalizeMojoConfig({ localDaemon: 'false', cluod: true, idleTimeoutSec: 'abc' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBe(3);
  });
});

describe('validated config keeps sandbox decisions consistent', () => {
  it('a stringified localDaemon can no longer reach the sandbox check', () => {
    // Before validation this combination bypassed the sandbox while enabling host
    // execution. The validator now rejects it outright, so the only inputs the
    // sandbox logic ever sees are real booleans.
    expect(normalizeMojoConfig({ cloud: true, localDaemon: 'false' }).ok).toBe(false);

    // And with real booleans the two decisions agree.
    expect(isMojoFullyRemote({ cloud: true, localDaemon: false })).toBe(true);
    expect(isMojoFullyRemote({ cloud: true, localDaemon: true })).toBe(false);
    expect(localSandboxApplies('mojo', { cloud: true, localDaemon: false })).toBe(false);
    expect(localSandboxApplies('mojo', { cloud: true, localDaemon: true })).toBe(true);
  });
});

describe('frozen control-plane identity', () => {
  it('captures exactly the endpoint/tenant/execution keys', () => {
    expect([...MOJO_IDENTITY_KEYS]).toEqual([
      'cloud', 'localDaemon', 'baseUrl', 'ppeEnv', 'workspaceId', 'agentId',
    ]);
  });

  it('never captures credentials (no plaintext JWT in session state)', () => {
    const identity = pickMojoSessionIdentity({
      cloud: true,
      baseUrl: 'https://a.example.com',
      jwt: 'super-secret',
      jwtEnv: 'X_JWT_TOKEN',
      env: { X_JWT_TOKEN: 'also-secret' },
    });
    expect(identity).toEqual({ cloud: true, baseUrl: 'https://a.example.com' });
    expect(JSON.stringify(identity)).not.toContain('secret');
  });

  it('omits absent keys instead of storing undefined', () => {
    // A faithful snapshot: "not configured" must be distinguishable from
    // "configured as undefined" when the frozen record is later applied.
    expect(pickMojoSessionIdentity({ cloud: true })).toEqual({ cloud: true });
    expect(pickMojoSessionIdentity({})).toEqual({});
    expect(pickMojoSessionIdentity(undefined)).toEqual({});
  });

  it('detects the drifts that must not follow a live edit', () => {
    const frozen = pickMojoSessionIdentity({
      cloud: true, localDaemon: false, baseUrl: 'https://tenant-a.example.com', workspaceId: 'ws-a',
    });
    const live = pickMojoSessionIdentity({
      cloud: false, localDaemon: true, baseUrl: 'https://tenant-b.example.com', workspaceId: 'ws-b',
    });
    const drift = diffMojoSessionIdentity(frozen, live);
    // cloud→host execution, tenant A→B, workspace a→b are each reported.
    expect(drift.join('\n')).toContain('cloud');
    expect(drift.join('\n')).toContain('localDaemon');
    expect(drift.join('\n')).toContain('baseUrl');
    expect(drift.join('\n')).toContain('workspaceId');
  });

  it('reports no drift for an unchanged config', () => {
    const cfg = { cloud: true, baseUrl: 'https://a.example.com', jwt: 'rotated-token' };
    const frozen = pickMojoSessionIdentity(cfg);
    // A rotated credential is NOT identity drift — that is the whole point of
    // excluding credentials from the frozen set.
    const live = pickMojoSessionIdentity({ ...cfg, jwt: 'new-token' });
    expect(diffMojoSessionIdentity(frozen, live)).toEqual([]);
  });
});

describe('control-plane env keys are not a back door', () => {
  it('lists exactly the env vars that mirror frozen identity keys', () => {
    // X_JWT_TOKEN must NOT be here: a rotated credential has to keep working.
    expect([...MOJO_CONTROL_ENV_KEYS]).toEqual([
      'AGENT_BASE_URL', 'MOJO_PPE_ENV', 'AGENT_LOCAL_DAEMON',
    ]);
    expect([...MOJO_CONTROL_ENV_KEYS]).not.toContain('X_JWT_TOKEN');
  });

  it('rejects a control-plane var inside mojo.env, naming the real setting', () => {
    // Silently stripping would leave the operator believing their endpoint applied.
    for (const [key, owner] of [
      ['AGENT_BASE_URL', 'baseUrl'],
      ['MOJO_PPE_ENV', 'ppeEnv'],
      ['AGENT_LOCAL_DAEMON', 'localDaemon'],
    ]) {
      const r = normalizeMojoConfig({ env: { [key]: 'x' } });
      expect(r.ok, `${key} must be rejected`).toBe(false);
      if (!r.ok) expect(r.errors.join()).toContain(owner);
    }
  });

  it('rejects session-identity keys the top-level env already blocks', () => {
    // mojo.env is the HIGHEST-precedence layer in buildEffectiveChildEnv, but it
    // only screened MOJO_CONTROL_ENV_KEYS — so keys that botmux blocks on the
    // top-level `env` (via sanitizePerBotEnv / isReservedPerBotEnvKey) sailed
    // through here and then won the merge. Review demonstrated
    // BOTMUX_SESSION_ID being overwritten to 'hijacked' in the real child env.
    for (const key of [
      'BOTMUX_SESSION_ID',   // session routing
      'SESSION_DATA_DIR',    // CLI data root
      'LARK_APP_SECRET',     // bot credential
      'CLAUDE_CONFIG_DIR',   // CLI data root / identity marker
      'IS_SANDBOX',
    ]) {
      const r = normalizeMojoConfig({ env: { [key]: 'hijacked' } });
      expect(r.ok, `${key} must be rejected in mojo.env`).toBe(false);
      if (!r.ok) expect(r.errors.join()).toContain(key);
    }
  });

  it('rejects a key that is not a valid env var name', () => {
    // The top-level entry point validates the NAME too; mojo.env did not, so a
    // key like `PATH=/evil` or an empty string reached the child env as-is.
    for (const key of ['', 'not a var', 'PATH=/evil', '1LEADING_DIGIT']) {
      expect(normalizeMojoConfig({ env: { [key]: 'x' } }).ok, `${JSON.stringify(key)} must be rejected`).toBe(false);
    }
  });

  it('still accepts an unrelated env var, and a live JWT', () => {
    expect(normalizeMojoConfig({ env: { MY_TOKEN: 'x' } }).ok).toBe(true);
    expect(normalizeMojoConfig({ env: { X_JWT_TOKEN: 'rotated' } }).ok).toBe(true);
  });
});

describe('drift logging does not leak credentials', () => {
  it('reports only the key name for URL-shaped values', () => {
    // The URL validator accepts userinfo and query strings because they are valid
    // endpoints, so logging old/new values verbatim would write a password or a
    // signed token into the daemon log.
    const frozen = pickMojoSessionIdentity({
      baseUrl: 'https://user:password@tenant-a.example.com/api?sig=secret-token',
    });
    const live = pickMojoSessionIdentity({
      baseUrl: 'https://other:pw@tenant-b.example.com/api?sig=another-secret',
    });
    const drift = diffMojoSessionIdentity(frozen, live);

    expect(drift).toEqual(['baseUrl']);
    const text = drift.join('\n');
    for (const secret of ['password', 'secret-token', 'another-secret', 'tenant-a', 'tenant-b']) {
      expect(text, `must not leak ${secret}`).not.toContain(secret);
    }
  });

  it('never leaks a workspace/agent/profile identifier either', () => {
    const drift = diffMojoSessionIdentity(
      pickMojoSessionIdentity({ workspaceId: 'ws-secret-a', agentId: 'ag-a', ppeEnv: 'ppe-a' }),
      pickMojoSessionIdentity({ workspaceId: 'ws-secret-b', agentId: 'ag-b', ppeEnv: 'ppe-b' }),
    );
    expect(drift).toEqual(['ppeEnv', 'workspaceId', 'agentId']);
    expect(drift.join()).not.toContain('secret');
  });

  it('DOES show boolean transitions — cloud→host is the point of the warning', () => {
    const drift = diffMojoSessionIdentity(
      pickMojoSessionIdentity({ cloud: true, localDaemon: false }),
      pickMojoSessionIdentity({ cloud: false, localDaemon: true }),
    );
    expect(drift.join('\n')).toContain('cloud: true → false');
    expect(drift.join('\n')).toContain('localDaemon: false → true');
  });
});

describe('a launch prefix voids the remote-execution proof', () => {
  it('treats a wrapperCli session as NOT provably remote', () => {
    // buildEnv() sets AGENT_LOCAL_DAEMON=0, but the wrapper runs AFTER it and can
    // rewrite the very input the decision depends on:
    //   wrapperCli = "env AGENT_LOCAL_DAEMON=1 mojo"
    // re-enables host execution while the local sandbox was already skipped on the
    // strength of "provably remote". Inspecting the string is not enough either —
    // a wrapper can be a script that sets it internally.
    expect(isMojoFullyRemote({ cloud: true })).toBe(true);
    expect(isMojoFullyRemote({ cloud: true, wrapperCli: 'env AGENT_LOCAL_DAEMON=1 mojo' })).toBe(false);
    // Any wrapper at all, not just an obviously hostile one.
    expect(isMojoFullyRemote({ cloud: true, wrapperCli: 'ttadk mojo' })).toBe(false);
    // Blank/whitespace is not a wrapper.
    expect(isMojoFullyRemote({ cloud: true, wrapperCli: '   ' })).toBe(true);
  });

  it('keeps the local sandbox engaged for a wrapped mojo session', () => {
    expect(localSandboxApplies('mojo', { cloud: true })).toBe(false);
    expect(localSandboxApplies('mojo', { cloud: true, wrapperCli: 'env X=1 mojo' })).toBe(true);
  });
});

describe('reserved CLI flags', () => {
  it('catches every spelling that reaches the CLI identically', () => {
    expect(findReservedMojoCliFlags(['--workspace-id', 'b'])).toEqual(['--workspace-id']);
    expect(findReservedMojoCliFlags(['--workspace-id=b'])).toEqual(['--workspace-id']);
    expect(findReservedMojoCliFlags(['--cloud'])).toEqual(['--cloud']);
    expect(findReservedMojoCliFlags(['--no-cloud'])).toEqual(['--no-cloud']);
    expect(findReservedMojoCliFlags(['-r', 'sid'])).toEqual(['-r']);
    expect(findReservedMojoCliFlags(['--yolo', '--agent-id=x']))
      .toEqual(['--yolo', '--agent-id']);
  });

  it('leaves genuine behaviour overrides alone', () => {
    expect(findReservedMojoCliFlags(['--idle-timeout', '77'])).toEqual([]);
    expect(findReservedMojoCliFlags(['--timeout=30'])).toEqual([]);
    expect(findReservedMojoCliFlags([])).toEqual([]);
  });

  it('does not mistake a positional value for a flag', () => {
    // A prompt or path that happens to contain a reserved word must not trip it.
    expect(findReservedMojoCliFlags(['please use --workspace-id carefully'])).toEqual([]);
  });

  it('reports each offending flag once', () => {
    expect(findReservedMojoCliFlags(['--cloud', '--cloud'])).toEqual(['--cloud']);
  });
});

describe('live credential patch', () => {
  it('carries ONLY the jwt — never env, and never the control plane', () => {
    // An arbitrary `env` patch is equivalent to replacing the launcher: with no
    // cliPathOverride the backend spawns the bare name `mojo`, so a live
    // `PATH` (or NODE_OPTIONS / LD_PRELOAD / DYLD_*) change executes a different
    // binary on the next turn. Enumerating dangerous variables cannot be complete,
    // so env is not patchable at all.
    expect([...MOJO_LIVE_PATCH_KEYS]).toEqual(['jwt']);
    expect([...MOJO_LIVE_PATCH_KEYS]).not.toContain('env');
    for (const identityKey of MOJO_IDENTITY_KEYS) {
      expect([...MOJO_LIVE_PATCH_KEYS], `${identityKey} must stay frozen`)
        .not.toContain(identityKey);
    }
  });

  it('resolves a literal jwt', () => {
    expect(pickMojoLivePatch({ jwt: 'literal-token' }, { ambientEnv: {} }))
      .toEqual({ jwt: 'literal-token' });
  });

  it('resolves jwtEnv across mojo.env → per-bot env → ambient, in that order', () => {
    const cfg = { jwtEnv: 'MY_JWT' };
    expect(pickMojoLivePatch({ ...cfg, env: { MY_JWT: 'from-mojo-env' } }, {
      genericEnv: { MY_JWT: 'from-generic' },
      ambientEnv: { MY_JWT: 'from-ambient' },
    })).toEqual({ jwt: 'from-mojo-env' });

    expect(pickMojoLivePatch(cfg, {
      genericEnv: { MY_JWT: 'from-generic' },
      ambientEnv: { MY_JWT: 'from-ambient' },
    })).toEqual({ jwt: 'from-generic' });

    expect(pickMojoLivePatch(cfg, { ambientEnv: { MY_JWT: 'from-ambient' } }))
      .toEqual({ jwt: 'from-ambient' });
  });

  it('defaults to X_JWT_TOKEN when jwtEnv is unset', () => {
    expect(pickMojoLivePatch({}, { ambientEnv: { X_JWT_TOKEN: 'ambient' } }))
      .toEqual({ jwt: 'ambient' });
  });

  it('emits an explicit null tombstone when there is no credential', () => {
    // `undefined` would be omitted from the payload and could never express
    // "cleared", which is how a deleted mojo.jwt used to linger on the backend.
    const patch = pickMojoLivePatch({}, { ambientEnv: {} });
    expect(patch).toEqual({ jwt: null });
    expect('jwt' in patch).toBe(true);
  });

  it('never ships an env map, even when mojo.env holds unrelated keys', () => {
    const patch = pickMojoLivePatch(
      { jwt: 't', env: { PATH: '/evil/bin', LD_PRELOAD: '/evil/x.so' } },
      { ambientEnv: {} },
    );
    expect(patch).toEqual({ jwt: 't' });
    expect(JSON.stringify(patch)).not.toContain('/evil');
  });


});

describe('normalizeMojoLivePatch', () => {
  it('accepts a null tombstone (the config validator rejects it)', () => {
    // This split is the whole point: the CONFIG validator requires a non-empty
    // jwt string, so reusing it silently dropped every clear request at the IPC
    // boundary and the credential stayed live for the worker's lifetime.
    expect(normalizeMojoConfig({ jwt: null }).ok).toBe(false);
    const r = normalizeMojoLivePatch({ jwt: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ jwt: null });
  });

  it('accepts a rotation', () => {
    const r = normalizeMojoLivePatch({ jwt: 'new-token' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ jwt: 'new-token' });
  });

  it('treats an absent patch as an empty one', () => {
    for (const raw of [undefined, null, {}]) {
      const r = normalizeMojoLivePatch(raw);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({});
    }
  });

  it('rejects anything beyond jwt — a patch must not widen', () => {
    // env in particular is equivalent to replacing the launcher.
    for (const raw of [
      { env: { PATH: '/evil' } },
      { jwt: 'x', cloud: true },
      { baseUrl: 'https://tenant-b.example.com' },
      { bin: '/evil/mojo' },
    ]) {
      const r = normalizeMojoLivePatch(raw);
      expect(r.ok, JSON.stringify(raw)).toBe(false);
    }
  });

  it('rejects a malformed jwt', () => {
    for (const bad of ['', '   ', 5, true, {}, []]) {
      expect(normalizeMojoLivePatch({ jwt: bad }).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects a non-object payload', () => {
    for (const bad of ['x', 5, ['a']]) {
      expect(normalizeMojoLivePatch(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('deriveMojoExecutionMode: single source for env/flag/audit-label (review F2/F3)', () => {
  // Full truth table. env value and --cloud emission MUST stay in lockstep with
  // isMojoFullyRemote(): '0' + flag exactly on the fully-remote shape.
  const cases: Array<{
    cfg: { cloud?: unknown; localDaemon?: unknown } | undefined;
    env: '0' | '1'; flag: boolean; labelHas: string;
  }> = [
    { cfg: undefined, env: '1', flag: false, labelHas: 'host (default)' },
    { cfg: {}, env: '1', flag: false, labelHas: 'host (default)' },
    { cfg: { cloud: true }, env: '0', flag: true, labelHas: 'cloud-sandbox' },
    { cfg: { localDaemon: true }, env: '1', flag: false, labelHas: 'explicit localDaemon' },
    // Review F3: explicit localDaemon beats cloud — no contradictory argv.
    { cfg: { cloud: true, localDaemon: true }, env: '1', flag: false, labelHas: 'cloud flag suppressed' },
    { cfg: { localDaemon: false }, env: '0', flag: false, labelHas: 'sandbox-fallback' },
    { cfg: { cloud: true, localDaemon: false }, env: '0', flag: true, labelHas: 'cloud-sandbox' },
    // Non-boolean survivors from pre-strictBoolean frozen snapshots fail closed
    // AND get a label that says so (the audit line used to claim 'host (default)').
    { cfg: { localDaemon: 'false' }, env: '0', flag: false, labelHas: 'invalid localDaemon' },
    { cfg: { cloud: 'true' }, env: '1', flag: false, labelHas: 'host (default)' },
  ];
  for (const c of cases) {
    it(`cfg=${JSON.stringify(c.cfg)} → env=${c.env} flag=${c.flag}`, () => {
      const mode = deriveMojoExecutionMode(c.cfg as never);
      expect(mode.agentLocalDaemon).toBe(c.env);
      expect(mode.passCloudFlag).toBe(c.flag);
      expect(mode.label).toContain(c.labelHas);
    });
  }

  it("emits '0'+flag exactly on the isMojoFullyRemote shape (env keys aside)", () => {
    for (const cloud of [true, false, undefined]) {
      for (const localDaemon of [true, false, undefined]) {
        const mode = deriveMojoExecutionMode({ cloud, localDaemon });
        // --cloud goes out iff the config has the fully-remote shape.
        expect(mode.passCloudFlag).toBe(cloud === true && localDaemon !== true);
        if (isMojoFullyRemote({ cloud, localDaemon })) {
          expect(mode.agentLocalDaemon).toBe('0');
          expect(mode.passCloudFlag).toBe(true);
        }
      }
    }
  });
});
