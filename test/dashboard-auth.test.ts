import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  symlinkSync, writeFileSync, existsSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  verifyHmac, generateToken, parseCookie, decideDashboardAuth,
  decideWorkbenchH5Auth, workbenchH5Capability,
  loadPersistedToken, loadOrCreatePersistedToken, persistToken, rotatePersistedToken,
  loadDashboardSecret, loadOrCreateDashboardSecret, describeDashboardTokenError,
} from '../src/dashboard/auth.js';
import { UnsafeHostAuthorityFileError } from '../src/platform/secure-host-file.js';

const SECRET = 'a'.repeat(43); // base64url 32 bytes

function sign(ts: string, nonce: string): string {
  return createHmac('sha256', SECRET).update(`${ts}:${nonce}`).digest('base64url');
}

describe('verifyHmac', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(0)); });
  afterEach(() => { vi.useRealTimers(); });

  it('accepts valid signature', () => {
    const ts = '0', nonce = 'n1';
    const r = verifyHmac(SECRET, { ts, nonce, sig: sign(ts, nonce) }, '127.0.0.1');
    expect(r.ok).toBe(true);
  });

  it('rejects wrong secret', () => {
    const ts = '0', nonce = 'n2';
    const r = verifyHmac(SECRET, { ts, nonce, sig: sign(ts, nonce).replace(/^./, 'X') }, '127.0.0.1');
    expect(r.ok).toBe(false);
  });

  it('rejects expired ts (>30s)', () => {
    vi.setSystemTime(new Date(60_000));
    const ts = '0', nonce = 'n3';
    const r = verifyHmac(SECRET, { ts, nonce, sig: sign(ts, nonce) }, '127.0.0.1');
    expect(r.ok).toBe(false);
  });

  it('rejects non-loopback IP', () => {
    const ts = '0', nonce = 'n4';
    const r = verifyHmac(SECRET, { ts, nonce, sig: sign(ts, nonce) }, '192.168.1.5');
    expect(r.ok).toBe(false);
  });

  it('rejects replayed nonce within window', () => {
    const ts = '0', nonce = 'n5';
    const a = verifyHmac(SECRET, { ts, nonce, sig: sign(ts, nonce) }, '127.0.0.1');
    expect(a.ok).toBe(true);
    const b = verifyHmac(SECRET, { ts, nonce, sig: sign(ts, nonce) }, '127.0.0.1');
    expect(b.ok).toBe(false);
  });
});

