import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock, withFileLockSync } from '../utils/file-lock.js';
import { loadSkillPackage } from '../core/skills/package.js';
import { skillRegistryPath, skillSourcesDir, skillStoreDir } from '../core/skills/registry-paths.js';
import type { SkillPackage, SkillSource } from '../core/skills/types.js';
import { assertAllowedGitProtocol, assertNoGitUrlCredentials, assertSafeGitRef, assertSafeGitSkillPath, githubToGitUrl, redactGitUrlCredentials } from '../core/skills/sources.js';

const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const execFileAsync = promisify(execFile);
const gitSourceLocks = new Map<string, Promise<void>>();

export interface SkillRegistryFile {
  schemaVersion: 1;
  skills: Record<string, SkillPackage>;
}

export function readSkillRegistry(): SkillRegistryFile {
  const file = skillRegistryPath();
  if (!existsSync(file)) return { schemaVersion: 1, skills: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    return {
      schemaVersion: 1,
      skills: parsed?.skills && typeof parsed.skills === 'object' ? parsed.skills : {},
    };
  } catch {
    return { schemaVersion: 1, skills: {} };
  }
}

function writeSkillRegistry(registry: SkillRegistryFile): void {
  mkdirSync(dirname(skillRegistryPath()), { recursive: true });
  atomicWriteFileSync(skillRegistryPath(), JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 });
}

export function installLocalSkill(dir: string, opts: { link: boolean }): SkillPackage {
  const sourceDir = resolve(dir);
  const provisional = loadSkillPackage(sourceDir, {
    source: opts.link ? { type: 'local-link', path: sourceDir } : { type: 'local-copy', originalPath: sourceDir },
  });
  const rootDir = opts.link ? sourceDir : join(skillStoreDir(), provisional.name);
  if (!opts.link) {
    assertNoCopyOverlap(sourceDir, rootDir);
    rmSync(rootDir, { recursive: true, force: true });
    mkdirSync(dirname(rootDir), { recursive: true });
    cpSync(sourceDir, rootDir, { recursive: true });
  }
  const pkg = loadSkillPackage(rootDir, {
    source: opts.link ? { type: 'local-link', path: sourceDir } : { type: 'local-copy', originalPath: sourceDir },
    id: provisional.id,
  });
  const now = new Date().toISOString();
  const registry = readSkillRegistry();
  registry.skills[pkg.name] = { ...pkg, installedAt: now, updatedAt: now };
  writeSkillRegistry(registry);
  return registry.skills[pkg.name];
}

export function installLocalSkillLinks(dirs: readonly string[]): SkillPackage[] {
  const uniqueDirs = [...new Set(dirs.map((dir) => resolve(dir)))];
  // Collapse by skill NAME (last-wins), not just by path: the registry is
  // keyed by name, and the discovery dialog can surface the same skill name
  // under multiple CLI roots (e.g. botmux's own builtin skills are installed
  // into every CLI's skillsDir). Without this, two distinct dirs with the same
  // name would write twice and the returned array would carry a duplicate.
  const byName = new Map<string, SkillPackage>();
  for (const sourceDir of uniqueDirs) {
    let pkg: SkillPackage;
    try {
      // id defaults to name for a local-link (rootDir === sourceDir), so a
      // single load is sufficient — no provisional re-load needed.
      pkg = loadSkillPackage(sourceDir, { source: { type: 'local-link', path: sourceDir } });
    } catch (err: any) {
      // Name the offending dir so an opaque missing_skill_md/invalid_skill_name
      // (e.g. a SKILL.md removed between discovery and registration) is actionable.
      throw new Error(`local_link_failed:${sourceDir}:${err?.message ?? String(err)}`);
    }
    byName.set(pkg.name, pkg);
  }
  const now = new Date().toISOString();
  const registry = readSkillRegistry();
  const installed: SkillPackage[] = [];
  for (const pkg of byName.values()) {
    registry.skills[pkg.name] = { ...pkg, installedAt: now, updatedAt: now };
    installed.push(registry.skills[pkg.name]);
  }
  writeSkillRegistry(registry);
  return installed;
}

