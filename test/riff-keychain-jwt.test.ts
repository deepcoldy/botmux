import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bytecloudKeychainCandidates,
  decodeJwtExp,
  readBytecloudKeychainJwt,
  JWT_EXPIRY_SAFETY_WINDOW_SEC,
} from '../src/adapters/backend/riff-backend.js';

const LEAF = join('bytecloud-auth', 'keychain', 'auth', 'cn', 'default');

/** Build a signature-less but structurally valid JWT with the given `exp`
 *  (seconds). `exp: null` omits the claim entirely (parseable payload, no exp). */
const makeJwt = (exp: number | null, extra: Record<string, unknown> = {}): string => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const payload = exp === null ? { sub: 'x', ...extra } : { sub: 'x', exp, ...extra };
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
};

describe('bytecloudKeychainCandidates — cross-platform path generation', () => {
  const HOME = '/home/tester';
  // env with no XDG overrides
  const bare = {} as NodeJS.ProcessEnv;

  it('on Linux, config-dir CLIs resolve under ~/.config and NOT Application Support', () => {
    const c = bytecloudKeychainCandidates(HOME, bare, 'linux');
    for (const cli of ['kaboo-cli', 'aiden-cli', 'cjadk']) {
      expect(c).toContain(join(HOME, '.config', cli, LEAF));
      // A single process only uses its own platform's config root; the foreign
      // Application Support root must never be a live candidate here.
      expect(c).not.toContain(join(HOME, 'Library', 'Application Support', cli, LEAF));
    }
  });

  it('on macOS, config-dir CLIs resolve under ~/Library/Application Support and NOT ~/.config', () => {
    const c = bytecloudKeychainCandidates(HOME, bare, 'darwin');
    for (const cli of ['kaboo-cli', 'aiden-cli', 'cjadk']) {
      expect(c).toContain(join(HOME, 'Library', 'Application Support', cli, LEAF));
      expect(c).not.toContain(join(HOME, '.config', cli, LEAF));
    }
  });

  it('covers the home dot-dir layouts (~/.cjadk, ~/.aipaas)', () => {
    const c = bytecloudKeychainCandidates(HOME, bare, 'linux');
    expect(c).toContain(join(HOME, '.cjadk', LEAF));
    expect(c).toContain(join(HOME, '.aipaas', LEAF));
  });

  it('on Windows, config-dir CLIs resolve under %AppData% (Roaming), not ~/.config', () => {
    const env = { APPDATA: 'C:\\Users\\t\\AppData\\Roaming' } as NodeJS.ProcessEnv;
    const c = bytecloudKeychainCandidates(HOME, env, 'win32');
    for (const cli of ['kaboo-cli', 'aiden-cli', 'cjadk']) {
      expect(c).toContain(join('C:\\Users\\t\\AppData\\Roaming', cli, LEAF));
      expect(c).not.toContain(join(HOME, '.config', cli, LEAF));
    }
    // bytedcli has no platform branch (verified in bytedcli-core.js): it uses
    // ~/.local/share/bytedcli on Windows too, so that candidate must be present.
    expect(c).toContain(join(HOME, '.local', 'share', 'bytedcli', 'data', LEAF));
  });

  it('on Windows without %APPDATA%, emits NO config-style candidate (Go errors, does not default to Roaming)', () => {
    const c = bytecloudKeychainCandidates(HOME, {} as NodeJS.ProcessEnv, 'win32');
    // Go's os.UserConfigDir ERRORS when %AppData% is unset — it never falls back
    // to ~/AppData/Roaming. Inventing that phantom path could let a stale token
    // there shadow a real candidate, so we emit no config-style root at all.
    for (const cli of ['kaboo-cli', 'aiden-cli', 'cjadk']) {
      expect(c).not.toContain(join(HOME, 'AppData', 'Roaming', cli, LEAF));
      expect(c).not.toContain(join(HOME, '.config', cli, LEAF));
    }
    // The other verified candidates still survive (fail-open on config only).
    expect(c).toContain(join(HOME, '.local', 'share', 'bytedcli', 'data', LEAF));
    expect(c).toContain(join(HOME, '.cjadk', LEAF));
    expect(c).toContain(join(HOME, '.aipaas', LEAF));
  });

  it('bytedcli uses ~/.local/share/bytedcli/data on BOTH platforms (never Application Support)', () => {
    // bytedcli uses ~/.local/share on Linux AND macOS (empirically confirmed);
    // it has no Application Support spelling, so that must not be a candidate.
    for (const plat of ['linux', 'darwin'] as NodeJS.Platform[]) {
      const c = bytecloudKeychainCandidates(HOME, bare, plat);
      expect(c).toContain(join(HOME, '.local', 'share', 'bytedcli', 'data', LEAF));
      expect(c).not.toContain(join(HOME, 'Library', 'Application Support', 'bytedcli', 'data', LEAF));
    }
  });

  it('on Linux, $XDG_CONFIG_HOME is the config ROOT that REPLACES ~/.config (not an extra candidate)', () => {
    const env = { XDG_CONFIG_HOME: '/custom/cfg' } as NodeJS.ProcessEnv;
    const c = bytecloudKeychainCandidates(HOME, env, 'linux');
    const custom = join('/custom/cfg', 'kaboo-cli', LEAF);
    const fallback = join(HOME, '.config', 'kaboo-cli', LEAF);
    // XDG spec: when set, XDG_CONFIG_HOME *is* the config root. Keeping ~/.config
    // too would be a phantom the tool never writes, and (since selection ignores
    // order) a stale token there could shadow the override — so it must be gone.
    expect(c).toContain(custom);
    expect(c).not.toContain(fallback);
  });

  it('on macOS, $XDG_CONFIG_HOME is ignored (config root is Application Support)', () => {
    const env = { XDG_CONFIG_HOME: '/custom/cfg' } as NodeJS.ProcessEnv;
    const c = bytecloudKeychainCandidates(HOME, env, 'darwin');
    // macOS resolves the config dir to Application Support regardless of XDG.
    expect(c).toContain(join(HOME, 'Library', 'Application Support', 'kaboo-cli', LEAF));
    expect(c).not.toContain(join('/custom/cfg', 'kaboo-cli', LEAF));
  });

  it('does NOT key bytedcli off $XDG_DATA_HOME (verified: bytedcli ignores it, always ~/.local/share)', () => {
    const env = { XDG_DATA_HOME: '/custom/data' } as NodeJS.ProcessEnv;
    const c = bytecloudKeychainCandidates(HOME, env);
    // bytedcli stays on ~/.local/share regardless of XDG_DATA_HOME…
    expect(c).toContain(join(HOME, '.local', 'share', 'bytedcli', 'data', LEAF));
    // …and we must NOT invent a /custom/data/bytedcli candidate it never uses.
    expect(c).not.toContain(join('/custom/data', 'bytedcli', 'data', LEAF));
  });

  it('uses ONLY the AIME identity domain when both AIME vars are set (NO host candidate of any tool)', () => {
    const env = {
      AIME_WORKSPACE_PATH: '/aime/ws',
      AIME_CURRENT_USER: 'alice',
    } as NodeJS.ProcessEnv;
    const c = bytecloudKeychainCandidates(HOME, env);
    const aime = join('/aime/ws', 'alice', '.local', 'share', 'bytedcli', 'data', LEAF);
    // In a full AIME runtime the identity domain is the AIME workspace, and
    // `os.homedir()` is still the HOST home — so EVERY host-derived keychain
    // belongs to a different identity. The one and only candidate is the
    // AIME-scoped bytedcli store; reading any host source would cross identities.
    expect(c).toEqual([aime]);
    // Belt-and-suspenders: none of the host bytedcli / config-CLI / dot-dir
    // candidates may leak in.
    expect(c).not.toContain(join(HOME, '.local', 'share', 'bytedcli', 'data', LEAF));
    expect(c).not.toContain(join(HOME, 'Library', 'Application Support', 'bytedcli', 'data', LEAF));
    for (const cli of ['kaboo-cli', 'aiden-cli', 'cjadk']) {
      expect(c).not.toContain(join(HOME, '.config', cli, LEAF));
      expect(c).not.toContain(join(HOME, 'Library', 'Application Support', cli, LEAF));
    }
    expect(c).not.toContain(join(HOME, '.cjadk', LEAF));
    expect(c).not.toContain(join(HOME, '.aipaas', LEAF));
  });

  it('keeps the plain-HOME bytedcli candidate when NOT a full AIME runtime', () => {
    const c = bytecloudKeychainCandidates(HOME, {} as NodeJS.ProcessEnv);
    expect(c).toContain(join(HOME, '.local', 'share', 'bytedcli', 'data', LEAF));
  });

  it('does NOT add an AIME path when only one of the two AIME vars is set', () => {
    const onlyWs = bytecloudKeychainCandidates(HOME, { AIME_WORKSPACE_PATH: '/aime/ws' } as NodeJS.ProcessEnv);
    const onlyUser = bytecloudKeychainCandidates(HOME, { AIME_CURRENT_USER: 'alice' } as NodeJS.ProcessEnv);
    for (const c of [onlyWs, onlyUser]) {
      expect(c.some((p) => p.startsWith(join('/aime/ws')))).toBe(false);
    }
  });

  it('sanitizes the AIME username exactly like bytedcli (illegal→_, lone . →_, lone .. →__)', () => {
    const mk = (user: string) =>
      bytecloudKeychainCandidates(HOME, {
        AIME_WORKSPACE_PATH: '/ws', AIME_CURRENT_USER: user,
      } as NodeJS.ProcessEnv);
    // slashes / spaces / @ are illegal → each char becomes "_"
    expect(mk('a b/c@d')).toContain(join('/ws', 'a_b_c_d', '.local', 'share', 'bytedcli', 'data', LEAF));
    // a lone "." → "_"
    expect(mk('.')).toContain(join('/ws', '_', '.local', 'share', 'bytedcli', 'data', LEAF));
    // a lone ".." → "__" (blocks the path-escape that "../" would cause)
    expect(mk('..')).toContain(join('/ws', '__', '.local', 'share', 'bytedcli', 'data', LEAF));
    // legal set [a-zA-Z0-9._-] is preserved (incl. interior dots)
    expect(mk('a.b-c_1')).toContain(join('/ws', 'a.b-c_1', '.local', 'share', 'bytedcli', 'data', LEAF));
  });

  it('every candidate ends with the keychain leaf (never the metadata credentials.json)', () => {
    const c = bytecloudKeychainCandidates(HOME, bare);
    for (const p of c) expect(p.endsWith(LEAF)).toBe(true);
    expect(c.some((p) => p.includes('credentials.json'))).toBe(false);
  });
});

