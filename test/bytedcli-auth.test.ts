/**
 * Per-person bytedcli authorization.
 *
 * The properties worth pinning are all about *whose* credentials get used:
 *
 *   1. every invocation runs with that person's own HOME, which is what keeps
 *      one person's login from being visible to another (or to the machine);
 *   2. an open_id shaped like a path traversal cannot redirect that HOME;
 *   3. a person with no login yields no credentials — never a fallback to the
 *      machine's own SSO session;
 *   4. a resume token belongs to the person who started that login.
 *
 * `bytedcli` itself is stubbed: these tests are about what botmux does around
 * it, and a real device-code flow needs a human to click something.
 *
 * Run:  npx vitest run --project unit test/bytedcli-auth.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

/** Every `bytedcli` invocation this test file caused: argv plus the HOME it ran under. */
const statuses = new Map<string, { code: number; stdout?: string; stderr?: string }>();
const statusCalls: Array<{ home: string | undefined; identity?: string }> = [];
const calls: Array<{ args: string[]; home: string | undefined }> = [];
/** Queued replies, one per invocation, in order. */
let replies: Array<{ code: number; stdout?: string; stderr?: string }> = [];

vi.mock('node:child_process', () => ({
  spawn: vi.fn((_cmd: string, args: string[], opts: { env?: Record<string, string> }) => {
    const status = args[0] === 'auth' && args[1] === 'status';
    if (status) statusCalls.push({ home: opts?.env?.HOME, identity: opts?.env?.BYTECLOUD_AUTH_AS });
    else calls.push({ args, home: opts?.env?.HOME });
    const reply = status ? (statuses.get(opts?.env?.HOME ?? '') ?? { code: 0, stdout: envelope({ authenticated: false }) })
      : replies.shift() ?? { code: 0, stdout: '' };
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    // Emit on a later tick so listeners are attached first, as a real spawn does.
    setImmediate(() => {
      if (reply.stdout) child.stdout.emit('data', reply.stdout);
      if (reply.stderr) child.stderr.emit('data', reply.stderr);
      child.emit('close', reply.code);
    });
    return child;
  }),
}));

let home: string;
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => home, default: { ...orig, homedir: () => home } };
});

const ALICE = 'ou_alice';
const BOB = 'ou_bob';

async function fresh() {
  vi.resetModules();
  return await import('../src/services/bytedcli-auth.js');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'botmux-bytedcli-'));
  calls.length = 0;
  replies = [];
  statuses.clear();
  statusCalls.length = 0;
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

/** bytedcli's `--json` envelope. */
function envelope(data: unknown, status = 'success') {
  return `${JSON.stringify({ status, data, error: null })}\n`;
}

describe('bytedcliHomeFor — the isolation boundary', () => {
  it('gives each person their own directory', async () => {
    const { bytedcliHomeFor } = await fresh();
    expect(bytedcliHomeFor(ALICE)).not.toBe(bytedcliHomeFor(BOB));
    expect(bytedcliHomeFor(ALICE)).toContain(ALICE);
  });

  // The value lands in a filesystem path, so a traversal-shaped id must not be
  // able to point one person's HOME at another's — or at the machine's own.
  it('refuses an open_id that could escape the root', async () => {
    const { bytedcliHomeFor } = await fresh();
    for (const bad of ['../..', 'a/b', '', '.', 'x/../../etc']) {
      expect(() => bytedcliHomeFor(bad)).toThrow(/open_id/);
    }
  });
});

function writeBytedData(mod: Awaited<ReturnType<typeof fresh>>, openId: string, rel: string) {
  const full = join(mod.bytedcliHomeFor(openId), '.local', 'share', 'bytedcli', rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, '{}');
}

function authorize(mod: { bytedcliHomeFor: (id: string) => string }, openId: string) {
  const dir = mod.bytedcliHomeFor(openId);
  mkdirSync(dir, { recursive: true });
  statuses.set(dir, { code: 0, stdout: envelope({ authenticated: true, bytecloud_auth: { authType: 'user' } }) });
}

