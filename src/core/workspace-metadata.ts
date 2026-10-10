/** Host-owned workspace identity. Never resolve a remote backend's path here. */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { resolveBotmuxConfigDir } from './config-dir.js';

export interface WorkspaceMetadata {
  sourceId: string;
  kind: 'git' | 'directory' | 'unknown';
  rootPath?: string;
  displayName?: string;
  branch?: string;
  state: 'resolved' | 'missing' | 'error' | 'unsupported';
}

let sourceId: string | undefined;
export function workspaceSourceId(): string {
  if (sourceId) return sourceId;
  const dir = resolveBotmuxConfigDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'workspace-source-id');
  try { writeFileSync(file, randomUUID(), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  let namespace = '';
  try { namespace = readlinkSync('/proc/self/ns/mnt'); } catch { /* macOS */ }
  // Deployment UUID + host + mount namespace: shared by local bots, isolated
  // across containers even when their config directory is bind-mounted.
  sourceId = createHash('sha256').update(JSON.stringify([
    readFileSync(file, 'utf8').trim(), hostname(), namespace,
  ])).digest('hex');
  return sourceId;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, LC_ALL: 'C' } as NodeJS.ProcessEnv;
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    execFile('git', ['-C', cwd, ...args], { env, timeout: 1500, maxBuffer: 65536 },
      (error, stdout, stderr) => error
        ? reject(Object.assign(error, { stderr }))
        : resolve(stdout.replace(/\r?\n$/, '')));
  });
}

export function createWorkspaceResolver(source: () => string = workspaceSourceId) {
  const cache = new Map<string, { at: number; value: WorkspaceMetadata }>();
  const inflight = new Map<string, Promise<WorkspaceMetadata>>();
  let running = 0;
  const queue: Array<() => void> = [];
  async function probe(cwd: string): Promise<WorkspaceMetadata> {
    if (running >= 8) await new Promise<void>(resolve => queue.push(resolve));
    else running++;
    try {
      const base = { sourceId: source() };
      let canonical: string;
      try {
        canonical = await realpath(cwd);
        if (!(await stat(canonical)).isDirectory()) throw Object.assign(new Error(), { code: 'ENOENT' });
      } catch (error) {
        return { ...base, kind: 'directory', rootPath: cwd, displayName: basename(cwd),
          state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'error' };
      }
      let root: string;
      try { root = await realpath(await git(canonical, ['rev-parse', '--show-toplevel'])); }
      catch (error) {
        const failure = error as { stderr?: string; message?: string };
        const notRepo = `${failure.stderr ?? ''}\n${failure.message ?? ''}`.includes('not a git repository');
        return { ...base, kind: 'directory', rootPath: canonical, displayName: basename(canonical), state: notRepo ? 'resolved' : 'error' };
      }
      let branch: string | undefined;
      try { branch = await git(canonical, ['symbolic-ref', '--short', 'HEAD']); } catch { /* detached HEAD */ }
      return { ...base, kind: 'git', rootPath: root, displayName: basename(root), branch, state: 'resolved' };
    } finally {
      const next = queue.shift();
      if (next) next(); else running--;
    }
  }
  return async (cwd: string, backendType?: string, force = false): Promise<WorkspaceMetadata> => {
    // Unknown/remote execution environments must not be interpreted on this host.
    if (!['pty', 'tmux', 'herdr', 'zellij', 'zmx'].includes(backendType ?? '') || !isAbsolute(cwd)) {
      return { sourceId: source(), kind: 'unknown', state: 'unsupported' };
    }
    // Preserve symlink/.. semantics until realpath runs on the owning host.
    const key = cwd;
    const pending = inflight.get(key);
    if (pending) return pending;
    const hit = cache.get(key);
    const age = hit ? Date.now() - hit.at : Infinity;
    // A short force debounce also deduplicates simultaneous turn boundaries.
    if (hit && age < (force ? 1000 : hit.value.state === 'resolved' ? 60_000 : 300_000)) return hit.value;
    const promise = probe(key).then(value => {
      cache.delete(key);
      cache.set(key, { at: Date.now(), value });
      if (cache.size > 2048) cache.delete(cache.keys().next().value!);
      return value;
    }).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  };
}
export const resolveWorkspace = createWorkspaceResolver();