describe('readBytecloudKeychainJwt — token extraction', () => {
  let home: string;
  const bare = {} as NodeJS.ProcessEnv;

  const writeKeychain = (relRoot: string, body: unknown) => {
    const dir = join(home, relRoot, 'bytecloud-auth', 'keychain', 'auth', 'cn');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'default'), JSON.stringify(body), 'utf-8');
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'riff-keychain-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('returns null when no keychain file exists anywhere', () => {
    expect(readBytecloudKeychainJwt(home, bare)).toBeNull();
  });

  it('reads bytecloud_jwt from kaboo-cli under ~/.config (Linux)', () => {
    writeKeychain(join('.config', 'kaboo-cli'), {
      access_token: 'a', bytecloud_jwt: 'JWT-KABOO', refresh_token: 'r',
    });
    expect(readBytecloudKeychainJwt(home, bare, Date.now(), 'linux')).toBe('JWT-KABOO');
  });

  it('reads bytecloud_jwt from bytedcli data dir (the Mac-verified layout)', () => {
    writeKeychain(join('.local', 'share', 'bytedcli', 'data'), {
      access_token: 'a', bytecloud_jwt: 'JWT-BYTEDCLI', refresh_token: 'r',
    });
    expect(readBytecloudKeychainJwt(home, bare)).toBe('JWT-BYTEDCLI');
  });

  it('reads bytecloud_jwt from macOS Application Support (config-style CLI)', () => {
    writeKeychain(join('Library', 'Application Support', 'aiden-cli'), {
      bytecloud_jwt: 'JWT-MAC-AIDEN',
    });
    expect(readBytecloudKeychainJwt(home, bare, Date.now(), 'darwin')).toBe('JWT-MAC-AIDEN');
  });

  it('does NOT read the sibling credentials.json (metadata form has no bytecloud_jwt)', () => {
    // Write ONLY the metadata form (auth/cn/credentials.json, no keychain/ segment).
    const dir = join(home, '.config', 'kaboo-cli', 'bytecloud-auth', 'auth', 'cn');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({
      app_id: 'x', expires_at: 123, user: 'u', // note: NO bytecloud_jwt
    }), 'utf-8');
    expect(readBytecloudKeychainJwt(home, bare)).toBeNull();
  });

  it('skips a keychain file whose bytecloud_jwt is empty and keeps scanning', () => {
    // kaboo has an empty token; bytedcli has a real one — later candidate wins.
    writeKeychain(join('.config', 'kaboo-cli'), { bytecloud_jwt: '' });
    writeKeychain(join('.local', 'share', 'bytedcli', 'data'), { bytecloud_jwt: 'JWT-REAL' });
    expect(readBytecloudKeychainJwt(home, bare)).toBe('JWT-REAL');
  });

  it('skips a malformed (non-JSON) keychain file without throwing', () => {
    const dir = join(home, '.config', 'kaboo-cli', 'bytecloud-auth', 'keychain', 'auth', 'cn');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'default'), 'not-json{{{', 'utf-8');
    writeKeychain(join('.cjadk'), { bytecloud_jwt: 'JWT-CJADK' });
    expect(readBytecloudKeychainJwt(home, bare)).toBe('JWT-CJADK');
  });

  it('reads the bytedcli keychain from the AIME workspace path (both AIME vars set)', () => {
    const dir = join(home, 'aime-ws', 'alice', '.local', 'share', 'bytedcli', 'data',
      'bytecloud-auth', 'keychain', 'auth', 'cn');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'default'), JSON.stringify({ bytecloud_jwt: 'JWT-AIME' }), 'utf-8');
    const env = {
      AIME_WORKSPACE_PATH: join(home, 'aime-ws'),
      AIME_CURRENT_USER: 'alice',
    } as NodeJS.ProcessEnv;
    expect(readBytecloudKeychainJwt(home, env)).toBe('JWT-AIME');
  });
});