describe('generateToken', () => {
  it('returns 43-char base64url (32 bytes)', () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('describeDashboardTokenError', () => {
  const TP = '/home/u/.botmux/.dashboard-token';

  // The function branches on process.platform (POSIX command vs prose). Default
  // the whole block to a POSIX view so the common-case assertions are stable on
  // any host; the win32 cases override it explicitly and restore after.
  let platformSpy: ReturnType<typeof vi.spyOn> | undefined;
  const asPlatform = (p: NodeJS.Platform) => {
    platformSpy?.mockRestore();
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue(p);
  };
  beforeEach(() => asPlatform('linux'));
  afterEach(() => { platformSpy?.mockRestore(); platformSpy = undefined; });

  it('keeps the bare stable code for non-credential errors', () => {
    expect(describeDashboardTokenError('token_unavailable', new Error('boom'), TP))
      .toEqual({ error: 'token_unavailable' });
    // Preserve the machine code so programmatic callers are unaffected.
    expect(describeDashboardTokenError('token_persist_failed', undefined, TP))
      .toEqual({ error: 'token_persist_failed' });
  });

  it('surfaces a group/other-writable dir reason with a chmod 700 (dir) hint', () => {
    const out = describeDashboardTokenError(
      'token_unavailable',
      new UnsafeHostAuthorityFileError('宿主凭证目录可被组内或其它用户写入'),
      TP,
    );
    expect(out.error).toBe('token_unavailable'); // stable code preserved
    expect(out.reason).toBe('宿主凭证目录可被组内或其它用户写入');
    expect(out.hint).toContain('chmod 700 /home/u/.botmux');
  });

  it('a wrong-owner DIRECTORY gets the chmod 700 dir hint', () => {
    const out = describeDashboardTokenError(
      'token_unavailable',
      new UnsafeHostAuthorityFileError('宿主凭证目录 不属于当前用户'),
      TP,
    );
    expect(out.hint).toContain('chmod 700 /home/u/.botmux');
  });

  it('a wrong-owner FILE does NOT get a chmod hint (chmod cannot fix ownership) but an rm-to-regenerate hint', () => {
    const out = describeDashboardTokenError(
      'token_persist_failed',
      // secure-host-file throws `${label} 不属于当前用户` with label 宿主凭证文件.
      new UnsafeHostAuthorityFileError('宿主凭证文件 不属于当前用户'),
      TP,
    );
    expect(out.reason).toBe('宿主凭证文件 不属于当前用户');
    expect(out.hint).not.toContain('chmod'); // the pre-fix bug: told user to chmod the dir
    expect(out.hint).toContain(`rm -f ${TP}`);
  });

  it('surfaces a wrong-mode token reason with a chmod 600 hint', () => {
    const out = describeDashboardTokenError(
      'token_persist_failed',
      new UnsafeHostAuthorityFileError('宿主凭证文件权限必须严格为 0600'),
      TP,
    );
    expect(out.reason).toBe('宿主凭证文件权限必须严格为 0600');
    expect(out.hint).toContain(`chmod 600 ${TP}`);
  });

  it('a symlink (ELOOP) gets a definite rm -f hint', () => {
    const out = describeDashboardTokenError(
      'token_persist_failed',
      new UnsafeHostAuthorityFileError('宿主凭证拒绝符号链接'),
      TP,
    );
    expect(out.hint).toContain(`rm -f ${TP}`);
  });

  it('a non-regular file of unknown kind degrades to an inspection step, NOT a blind rm -f (a dir leaf would fail "Is a directory")', () => {
    const out = describeDashboardTokenError(
      'token_persist_failed',
      new UnsafeHostAuthorityFileError('宿主凭证必须是普通文件'),
      TP,
    );
    expect(out.reason).toBe('宿主凭证必须是普通文件');
    expect(out.hint).not.toContain('rm -f'); // the pre-fix bug: `rm -f` on a dir leaf
    expect(out.hint).toContain(`ls -ld ${TP}`);
  });

  it('surfaces an unsafe-ancestor reason without inventing a chmod on the leaf', () => {
    const out = describeDashboardTokenError(
      'token_persist_failed',
      new UnsafeHostAuthorityFileError('宿主凭证目录可被不可信祖先目录替换'),
      TP,
    );
    expect(out.reason).toBe('宿主凭证目录可被不可信祖先目录替换');
    expect(out.hint).toContain('祖先');
  });

  it('shell-quotes paths with spaces/metacharacters in the copy-paste command', () => {
    const spaced = '/home/u/My Botmux/.dashboard-token';
    const out = describeDashboardTokenError(
      'token_persist_failed',
      new UnsafeHostAuthorityFileError('宿主凭证文件权限必须严格为 0600'),
      spaced,
    );
    // Quoted so the command survives a copy-paste; the raw path may still appear
    // in prose, but the command token itself must be the quoted form.
    expect(out.hint).toContain(`chmod 600 '${spaced}'`);
  });

  it('on win32 emits prose, never an unusable chmod/rm one-liner', () => {
    asPlatform('win32');
    const chmodCase = describeDashboardTokenError(
      'token_unavailable',
      new UnsafeHostAuthorityFileError('宿主凭证目录可被组内或其它用户写入'),
      'C:\\Users\\u\\.botmux\\.dashboard-token',
    );
    expect(chmodCase.hint).toBeTruthy();
    expect(chmodCase.hint).not.toMatch(/chmod|rm -f/);
    const rmCase = describeDashboardTokenError(
      'token_persist_failed',
      new UnsafeHostAuthorityFileError('宿主凭证拒绝符号链接'),
      'C:\\Users\\u\\.botmux\\.dashboard-token',
    );
    expect(rmCase.hint).toBeTruthy();
    expect(rmCase.hint).not.toMatch(/chmod|rm -f/);
  });

  it('an unmapped credential reason still surfaces the reason verbatim with no hint', () => {
    const out = describeDashboardTokenError(
      'token_persist_failed',
      new UnsafeHostAuthorityFileError('宿主凭证文件大小异常'),
      TP,
    );
    expect(out.reason).toBe('宿主凭证文件大小异常');
    expect(out.hint).toBeUndefined();
  });
});

describe('token persistence (survives restart, rotates only on `botmux dashboard rotate`)', () => {
  let dir: string;
  let tokenPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-token-'));
    tokenPath = join(dir, 'nested', '.dashboard-token');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('loadPersistedToken returns null when the file is absent', () => {
    expect(loadPersistedToken(tokenPath)).toBeNull();
  });

  it('persistToken then loadPersistedToken round-trips the token (creates dirs)', () => {
    const tok = generateToken();
    persistToken(tokenPath, tok);
    expect(loadPersistedToken(tokenPath)).toBe(tok);
  });

  it('loadOrCreatePersistedToken creates and persists a missing token', () => {
    const tok = loadOrCreatePersistedToken(tokenPath);
    expect(tok).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loadPersistedToken(tokenPath)).toBe(tok);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it('loadOrCreatePersistedToken reuses an existing token without rotating it', () => {
    persistToken(tokenPath, 'existing-token');
    expect(loadOrCreatePersistedToken(tokenPath)).toBe('existing-token');
    expect(loadPersistedToken(tokenPath)).toBe('existing-token');
  });

  it('concurrent processes creating the first token all return the persisted winner', async () => {
    const goPath = join(dir, 'go');
    const authModuleUrl = new URL('../src/dashboard/auth.ts', import.meta.url).href;
    const childSource = `
      import { existsSync, writeFileSync } from 'node:fs';
      const [tokenPath, readyPath, goPath] = process.argv.slice(1);
      const { loadOrCreatePersistedToken } = await import(${JSON.stringify(authModuleUrl)});
      writeFileSync(readyPath, 'ready');
      while (!existsSync(goPath)) await new Promise(resolve => setTimeout(resolve, 5));
      process.stdout.write(loadOrCreatePersistedToken(tokenPath));
    `;
    const children = Array.from({ length: 12 }, (_, index) => {
      const readyPath = join(dir, `token-ready-${index}`);
      const child = spawn(process.execPath, [
        '--import', 'tsx', '--input-type=module', '-e', childSource,
        tokenPath, readyPath, goPath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      return { child, readyPath, stdout: () => stdout, stderr: () => stderr };
    });

    try {
      const deadline = Date.now() + 10_000;
      while (!children.every(entry => existsSync(entry.readyPath))) {
        if (Date.now() >= deadline) throw new Error('token children did not reach barrier');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      writeFileSync(goPath, 'go');
      const exits = await Promise.all(children.map(async entry => {
        const [code, signal] = await once(entry.child, 'close');
        return { code, signal, stdout: entry.stdout(), stderr: entry.stderr() };
      }));
      for (const result of exits) {
        expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      }
      const tokens = exits.map(result => result.stdout);
      expect(new Set(tokens).size).toBe(1);
      expect(tokens[0]).toBe(loadPersistedToken(tokenPath));
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
  }, 20_000);

  it('persisted token survives a simulated restart (same file, new process)', () => {
    const tok = generateToken();
    persistToken(tokenPath, tok);
    // A "restart" re-reads from disk — the previously-issued token is still active.
    expect(loadPersistedToken(tokenPath)).toBe(tok);
  });

  it('running `botmux dashboard rotate` overwrites the old token (old link invalidated)', () => {
    const first = generateToken();
    persistToken(tokenPath, first);
    const second = rotatePersistedToken(tokenPath);
    expect(second).not.toBe(first);
    expect(loadPersistedToken(tokenPath)).toBe(second);
  });

  it('persistToken writes the file with 0600 perms', () => {
    persistToken(tokenPath, generateToken());
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it('refuses rotation through a token leaf symlink without modifying its target', () => {
    if (process.platform === 'win32') return;
    mkdirSync(join(dir, 'nested'));
    const victim = join(dir, 'victim');
    writeFileSync(victim, 'keep-me', { mode: 0o600 });
    symlinkSync(victim, tokenPath);

    expect(() => rotatePersistedToken(tokenPath)).toThrow();
    expect(readFileSync(victim, 'utf8')).toBe('keep-me');
  });

  it('loadPersistedToken trims surrounding whitespace/newlines', () => {
    const p = join(dir, 'spaced-token');
    writeFileSync(p, '  tok-with-space\n', { mode: 0o600 });
    expect(loadPersistedToken(p)).toBe('tok-with-space');
  });

  it('loadPersistedToken returns null for an empty file', () => {
    const p = join(dir, 'empty-token');
    writeFileSync(p, '   \n', { mode: 0o600 });
    expect(loadPersistedToken(p)).toBeNull();
    expect(existsSync(p)).toBe(true);
  });

  it('loadPersistedToken fails closed when the credential path is not a regular file', () => {
    expect(() => loadPersistedToken(dir)).toThrow();
  });
});

/**
 * Regression: dashboard token ensure/rotate on a Linux dev box whose HOME is a
 * symlink resolving onto a shared drive / 0777 ancestor. Before the FD-anchored
 * fix, loadOrCreatePersistedToken()/rotatePersistedToken() ran the strict
 * ancestor-chain assertion (via secureHostFilePath) before reaching the Linux
 * FD-pinning path, so a single writable ancestor made `botmux dashboard` fail
 * with `500 token_persist_failed` even though the direct write path succeeded.
 */
describe('token persistence under a symlinked HOME on a shared drive (Linux FD-pinning)', () => {
  let base: string;

  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'botmux-token-shared-')); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  /**
   * Build `<shared 0777>/real-home/.botmux` (0700, current user) and a HOME
   * symlink pointing at real-home. Returns the token path as seen through the
   * symlinked HOME plus the canonical (post-realpath) leaf path.
   */
  function sharedDriveHome(): { tokenPath: string; canonicalLeaf: string; botmux: string } {
    const shared = join(base, 'shared');
    mkdirSync(shared, { recursive: true });
    chmodSync(shared, 0o777); // shared drive / group+other-writable ancestor
    const realHome = join(shared, 'real-home');
    mkdirSync(realHome, { recursive: true });
    const botmux = join(realHome, '.botmux');
    mkdirSync(botmux, { mode: 0o700 });
    chmodSync(botmux, 0o700); // defeat umask so the dir is exactly 0700
    const homeLink = join(base, 'home-link');
    symlinkSync(realHome, homeLink);
    return {
      tokenPath: join(homeLink, '.botmux', '.dashboard-token'),
      canonicalLeaf: join(realHome, '.botmux', '.dashboard-token'),
      botmux,
    };
  }

  it('ensures a token under a 0777 ancestor; leaf lands in the real dir at 0600', () => {
    if (process.platform !== 'linux') return;
    const { tokenPath, canonicalLeaf } = sharedDriveHome();

    const token = loadOrCreatePersistedToken(tokenPath);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Persisted through the symlink into the real (canonical) directory.
    expect(readFileSync(canonicalLeaf, 'utf8').trim()).toBe(token);
    expect(lstatSync(canonicalLeaf).mode & 0o777).toBe(0o600);
    // Re-ensure reuses the same durable token instead of minting a new one.
    expect(loadOrCreatePersistedToken(tokenPath)).toBe(token);
    expect(loadPersistedToken(tokenPath)).toBe(token);
  });

  it('rotates the token under the same shared-drive path', () => {
    if (process.platform !== 'linux') return;
    const { tokenPath, canonicalLeaf } = sharedDriveHome();

    const first = loadOrCreatePersistedToken(tokenPath);
    const rotated = rotatePersistedToken(tokenPath);
    expect(rotated).not.toBe(first);
    expect(rotated).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(canonicalLeaf, 'utf8').trim()).toBe(rotated);
    expect(lstatSync(canonicalLeaf).mode & 0o777).toBe(0o600);
    expect(loadPersistedToken(tokenPath)).toBe(rotated);
  });

  it('ensures a token through a HOME symlink to a permission-safe plain dir', () => {
    if (process.platform === 'win32') return;
    // Safe layout: no writable ancestor, HOME is just a symlink indirection.
    const realHome = join(base, 'real-home');
    mkdirSync(join(realHome, '.botmux'), { recursive: true, mode: 0o700 });
    chmodSync(join(realHome, '.botmux'), 0o700);
    const homeLink = join(base, 'home-link');
    symlinkSync(realHome, homeLink);
    const tokenPath = join(homeLink, '.botmux', '.dashboard-token');

    const token = loadOrCreatePersistedToken(tokenPath);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(join(realHome, '.botmux', '.dashboard-token'), 'utf8').trim()).toBe(token);
    expect(rotatePersistedToken(tokenPath)).not.toBe(token);
  });

  it('still refuses a token leaf symlink under a shared-drive HOME (target untouched)', () => {
    if (process.platform === 'win32') return;
    const { tokenPath, botmux } = sharedDriveHome();
    const victim = join(botmux, 'victim');
    writeFileSync(victim, 'keep-me', { mode: 0o600 });
    symlinkSync(victim, realpathSync(botmux) + '/.dashboard-token');

    expect(() => rotatePersistedToken(tokenPath)).toThrow();
    expect(() => loadOrCreatePersistedToken(tokenPath)).toThrow();
    expect(readFileSync(victim, 'utf8')).toBe('keep-me');
  });

  it('still refuses when ~/.botmux itself is group/other-writable', () => {
    if (process.platform === 'win32') return;
    const shared = join(base, 'shared');
    mkdirSync(shared, { recursive: true });
    chmodSync(shared, 0o777);
    const realHome = join(shared, 'real-home');
    const botmux = join(realHome, '.botmux');
    mkdirSync(botmux, { recursive: true });
    chmodSync(botmux, 0o770); // the credential dir itself is group-writable → unsafe
    const homeLink = join(base, 'home-link');
    symlinkSync(realHome, homeLink);
    const tokenPath = join(homeLink, '.botmux', '.dashboard-token');

    expect(() => loadOrCreatePersistedToken(tokenPath)).toThrow(/组内|其它用户写入/);
    expect(() => rotatePersistedToken(tokenPath)).toThrow(/组内|其它用户写入/);
  });

  it('concurrent processes under a shared-drive symlinked HOME all return one token', async () => {
    if (process.platform !== 'linux') return;
    const { tokenPath, canonicalLeaf } = sharedDriveHome();
    const goPath = join(base, 'go');
    const authModuleUrl = new URL('../src/dashboard/auth.ts', import.meta.url).href;
    const childSource = `
      import { existsSync, writeFileSync } from 'node:fs';
      const [tokenPath, readyPath, goPath] = process.argv.slice(1);
      const { loadOrCreatePersistedToken } = await import(${JSON.stringify(authModuleUrl)});
      writeFileSync(readyPath, 'ready');
      while (!existsSync(goPath)) await new Promise(resolve => setTimeout(resolve, 5));
      process.stdout.write(loadOrCreatePersistedToken(tokenPath));
    `;
    const children = Array.from({ length: 12 }, (_, index) => {
      const readyPath = join(base, `ready-${index}`);
      const child = spawn(process.execPath, [
        '--import', 'tsx', '--input-type=module', '-e', childSource,
        tokenPath, readyPath, goPath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      return { child, readyPath, stdout: () => stdout, stderr: () => stderr };
    });

    try {
      const deadline = Date.now() + 10_000;
      while (!children.every(entry => existsSync(entry.readyPath))) {
        if (Date.now() >= deadline) throw new Error('token children did not reach barrier');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      writeFileSync(goPath, 'go');
      const exits = await Promise.all(children.map(async entry => {
        const [code, signal] = await once(entry.child, 'close');
        return { code, signal, stdout: entry.stdout(), stderr: entry.stderr() };
      }));
      for (const result of exits) {
        expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      }
      const tokens = exits.map(result => result.stdout);
      expect(new Set(tokens).size).toBe(1);
      expect(tokens[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // The single durable winner is what the real (canonical) leaf holds.
      expect(readFileSync(canonicalLeaf, 'utf8').trim()).toBe(tokens[0]);
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
  }, 20_000);
});

describe('dashboard secret persistence', () => {
  let dir: string;
  let secretPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-secret-'));
    secretPath = join(dir, 'nested', '.dashboard-secret');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('loadDashboardSecret returns null when file is absent or whitespace-only', () => {
    expect(loadDashboardSecret(secretPath)).toBeNull();
    const p = join(dir, 'empty-secret');
    writeFileSync(p, '   \n');
    expect(loadDashboardSecret(p)).toBeNull();
  });

  it('loadOrCreateDashboardSecret overwrites whitespace-only file with a fresh 0600 secret', () => {
    mkdirSync(join(dir, 'nested'));
    writeFileSync(secretPath, ' \n');
    const secret = loadOrCreateDashboardSecret(secretPath);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loadDashboardSecret(secretPath)).toBe(secret);
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
  });

  it('ignores a legacy stale repair lock and converges through a permanent seed', () => {
    mkdirSync(join(dir, 'nested'));
    writeFileSync(secretPath, ' \n');
    const lockPath = `${secretPath}.repair.lock`;
    writeFileSync(lockPath, '');

    const secret = loadOrCreateDashboardSecret(secretPath);

    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loadDashboardSecret(secretPath)).toBe(secret);
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    expect(loadDashboardSecret(`${secretPath}.repair-seed`)).toBe(secret);
    expect(statSync(`${secretPath}.repair-seed`).mode & 0o777).toBe(0o600);
    expect(existsSync(lockPath)).toBe(true); // ignored legacy residue cannot block startup
  });

  it('concurrent processes repairing one corrupt secret converge on the repair seed', async () => {
    mkdirSync(join(dir, 'nested'));
    writeFileSync(secretPath, ' \n');
    const goPath = join(dir, 'go');
    const authModuleUrl = new URL('../src/dashboard/auth.ts', import.meta.url).href;
    const childSource = `
      import { existsSync, writeFileSync } from 'node:fs';
      const [secretPath, readyPath, goPath] = process.argv.slice(1);
      const { loadOrCreateDashboardSecret } = await import(${JSON.stringify(authModuleUrl)});
      writeFileSync(readyPath, 'ready');
      while (!existsSync(goPath)) await new Promise(resolve => setTimeout(resolve, 5));
      process.stdout.write(loadOrCreateDashboardSecret(secretPath));
    `;
    const children = Array.from({ length: 8 }, (_, index) => {
      const readyPath = join(dir, `ready-${index}`);
      const child = spawn(process.execPath, [
        '--import', 'tsx', '--input-type=module', '-e', childSource,
        secretPath, readyPath, goPath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      return { child, readyPath, stdout: () => stdout, stderr: () => stderr };
    });

    try {
      const deadline = Date.now() + 10_000;
      while (!children.every(entry => existsSync(entry.readyPath))) {
        if (Date.now() >= deadline) throw new Error('repair children did not reach barrier');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      writeFileSync(goPath, 'go');
      const exits = await Promise.all(children.map(async entry => {
        const [code, signal] = await once(entry.child, 'close');
        return { code, signal, stdout: entry.stdout(), stderr: entry.stderr() };
      }));
      for (const result of exits) {
        expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      }
      const secrets = exits.map(result => result.stdout);
      expect(new Set(secrets).size).toBe(1);
      expect(secrets[0]).toBe(loadDashboardSecret(secretPath));
      expect(secrets[0]).toBe(loadDashboardSecret(`${secretPath}.repair-seed`));
      expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
  }, 20_000);
});

describe('parseCookie', () => {
  it('extracts botmux_dashboard_token value', () => {
    const v = parseCookie('foo=bar; botmux_dashboard_token=tk_abc; x=1');
    expect(v).toBe('tk_abc');
  });
  it('returns undefined when absent', () => {
    expect(parseCookie('foo=bar')).toBeUndefined();
  });
});

// ─── decideDashboardAuth ─────────────────────────────────────────────────────
//
// Locks the per-request public-vs-protected matrix added in canary.3
// (src/dashboard.ts public-read split for workflow run links from Lark
// approval cards).  If anyone narrows or widens the public surface by
// accident, these matrix tests fail and CI catches it.
// codex's HTTP integration smoke covers the same routes end-to-end; this
// pure-function layer is the cheap unit safety net.

describe('decideDashboardAuth — public surface', () => {
  const TOK = 'active-token-xyz';

  it('GET /api/workflows/* — allow without any token', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/api/workflows/run-123/snapshot',
      hasTokenParam: false,
      presentedToken: undefined,
      activeToken: TOK,
    });
    expect(d.kind).toBe('allow');
  });

  it('GET /api/workflows/runs/.../terminal-log/raw — NOT public (PTY bytes)', () => {
    // PTY transcript may have logged API keys / env / token reads that
    // happened to scroll the terminal — keep it behind cookie auth even
    // though sibling workflow read paths are link-shareable.
    const d = decideDashboardAuth({
      method: 'GET',
      pathname:
        '/api/workflows/runs/run-1/attempts/att-1/node-a/terminal-log/raw',
      hasTokenParam: false,
      presentedToken: undefined,
      activeToken: TOK,
    });
    expect(d.kind).toBe('deny401');
  });

  it('GET /api/workflows/...terminal-log/raw with valid cookie → allow', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname:
        '/api/workflows/runs/run-1/attempts/att-1/node-a/terminal-log/raw',
      hasTokenParam: false,
      presentedToken: TOK,
      activeToken: TOK,
    });
    expect(d.kind).toBe('allow');
  });

  it('GET / — static SPA shell allow without any token', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/',
      hasTokenParam: false,
      presentedToken: undefined,
      activeToken: TOK,
    });
    expect(d.kind).toBe('allow');
  });

  it('GET /assets/app.js — static asset allow without any token', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/assets/app.js',
      hasTokenParam: false,
      presentedToken: undefined,
      activeToken: TOK,
    });
    expect(d.kind).toBe('allow');
  });

  it('GET /favicon.ico — browser root favicon probe allow without any token', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/favicon.ico',
      hasTokenParam: false,
      presentedToken: undefined,
      activeToken: TOK,
    });
    expect(d.kind).toBe('allow');
  });

  it('HEAD /favicon.ico — browser favicon metadata probe allow without any token', () => {
    const d = decideDashboardAuth({
      method: 'HEAD',
      pathname: '/favicon.ico',
      hasTokenParam: false,
      presentedToken: undefined,
      activeToken: TOK,
    });
    expect(d.kind).toBe('allow');
  });

  it('DELETE /api/whiteboards/:id without token → deny401', () => {
    const d = decideDashboardAuth({
      method: 'DELETE',
      pathname: '/api/whiteboards/wb_test',
      hasTokenParam: false,
      presentedToken: undefined,
      activeToken: TOK,
      publicReadOnly: true,
    });
    expect(d.kind).toBe('deny401');
  });

  it('GET /game/index.html — HD2D office shell allow without any token', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/game/index.html',
      hasTokenParam: false,
      presentedToken: undefined,
      activeToken: TOK,
    });
    expect(d.kind).toBe('allow');
  });

  it('POST /api/game/download without token → deny401 (gated: triggers a ~74MB fetch)', () => {
    const d = decideDashboardAuth({
      method: 'POST',
      pathname: '/api/game/download',
      hasTokenParam: false,
      presentedToken: undefined,
      activeToken: TOK,
    });
    expect(d.kind).toBe('deny401');
  });
});

