/**
 * Grok Build ≥1.0.64 opens on "Do you trust the contents of this directory?"
 * in every untrusted folder while any user hook exists (Botmux installs its
 * own), so a Botmux-owned spawn must pre-write the trust store Grok reads:
 * `$GROK_HOME/trusted_folders.toml`, serialized by flock(2) on
 * `trusted_folders.toml.lock`.
 *
 * The lock tests use a real foreign flock(2) holder (`flock(1)`), i.e. the
 * same primitive Grok itself takes, and only ever stop processes this file
 * spawned (by handle).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureGrokFolderTrust, planGrokFolderTrust, resolveGrokTrustFolder, tomlBasicString,
} from '../src/services/grok-folder-trust.js';
import { createGrokAdapter } from '../src/adapters/cli/grok.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const children = new Set<ChildProcess>();
let root: string;
let grokHome: string;
let store: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'bmx-grok-trust-')));
  grokHome = join(root, 'grok-home');
  mkdirSync(grokHome);
  store = join(grokHome, 'trusted_folders.toml');
});

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  rmSync(root, { recursive: true, force: true });
});

function dir(...parts: string[]): string {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

/** The minimal git dir shape discovery accepts (what `git init` leaves). */
function gitDir(...parts: string[]): string {
  const path = dir(...parts);
  writeFileSync(join(path, 'HEAD'), 'ref: refs/heads/main\n');
  dir(...parts, 'objects');
  dir(...parts, 'refs');
  return path;
}

/** Hold flock(LOCK_EX) on `lockPath` from a separate process, as Grok does
 *  while it rewrites the store. Resolves once the lock is held. */
function holdForeignLock(lockPath: string): Promise<{ release: () => Promise<void> }> {
  const child = spawn('flock', ['-x', lockPath, 'sh', '-c', 'echo held; exec cat >/dev/null'], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  children.add(child);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      if (!chunk.includes('held')) return;
      resolve({
        release: () => new Promise(done => {
          child.once('exit', () => done());
          child.stdin!.end();
        }),
      });
    });
  });
}

/** Grok's critical section, timed by the waiter actually being there: a
 *  foreign process takes the lock, snapshots the store, waits until someone is
 *  QUEUED behind it in the kernel lock table (`/proc/locks`: `N: -> FLOCK …
 *  <dev>:<inode>`), then rewrites the store from its snapshot plus `addition`
 *  and lets go. It decides when to release on its own, so nothing here depends
 *  on this test process being scheduled in time. If nobody ever queues (the
 *  pre-trust did not wait for the lock) it gives up waiting after ~5s and
 *  rewrites anyway — clobbering whatever was written meanwhile, which is
 *  exactly what such a regression must look like. Resolves once it holds. */
function holdUntilQueuedThenRewrite(lockPath: string, storePath: string, addition: string): Promise<void> {
  const script = [
    'ino=$(stat -c %i "$1")',
    'cat "$2" > "$2.snapshot"',
    'echo held',
    'n=0',
    'while ! grep -Eq "^[0-9]+: -> FLOCK +ADVISORY +WRITE +[0-9]+ +[0-9a-f]+:[0-9a-f]+:$ino " /proc/locks; do',
    '  n=$((n + 1)); [ "$n" -ge 250 ] && break; sleep 0.02',
    'done',
    '{ cat "$2.snapshot"; printf "%s" "$3"; } > "$2.next" && mv -f "$2.next" "$2"',
  ].join('\n');
  const child = spawn('flock', ['-x', lockPath, 'sh', '-c', script, 'sh', lockPath, storePath, addition], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  children.add(child);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => { if (chunk.includes('held')) resolve(); });
  });
}

/** A foreign holder that lets go BY ITSELF after `seconds`. Resolves once it holds. */
function holdForeignLockFor(lockPath: string, seconds: number): Promise<void> {
  const child = spawn('flock', ['-x', lockPath, 'sh', '-c', `echo held; exec sleep ${seconds}`], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  children.add(child);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => { if (chunk.includes('held')) resolve(); });
  });
}

const GROK_WRITTEN = [
  '[folders."/root/iserver"]',
  'trusted = true',
  'decided_at = 1789661312',
  '',
  '[folders."/root/iserver/astergate"]',
  'trusted = true',
  'decided_at = 1791781584',
  '',
].join('\n');