describe('readBytecloudKeychainJwt — expiry-aware selection (stale must not shadow valid)', () => {
  let home: string;
  const bare = {} as NodeJS.ProcessEnv;
  const NOW = 1_000_000; // seconds
  const nowMs = NOW * 1000;

  const writeKeychain = (relRoot: string, body: unknown) => {
    const dir = join(home, relRoot, 'bytecloud-auth', 'keychain', 'auth', 'cn');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'default'), JSON.stringify(body), 'utf-8');
  };

  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'riff-keychain-exp-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('THE codex migration case: an expired .cjadk token must not shadow a valid bytedcli token', () => {
    // .cjadk is listed BEFORE bytedcli, but its token is expired → must be skipped.
    writeKeychain('.cjadk', { bytecloud_jwt: makeJwt(NOW - 3600) });          // expired 1h ago
    const live = makeJwt(NOW + 3600);                                          // valid 1h out
    writeKeychain(join('.local', 'share', 'bytedcli', 'data'), { bytecloud_jwt: live });
    expect(readBytecloudKeychainJwt(home, bare, nowMs)).toBe(live);
  });

  it('picks the freshest (greatest exp) among multiple live tokens', () => {
    writeKeychain(join('.config', 'kaboo-cli'), { bytecloud_jwt: makeJwt(NOW + 60) });
    const freshest = makeJwt(NOW + 9999);
    writeKeychain('.cjadk', { bytecloud_jwt: freshest });
    writeKeychain(join('.local', 'share', 'bytedcli', 'data'), { bytecloud_jwt: makeJwt(NOW + 500) });
    expect(readBytecloudKeychainJwt(home, bare, nowMs)).toBe(freshest);
  });

  it('returns null when every parseable token is expired (and no opaque fallback exists)', () => {
    writeKeychain(join('.config', 'kaboo-cli'), { bytecloud_jwt: makeJwt(NOW - 1) });
    writeKeychain(join('.local', 'share', 'bytedcli', 'data'), { bytecloud_jwt: makeJwt(NOW - 999) });
    expect(readBytecloudKeychainJwt(home, bare, nowMs)).toBeNull();
  });

  it('an opaque (exp-less) token is used only as fallback, never over a parseable live token', () => {
    // kaboo (listed first) is opaque; bytedcli has a real live JWT → live wins.
    writeKeychain(join('.config', 'kaboo-cli'), { bytecloud_jwt: 'opaque-no-exp' });
    const live = makeJwt(NOW + 3600);
    writeKeychain(join('.local', 'share', 'bytedcli', 'data'), { bytecloud_jwt: live });
    expect(readBytecloudKeychainJwt(home, bare, nowMs)).toBe(live);
  });

  it('falls back to an opaque token when no parseable-live token exists', () => {
    // only an opaque token present → use it (better than nothing; we cannot judge its exp).
    writeKeychain(join('.config', 'kaboo-cli'), { bytecloud_jwt: 'opaque-only' });
    expect(readBytecloudKeychainJwt(home, bare, nowMs, 'linux')).toBe('opaque-only');
  });

  it('prefers a parseable-live token over an opaque one even when the opaque is listed later', () => {
    const live = makeJwt(NOW + 3600);
    writeKeychain(join('.config', 'kaboo-cli'), { bytecloud_jwt: live });
    writeKeychain(join('.local', 'share', 'bytedcli', 'data'), { bytecloud_jwt: 'opaque-later' });
    expect(readBytecloudKeychainJwt(home, bare, nowMs, 'linux')).toBe(live);
  });

  it('a non-3-segment fake token (2 or 4 segments) must NOT shadow a real JWT via a decodable exp', () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    // 2-segment string listed FIRST, carrying a huge exp: it is not a JWT, so it
    // ranks as opaque (last-resort), never as the "freshest live" token.
    const fake2 = `x.${b64({ exp: NOW + 999999 })}`;
    const real = makeJwt(NOW + 3600);
    writeKeychain(join('.config', 'kaboo-cli'), { bytecloud_jwt: fake2 });
    writeKeychain(join('.local', 'share', 'bytedcli', 'data'), { bytecloud_jwt: real });
    expect(readBytecloudKeychainJwt(home, bare, nowMs)).toBe(real);
  });
});