describe('decideDashboardAuth — protected surface', () => {
  const TOK = 'active-token-xyz';

  it('POST /api/workflows/<id>/cancel without token → deny401', () => {
    const d = decideDashboardAuth({
      method: 'POST',
      pathname: '/api/workflows/run-123/cancel',
      hasTokenParam: false,
      presentedToken: undefined,
      activeToken: TOK,
    });
    expect(d.kind).toBe('deny401');
  });

  it('GET /api/sessions without token → deny401 (non-workflow API)', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/api/sessions',
      hasTokenParam: false,
      presentedToken: undefined,
      activeToken: TOK,
    });
    expect(d.kind).toBe('deny401');
  });

  it('GET /api/schedules without token → deny401', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/api/schedules',
      hasTokenParam: false,
      presentedToken: undefined,
      activeToken: TOK,
    });
    expect(d.kind).toBe('deny401');
  });

  it('GET /api/v3 run list/detail without token → deny401', () => {
    for (const pathname of ['/api/v3/runs', '/api/v3/runs/project-review-1']) {
      const d = decideDashboardAuth({
        method: 'GET',
        pathname,
        hasTokenParam: false,
        presentedToken: undefined,
        activeToken: TOK,
      });
      expect(d.kind, pathname).toBe('deny401');
    }
  });

  it('POST / static-looking path is NOT public (only GET is)', () => {
    const d = decideDashboardAuth({
      method: 'POST',
      pathname: '/',
      hasTokenParam: false,
      presentedToken: undefined,
      activeToken: TOK,
    });
    expect(d.kind).toBe('deny401');
  });

  it('GET protected with valid cookie → allow', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/api/sessions',
      hasTokenParam: false,
      presentedToken: TOK,
      activeToken: TOK,
    });
    expect(d.kind).toBe('allow');
  });

  it('POST protected with valid cookie → allow', () => {
    const d = decideDashboardAuth({
      method: 'POST',
      pathname: '/api/workflows/run-123/cancel',
      hasTokenParam: false,
      presentedToken: TOK,
      activeToken: TOK,
    });
    expect(d.kind).toBe('allow');
  });

  it('GET protected with wrong token → deny401', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/api/sessions',
      hasTokenParam: false,
      presentedToken: 'wrong-token',
      activeToken: TOK,
    });
    expect(d.kind).toBe('deny401');
  });
});