describe('hasBytedcliHome — provider-owned login state', () => {
  it('accepts an SDK login without any legacy token file and forces personal identity', async () => {
    const mod = await fresh(); authorize(mod, ALICE);
    expect(await mod.hasBytedcliHome(ALICE)).toBe(true);
    expect(statusCalls).toEqual([{ home: mod.bytedcliHomeFor(ALICE), identity: 'user' }]);
    expect(existsSync(join(mod.bytedcliHomeFor(ALICE), '.local/share/bytedcli/token.json'))).toBe(false);
  });
  it('does not treat a bare HOME or an expired legacy token file as authorization', async () => {
    const mod = await fresh();
    writeBytedData(mod, ALICE, 'token.json');
    expect(await mod.hasBytedcliHome(ALICE)).toBe(false);
  });
  it.each([
    { code: 1, stderr: 'provider unavailable' },
    { code: 0, stdout: 'not json' },
    { code: 0, stdout: envelope({ authenticated: true, auth_as: 'app' }) },
    { code: 0, stdout: envelope({ authenticated: true, bytecloud_auth: { authType: 'app' } }) },
  ])('refuses failed, malformed or non-personal status: %j', async status => {
    const mod = await fresh(); authorize(mod, ALICE);
    statuses.set(mod.bytedcliHomeFor(ALICE), status);
    await expect(mod.hasBytedcliHome(ALICE)).rejects.toThrow('unavailable');
  });
  it('keeps two people isolated and observes revocation on the next check', async () => {
    const mod = await fresh(); authorize(mod, ALICE);
    expect(await mod.hasBytedcliHome(ALICE)).toBe(true);
    expect(await mod.hasBytedcliHome(BOB)).toBe(false);
    statuses.set(mod.bytedcliHomeFor(ALICE), { code: 0, stdout: envelope({ authenticated: false }) });
    expect(await mod.hasBytedcliHome(ALICE)).toBe(false);
  });
});