describe('resolveGrokTrustFolder — the key Grok actually consults', () => {
  it('uses the launch directory itself outside git (parents are not inherited)', () => {
    const work = dir('plain', 'proj');
    expect(resolveGrokTrustFolder(work)).toBe(work);
  });

  it('records the realpath of a symlinked working directory', () => {
    const target = dir('real', 'p6');
    const link = join(root, 'link6');
    symlinkSync(target, link);
    expect(resolveGrokTrustFolder(link)).toBe(target);
  });

  it('uses the repository root for a subdirectory of a git checkout', () => {
    const repo = dir('repo');
    gitDir('repo', '.git');
    expect(resolveGrokTrustFolder(dir('repo', 'packages', 'app'))).toBe(repo);
  });

  it('does not treat an empty .git directory as a repository', () => {
    // Real Grok 1.0.70 asked about the launch dir here, not the parent.
    dir('not-a-repo', '.git');
    const work = dir('not-a-repo', 'pkg');
    expect(resolveGrokTrustFolder(work)).toBe(work);
  });

  it("uses the MAIN checkout's root for a linked worktree (.git file → gitdir → commondir)", () => {
    const main = dir('main');
    gitDir('main', '.git');
    const wtGitDir = dir('main', '.git', 'worktrees', 'wt3');
    writeFileSync(join(wtGitDir, 'HEAD'), 'ref: refs/heads/wt3\n');
    writeFileSync(join(wtGitDir, 'commondir'), '../..\n');
    const worktree = dir('wt3');
    writeFileSync(join(worktree, '.git'), `gitdir: ${wtGitDir}\n`);
    expect(resolveGrokTrustFolder(dir('wt3', 'deep'))).toBe(main);
  });

  it('keeps a .git-file checkout without commondir (submodule) at its own root', () => {
    gitDir('super', '.git', 'modules', 'lib');
    const sub = dir('super', 'vendor', 'lib');
    writeFileSync(join(sub, '.git'), 'gitdir: ../../.git/modules/lib\n');
    expect(resolveGrokTrustFolder(sub)).toBe(sub);
  });
});

describe('planGrokFolderTrust — append-only, never rewrite', () => {
  it('appends a Grok-shaped entry and keeps every existing byte, comments included', () => {
    const existing = `# hand-written note\n${GROK_WRITTEN}`;
    const plan = planGrokFolderTrust(existing, '/root/ec-apply-access', 1792809756);
    expect(plan.kind).toBe('append');
    if (plan.kind !== 'append') return;
    expect(plan.text.startsWith(existing)).toBe(true);
    // Blank line between tables, as Grok itself writes them.
    expect(plan.text.slice(existing.length)).toBe(
      '\n[folders."/root/ec-apply-access"]\ntrusted = true\ndecided_at = 1792809756\n',
    );
  });

  it('separates the new table from a file that lacks a trailing newline', () => {
    const plan = planGrokFolderTrust('[folders."/a"]\ntrusted = true', '/b', 1);
    expect(plan).toEqual({ kind: 'append', text: '[folders."/a"]\ntrusted = true\n\n[folders."/b"]\ntrusted = true\ndecided_at = 1\n' });
  });

  it('recognizes an existing entry in basic, escaped and literal key spellings', () => {
    expect(planGrokFolderTrust(GROK_WRITTEN, '/root/iserver/astergate', 1)).toEqual({ kind: 'already-trusted' });
    const odd = '/tmp/we"ird\\path';
    expect(planGrokFolderTrust(`[folders.${tomlBasicString(odd)}]\ntrusted = true\n`, odd, 1)).toEqual({ kind: 'already-trusted' });
    expect(planGrokFolderTrust("[ folders . '/lit' ]  # note\ntrusted=true\n", '/lit', 1)).toEqual({ kind: 'already-trusted' });
  });

  it('reports an explicit trusted = false instead of overriding it', () => {
    const text = `${GROK_WRITTEN}[folders."/root/secret"]\ntrusted = false\ndecided_at = 1792810000\n`;
    expect(planGrokFolderTrust(text, '/root/secret', 1)).toEqual({ kind: 'explicitly-untrusted' });
  });

  it('refuses shapes it cannot fully read rather than risk a duplicate table', () => {
    expect(planGrokFolderTrust('folders = { "/x" = { trusted = true } }\n', '/y', 1).kind).toBe('unrecognized');
    expect(planGrokFolderTrust('[folders]\n"/x".trusted = true\n', '/y', 1).kind).toBe('unrecognized');
    expect(planGrokFolderTrust('[folders."/x"]\ndecided_at = 1\n', '/x', 1).kind).toBe('unrecognized');
    expect(planGrokFolderTrust('[[folders]]\npath = "/x"\n', '/y', 1).kind).toBe('unrecognized');
  });
});