describe('decideDashboardAuth — ?t=<token> cookie set redirect', () => {
  const TOK = 'active-token-xyz';

  it('?t=<correct> on / → set-cookie + redirect to /', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/',
      hasTokenParam: true,
      presentedToken: TOK,
      activeToken: TOK,
    });
    expect(d).toEqual({ kind: 'allow+set-cookie', token: TOK, redirectTo: '/' });
  });

  it('?t=<correct> on deep path → set-cookie + redirect preserves path', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/api/workflows/run-99/snapshot',
      hasTokenParam: true,
      presentedToken: TOK,
      activeToken: TOK,
    });
    expect(d).toEqual({
      kind: 'allow+set-cookie',
      token: TOK,
      redirectTo: '/api/workflows/run-99/snapshot',
    });
  });

  it('?t=<wrong> on protected route → deny401 (no cookie minted)', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/api/sessions',
      hasTokenParam: true,
      presentedToken: 'wrong-token',
      activeToken: TOK,
    });
    expect(d.kind).toBe('deny401');
  });

  it('?t=<wrong> on public route → allow but no set-cookie (no auth granted)', () => {
    // Public workflow GET works regardless of token, but the cookie must
    // NOT be minted to the wrong value — otherwise the cookie would override
    // a legit later cookie.
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/api/workflows/run-1/snapshot',
      hasTokenParam: true,
      presentedToken: 'wrong-token',
      activeToken: TOK,
    });
    expect(d.kind).toBe('allow');
  });

  it('?t=<correct> via cookie (no query) → plain allow, no redirect', () => {
    // Cookie path means the browser already has the token; don't bounce.
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/api/sessions',
      hasTokenParam: false,
      presentedToken: TOK,
      activeToken: TOK,
    });
    expect(d.kind).toBe('allow');
  });

  it('empty active token never authenticates (server has not created one yet)', () => {
    const d = decideDashboardAuth({
      method: 'POST',
      pathname: '/api/workflows/run-1/cancel',
      hasTokenParam: false,
      presentedToken: '',
      activeToken: '',
    });
    expect(d.kind).toBe('deny401');
  });
});

