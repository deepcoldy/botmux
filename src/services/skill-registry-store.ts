import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
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
import type { AgentbuddySource } from '../core/skills/sources.js';

const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const execFileAsync = promisify(execFile);
const gitSourceLocks = new Map<string, Promise<void>>();

export interface DiscoveredSkillCandidate {
  name: string;
  displayName?: string;
  description?: string;
  version?: string;
  tags: string[];
  path: string;
}

export interface SkillSourceDiscovery {
  commit?: string;
  skills: DiscoveredSkillCandidate[];
}

export interface SkillInstallSelection {
  skillNames?: string[];
  all?: boolean;
  fullDepth?: boolean;
}

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

function relativeSkillPath(parentDir: string, targetDir: string): string {
  const rel = relative(realpathSync(parentDir), realpathSync(targetDir)).replace(/\\/g, '/');
  return rel || '.';
}

function listChildDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(root, entry.name));
  } catch {
    return [];
  }
}

function candidateFromDir(parentDir: string, skillDir: string): DiscoveredSkillCandidate | null {
  try {
    assertPathWithin(parentDir, skillDir, 'skill_path_outside_source');
    const pkg = loadSkillPackage(skillDir, { source: { type: 'user', root: skillDir } });
    return {
      name: pkg.name,
      ...(pkg.displayName ? { displayName: pkg.displayName } : {}),
      ...(pkg.description ? { description: pkg.description } : {}),
      ...(pkg.version ? { version: pkg.version } : {}),
      tags: pkg.tags,
      path: relativeSkillPath(parentDir, skillDir),
    };
  } catch {
    return null;
  }
}