describe('login — device code, in two steps', () => {
  it('returns the authorization link and remembers the resume token', async () => {
    const mod = await fresh();
    replies = [{
      code: 0,
      // A real `--begin` prints progress events before the envelope.
      stdout: `${JSON.stringify({ event: 'qr_image_ready', data: { path: '/tmp/q.png' } })}\n`
        + envelope({ verification_uri_complete: 'https://cloud.example.com/a?state=s', complete_token: 'tok-1' }),
    }];

    const started = await mod.beginBytedcliLogin(ALICE);
    expect(started).toEqual({ authUrl: 'https://cloud.example.com/a?state=s', completeToken: 'tok-1' });
    // Persisted, so the person can come back with `done` in a later message.
    expect(mod.pendingBytedcliChallenge(ALICE)).toBe('tok-1');
  });

  it('reuses an unfinished login instead of creating another link', async () => {
    const mod = await fresh();
    replies = [{
      code: 0,
      stdout: envelope({ verification_uri_complete: 'https://cloud.example.com/a?state=s', complete_token: 'tok-1' }),
    }];

    const first = await mod.beginBytedcliLogin(ALICE);
    const second = await mod.beginBytedcliLogin(ALICE);

    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  // Every call must carry that person's HOME — this is the entire mechanism by
  // which one person's login stays invisible to everyone else.
  it('runs under the requesting person\'s HOME', async () => {
    const mod = await fresh();
    replies = [{ code: 0, stdout: envelope({ verification_uri_complete: 'https://x/y', complete_token: 't' }) }];
    await mod.beginBytedcliLogin(ALICE);
    expect(calls[0].home).toBe(mod.bytedcliHomeFor(ALICE));
    expect(calls[0].home).not.toBe(home);
  });

  it('reports failure rather than a half-built challenge', async () => {
    const mod = await fresh();
    replies = [{ code: 1, stderr: 'network unreachable' }];
    expect(await mod.beginBytedcliLogin(ALICE)).toBeNull();
    expect(mod.pendingBytedcliChallenge(ALICE)).toBeNull();
  });

  it('treats "not clicked yet" as pending, not as an error', async () => {
    const mod = await fresh();
    replies = [{ code: 0, stdout: envelope({ status: 'pending' }) }];
    expect(await mod.completeBytedcliLogin(ALICE, 'tok-1')).toEqual({ state: 'pending' });
  });

  it('clears the challenge once the login lands', async () => {
    const mod = await fresh();
    authorize(mod, ALICE);
    replies = [
      { code: 0, stdout: envelope({ verification_uri_complete: 'https://x/y', complete_token: 'tok-1' }) },
      { code: 0, stdout: envelope({ status: 'ok' }) },
    ];
    await mod.beginBytedcliLogin(ALICE);
    expect(await mod.completeBytedcliLogin(ALICE, 'tok-1')).toEqual({ state: 'authorized' });
    expect(mod.pendingBytedcliChallenge(ALICE)).toBeNull();
  });

  // One person's pending login must never be visible as another's.
  it('keeps each person\'s challenge to themselves', async () => {
    const mod = await fresh();
    replies = [{ code: 0, stdout: envelope({ verification_uri_complete: 'https://x/y', complete_token: 'alice-tok' }) }];
    await mod.beginBytedcliLogin(ALICE);
    expect(mod.pendingBytedcliChallenge(BOB)).toBeNull();
  });
});

describe('mintBytedcliJwts — fresh per turn, never borrowed', () => {
  it('mints both JWTs for an authorized person', async () => {
    const mod = await fresh();
    authorize(mod, ALICE);
    replies = [{ code: 0, stdout: 'cloud.jwt.value\n' }, { code: 0, stdout: 'code.jwt.value\n' }];

    expect(await mod.mintBytedcliJwts(ALICE)).toEqual({
      cloudJwt: 'cloud.jwt.value',
      codeJwt: 'code.jwt.value',
    });
    expect(calls.every(c => c.home === mod.bytedcliHomeFor(ALICE))).toBe(true);
  });

  it('automatically completes a pending login before minting JWTs', async () => {
    const mod = await fresh();
    replies = [{
      code: 0,
      stdout: envelope({ verification_uri_complete: 'https://cloud.example.com/a?state=s', complete_token: 'tok-1' }),
    }];
    await mod.beginBytedcliLogin(ALICE);
    // A successful --complete makes bytedcli itself write the SSO token; the
    // scripted runner cannot, so lay down what the real CLI would.
    authorize(mod, ALICE);
    replies = [
      { code: 0, stdout: envelope({ status: 'ok' }) },
      { code: 0, stdout: 'cloud.jwt.value\n' },
      { code: 0, stdout: 'code.jwt.value\n' },
    ];

    expect(await mod.mintBytedcliJwts(ALICE)).toEqual({
      cloudJwt: 'cloud.jwt.value',
      codeJwt: 'code.jwt.value',
    });
    expect(calls.slice(1).map(call => call.args)).toEqual([
      ['auth', 'login', '--complete', 'tok-1', '--json'],
      ['auth', 'get-bytecloud-jwt-token'],
      ['auth', 'get-codebase-jwt-token'],
    ]);
    expect(mod.pendingBytedcliChallenge(ALICE)).toBeNull();
  });

  it('waits for the user to click a pending login before minting JWTs', async () => {
    const mod = await fresh();
    replies = [{
      code: 0,
      stdout: envelope({ verification_uri_complete: 'https://cloud.example.com/a?state=s', complete_token: 'tok-1' }),
    }];
    await mod.beginBytedcliLogin(ALICE);
    replies = [{ code: 0, stdout: envelope({ status: 'pending' }) }];

    expect(await mod.mintBytedcliJwts(ALICE)).toBeNull();
    expect(calls.slice(1).map(call => call.args)).toEqual([
      ['auth', 'login', '--complete', 'tok-1', '--json'],
    ]);
  });

  // The whole point: no login means no credentials, NOT the machine's own SSO
  // session — which is what plain `bytedcli` would have used.
  it('returns nothing for a person who has never authorized', async () => {
    const mod = await fresh();
    expect(await mod.mintBytedcliJwts(BOB)).toBeNull();
    // And it did not even shell out, so it cannot have read anyone's session.
    expect(calls).toEqual([]);
  });

  it('returns nothing once their login has expired', async () => {
    const mod = await fresh();
    authorize(mod, ALICE);
    statuses.set(mod.bytedcliHomeFor(ALICE), { code: 0, stdout: envelope({ authenticated: false, bytecloud_auth: { status: 'need_login' } }) });
    expect(await mod.mintBytedcliJwts(ALICE)).toBeNull();
  });

  // Only git attribution depends on the Codebase JWT, so losing it must not
  // deny the turn outright — that would trade a cosmetic failure for a hard one.
  it('still authorizes when only the Codebase JWT is unavailable', async () => {
    const mod = await fresh();
    authorize(mod, ALICE);
    replies = [{ code: 0, stdout: 'cloud.jwt.value\n' }, { code: 1, stderr: 'codebase down' }];
    expect(await mod.mintBytedcliJwts(ALICE)).toEqual({ cloudJwt: 'cloud.jwt.value' });
  });

  // Minted per turn on purpose: the ByteCloud JWT lives ~2h while the login
  // behind it lives ~3 weeks, and bytedcli refreshes it internally. Caching
  // here would re-introduce the 2-hour re-scan this design exists to avoid.
  it('asks bytedcli again on every turn rather than caching', async () => {
    const mod = await fresh();
    authorize(mod, ALICE);
    replies = [
      { code: 0, stdout: 'jwt-1\n' }, { code: 0, stdout: 'code-1\n' },
      { code: 0, stdout: 'jwt-2\n' }, { code: 0, stdout: 'code-2\n' },
    ];
    expect((await mod.mintBytedcliJwts(ALICE))?.cloudJwt).toBe('jwt-1');
    expect((await mod.mintBytedcliJwts(ALICE))?.cloudJwt).toBe('jwt-2');
  });
});

describe('mintBytedcliJwts — a pending login is best-effort, never a hard gate (F-B)', () => {
  async function beginOnce(mod: Awaited<ReturnType<typeof fresh>>) {
    replies = [{
      code: 0,
      stdout: envelope({ verification_uri_complete: 'https://cloud.example.com/a', complete_token: 'tok-1' }),
    }];
    await mod.beginBytedcliLogin(ALICE);
  }

  // The lockout this fixes: a transient blip auto-begins a challenge on the
  // refusal path; the person IS authorized, and must keep working while nobody
  // scans that link.
  it('still mints JWTs when the completion poll is pending and a login exists', async () => {
    const mod = await fresh();
    await beginOnce(mod);
    authorize(mod, ALICE);
    replies = [
      { code: 0, stdout: envelope({ status: 'pending' }) },
      { code: 0, stdout: 'cloud.jwt\n' },
      { code: 0, stdout: 'code.jwt\n' },
    ];
    expect(await mod.mintBytedcliJwts(ALICE)).toEqual({ cloudJwt: 'cloud.jwt', codeJwt: 'code.jwt' });
    expect(calls.slice(1).map(c => c.args)).toEqual([
      ['auth', 'login', '--complete', 'tok-1', '--json'],
      ['auth', 'get-bytecloud-jwt-token'],
      ['auth', 'get-codebase-jwt-token'],
    ]);
    // Pending leaves the challenge in place so the link stays usable.
    expect(mod.pendingBytedcliChallenge(ALICE)).toBe('tok-1');
  });

  it('still mints when the completion poll fails terminally, and drops the dead challenge', async () => {
    const mod = await fresh();
    await beginOnce(mod);
    authorize(mod, ALICE);
    replies = [
      { code: 1, stdout: envelope(null, 'error') + JSON.stringify({ error: { code: 'BYTECLOUD_AUTH_LOGIN_EXPIRED', message: 'token expired' } }) + '\n' },
      { code: 0, stdout: 'cloud.jwt\n' },
      { code: 0, stdout: 'code.jwt\n' },
    ];
    // Build the failure envelope properly below instead of the concat above.
    replies[0] = { code: 1, stdout: JSON.stringify({ status: 'error', data: null, error: { code: 'BYTECLOUD_AUTH_LOGIN_EXPIRED', message: 'token expired' } }) + '\n' };
    expect(await mod.mintBytedcliJwts(ALICE)).toEqual({ cloudJwt: 'cloud.jwt', codeJwt: 'code.jwt' });
    expect(mod.pendingBytedcliChallenge(ALICE)).toBeNull();
  });

  it('refuses (no JWT read at all) when nobody ever authorized, challenge or not', async () => {
    const mod = await fresh();
    await beginOnce(mod);
    replies = [{ code: 0, stdout: envelope({ status: 'pending' }) }];
    expect(await mod.mintBytedcliJwts(ALICE)).toBeNull();
    expect(calls.slice(1).map(c => c.args)).toEqual([
      ['auth', 'login', '--complete', 'tok-1', '--json'],
    ]);
  });

  it('recovers on the same challenge the moment the login lands', async () => {
    const mod = await fresh();
    await beginOnce(mod);
    // Earlier turn: no login yet → nothing.
    replies = [{ code: 0, stdout: envelope({ status: 'pending' }) }];
    expect(await mod.mintBytedcliJwts(ALICE)).toBeNull();
    // Person taps the link; the next turn completes AND mints.
    authorize(mod, ALICE);
    replies = [
      { code: 0, stdout: envelope({ status: 'ok' }) },
      { code: 0, stdout: 'cloud.jwt\n' },
      { code: 0, stdout: 'code.jwt\n' },
    ];
    expect(await mod.mintBytedcliJwts(ALICE)).toEqual({ cloudJwt: 'cloud.jwt', codeJwt: 'code.jwt' });
  });
});

describe('clearBytedcliAuth', () => {
  it('forgets that person entirely, pending login included', async () => {
    const mod = await fresh();
    mkdirSync(mod.bytedcliHomeFor(ALICE), { recursive: true });
    writeFileSync(join(mod.bytedcliHomeFor(ALICE), '.botmux-login-challenge'), '{}');

    mod.clearBytedcliAuth(ALICE);
    expect(existsSync(mod.bytedcliHomeFor(ALICE))).toBe(false);
    expect(await mod.hasBytedcliHome(ALICE)).toBe(false);
  });
});


describe('authorization loop regressions', () => {
  async function begin(mod: Awaited<ReturnType<typeof fresh>>) {
    replies = [{ code: 0, stdout: envelope({ verification_uri_complete: 'https://example.test/login', complete_token: 'challenge' }) }];
    await mod.beginBytedcliLogin(ALICE);
  }

  it.each([{ login_status: 'pending' }, { status: 'pending' }])('retains and reuses a pending challenge: %j', async data => {
    const mod = await fresh(); await begin(mod);
    replies = [{ code: 0, stdout: envelope(data) }];
    expect(await mod.completeBytedcliLogin(ALICE, 'challenge')).toEqual({ state: 'pending' });
    expect((await mod.beginBytedcliLogin(ALICE))?.completeToken).toBe('challenge');
    expect(calls.filter(c => c.args.includes('--begin'))).toHaveLength(1);
  });

  it.each([
    { code: 1, stderr: 'network unavailable' },
    { code: 0, stdout: 'malformed output' },
    { code: 0, stdout: envelope({ login_status: 'unexpected' }) },
    { code: 0, stdout: envelope({ login_status: 'success' }, 'error') },
    { code: 0, stdout: envelope({ login_status: 'success' }) },
  ])('does not turn an unverified completion into success or discard its challenge: %j', async reply => {
    const mod = await fresh(); await begin(mod); replies = [reply];
    expect((await mod.completeBytedcliLogin(ALICE, 'challenge')).state).toBe('unavailable');
    expect(mod.pendingBytedcliChallenge(ALICE)).toBe('challenge');
  });

  it('accepts modern success only after the personal provider confirms it', async () => {
    const mod = await fresh(); await begin(mod); authorize(mod, ALICE);
    replies = [{ code: 0, stdout: envelope({ login_status: 'success' }) }];
    expect(await mod.completeBytedcliLogin(ALICE, 'challenge')).toEqual({ state: 'authorized' });
    expect(mod.pendingBytedcliChallenge(ALICE)).toBeNull();
  });

  it('does not report exit-zero expiration as authorized', async () => {
    const mod = await fresh(); await begin(mod);
    replies = [{ code: 0, stdout: envelope({ login_status: 'expired' }) }];
    expect((await mod.completeBytedcliLogin(ALICE, 'challenge')).state).toBe('failed');
    expect(mod.pendingBytedcliChallenge(ALICE)).toBeNull();
  });

  it('coalesces simultaneous login attempts for the same user', async () => {
    const mod = await fresh();
    replies = [{ code: 0, stdout: envelope({ verification_uri_complete: 'https://example.test/login', complete_token: 'challenge' }) }];
    const results = await Promise.all(Array.from({ length: 8 }, () => mod.beginBytedcliLogin(ALICE)));
    expect(results.every(r => r?.completeToken === 'challenge')).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it.each([
    { code: 1, stderr: 'provider offline' },
    { code: 0, stdout: 'not JSON' },
    { code: 0, stdout: envelope({ authenticated: false, bytecloud_auth: { status: 'error' } }) },
  ])('distinguishes provider failures from missing authorization: %j', async reply => {
    const mod = await fresh(); authorize(mod, ALICE);
    statuses.set(mod.bytedcliHomeFor(ALICE), reply);
    await expect(mod.mintBytedcliJwts(ALICE)).rejects.toThrow('service unavailable');
    expect(calls).toEqual([]);
  });

  it('reports a failed JWT mint as unavailable instead of asking for another login', async () => {
    const mod = await fresh(); authorize(mod, ALICE);
    replies = [{ code: 1, stderr: 'network down' }];
    await expect(mod.mintBytedcliJwts(ALICE)).rejects.toThrow('service unavailable');
  });
});


describe('provider timeout', () => {
  it('settles and releases singleflight even when inherited pipes never close', async () => {
    const mod = await fresh();
    const { spawn } = await import('node:child_process');
    const { PassThrough } = await import('node:stream');
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    vi.useFakeTimers();
    try {
      const first = mod.beginBytedcliLogin(ALICE);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await first).toBeNull();
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
    } finally { vi.useRealTimers(); }
    replies = [{ code: 0, stdout: envelope({ verification_uri_complete: 'https://example.test/login', complete_token: 'retry' }) }];
    expect((await mod.beginBytedcliLogin(ALICE))?.completeToken).toBe('retry');
  });
});