function sourceId(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

function gitSourceLockTarget(url: string): string {
  mkdirSync(skillSourcesDir(), { recursive: true });
  return join(skillSourcesDir(), sourceId(url));
}

function gitLockWaitMs(): number {
  return Math.max(gitTimeoutMs() * 5, 60_000);
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function isSameOrChild(path: string, maybeParent: string): boolean {
  return path === maybeParent || path.startsWith(maybeParent + '/');
}

function assertNoCopyOverlap(sourceDir: string, targetDir: string): void {
  const source = canonicalPath(sourceDir);
  const target = canonicalPath(targetDir);
  if (isSameOrChild(source, target) || isSameOrChild(target, source)) {
    throw new Error('local_skill_source_overlaps_store_target');
  }
}

function assertPathWithin(parentDir: string, targetDir: string, error: string): void {
  const parent = realpathSync(parentDir);
  const target = realpathSync(targetDir);
  if (target === parent) return;
  const rel = relative(parent, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(error);
}

function gitSkillDir(sourceDir: string, path: string): string {
  assertSafeGitSkillPath(path);
  const skillDir = resolve(sourceDir, path);
  assertPathWithin(sourceDir, skillDir, 'git_skill_path_outside_repo');
  return skillDir;
}

async function withGitSourceLock<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const key = sourceId(url);
  const previous = gitSourceLocks.get(key) ?? Promise.resolve();
  const waitForPrevious = previous.catch(() => undefined);
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = waitForPrevious.then(() => current);
  gitSourceLocks.set(key, tail);
  await waitForPrevious;
  try {
    return await withFileLock(gitSourceLockTarget(url), fn, { maxWaitMs: gitLockWaitMs() });
  } finally {
    release();
    if (gitSourceLocks.get(key) === tail) gitSourceLocks.delete(key);
  }
}

function withGitSourceLockSync<T>(url: string, fn: () => T): T {
  return withFileLockSync(gitSourceLockTarget(url), fn, { maxWaitMs: gitLockWaitMs() });
}

function gitTimeoutMs(): number {
  const raw = Number(process.env.BOTMUX_SKILL_GIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GIT_TIMEOUT_MS;
}

function redactGitArg(arg: string): string {
  return redactGitUrlCredentials(arg);
}

function formatGitCommand(args: string[]): string {
  return `git ${args.map(redactGitArg).join(' ')}`;
}

function isGitNotFoundError(err: any): boolean {
  return err?.code === 'ENOENT';
}

function formatGitFailure(args: string[], err: any): Error {
  if (isGitNotFoundError(err)) return new Error('git_not_found');
  const stderr = Buffer.isBuffer(err?.stderr) ? err.stderr.toString('utf-8').trim() : String(err?.stderr ?? '').trim();
  const reason = [
    stderr ? redactGitUrlCredentials(stderr) : '',
    err?.signal ? `signal ${err.signal}` : '',
    err?.status !== undefined ? `status ${err.status}` : '',
    err?.code ? `code ${err.code}` : '',
  ].filter(Boolean).join('; ') || (err?.message ? redactGitUrlCredentials(err.message) : String(err));
  return new Error(`skill_git_command_failed: ${formatGitCommand(args)}: ${reason}`);
}

// Defense-in-depth alongside assertAllowedGitProtocol: even if a dangerous
// transport ever reached this layer, git itself refuses anything outside the
// allowlist. GIT_TERMINAL_PROMPT=0 also keeps a private repo from hanging on an
// interactive credential prompt instead of failing fast.
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_ALLOW_PROTOCOL: 'https:http:ssh:git:file',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function git(args: string[], cwd?: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: gitTimeoutMs(),
      env: gitEnv(),
    }).trim();
  } catch (err: any) {
    throw formatGitFailure(args, err);
  }
}

