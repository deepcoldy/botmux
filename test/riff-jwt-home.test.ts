import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isValidRiffJwtHome,
  readBytecloudKeychainJwt,
  refreshBytecloudJwt,
  resolveRiffJwtIdentity,
  RiffBackend,
  JWT_REFRESH_DEBOUNCE_MS,
  __resetJwtRefreshDebounceForTest,
} from '../src/adapters/backend/riff-backend.js';

/**
 * riff.jwtHome — which human's ByteCloud login a riff bot authenticates as.
 *
 * The bug this pins: the keychain lookup is home-derived and defaulted to the
 * DAEMON's home. On a host running one bot per person (each pointed at its own
 * login through a per-user `cliPathOverride` wrapper) every riff bot read the
 * daemon account's keychain and 401'd, because nobody logs the daemon account
 * into ByteCloud.
 */

const LEAF = join('bytecloud-auth', 'keychain', 'auth', 'cn', 'default');
const NOW_SEC = Math.floor(Date.now() / 1000);

/** Structurally valid, signature-less JWT carrying `sub` (whose identity it is). */
const makeJwt = (sub: string, expSec: number): string => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, exp: expSec })}.sig`;
};
/** Read back the `sub` so assertions name an IDENTITY, not an opaque string. */
const subjectOf = (jwt: string | null): string | null =>
  jwt === null ? null : (JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as { sub: string }).sub;

describe('resolveRiffJwtIdentity — which identity domain the keychain lookup reads', () => {
  const ambientHome = '/home/daemonuser';
  const ambientEnv = {
    XDG_CONFIG_HOME: '/home/daemonuser/.config',
    APPDATA: 'C:\\Users\\daemonuser\\AppData\\Roaming',
    PATH: '/usr/bin',
  } as NodeJS.ProcessEnv;

  it('with no override, returns the ambient home+env UNCHANGED (default path is current behaviour)', () => {
    const r = resolveRiffJwtIdentity(undefined, ambientHome, ambientEnv);
    expect(r.home).toBe(ambientHome);
    expect(r.env).toBe(ambientEnv);
    expect(r.overridden).toBe(false);
  });

  it('an override swaps the home AND drops the home-derived env roots', () => {
    const r = resolveRiffJwtIdentity('/home/alice', ambientHome, ambientEnv);
    expect(r.home).toBe('/home/alice');
    expect(r.overridden).toBe(true);
    // These three would otherwise keep pointing at the DAEMON's account.
    expect(r.env.XDG_CONFIG_HOME).toBeUndefined();
    expect(r.env.APPDATA).toBeUndefined();
    // Unrelated env is preserved — this is an identity scope, not a scrub.
    expect(r.env.PATH).toBe('/usr/bin');
    // The caller's env object must not be mutated.
    expect(ambientEnv.XDG_CONFIG_HOME).toBe('/home/daemonuser/.config');
  });

  it('an override also drops AIME_* (they describe the DAEMON runtime, not the override)', () => {
    const aime = {
      AIME_WORKSPACE_PATH: '/aime/ws', AIME_CURRENT_USER: 'daemonuser',
    } as NodeJS.ProcessEnv;
    const r = resolveRiffJwtIdentity('/home/alice', ambientHome, aime);
    expect(r.env.AIME_WORKSPACE_PATH).toBeUndefined();
    expect(r.env.AIME_CURRENT_USER).toBeUndefined();
  });

  it('a RELATIVE override is refused and degrades to the daemon home (never resolved against cwd)', () => {
    for (const bad of ['home/alice', './alice', '../alice', '']) {
      const r = resolveRiffJwtIdentity(bad, ambientHome, ambientEnv);
      expect(r.home).toBe(ambientHome);
      expect(r.overridden).toBe(false);
    }
  });

  it('a whitespace-only override is treated as unset', () => {
    const r = resolveRiffJwtIdentity('   ', ambientHome, ambientEnv);
    expect(r.overridden).toBe(false);
    expect(r.home).toBe(ambientHome);
  });
});

describe('isValidRiffJwtHome — spawn-gate validation', () => {
  it('accepts an absolute path', () => {
    expect(isValidRiffJwtHome('/home/alice')).toBe(true);
  });
  it('rejects relative, empty and non-string values', () => {
    for (const bad of ['home/alice', './x', '', '   ', 42, null, undefined, {}]) {
      expect(isValidRiffJwtHome(bad)).toBe(false);
    }
  });
});

describe('riff JWT identity — end to end against a real on-disk keychain', () => {
  let root: string;
  let ownerHome: string;
  let daemonHome: string;
  const savedEnv = { ...process.env };

  const writeKeychain = (home: string, relRoot: string, jwt: string) => {
    const dir = join(home, relRoot, 'bytecloud-auth', 'keychain', 'auth', 'cn');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'default'), JSON.stringify({ bytecloud_jwt: jwt }), 'utf-8');
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'riff-jwt-home-'));
    ownerHome = join(root, 'home', 'alice');
    daemonHome = join(root, 'root');
    // The bot owner is logged in…
    writeKeychain(ownerHome, join('.config', 'kaboo-cli'), makeJwt('OWNER', NOW_SEC + 86_400));
    // …and so is the daemon account, with a LONGER-lived token. The selector
    // picks the globally-freshest by `exp` regardless of order, so if the daemon
    // identity leaks into the candidate list at all it WINS — which makes this
    // the discriminating fixture rather than a coincidence of ordering.
    writeKeychain(daemonHome, join('.config', 'kaboo-cli'), makeJwt('DAEMON', NOW_SEC + 999_999));
    process.env.HOME = daemonHome;
    process.env.XDG_CONFIG_HOME = join(daemonHome, '.config');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  const resolve = async (jwtHome?: string): Promise<string | null> => {
    const inst = new RiffBackend(
      { baseUrl: 'https://riff.example', ...(jwtHome ? { jwtHome } : {}) },
      'test-session',
    );
    // allowRefresh:false keeps this hermetic — no bytedcli subprocess.
    const jwt = await (inst as unknown as {
      resolveJwt(o: { allowRefresh: boolean }): Promise<string | null>;
    }).resolveJwt({ allowRefresh: false });
    return subjectOf(jwt);
  };

  it('without jwtHome, authenticates as the DAEMON account (the pre-fix behaviour, unchanged)', async () => {
    expect(await resolve()).toBe('DAEMON');
  });

  it('with jwtHome, authenticates as the BOT OWNER even though the daemon token lives longer', async () => {
    expect(await resolve(ownerHome)).toBe('OWNER');
  });

  it('with jwtHome, the daemon XDG_CONFIG_HOME does NOT pull the daemon token back in', async () => {
    // Guards the exact regression the env-strip exists for: keeping the ambient
    // env would leave kaboo/aiden/cjadk resolving under the daemon's config root
    // and the longer-lived DAEMON token would win.
    process.env.XDG_CONFIG_HOME = join(daemonHome, '.config');
    expect(await resolve(ownerHome)).toBe('OWNER');
  });

  it('a relative jwtHome falls back to the daemon home rather than a cwd-relative tree', async () => {
    expect(await resolve('home/alice')).toBe('DAEMON');
  });

  it('jwtHome pointing at a home with no login returns null (fails closed, no daemon fallback)', async () => {
    // The whole point is identity scoping: an override that is not logged in must
    // NOT silently fall back to whoever the daemon is.
    expect(await resolve(join(root, 'home', 'nobody'))).toBeNull();
  });

  it('the override reaches the shared keychain reader with the same home+env', () => {
    // Ties resolveRiffJwtIdentity to the reader it feeds, so the two cannot drift.
    const id = resolveRiffJwtIdentity(ownerHome);
    expect(subjectOf(readBytecloudKeychainJwt(id.home, id.env))).toBe('OWNER');
  });
});

describe('refreshBytecloudJwt — debounce/coalesce are scoped PER IDENTITY', () => {
  beforeEach(() => { __resetJwtRefreshDebounceForTest(); });
  afterEach(() => { __resetJwtRefreshDebounceForTest(); });

  it('one identity refreshing does NOT swallow another identity\'s refresh', async () => {
    // The bug a single global clock caused on a shared host: alice's bot
    // refreshes, and for the next 60s every OTHER user's bot is told "false"
    // without its command ever running — so bob sits unauthenticated behind a
    // colleague's unrelated refresh.
    const ran: string[] = [];
    const runner = vi.fn(async (bin: string) => { ran.push(bin); });
    expect(await refreshBytecloudJwt(['refresh-alice'], { runner, nowMs: 1_000, identityKey: '/home/alice' })).toBe(true);
    expect(await refreshBytecloudJwt(['refresh-bob'], { runner, nowMs: 1_001, identityKey: '/home/bob' })).toBe(true);
    expect(ran).toEqual(['refresh-alice', 'refresh-bob']);
  });

  it('still debounces repeat refreshes WITHIN one identity', async () => {
    const runner = vi.fn(async () => {});
    expect(await refreshBytecloudJwt(['x'], { runner, nowMs: 1_000, identityKey: '/home/alice' })).toBe(true);
    expect(await refreshBytecloudJwt(['x'], { runner, nowMs: 2_000, identityKey: '/home/alice' })).toBe(false);
    expect(runner).toHaveBeenCalledTimes(1);
    // …and lets it through once the window has passed.
    expect(await refreshBytecloudJwt(['x'], {
      runner, nowMs: 1_000 + JWT_REFRESH_DEBOUNCE_MS, identityKey: '/home/alice',
    })).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent refreshes for the SAME identity onto one child', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const runner = vi.fn(async () => { await gate; });
    const a = refreshBytecloudJwt(['x'], { runner, nowMs: 1_000, identityKey: '/home/alice' });
    const b = refreshBytecloudJwt(['x'], { runner, nowMs: 1_001, identityKey: '/home/alice' });
    release();
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
  });
});

describe('riff.jwtHome + auto-refresh — can botmux renew a sub-user\'s login?', () => {
  let root: string;
  let ownerHome: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    __resetJwtRefreshDebounceForTest();
    root = mkdtempSync(join(tmpdir(), 'riff-jwt-refresh-home-'));
    ownerHome = join(root, 'home', 'alice');   // deliberately NOT logged in
    process.env.HOME = join(root, 'root');
    delete process.env.BOTMUX_RIFF_JWT_REFRESH_CMD;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    process.env = { ...savedEnv };
    __resetJwtRefreshDebounceForTest();
  });

  const resolveWith = async (cfg: Record<string, unknown>): Promise<string | null> => {
    const inst = new RiffBackend({ baseUrl: 'https://riff.example', ...cfg } as never, 'test');
    return (inst as unknown as {
      resolveJwt(o: { allowRefresh: boolean }): Promise<string | null>;
    }).resolveJwt({ allowRefresh: true });
  };

  it('with jwtHome and an explicit jwtRefreshCmd, the operator hook IS run', async () => {
    // The hook is the only thing that knows how to refresh as another user, so
    // an override must not be barred from auto-refresh when one is configured.
    const marker = join(root, 'hook-ran');
    await resolveWith({
      jwtHome: ownerHome,
      jwtRefreshCmd: ['/bin/sh', '-c', `touch ${JSON.stringify(marker)}`],
    });
    const { existsSync } = await import('node:fs');
    expect(existsSync(marker)).toBe(true);
  });

  it('with jwtHome and NO explicit cmd, the daemon-identity default is NOT run', async () => {
    // The resolved default (`bytedcli …`) runs as the daemon UID against the
    // daemon's HOME: it would rewrite the WRONG keychain, so running it could
    // not fix the token we are about to return.
    //
    // The env-configured command must be one that WOULD really create the marker
    // if it ran — otherwise this assertion passes for the wrong reason and stays
    // green even with the guard deleted (verified: it did).
    const marker = join(root, 'default-ran');
    process.env.BOTMUX_RIFF_JWT_REFRESH_CMD = `/bin/touch ${marker}`;
    const ran = await resolveWith({ jwtHome: ownerHome });
    const { existsSync } = await import('node:fs');
    expect(ran).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  it('WITHOUT jwtHome, the env-configured default still runs (unchanged behaviour)', async () => {
    // Control: proves the previous assertion is about the override, not about
    // the env var being ignored generally.
    const marker = join(root, 'daemon-default-ran');
    process.env.BOTMUX_RIFF_JWT_REFRESH_CMD = `/bin/touch ${marker}`;
    await resolveWith({});
    const { existsSync } = await import('node:fs');
    expect(existsSync(marker)).toBe(true);
  });
});