describe('decideDashboardAuth — publicReadOnly mode', () => {
  const TOK = 'tok-active';

  it('tokenless GET /api/sessions → allow (read-only visitor)', () => {
    const d = decideDashboardAuth({
      method: 'GET', pathname: '/api/sessions', hasTokenParam: false,
      presentedToken: undefined, activeToken: TOK, publicReadOnly: true,
    });
    expect(d.kind).toBe('allow');
  });

  it('tokenless GET /events (SSE) → allow', () => {
    const d = decideDashboardAuth({
      method: 'GET', pathname: '/events', hasTokenParam: false,
      presentedToken: undefined, activeToken: TOK, publicReadOnly: true,
    });
    expect(d.kind).toBe('allow');
  });

  it('tokenless POST (write) → still deny401', () => {
    const d = decideDashboardAuth({
      method: 'POST', pathname: '/api/sessions/sess-1/close', hasTokenParam: false,
      presentedToken: undefined, activeToken: TOK, publicReadOnly: true,
    });
    expect(d.kind).toBe('deny401');
  });

  it('tokenless GET raw PTY log → still deny401 (sensitive carve-out)', () => {
    const d = decideDashboardAuth({
      method: 'GET', pathname: '/api/workflows/run-1/nodes/n1/terminal-log/raw', hasTokenParam: false,
      presentedToken: undefined, activeToken: TOK, publicReadOnly: true,
    });
    expect(d.kind).toBe('deny401');
  });

  it('publicReadOnly off → tokenless GET /api/sessions denied (legacy behavior)', () => {
    const d = decideDashboardAuth({
      method: 'GET', pathname: '/api/sessions', hasTokenParam: false,
      presentedToken: undefined, activeToken: TOK, publicReadOnly: false,
    });
    expect(d.kind).toBe('deny401');
  });

  it('publicReadOnly off → tokenless dashboard summary stays private', () => {
    const d = decideDashboardAuth({
      method: 'GET', pathname: '/api/dashboard/v1/summary', hasTokenParam: false,
      presentedToken: undefined, activeToken: TOK, publicReadOnly: false,
    });
    expect(d.kind).toBe('deny401');
  });

  it('stale token GET behaves like tokenless read-only (no 401 wall)', () => {
    const d = decideDashboardAuth({
      method: 'GET', pathname: '/api/schedules', hasTokenParam: false,
      presentedToken: 'rotated-away', activeToken: TOK, publicReadOnly: true,
    });
    expect(d.kind).toBe('allow');
  });

  it('management/config reads stay behind the token even in publicReadOnly', () => {
    for (const pathname of [
      '/api/connectors',
      '/api/connectors/stats',
      '/api/webhook-secrets',
      '/api/trigger-logs',
      '/api/trigger-logs/summary',
      '/api/feedback/analytics/summary',
      '/api/feedback/analytics/trend',
      '/api/feedback/analytics/reasons',
      '/api/feedback/analytics/deliveries',
      '/api/bot-onboarding/ob-1',
      // Allow-list is fail-closed: these read endpoints are NOT public-readable
      // (role/persona content, per-bot oncall config, CLI option metadata).
      '/api/roles/cli_app/oc_chat',
      '/api/bots',
      '/api/skills',
      '/api/cli-options',
      // Workflow projections contain user-authored goals and identifiers.
      '/api/v3/runs',
      '/api/v3/runs/project-review-1',
      // Mints a token-bearing writable terminal URL — never public, even in
      // publicReadOnly (the daemon IPC behind it is also loopback-HMAC gated).
      '/api/sessions/sess-1/write-link',
      // Preview metadata and proxied app bytes require the management cookie;
      // public-read visitors may see neither, even though /api/sessions itself
      // is available through its redacted projection.
      '/api/sessions/sess-1/preview',
      '/api/sessions/sess-1/control',
      '/api/sessions/sess-1/preview-interaction',
      '/api/workbench/h5-context',
      '/preview/sess-1/',
      // A path that doesn't exist yet must also default to private.
      '/api/some-future-read',
    ]) {
      const d = decideDashboardAuth({
        method: 'GET', pathname, hasTokenParam: false,
        presentedToken: undefined, activeToken: TOK, publicReadOnly: true,
      });
      expect(d.kind, pathname).toBe('deny401');
    }
  });

  it('allow-listed watch-work reads are public in publicReadOnly', () => {
    for (const pathname of ['/api/dashboard/v1/summary', '/api/sessions', '/api/schedules', '/api/settings', '/api/groups', '/events']) {
      const d = decideDashboardAuth({
        method: 'GET', pathname, hasTokenParam: false,
        presentedToken: undefined, activeToken: TOK, publicReadOnly: true,
      });
      expect(d.kind, pathname).toBe('allow');
    }
  });

  it('token holder still reads management endpoints in publicReadOnly', () => {
    const d = decideDashboardAuth({
      method: 'GET', pathname: '/api/connectors', hasTokenParam: false,
      presentedToken: TOK, activeToken: TOK, publicReadOnly: true,
    });
    expect(d.kind).toBe('allow');
  });
});