async function gitAsync(args: string[], cwd?: string): Promise<string> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: gitTimeoutMs(),
      env: gitEnv(),
    });
    return String(result.stdout ?? '').trim();
  } catch (err: any) {
    throw formatGitFailure(args, err);
  }
}

function ensureGitSource(url: string): string {
  assertNoGitUrlCredentials(url);
  assertAllowedGitProtocol(url);
  const dir = join(skillSourcesDir(), sourceId(url));
  mkdirSync(skillSourcesDir(), { recursive: true });
  if (existsSync(join(dir, '.git'))) {
    git(['fetch', '--tags', '--prune'], dir);
  } else {
    git(['clone', '--', url, dir]);
  }
  return dir;
}

async function ensureGitSourceAsync(url: string): Promise<string> {
  assertNoGitUrlCredentials(url);
  assertAllowedGitProtocol(url);
  const dir = join(skillSourcesDir(), sourceId(url));
  mkdirSync(skillSourcesDir(), { recursive: true });
  if (existsSync(join(dir, '.git'))) {
    await gitAsync(['fetch', '--tags', '--prune'], dir);
  } else {
    await gitAsync(['clone', '--', url, dir]);
  }
  return dir;
}

export function installGitSkill(opts: {
  url: string;
  path: string;
  ref?: string;
  sourceOverride?: SkillSource;
}): SkillPackage {
  return withGitSourceLockSync(opts.url, () => installGitSkillLocked(opts));
}

function installGitSkillLocked(opts: {
  url: string;
  path: string;
  ref?: string;
  sourceOverride?: SkillSource;
}): SkillPackage {
  assertSafeGitRef(opts.ref);
  const sourceDir = ensureGitSource(opts.url);
  const ref = opts.ref ?? 'HEAD';
  if (ref === 'HEAD') {
    git(['fetch', 'origin', 'HEAD'], sourceDir);
    git(['checkout', 'FETCH_HEAD'], sourceDir);
  } else {
    git(['checkout', ref], sourceDir);
  }
  const commit = git(['rev-parse', 'HEAD'], sourceDir);
  const source: SkillSource = opts.sourceOverride
    ? opts.sourceOverride.type === 'git' || opts.sourceOverride.type === 'github'
      ? { ...opts.sourceOverride, commit }
      : opts.sourceOverride
    : { type: 'git', url: opts.url, path: opts.path, ref, commit };
  const skillDir = gitSkillDir(sourceDir, opts.path);
  const provisional = loadSkillPackage(skillDir, { source });
  const rootDir = join(skillStoreDir(), provisional.name);
  rmSync(rootDir, { recursive: true, force: true });
  mkdirSync(dirname(rootDir), { recursive: true });
  cpSync(skillDir, rootDir, { recursive: true });
  const pkg = loadSkillPackage(rootDir, { source, id: provisional.id });
  const now = new Date().toISOString();
  const registry = readSkillRegistry();
  registry.skills[pkg.name] = { ...pkg, installedAt: now, updatedAt: now };
  writeSkillRegistry(registry);
  return registry.skills[pkg.name];
}

export async function installGitSkillAsync(opts: {
  url: string;
  path: string;
  ref?: string;
  sourceOverride?: SkillSource;
}): Promise<SkillPackage> {
  return withGitSourceLock(opts.url, () => installGitSkillAsyncLocked(opts));
}