describe('readBytecloudKeychainJwt — AIME fail-closed identity isolation', () => {
  let home: string;
  const NOW = 1_000_000;
  const nowMs = NOW * 1000;
  const WS = () => join(home, 'aime-ws');
  const aimeEnv = () => ({ AIME_WORKSPACE_PATH: WS(), AIME_CURRENT_USER: 'alice' }) as NodeJS.ProcessEnv;

  const writeKeychain = (relRoot: string, body: unknown) => {
    const dir = join(home, relRoot, 'bytecloud-auth', 'keychain', 'auth', 'cn');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'default'), JSON.stringify(body), 'utf-8');
  };
  const writeAimeKeychain = (body: unknown) => {
    const dir = join(WS(), 'alice', '.local', 'share', 'bytedcli', 'data',
      'bytecloud-auth', 'keychain', 'auth', 'cn');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'default'), JSON.stringify(body), 'utf-8');
  };

  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'riff-keychain-aime-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('AIME wins even when a plain ~/.local/share token has a LATER expiry (no cross-identity leak)', () => {
    // The exp-aware selector must NOT let a longer-lived plain-HOME token beat
    // the AIME-scoped one: in a full AIME runtime, plain HOME is not a candidate.
    writeAimeKeychain({ bytecloud_jwt: makeJwt(NOW + 3600) });                         // AIME: +1h
    writeKeychain(join('.local', 'share', 'bytedcli', 'data'), { bytecloud_jwt: makeJwt(NOW + 7200) }); // plain: +2h
    expect(readBytecloudKeychainJwt(home, aimeEnv(), nowMs)).toBe(makeJwt(NOW + 3600));
  });

  it('returns null when AIME keychain is absent, even if plain HOME has a valid bytedcli token', () => {
    // fail-closed: do not fall back to another identity's HOME token.
    writeKeychain(join('.local', 'share', 'bytedcli', 'data'), { bytecloud_jwt: makeJwt(NOW + 7200) });
    expect(readBytecloudKeychainJwt(home, aimeEnv(), nowMs)).toBeNull();
  });

  it('still allows plain HOME bytedcli when only ONE AIME var is set (not a full AIME runtime)', () => {
    const live = makeJwt(NOW + 3600);
    writeKeychain(join('.local', 'share', 'bytedcli', 'data'), { bytecloud_jwt: live });
    const onlyWs = { AIME_WORKSPACE_PATH: WS() } as NodeJS.ProcessEnv;
    const onlyUser = { AIME_CURRENT_USER: 'alice' } as NodeJS.ProcessEnv;
    expect(readBytecloudKeychainJwt(home, onlyWs, nowMs)).toBe(live);
    expect(readBytecloudKeychainJwt(home, onlyUser, nowMs)).toBe(live);
  });

  it('BLOCKER regression: full AIME must NOT cross into a host config-CLI token even with a LATER exp', () => {
    // The core cross-identity hazard codex flagged: AIME scopes bytedcli, but a
    // host kaboo/aiden/cjadk token is a DIFFERENT identity's. The exp-aware
    // selector must never be handed one to prefer. Host kaboo (+2h) vs AIME
    // bytedcli (+1h): the AIME token wins, the host token is not even a candidate.
    const aimeTok = makeJwt(NOW + 3600);
    writeAimeKeychain({ bytecloud_jwt: aimeTok });
    writeKeychain(join('.config', 'kaboo-cli'), { bytecloud_jwt: makeJwt(NOW + 7200) });
    expect(readBytecloudKeychainJwt(home, aimeEnv(), nowMs)).toBe(aimeTok);
  });

  it('BLOCKER regression: full AIME with no AIME keychain but a valid host config token → fail-closed null', () => {
    // Never authenticate as the host identity when the AIME store is empty.
    writeKeychain(join('.config', 'kaboo-cli'), { bytecloud_jwt: makeJwt(NOW + 7200) });
    writeKeychain(join('.cjadk'), { bytecloud_jwt: makeJwt(NOW + 9999) });
    expect(readBytecloudKeychainJwt(home, aimeEnv(), nowMs)).toBeNull();
  });
});