describe('Workbench H5 capability boundary', () => {
  it('allows only session observation and explicitly scoped terminal/preview control', () => {
    expect(workbenchH5Capability('GET', '/api/sessions')).toBe('workbench.view');
    expect(workbenchH5Capability('GET', '/events')).toBe('workbench.view');
    expect(workbenchH5Capability('GET', '/api/workbench/h5-context')).toBe('workbench.view');
    expect(workbenchH5Capability('GET', '/api/sessions/s1/view-link')).toBe('terminal.view');
    expect(workbenchH5Capability('GET', '/api/sessions/s1/control')).toBe('terminal.view');
    expect(workbenchH5Capability('GET', '/api/sessions/s1/preview')).toBe('preview.view');
    expect(workbenchH5Capability('POST', '/api/sessions/s1/control/takeover')).toBe('terminal.operate');
    expect(workbenchH5Capability('POST', '/api/sessions/s1/preview-interaction/unlock')).toBe('preview.operate');
  });

  it('fails closed for every management mutation and sensitive read', () => {
    for (const [method, pathname] of [
      ['PUT', '/api/bots/app/env'],
      ['PUT', '/api/settings'],
      ['POST', '/api/schedules'],
      ['DELETE', '/api/skills/tool'],
      ['POST', '/api/sessions/s1/close'],
      ['GET', '/api/sessions/s1/write-link'],
      ['GET', '/api/bots'],
      ['GET', '/api/settings'],
      ['GET', '/api/some-future-route'],
    ] as const) {
      expect(workbenchH5Capability(method, pathname), `${method} ${pathname}`).toBeNull();
      expect(decideWorkbenchH5Auth({ method, pathname }).kind, `${method} ${pathname}`).toBe('deny401');
    }
  });

  it('retains the static Workbench shell without broadening APIs', () => {
    expect(decideWorkbenchH5Auth({ method: 'GET', pathname: '/' }).kind).toBe('allow');
    expect(decideWorkbenchH5Auth({ method: 'GET', pathname: '/assets/dashboard.js' }).kind).toBe('allow');
    expect(decideWorkbenchH5Auth({ method: 'GET', pathname: '/api/settings' }).kind).toBe('deny401');
  });
});