async function installGitSkillAsyncLocked(opts: {
  url: string;
  path: string;
  ref?: string;
  sourceOverride?: SkillSource;
}): Promise<SkillPackage> {
  assertSafeGitRef(opts.ref);
  const sourceDir = await ensureGitSourceAsync(opts.url);
  const ref = opts.ref ?? 'HEAD';
  if (ref === 'HEAD') {
    await gitAsync(['fetch', 'origin', 'HEAD'], sourceDir);
    await gitAsync(['checkout', 'FETCH_HEAD'], sourceDir);
  } else {
    await gitAsync(['checkout', ref], sourceDir);
  }
  const commit = await gitAsync(['rev-parse', 'HEAD'], sourceDir);
  const source: SkillSource = opts.sourceOverride
    ? opts.sourceOverride.type === 'git' || opts.sourceOverride.type === 'github'
      ? { ...opts.sourceOverride, commit }
      : opts.sourceOverride
    : { type: 'git', url: opts.url, path: opts.path, ref, commit };
  const skillDir = gitSkillDir(sourceDir, opts.path);
  const provisional = loadSkillPackage(skillDir, { source });
  const rootDir = join(skillStoreDir(), provisional.name);
  rmSync(rootDir, { recursive: true, force: true });
  mkdirSync(dirname(rootDir), { recursive: true });
  cpSync(skillDir, rootDir, { recursive: true });
  const pkg = loadSkillPackage(rootDir, { source, id: provisional.id });
  const now = new Date().toISOString();
  const registry = readSkillRegistry();
  registry.skills[pkg.name] = { ...pkg, installedAt: now, updatedAt: now };
  writeSkillRegistry(registry);
  return registry.skills[pkg.name];
}

export function removeInstalledSkill(name: string): { ok: true } | { ok: false; reason: string } {
  const registry = readSkillRegistry();
  const pkg = registry.skills[name];
  if (!pkg) return { ok: false, reason: 'skill_not_installed' };
  delete registry.skills[name];
  writeSkillRegistry(registry);
  if (pkg.source.type !== 'local-link' && isStoreManagedRoot(pkg.rootDir)) {
    rmSync(pkg.rootDir, { recursive: true, force: true });
  }
  return { ok: true };
}

function isStoreManagedRoot(rootDir: string): boolean {
  const storePath = resolve(skillStoreDir());
  const targetPath = resolve(rootDir);
  const store = existsSync(storePath) ? realpathSync(storePath) : storePath;
  const target = existsSync(targetPath) ? realpathSync(targetPath) : targetPath;
  if (target === store) return false;
  const rel = relative(store, target);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

export function updateInstalledSkill(name: string): { ok: true; skill: SkillPackage } | { ok: false; reason: string } {
  const current = readSkillRegistry().skills[name];
  if (!current) return { ok: false, reason: 'skill_not_installed' };
  const source = current.source;
  if (source.type === 'local-copy') return { ok: true, skill: installLocalSkill(source.originalPath, { link: false }) };
  if (source.type === 'local-link') return { ok: true, skill: installLocalSkill(source.path, { link: true }) };
  if (source.type === 'git') {
    return { ok: true, skill: installGitSkill({ url: source.url, path: source.path, ref: source.ref }) };
  }
  if (source.type === 'github') {
    return {
      ok: true,
      skill: installGitSkill({
        url: githubToGitUrl(source.owner, source.repo),
        path: source.path,
        ref: source.ref,
        sourceOverride: source,
      }),
    };
  }
  return { ok: false, reason: `unsupported_source:${source.type}` };
}

export async function updateInstalledSkillAsync(name: string): Promise<{ ok: true; skill: SkillPackage } | { ok: false; reason: string }> {
  const current = readSkillRegistry().skills[name];
  if (!current) return { ok: false, reason: 'skill_not_installed' };
  const source = current.source;
  if (source.type === 'local-copy') return { ok: true, skill: installLocalSkill(source.originalPath, { link: false }) };
  if (source.type === 'local-link') return { ok: true, skill: installLocalSkill(source.path, { link: true }) };
  if (source.type === 'git') {
    return { ok: true, skill: await installGitSkillAsync({ url: source.url, path: source.path, ref: source.ref }) };
  }
  if (source.type === 'github') {
    return {
      ok: true,
      skill: await installGitSkillAsync({
        url: githubToGitUrl(source.owner, source.repo),
        path: source.path,
        ref: source.ref,
        sourceOverride: source,
      }),
    };
  }
  return { ok: false, reason: `unsupported_source:${source.type}` };
}
