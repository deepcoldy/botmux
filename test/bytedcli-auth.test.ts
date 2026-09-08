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
const calls: Array<{ args: string[]; home: string | undefined }> = [];
/** Queued replies, one per invocation, in order. */
let replies: Array<{ code: number; stdout?: string; stderr?: string }> = [];

vi.mock('node:child_process', () => ({
  spawn: vi.fn((_cmd: string, args: string[], opts: { env?: Record<string, string> }) => {
    calls.push({ args, home: opts?.env?.HOME });
    const reply = replies.shift() ?? { code: 0, stdout: '' };
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
  /** Stand in for a completed login: the HOME exists. */
  function markLoggedIn(mod: { bytedcliHomeFor: (id: string) => string }, openId: string) {
    mkdirSync(mod.bytedcliHomeFor(openId), { recursive: true });
  }

  it('mints both JWTs for an authorized person', async () => {
    const mod = await fresh();
    markLoggedIn(mod, ALICE);
    replies = [{ code: 0, stdout: 'cloud.jwt.value\n' }, { code: 0, stdout: 'code.jwt.value\n' }];

    expect(await mod.mintBytedcliJwts(ALICE)).toEqual({
      cloudJwt: 'cloud.jwt.value',
      codeJwt: 'code.jwt.value',
    });
    expect(calls.every(c => c.home === mod.bytedcliHomeFor(ALICE))).toBe(true);
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
    markLoggedIn(mod, ALICE);
    replies = [{ code: 1, stderr: 'not logged in' }];
    expect(await mod.mintBytedcliJwts(ALICE)).toBeNull();
  });

  // Only git attribution depends on the Codebase JWT, so losing it must not
  // deny the turn outright — that would trade a cosmetic failure for a hard one.
  it('still authorizes when only the Codebase JWT is unavailable', async () => {
    const mod = await fresh();
    markLoggedIn(mod, ALICE);
    replies = [{ code: 0, stdout: 'cloud.jwt.value\n' }, { code: 1, stderr: 'codebase down' }];
    expect(await mod.mintBytedcliJwts(ALICE)).toEqual({ cloudJwt: 'cloud.jwt.value' });
  });

  // Minted per turn on purpose: the ByteCloud JWT lives ~2h while the login
  // behind it lives ~3 weeks, and bytedcli refreshes it internally. Caching
  // here would re-introduce the 2-hour re-scan this design exists to avoid.
  it('asks bytedcli again on every turn rather than caching', async () => {
    const mod = await fresh();
    markLoggedIn(mod, ALICE);
    replies = [
      { code: 0, stdout: 'jwt-1\n' }, { code: 0, stdout: 'code-1\n' },
      { code: 0, stdout: 'jwt-2\n' }, { code: 0, stdout: 'code-2\n' },
    ];
    expect((await mod.mintBytedcliJwts(ALICE))?.cloudJwt).toBe('jwt-1');
    expect((await mod.mintBytedcliJwts(ALICE))?.cloudJwt).toBe('jwt-2');
  });
});

describe('clearBytedcliAuth', () => {
  it('forgets that person entirely, pending login included', async () => {
    const mod = await fresh();
    mkdirSync(mod.bytedcliHomeFor(ALICE), { recursive: true });
    writeFileSync(join(mod.bytedcliHomeFor(ALICE), '.botmux-login-challenge'), '{}');

    mod.clearBytedcliAuth(ALICE);
    expect(existsSync(mod.bytedcliHomeFor(ALICE))).toBe(false);
    expect(mod.hasBytedcliHome(ALICE)).toBe(false);
  });
});