describe('ensureGrokFolderTrust', () => {
  it('writes a new folder with Grok\'s 0600 mode and leaves existing entries byte-identical', async () => {
    const work = dir('ec-apply-access');
    writeFileSync(store, GROK_WRITTEN, { mode: 0o600 });
    const outcome = await ensureGrokFolderTrust(work, { grokHome, nowMs: () => 1792809756_000 });
    expect(outcome).toEqual({ status: 'trusted', folder: work, storePath: store });
    const text = readFileSync(store, 'utf-8');
    expect(text).toBe(`${GROK_WRITTEN}\n[folders."${work}"]\ntrusted = true\ndecided_at = 1792809756\n`);
    expect(statSync(store).mode & 0o777).toBe(0o600);
    // Idempotent: a second spawn finds it and writes nothing.
    await expect(ensureGrokFolderTrust(work, { grokHome })).resolves.toMatchObject({ status: 'already-trusted' });
    expect(readFileSync(store, 'utf-8')).toBe(text);
  });

  it('creates the store when Grok has a home but no trust file yet', async () => {
    const work = dir('fresh');
    await expect(ensureGrokFolderTrust(work, { grokHome, nowMs: () => 5_000 })).resolves.toMatchObject({ status: 'trusted' });
    expect(readFileSync(store, 'utf-8')).toBe(`[folders."${work}"]\ntrusted = true\ndecided_at = 5\n`);
    expect(statSync(store).mode & 0o777).toBe(0o600);
  });

  it('never rewrites a folder the user set to trusted = false', async () => {
    const work = dir('denied');
    const text = `${GROK_WRITTEN}[folders."${work}"]\ntrusted = false\ndecided_at = 1792810000\n`;
    writeFileSync(store, text, { mode: 0o640 });
    const before = statSync(store).mtimeMs;
    await expect(ensureGrokFolderTrust(work, { grokHome })).resolves.toEqual({
      status: 'explicitly-untrusted', folder: work, storePath: store,
    });
    expect(readFileSync(store, 'utf-8')).toBe(text);
    expect(statSync(store).mtimeMs).toBe(before);
  });

  it('trusts the repository root Grok asks about, not the subdirectory', async () => {
    const repo = dir('repo2');
    gitDir('repo2', '.git');
    await ensureGrokFolderTrust(dir('repo2', 'sub'), { grokHome, nowMs: () => 1_000 });
    expect(readFileSync(store, 'utf-8')).toBe(`[folders."${repo}"]\ntrusted = true\ndecided_at = 1\n`);
  });

  it('does not create a Grok home that does not exist, nor trust $HOME or /', async () => {
    const work = dir('w');
    const missingHome = join(root, 'no-grok-home');
    await expect(ensureGrokFolderTrust(work, { grokHome: missingHome })).resolves.toMatchObject({ status: 'skipped' });
    await expect(ensureGrokFolderTrust(work, { grokHome, homeDir: work })).resolves.toMatchObject({ status: 'not-needed' });
    await expect(ensureGrokFolderTrust('/', { grokHome })).resolves.toMatchObject({ status: 'not-needed' });
    expect(() => readFileSync(store)).toThrow();
  });

  it('waits for a foreign flock holder and merges with what it wrote meanwhile', async () => {
    const work = dir('mine');
    writeFileSync(store, GROK_WRITTEN, { mode: 0o600 });
    const theirs = '[folders."/root/theirs"]\ntrusted = true\ndecided_at = 6\n';
    await holdUntilQueuedThenRewrite(`${store}.lock`, store, theirs);

    // Default lock timeout: the holder lets go as soon as this call queues.
    await expect(ensureGrokFolderTrust(work, { grokHome, nowMs: () => 7_000 }))
      .resolves.toMatchObject({ status: 'trusted' });
    const text = readFileSync(store, 'utf-8');
    expect(text.startsWith(GROK_WRITTEN)).toBe(true);
    expect(text, 'the holder\'s write was lost').toContain('[folders."/root/theirs"]');
    expect(text, 'written while the holder held the lock, then clobbered').toContain(`[folders."${work}"]`);
  });

  it('does not turn a lock the helper already took into a timeout when this process stalls', async () => {
    // A timer that expires while this process is not scheduled runs, on
    // resume, before the helper's "locked" line already waiting in the pipe
    // (Node's timers phase precedes I/O). Reproduce that stall deterministically.
    const work = dir('stalled');
    writeFileSync(store, GROK_WRITTEN);
    await holdForeignLockFor(`${store}.lock`, 0.2);
    const pending = ensureGrokFolderTrust(work, { grokHome, lockTimeoutMs: 2_000 });
    // The helper queues, takes the lock once the holder leaves (~0.2s) and
    // reports it — all while this event loop is blocked for longer than the
    // lock timeout plus the old 2s parent-side guard.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4_500);
    await expect(pending).resolves.toMatchObject({ status: 'trusted', folder: work });
    expect(readFileSync(store, 'utf-8')).toContain(`[folders."${work}"]`);
  });

  it('gives up without writing when the lock stays held past its timeout', async () => {
    const work = dir('late');
    writeFileSync(store, GROK_WRITTEN);
    const holder = await holdForeignLock(`${store}.lock`);
    const outcome = await ensureGrokFolderTrust(work, { grokHome, lockTimeoutMs: 300 });
    expect(outcome).toMatchObject({ status: 'skipped', folder: work });
    expect(outcome.reason).toMatch(/held by another process/);
    expect(readFileSync(store, 'utf-8')).toBe(GROK_WRITTEN);
    await holder.release();
  });

  it('falls back to perl where flock(1) is missing and still queues behind a flock(2) holder', async () => {
    const bin = dir('perl-only-bin');
    symlinkSync('/usr/bin/perl', join(bin, 'perl'));
    const work = dir('via-perl');
    writeFileSync(store, GROK_WRITTEN);
    const theirs = '[folders."/root/theirs"]\ntrusted = true\ndecided_at = 6\n';
    await holdUntilQueuedThenRewrite(`${store}.lock`, store, theirs);
    const savedPath = process.env.PATH;
    process.env.PATH = bin;
    let outcome: Awaited<ReturnType<typeof ensureGrokFolderTrust>>;
    try {
      outcome = await ensureGrokFolderTrust(work, { grokHome });
    } finally {
      process.env.PATH = savedPath;
    }
    expect(outcome).toMatchObject({ status: 'trusted' });
    const text = readFileSync(store, 'utf-8');
    expect(text).toContain('[folders."/root/theirs"]');
    expect(text).toContain(`[folders."${work}"]`);
  });

  it('loses no entry when several processes pre-trust different folders at once', async () => {
    writeFileSync(store, GROK_WRITTEN, { mode: 0o600 });
    const folders = ['a', 'b', 'c', 'd', 'e', 'f'].map(name => dir('many', name));
    const results = await Promise.all(folders.map(folder => new Promise<string>((resolve, reject) => {
      const child = spawnTsEvalWithRepoImports(
        `import { ensureGrokFolderTrust } from './src/services/grok-folder-trust.js';
         const outcome = await ensureGrokFolderTrust(${JSON.stringify(folder)}, { grokHome: ${JSON.stringify(grokHome)} });
         process.stdout.write(outcome.status);`,
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
      );
      children.add(child);
      let out = '';
      let err = '';
      child.stdout!.on('data', chunk => { out += chunk; });
      child.stderr!.on('data', chunk => { err += chunk; });
      child.on('exit', code => (code === 0 ? resolve(out) : reject(new Error(`child exited ${code}: ${err}`))));
    })));
    expect(results).toEqual(folders.map(() => 'trusted'));
    const text = readFileSync(store, 'utf-8');
    expect(text.startsWith(GROK_WRITTEN)).toBe(true);
    for (const folder of folders) expect(text.split(`[folders."${folder}"]`).length).toBe(2);
  }, 60_000);
});

describe('Grok adapter wiring', () => {
  it('exposes the pre-trust hook the worker calls before an owned spawn', async () => {
    const adapter = createGrokAdapter();
    const work = dir('via-adapter');
    const saved = process.env.GROK_HOME;
    process.env.GROK_HOME = grokHome;
    try {
      await expect(adapter.ensureWorkspaceTrust?.(work)).resolves.toMatchObject({ status: 'trusted', folder: work });
    } finally {
      if (saved === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = saved;
    }
    expect(readFileSync(store, 'utf-8')).toContain(`[folders."${work}"]`);
  });
});