describe('decodeJwtExp', () => {
  it('decodes a numeric exp from the payload', () => {
    expect(decodeJwtExp(makeJwt(1712345678))).toBe(1712345678);
  });
  it('returns null for a payload with no exp', () => {
    expect(decodeJwtExp(makeJwt(null))).toBeNull();
  });
  it('returns null for opaque / non-JWT strings', () => {
    expect(decodeJwtExp('not-a-jwt')).toBeNull();
    expect(decodeJwtExp('')).toBeNull();
    expect(decodeJwtExp('a.b.c')).toBeNull(); // b is not valid base64url JSON
  });
  it('returns null when exp is present but not a number', () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const jwt = `${b64({ alg: 'HS256' })}.${b64({ exp: 'soon' })}.sig`;
    expect(decodeJwtExp(jwt)).toBeNull();
  });
  it('rejects non-3-segment strings (a JWS compact JWT is exactly 3 segments)', () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    // 2 segments with a decodable payload — must NOT be read as a live token.
    expect(decodeJwtExp(`x.${b64({ exp: 1712345678 })}`)).toBeNull();
    // 4 segments, ditto.
    expect(decodeJwtExp(`a.${b64({ exp: 1712345678 })}.c.d`)).toBeNull();
    // empty segments.
    expect(decodeJwtExp(`.${b64({ exp: 1712345678 })}.`)).toBeNull();
  });
  it('rejects a header/payload that is not strictly base64url', () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    // A "+" is base64 (std) but NOT base64url — a real JWT never contains it.
    expect(decodeJwtExp(`ab+cd.${b64({ exp: 1712345678 })}.sig`)).toBeNull();
  });
  it('rejects a signature segment that is not base64url (all three segments are checked)', () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const hdr = b64({ alg: 'HS256', typ: 'JWT' });
    // Decodable header+payload but the signature contains a non-base64url "+".
    expect(decodeJwtExp(`${hdr}.${b64({ exp: 1712345678 })}.sig+bad`)).toBeNull();
  });
  it('rejects when the header does not decode to a JSON object', () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    // "x" is base64url-shaped but not a JSON object → not a real JOSE header.
    expect(decodeJwtExp(`x.${b64({ exp: 1712345678 })}.sig`)).toBeNull();
    // A header that decodes to an array (not an object) is also rejected.
    expect(decodeJwtExp(`${b64([1, 2])}.${b64({ exp: 1712345678 })}.sig`)).toBeNull();
  });
  it('rejects when the payload decodes to a non-object (array/scalar)', () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const hdr = b64({ alg: 'HS256' });
    expect(decodeJwtExp(`${hdr}.${b64([{ exp: 1 }])}.sig`)).toBeNull();
  });
});