function dedupeAndSortCandidates(candidates: DiscoveredSkillCandidate[]): DiscoveredSkillCandidate[] {
  const byPath = new Map<string, DiscoveredSkillCandidate>();
  for (const candidate of candidates) byPath.set(candidate.path, candidate);
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function walkSkillDirs(parentDir: string, dir: string, out: DiscoveredSkillCandidate[], depth: number): void {
  if (depth > 4) return;
  for (const child of listChildDirs(dir)) {
    const name = child.split('/').pop() ?? '';
    if (name === '.git' || name === 'node_modules') continue;
    const candidate = candidateFromDir(parentDir, child);
    if (candidate) out.push(candidate);
    walkSkillDirs(parentDir, child, out, depth + 1);
  }
}

export function discoverLocalSkillCandidates(rootDir: string, opts: { fullDepth?: boolean } = {}): SkillSourceDiscovery {
  const sourceDir = realpathSync(resolve(rootDir));
  const candidates: DiscoveredSkillCandidate[] = [];
  const rootCandidate = candidateFromDir(sourceDir, sourceDir);
  if (rootCandidate) {
    candidates.push(rootCandidate);
    if (!opts.fullDepth) return { skills: dedupeAndSortCandidates(candidates) };
  }
  for (const relativeRoot of ['skills', '.agents/skills', '.botmux/skills']) {
    for (const child of listChildDirs(join(sourceDir, relativeRoot))) {
      const candidate = candidateFromDir(sourceDir, child);
      if (candidate) candidates.push(candidate);
    }
  }
  if (opts.fullDepth) walkSkillDirs(sourceDir, sourceDir, candidates, 0);
  return { skills: dedupeAndSortCandidates(candidates) };
}

function selectDiscoveredSkills(
  candidates: DiscoveredSkillCandidate[],
  selection: SkillInstallSelection = {},
): DiscoveredSkillCandidate[] {
  if (candidates.length === 0) throw new Error('no_skills_found');
  const requestedNames = [...new Set((selection.skillNames ?? []).map(name => name.trim()).filter(Boolean))];
  if (selection.all || requestedNames.includes('*')) return candidates;
  if (requestedNames.length > 0) {
    const selected: DiscoveredSkillCandidate[] = [];
    for (const name of requestedNames) {
      const matches = candidates.filter(candidate => candidate.name === name);
      if (matches.length === 0) throw new Error(`skill_not_found:${name}`);
      if (matches.length > 1) throw new Error(`duplicate_skill_name:${name}`);
      selected.push(matches[0]);
    }
    return selected;
  }
  if (candidates.length === 1) return candidates;
  throw new Error(`multiple_skills_found:${candidates.map(candidate => candidate.name).join(',')}`);
}

export function installLocalSkillsFromSource(
  rootDir: string,
  opts: { link: boolean } & SkillInstallSelection,
): SkillPackage[] {
  const sourceDir = resolve(rootDir);
  const discovery = discoverLocalSkillCandidates(sourceDir, { fullDepth: opts.fullDepth });
  return selectDiscoveredSkills(discovery.skills, opts).map(candidate => {
    const skillDir = candidate.path === '.' ? sourceDir : join(sourceDir, candidate.path);
    return installLocalSkill(skillDir, { link: opts.link });
  });
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

function checkoutGitSource(url: string, refValue: string | undefined): { sourceDir: string; ref: string; commit: string } {
  assertSafeGitRef(refValue);
  const sourceDir = ensureGitSource(url);
  const ref = refValue ?? 'HEAD';
  if (ref === 'HEAD') {
    git(['fetch', 'origin', 'HEAD'], sourceDir);
    git(['checkout', 'FETCH_HEAD'], sourceDir);
  } else {
    git(['checkout', ref], sourceDir);
  }
  return { sourceDir, ref, commit: git(['rev-parse', 'HEAD'], sourceDir) };
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

async function checkoutGitSourceAsync(url: string, refValue: string | undefined): Promise<{ sourceDir: string; ref: string; commit: string }> {
  assertSafeGitRef(refValue);
  const sourceDir = await ensureGitSourceAsync(url);
  const ref = refValue ?? 'HEAD';
  if (ref === 'HEAD') {
    await gitAsync(['fetch', 'origin', 'HEAD'], sourceDir);
    await gitAsync(['checkout', 'FETCH_HEAD'], sourceDir);
  } else {
    await gitAsync(['checkout', ref], sourceDir);
  }
  return { sourceDir, ref, commit: await gitAsync(['rev-parse', 'HEAD'], sourceDir) };
}

export function discoverGitSkillCandidates(opts: {
  url: string;
  ref?: string;
  path?: string;
  fullDepth?: boolean;
}): SkillSourceDiscovery {
  return withGitSourceLockSync(opts.url, () => {
    const { sourceDir, commit } = checkoutGitSource(opts.url, opts.ref);
    if (opts.path) {
      const candidate = candidateFromDir(sourceDir, gitSkillDir(sourceDir, opts.path));
      return { commit, skills: candidate ? [candidate] : [] };
    }
    return {
      commit,
      skills: discoverLocalSkillCandidates(sourceDir, { fullDepth: opts.fullDepth }).skills,
    };
  });
}

export async function discoverGitSkillCandidatesAsync(opts: {
  url: string;
  ref?: string;
  path?: string;
  fullDepth?: boolean;
}): Promise<SkillSourceDiscovery> {
  return withGitSourceLock(opts.url, async () => {
    const { sourceDir, commit } = await checkoutGitSourceAsync(opts.url, opts.ref);
    if (opts.path) {
      const candidate = candidateFromDir(sourceDir, gitSkillDir(sourceDir, opts.path));
      return { commit, skills: candidate ? [candidate] : [] };
    }
    return {
      commit,
      skills: discoverLocalSkillCandidates(sourceDir, { fullDepth: opts.fullDepth }).skills,
    };
  });
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
  const { sourceDir, ref, commit } = checkoutGitSource(opts.url, opts.ref);
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
  const { sourceDir, ref, commit } = await checkoutGitSourceAsync(opts.url, opts.ref);
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

function sourceOverrideForCandidate(source: SkillSource | undefined, candidate: DiscoveredSkillCandidate): SkillSource | undefined {
  if (!source) return undefined;
  if (source.type === 'git') return { ...source, path: candidate.path };
  if (source.type === 'github') return { ...source, path: candidate.path };
  return source;
}

export function installGitSkillsFromSource(opts: {
  url: string;
  ref?: string;
  sourceOverride?: SkillSource;
} & SkillInstallSelection): SkillPackage[] {
  const discovery = discoverGitSkillCandidates({ url: opts.url, ref: opts.ref, fullDepth: opts.fullDepth });
  const selected = selectDiscoveredSkills(discovery.skills, opts);
  return selected.map(candidate => installGitSkill({
    url: opts.url,
    path: candidate.path,
    ref: opts.ref,
    sourceOverride: sourceOverrideForCandidate(opts.sourceOverride, candidate),
  }));
}

export async function installGitSkillsFromSourceAsync(opts: {
  url: string;
  ref?: string;
  sourceOverride?: SkillSource;
} & SkillInstallSelection): Promise<SkillPackage[]> {
  const discovery = await discoverGitSkillCandidatesAsync({ url: opts.url, ref: opts.ref, fullDepth: opts.fullDepth });
  const selected = selectDiscoveredSkills(discovery.skills, opts);
  const installed: SkillPackage[] = [];
  for (const candidate of selected) {
    installed.push(await installGitSkillAsync({
      url: opts.url,
      path: candidate.path,
      ref: opts.ref,
      sourceOverride: sourceOverrideForCandidate(opts.sourceOverride, candidate),
    }));
  }
  return installed;
}

// --- agentbuddy (external CLI) skill source ---------------------------------
//
// Delegates fetch + SSO auth + versioning to the operator-configured `agentbuddy`
// binary (BOTMUX_AGENTBUDDY_CMD, default `agentbuddy`), captures the SKILL.md
// dir(s) it writes into a throwaway staging project, and copies them into
// botmux's own store. The registry host and login cache live entirely in the
// agentbuddy binary + the daemon host's npmrc/login state, so no internal
// registry domain ever enters botmux's (publicly-published) source.

const DEFAULT_AGENTBUDDY_TIMEOUT_MS = 180_000;

function agentbuddyCommand(): { bin: string; prefixArgs: string[] } {
  const raw = (process.env.BOTMUX_AGENTBUDDY_CMD ?? 'agentbuddy').trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  return parts.length > 0 ? { bin: parts[0], prefixArgs: parts.slice(1) } : { bin: 'agentbuddy', prefixArgs: [] };
}

function agentbuddyTimeoutMs(): number {
  const raw = Number(process.env.BOTMUX_AGENTBUDDY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AGENTBUDDY_TIMEOUT_MS;
}

const agentbuddyLocks = new Map<string, Promise<void>>();

/** Lock target for an identifier — the shared staging dir path; withFileLock
 *  appends `.lock`, so the lock file is a sibling of (not inside) the staging
 *  dir the install rmSyncs. Mirrors gitSourceLockTarget. */
function agentbuddyLockTarget(identifier: string): string {
  const dir = join(skillSourcesDir(), 'agentbuddy');
  mkdirSync(dir, { recursive: true });
  return join(dir, sourceId(identifier));
}

function agentbuddyLockWaitMs(): number {
  return Math.max(agentbuddyTimeoutMs() * 5, 60_000);
}

/** Serialize install/update of the SAME agentbuddy identifier — like the git
 *  path's withGitSourceLock. Two concurrent tasks for one identifier (two
 *  dashboard tabs, or CLI + dashboard) otherwise rmSync each other's shared
 *  staging dir mid-run (both agentbuddy children fail with uv_cwd/ENOENT). The
 *  cross-process file lock covers separate processes; wait budget ≥ a full run. */
function withAgentbuddyLockSync<T>(identifier: string, fn: () => T): T {
  // A blocking sync file-lock acquire cannot coexist with an in-process ASYNC
  // holder of the same identifier: withFileLock is non-reentrant, and the sync
  // acquire freezes the event loop so the async holder never reaches its release
  // — a guaranteed deadlock until the (long) lock timeout. The sync API is the
  // one-shot CLI path; if an async op is in flight in THIS process, fast-fail
  // instead of dead-waiting. (Cross-process sync↔async is fine: the file lock
  // serializes those, and blocking a one-shot CLI's own loop is harmless.)
  if (agentbuddyLocks.has(sourceId(identifier))) throw new Error('agentbuddy_busy');
  return withFileLockSync(agentbuddyLockTarget(identifier), fn, { maxWaitMs: agentbuddyLockWaitMs() });
}

/** Async twin: an in-process promise chain orders same-process async callers
 *  (withFileLock is not reentrant), then the cross-process file lock. */
async function withAgentbuddyLock<T>(identifier: string, fn: () => Promise<T>): Promise<T> {
  const key = sourceId(identifier);
  const previous = agentbuddyLocks.get(key) ?? Promise.resolve();
  const waitForPrevious = previous.catch(() => undefined);
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = waitForPrevious.then(() => current);
  agentbuddyLocks.set(key, tail);
  await waitForPrevious;
  try {
    return await withFileLock(agentbuddyLockTarget(identifier), fn, { maxWaitMs: agentbuddyLockWaitMs() });
  } finally {
    release();
    if (agentbuddyLocks.get(key) === tail) agentbuddyLocks.delete(key);
  }
}

function agentbuddyInstallArgs(opts: AgentbuddySource): string[] {
  // --copy: write real files (not symlinks into the user's agent dirs) so the
  //         staging tree is self-contained to copy into the store.
  // --strict: fail fast with "needs login" instead of blocking on an
  //           interactive SSO prompt on a headless daemon host.
  const common = ['--agent', 'claude-code', '--copy', '-y', '--strict'];
  if (opts.collection) return ['skill', 'collection', 'add', opts.collection, ...common];
  const args = ['skill', 'add', opts.group!, '--skill', opts.skill!];
  if (opts.version) args.push('--version', opts.version);
  return [...args, ...common];
}

function runAgentbuddyCli(args: string[], cwd: string, failCode: string): void {
  const { bin, prefixArgs } = agentbuddyCommand();
  try {
    execFileSync(bin, [...prefixArgs, ...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: agentbuddyTimeoutMs(),
    });
  } catch (err: any) {
    if (err?.code === 'ENOENT') throw new Error('agentbuddy_not_found');
    const stderr = Buffer.isBuffer(err?.stderr) ? err.stderr.toString('utf-8').trim() : String(err?.stderr ?? '').trim();
    const stdout = Buffer.isBuffer(err?.stdout) ? err.stdout.toString('utf-8').trim() : String(err?.stdout ?? '').trim();
    throw new Error(`${failCode}: ${stderr || stdout || err?.message || String(err)}`);
  }
}

function agentbuddyKeepTelemetry(): boolean {
  const v = (process.env.BOTMUX_AGENTBUDDY_KEEP_TELEMETRY ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Strip the usage-telemetry the marketplace bakes into published skills (a
 *  `<!-- @telemetry -->` block in SKILL.md plus `spans/*.sh` and
 *  `.agentbuddy`/`.ai-extension` dirs) via agentbuddy's own built-in scrubber,
 *  so botmux-delivered skills don't phone home from bridged sessions. Runs over
 *  the staging tree before it's copied into the store. Fail-closed: a scrub
 *  error aborts the install rather than silently shipping telemetry (opt out
 *  with BOTMUX_AGENTBUDDY_KEEP_TELEMETRY=1). */
function clearAgentbuddyTelemetry(stagingDir: string): void {
  runAgentbuddyCli(['clear-embedded-telemetry', stagingDir], stagingDir, 'agentbuddy_clear_telemetry_failed');
}

const TELEMETRY_ARTIFACT_DIRS = ['spans', '.agentbuddy', '.ai-extension'];

/** Fail-closed post-scrub check on a produced skill dir. `clear-embedded-telemetry`
 *  exiting 0 is not proof it stripped anything — a stale/behaviour-drifted
 *  agentbuddy (or a scrub that missed) could leave telemetry behind. Reject the
 *  skill if any known telemetry artifact survives, before it enters the store. */
function assertTelemetryStripped(skillDir: string): void {
  for (const artifact of TELEMETRY_ARTIFACT_DIRS) {
    if (existsSync(join(skillDir, artifact))) throw new Error(`agentbuddy_telemetry_not_stripped: ${artifact}`);
  }
  const skillMd = join(skillDir, 'SKILL.md');
  if (existsSync(skillMd) && readFileSync(skillMd, 'utf-8').includes('@telemetry')) {
    throw new Error('agentbuddy_telemetry_not_stripped: SKILL.md');
  }
}

/** Depth-first scan for skill roots (dirs containing SKILL.md). Stops
 *  descending once a SKILL.md is found so a skill's own resource files can't be
 *  mistaken for nested skills. Skips node_modules / VCS dirs. */
function findSkillDirs(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    if (entries.includes('SKILL.md')) { found.push(dir); return; }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry.startsWith('.git')) continue;
      const child = join(dir, entry);
      let isDir = false;
      try { isDir = statSync(child).isDirectory(); } catch { continue; }
      if (isDir) walk(child);
    }
  };
  walk(root);
  return found;
}

function agentbuddyIdentifier(opts: AgentbuddySource): string {
  return opts.collection
    ? `collection/${opts.collection}`
    : `${opts.group}/${opts.skill}${opts.version ? `@${opts.version}` : ''}`;
}

/** Register the skill dir(s) agentbuddy wrote into the staging tree into the
 *  botmux store. Shared by the sync (CLI) and async (dashboard job) install
 *  paths so they stay behaviourally identical.
 *
 *  `requireSkillName` (set by update): if that skill is not among the produced
 *  set (renamed upstream, or dropped from its collection), abort with
 *  `agentbuddy_update_failed` BEFORE touching the store/registry — so a failed
 *  update never leaves the old entry stale while writing unrelated products.
 *  `verifyTelemetryStripped`: fail-closed telemetry post-check per skill. Both
 *  checks run before any store copy / registry write. */
function registerAgentbuddyStaging(
  opts: AgentbuddySource,
  identifier: string,
  staging: string,
  register: { requireSkillName?: string; verifyTelemetryStripped: boolean },
): SkillPackage[] {
  const dirs = findSkillDirs(staging);
  if (dirs.length === 0) throw new Error('agentbuddy_no_skill_produced');
  // Resolve names first (dedup: the same skill can mirror under multiple agent
  // dirs) so requireSkillName / telemetry checks can reject before any write.
  const byName = new Map<string, string>();
  for (const dir of dirs) {
    const provisional = loadSkillPackage(dir, { source: { type: 'agentbuddy', identifier } });
    if (!byName.has(provisional.name)) byName.set(provisional.name, dir);
  }
  if (register.requireSkillName && !byName.has(register.requireSkillName)) {
    throw new Error('agentbuddy_update_failed');
  }
  if (register.verifyTelemetryStripped) {
    for (const dir of byName.values()) assertTelemetryStripped(dir);
  }
  const now = new Date().toISOString();
  const registry = readSkillRegistry();
  const installed: SkillPackage[] = [];
  for (const [name, dir] of byName) {
    // A collection member re-installs via its collection; a single skill via
    // its own group/skill/version — record whichever lets `update` re-run it.
    const source: SkillSource = opts.collection
      ? { type: 'agentbuddy', identifier, collection: opts.collection, skill: name }
      : { type: 'agentbuddy', identifier, group: opts.group, skill: opts.skill, ...(opts.version ? { version: opts.version } : {}) };
    const rootDir = join(skillStoreDir(), name);
    rmSync(rootDir, { recursive: true, force: true });
    mkdirSync(dirname(rootDir), { recursive: true });
    cpSync(dir, rootDir, { recursive: true });
    const pkg = loadSkillPackage(rootDir, { source, id: name });
    registry.skills[pkg.name] = { ...pkg, installedAt: now, updatedAt: now };
    installed.push(registry.skills[pkg.name]);
  }
  writeSkillRegistry(registry);
  return installed;
}

async function runAgentbuddyCliAsync(args: string[], cwd: string, failCode: string): Promise<void> {
  const { bin, prefixArgs } = agentbuddyCommand();
  try {
    await execFileAsync(bin, [...prefixArgs, ...args], { cwd, encoding: 'utf-8', timeout: agentbuddyTimeoutMs() });
  } catch (err: any) {
    if (err?.code === 'ENOENT') throw new Error('agentbuddy_not_found');
    const stderr = Buffer.isBuffer(err?.stderr) ? err.stderr.toString('utf-8').trim() : String(err?.stderr ?? '').trim();
    const stdout = Buffer.isBuffer(err?.stdout) ? err.stdout.toString('utf-8').trim() : String(err?.stdout ?? '').trim();
    throw new Error(`${failCode}: ${stderr || stdout || err?.message || String(err)}`);
  }
}

export function installAgentbuddySkill(opts: AgentbuddySource, requireSkillName?: string): SkillPackage[] {
  const identifier = agentbuddyIdentifier(opts);
  return withAgentbuddyLockSync(identifier, () => {
    const staging = join(skillSourcesDir(), 'agentbuddy', sourceId(identifier));
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    try {
      runAgentbuddyCli(agentbuddyInstallArgs(opts), staging, 'agentbuddy_command_failed');
      const verifyTelemetryStripped = !agentbuddyKeepTelemetry();
      if (verifyTelemetryStripped) clearAgentbuddyTelemetry(staging);
      return registerAgentbuddyStaging(opts, identifier, staging, { requireSkillName, verifyTelemetryStripped });
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
}

/** Async twin of installAgentbuddySkill for the dashboard install job — same
 *  behaviour, but awaits the (minutes-long, network-bound) agentbuddy calls off
 *  the daemon event loop instead of blocking it with execFileSync. */
export async function installAgentbuddySkillAsync(opts: AgentbuddySource, requireSkillName?: string): Promise<SkillPackage[]> {
  const identifier = agentbuddyIdentifier(opts);
  return withAgentbuddyLock(identifier, async () => {
    const staging = join(skillSourcesDir(), 'agentbuddy', sourceId(identifier));
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    try {
      await runAgentbuddyCliAsync(agentbuddyInstallArgs(opts), staging, 'agentbuddy_command_failed');
      const verifyTelemetryStripped = !agentbuddyKeepTelemetry();
      if (verifyTelemetryStripped) await runAgentbuddyCliAsync(['clear-embedded-telemetry', staging], staging, 'agentbuddy_clear_telemetry_failed');
      return registerAgentbuddyStaging(opts, identifier, staging, { requireSkillName, verifyTelemetryStripped });
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
}

function agentbuddyReinstallOpts(source: Extract<SkillSource, { type: 'agentbuddy' }>): AgentbuddySource {
  return source.collection
    ? { collection: source.collection }
    : { group: source.group, skill: source.skill, version: source.version };
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
  if (source.type === 'agentbuddy') {
    try {
      const pkgs = installAgentbuddySkill(agentbuddyReinstallOpts(source), name);
      const match = pkgs.find((pkg) => pkg.name === name);
      return match ? { ok: true, skill: match } : { ok: false, reason: 'agentbuddy_update_failed' };
    } catch (err: any) {
      if (err?.message === 'agentbuddy_update_failed') return { ok: false, reason: 'agentbuddy_update_failed' };
      throw err;
    }
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
  if (source.type === 'agentbuddy') {
    try {
      const pkgs = await installAgentbuddySkillAsync(agentbuddyReinstallOpts(source), name);
      const match = pkgs.find((pkg) => pkg.name === name);
      return match ? { ok: true, skill: match } : { ok: false, reason: 'agentbuddy_update_failed' };
    } catch (err: any) {
      if (err?.message === 'agentbuddy_update_failed') return { ok: false, reason: 'agentbuddy_update_failed' };
      throw err;
    }
  }
  return { ok: false, reason: `unsupported_source:${source.type}` };
}
