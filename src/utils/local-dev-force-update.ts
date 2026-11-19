import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { redactChildEnv } from './child-env.js';
import { isBotmuxCheckout } from './local-dev-update.js';

const exec = promisify(execFile);
async function git(dir: string, args: string[]): Promise<string> {
  const result = await exec('git', args, {
    cwd: dir, encoding: 'utf8', env: redactChildEnv(process.env),
    timeout: 90_000, maxBuffer: 32 * 1024 * 1024,
  });
  return result.stdout;
}
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }

async function assertNoGitOperation(dir: string): Promise<void> {
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    const path = (await git(dir, ['rev-parse', '--git-path', name])).trim();
    try { await lstat(isAbsolute(path) ? path : join(dir, path)); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    fail('local_update_operation_in_progress');
  }
}

async function assertNoLinkedDeps(dir: string): Promise<void> {
  let stat;
  try { stat = await lstat(join(dir, 'node_modules')); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (!stat.isSymbolicLink()) return;
  // Only ignored, untracked node_modules links are invisible to the snapshot
  // and stash. Tracked links and non-ignored links follow normal Git backup.
  try { await git(dir, ['check-ignore', '--quiet', '--', 'node_modules']); } catch (e) {
    if ((e as { code?: unknown }).code === 1) return;
    throw e;
  }
  // Install may rewrite another checkout's dependencies, which Git backups
  // cannot restore. Conservatively reject even when its lockfile might match;
  // lstat also catches dangling/self links without resolving their targets.
  fail('local_update_shared_deps');
}

interface Snapshot {
  head: string;
  branch: string;
  fingerprint: string;
  cleanFingerprint: string;
  status: string;
}
async function snapshot(dir: string): Promise<Snapshot> {
  const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const status = await git(dir, ['status', '--porcelain']);
  const hash = createHash('sha256').update(head).update(branch).update(status);
  hash.update(await git(dir, ['diff', '--binary', 'HEAD']));
  hash.update(await git(dir, ['diff', '--cached', '--binary']));
  const configuration = await git(dir, ['config', '--local', '--list']);
  hash.update(configuration);
  const cleanFingerprint = createHash('sha256').update(head).update(branch).update(configuration).digest('hex');
  const paths = (await git(dir, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).sort();
  for (const path of paths) {
    const file = join(dir, path);
    const stat = await lstat(file);
    if (stat.isDirectory()) fail('local_update_untracked_directory');
    hash.update(path).update(String(stat.mode));
    hash.update(stat.isSymbolicLink() ? await readlink(file) : await readFile(file));
  }
  return { head, branch, status, fingerprint: hash.digest('hex'), cleanFingerprint };
}

export interface LocalDevForcePreview {
  token: string;
  dir: string;
  target: string;
  targetHead: string;
  status: string;
  localCommits: string;
}
interface Plan extends LocalDevForcePreview {
  state: Snapshot;
  remote: string;
  branch: string;
  expiresAt: number;
}

async function assertIgnoredFilesPreserved(dir: string, targetHead: string): Promise<void> {
  const ignored = (await git(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const tracked = (await git(dir, ['ls-tree', '-r', '--name-only', '-z', targetHead])).split('\0').filter(Boolean);
  const localPaths = new Set(ignored);
  const localParents = new Set<string>();
  for (const path of ignored) {
    const parts = path.split('/');
    while (parts.length > 1) { parts.pop(); localParents.add(parts.join('/')); }
  }
  for (const path of tracked) {
    if (localPaths.has(path) || localParents.has(path)) fail('local_update_ignored_collision');
    const parts = path.split('/');
    while (parts.length > 1) { parts.pop(); if (localPaths.has(parts.join('/'))) fail('local_update_ignored_collision'); }
  }
}

/** Owner confirmation is single-use and pins both local content and fetched upstream. */
export class LocalDevForceUpdates {
  private plans = new Map<string, Plan>();
  constructor(private now: () => number = Date.now) {}

  async preview(checkout: string): Promise<LocalDevForcePreview> {
    const dir = await realpath(checkout);
    if (!isBotmuxCheckout(dir)) fail('not_a_worktree');
    const state = await snapshot(dir);
    // An unresolved merge/rebase is a separate operation; do not erase it.
    await assertNoGitOperation(dir);
    await assertNoLinkedDeps(dir);
    let remote = 'origin';
    let branch = '';
    if (state.branch !== 'HEAD') {
      remote = (await git(dir, ['config', '--get', `branch.${state.branch}.remote`]).catch(() => '')).trim() || 'origin';
      branch = (await git(dir, ['config', '--get', `branch.${state.branch}.merge`]).catch(() => '')).trim().replace(/^refs\/heads\//, '');
    }
    if (!branch) {
      const refs = await git(dir, ['ls-remote', '--symref', remote, 'HEAD']);
      branch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(refs)?.[1] ?? '';
    }
    if (!branch || remote === '.' || remote.startsWith('-')) fail('local_update_no_upstream');
    const target = `refs/remotes/${remote}/${branch}`;
    await git(dir, ['fetch', '--', remote, `+refs/heads/${branch}:${target}`]);
    const targetHead = (await git(dir, ['rev-parse', `${target}^{commit}`])).trim();
    const pkg = JSON.parse(await git(dir, ['show', `${targetHead}:package.json`])) as { name?: string };
    if (pkg.name !== 'botmux') fail('local_update_no_upstream');
    // Do not let reset overwrite ignored local content that became tracked upstream.
    await assertIgnoredFilesPreserved(dir, targetHead);
    if ((await snapshot(dir)).fingerprint !== state.fingerprint) fail('local_update_preview_stale');
    const localCommits = (await git(dir, ['log', '--format=%h %s', `${targetHead}..HEAD`])).trim();
    const plan: Plan = { token: randomUUID(), dir, target, targetHead, status: state.status.trim(), localCommits,
      state, remote, branch, expiresAt: this.now() + 5 * 60_000 };
    while (this.plans.size >= 8) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(plan.token, plan);
    return { token: plan.token, dir, target, targetHead, status: plan.status, localCommits };
  }

  /** Caller holds the same install lock as normal updates and restart checks. */
  async apply(checkout: string, token: string): Promise<{ backupRef: string }> {
    const plan = this.plans.get(token);
    this.plans.delete(token);
    if (!plan || plan.expiresAt < this.now() || await realpath(checkout) !== plan.dir) fail('local_update_preview_stale');
    if ((await snapshot(plan.dir)).fingerprint !== plan.state.fingerprint) fail('local_update_preview_stale');
    await git(plan.dir, ['fetch', '--', plan.remote, `+refs/heads/${plan.branch}:${plan.target}`]);
    if ((await git(plan.dir, ['rev-parse', `${plan.target}^{commit}`])).trim() !== plan.targetHead
      || (await snapshot(plan.dir)).fingerprint !== plan.state.fingerprint) fail('local_update_preview_stale');
    if (plan.expiresAt < this.now()) fail('local_update_preview_stale');
    await assertIgnoredFilesPreserved(plan.dir, plan.targetHead);
    await assertNoGitOperation(plan.dir);
    await assertNoLinkedDeps(plan.dir);
    const backupRef = `refs/botmux/update-backups/${randomUUID()}`;
    // Commit history is recoverable even with a clean worktree or detached HEAD.
    await git(plan.dir, ['update-ref', `${backupRef}/head`, plan.state.head]);
    try {
      if (plan.state.status.trim()) {
        await git(plan.dir, ['-c', 'user.name=Botmux Update Backup', '-c', 'user.email=botmux@localhost',
          'stash', 'push', '--include-untracked', '-m', backupRef]);
        const stash = (await git(plan.dir, ['rev-parse', 'refs/stash'])).trim();
        try {
          await git(plan.dir, ['update-ref', `${backupRef}/worktree`, stash]);
        } catch (e) {
          // stash push has already removed the files. Restore only a still-clean
          // checkout; retain the exact stash OID if restoration is interrupted.
          const error = Object.assign(e instanceof Error ? e : new Error(String(e)), { backupStash: stash });
          try {
            if ((await git(plan.dir, ['rev-parse', 'HEAD'])).trim() === plan.state.head
              && !(await git(plan.dir, ['status', '--porcelain'])).trim()) {
              await git(plan.dir, ['stash', 'apply', '--index', stash]);
            }
          } catch { /* Exact durable stash remains available for manual recovery. */ }
          throw error;
        }
        // Nested untracked repos cannot be stashed; stop before reset instead of cleaning them.
        if ((await git(plan.dir, ['status', '--porcelain'])).trim()) fail('local_update_backup_incomplete');
      }
      await assertNoGitOperation(plan.dir);
      await assertIgnoredFilesPreserved(plan.dir, plan.targetHead);
      await assertNoLinkedDeps(plan.dir);
      // Creating backup refs/stashing yields to other processes. Require the
      // original HEAD/config and exactly the expected clean index/worktree
      // immediately before reset, including plans that initially had no edits.
      const expected = plan.state.status.trim() ? plan.state.cleanFingerprint : plan.state.fingerprint;
      if ((await snapshot(plan.dir)).fingerprint !== expected) fail('local_update_preview_stale');
      await git(plan.dir, ['reset', '--hard', plan.targetHead]);
      if (plan.state.branch === 'HEAD') {
        await git(plan.dir, ['checkout', '-b', `botmux-update-${randomUUID()}`]);
      }
      await git(plan.dir, ['branch', `--set-upstream-to=${plan.target.replace(/^refs\/remotes\//, '')}`]);
      return { backupRef };
    } catch (e) {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { backupRef });
    }
  }
}