describe('bytecloudKeychainCandidates — platform-aware config root (no foreign-root shadow)', () => {
  let home: string;
  const NOW = 1_000_000;
  const nowMs = NOW * 1000;
  const writeAbs = (absRoot: string, body: unknown) => {
    const dir = join(absRoot, 'bytecloud-auth', 'keychain', 'auth', 'cn');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'default'), JSON.stringify(body), 'utf-8');
  };
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'riff-keychain-plat-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('on Linux, an Application Support token with a LATER exp must NOT shadow the XDG root token', () => {
    // The residual XDG hazard: removing ~/.config alone wasn't enough — a
    // foreign-platform Application Support token could still win on max-exp.
    // Platform-aware generation drops Application Support on Linux entirely.
    const xdg = join(home, 'isolated');
    const xdgTok = makeJwt(NOW + 3600);   // +1h, the authoritative root
    const appSup = makeJwt(NOW + 7200);   // +2h, foreign platform root
    writeAbs(join(xdg, 'kaboo-cli'), { bytecloud_jwt: xdgTok });
    writeAbs(join(home, 'Library', 'Application Support', 'kaboo-cli'), { bytecloud_jwt: appSup });
    const env = { XDG_CONFIG_HOME: xdg } as NodeJS.ProcessEnv;
    expect(readBytecloudKeychainJwt(home, env, nowMs, 'linux')).toBe(xdgTok);
  });

  it('on macOS, a ~/.config token must NOT shadow the Application Support root token', () => {
    const cfgTok = makeJwt(NOW + 7200);   // +2h under ~/.config (foreign on mac)
    const appSup = makeJwt(NOW + 3600);   // +1h under Application Support (authoritative)
    writeAbs(join(home, '.config', 'kaboo-cli'), { bytecloud_jwt: cfgTok });
    writeAbs(join(home, 'Library', 'Application Support', 'kaboo-cli'), { bytecloud_jwt: appSup });
    expect(readBytecloudKeychainJwt(home, {} as NodeJS.ProcessEnv, nowMs, 'darwin')).toBe(appSup);
  });
});

describe('readBytecloudKeychainJwt — expiry safety window', () => {
  let home: string;
  const NOW = 1_000_000;
  const nowMs = NOW * 1000;
  const writeKeychain = (relRoot: string, body: unknown) => {
    const dir = join(home, relRoot, 'bytecloud-auth', 'keychain', 'auth', 'cn');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'default'), JSON.stringify(body), 'utf-8');
  };
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'riff-keychain-win-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('has a positive safety window (documents the constant is wired in)', () => {
    expect(JWT_EXPIRY_SAFETY_WINDOW_SEC).toBeGreaterThan(0);
  });

  it('skips a token expiring within the safety window in favour of a longer-lived one', () => {
    // kaboo expires in 10s (< window) — must be treated as expired and skipped;
    // bytedcli is well beyond the window and should win.
    const soon = makeJwt(NOW + 10);
    const live = makeJwt(NOW + 3600);
    writeKeychain(join('.config', 'kaboo-cli'), { bytecloud_jwt: soon });
    writeKeychain(join('.local', 'share', 'bytedcli', 'data'), { bytecloud_jwt: live });
    expect(readBytecloudKeychainJwt(home, {} as NodeJS.ProcessEnv, nowMs, 'linux')).toBe(live);
  });

  it('returns null when the only token expires within the safety window (fail-closed, no near-dead token)', () => {
    writeKeychain(join('.config', 'kaboo-cli'), { bytecloud_jwt: makeJwt(NOW + 5) });
    expect(readBytecloudKeychainJwt(home, {} as NodeJS.ProcessEnv, nowMs, 'linux')).toBeNull();
  });

  it('still accepts a token comfortably beyond the safety window', () => {
    const live = makeJwt(NOW + JWT_EXPIRY_SAFETY_WINDOW_SEC + 60);
    writeKeychain(join('.config', 'kaboo-cli'), { bytecloud_jwt: live });
    expect(readBytecloudKeychainJwt(home, {} as NodeJS.ProcessEnv, nowMs, 'linux')).toBe(live);
  });
});
