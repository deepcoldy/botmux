import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface DiscoveredAppendPrompt {
  readonly path: string;
  readonly content: string;
}

function expandTilde(p: string, home: string = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return join(home, p.slice(2));
  }
  return p;
}

function normalizeCwd(cwd: string): string {
  try {
    return realpathSync(resolve(cwd));
  } catch {
    return resolve(cwd);
  }
}

/**
 * Pi-compatible trust entry search: walks upward from normalized cwd looking
 * for an explicit boolean decision in data.
 */
function findNearestTrustEntry(data: Record<string, unknown>, cwd: string): boolean | null {
  let currentDir = normalizeCwd(cwd);
  while (true) {
    const value = data[currentDir];
    if (value === true || value === false) {
      return value;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export interface PiProjectTrustCheckOptions {
  cwd: string;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  extraArgs?: string[];
  trustOverride?: boolean;
  projectTrusted?: boolean;
}

/**
 * Checks if a directory is marked as trusted in Pi's trust store and settings:
 * 1. CLI trust override / explicit flags (--no-approve -> false, --approve -> true).
 * 2. Trust store (agentDir/trust.json).
 * 3. Settings (agentDir/settings.json: defaultProjectTrust).
 */
export function isPiProjectTrusted(
  cwdOrOpts: string | PiProjectTrustCheckOptions,
  legacyAgentDir?: string,
): boolean {
  const cwd = typeof cwdOrOpts === 'string' ? cwdOrOpts : cwdOrOpts.cwd;
  const opts = typeof cwdOrOpts === 'object' ? cwdOrOpts : undefined;
  const env = opts?.env ?? process.env;
  const rawAgentDir = opts?.agentDir
    || legacyAgentDir
    || env.PI_CODING_AGENT_DIR
    || env.PI_AGENT_DIR
    || join(homedir(), '.pi', 'agent');
  const agentDir = resolve(expandTilde(rawAgentDir));

  // 1. Explicit trust override or flags in extraArgs / CLI_EXTRA_ARGS
  let trustOverride: boolean | undefined = opts?.trustOverride ?? opts?.projectTrusted;
  if (trustOverride === undefined) {
    const extraArgs = [
      ...(opts?.extraArgs ?? []),
      ...((env.CLI_EXTRA_ARGS ?? '').trim().split(/\s+/).filter(Boolean)),
    ];
    if (extraArgs.includes('--no-approve') || extraArgs.includes('-na')) {
      trustOverride = false;
    } else if (extraArgs.includes('--approve') || extraArgs.includes('-a')) {
      trustOverride = true;
    }
  }
  if (trustOverride !== undefined) {
    return trustOverride;
  }

  // 2. Trust store (agentDir/trust.json)
  const trustPath = join(agentDir, 'trust.json');
  if (existsSync(trustPath)) {
    try {
      const raw = readFileSync(trustPath, 'utf-8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const decision = findNearestTrustEntry(data as Record<string, unknown>, cwd);
        if (decision !== null) {
          return decision;
        }
      }
    } catch {
      // ignore parse failure
    }
  }

  // 3. Settings default (agentDir/settings.json)
  const settingsPath = join(agentDir, 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(raw);
      if (settings?.defaultProjectTrust === 'always') return true;
      if (settings?.defaultProjectTrust === 'never') return false;
    } catch {
      // ignore parse failure
    }
  }

  return false;
}

/**
 * Discovers an existing APPEND_SYSTEM.md for Pi according to Pi's discovery rules:
 * 1. Project level: join(cwd, '.pi', 'APPEND_SYSTEM.md') - requires project trust in trust.json / settings.
 * 2. User level: join(agentDir, 'APPEND_SYSTEM.md').
 */
export function discoverPiAppendSystemPrompt(opts?: {
  cwd?: string;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  extraArgs?: string[];
  trustOverride?: boolean;
  projectTrusted?: boolean;
}): DiscoveredAppendPrompt | undefined {
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ? resolve(opts.cwd) : process.cwd();
  const rawAgentDir = opts?.agentDir
    || env.PI_CODING_AGENT_DIR
    || env.PI_AGENT_DIR
    || join(homedir(), '.pi', 'agent');
  const agentDir = resolve(expandTilde(rawAgentDir));

  // 1. Project level (only if trusted)
  const projectPath = join(cwd, '.pi', 'APPEND_SYSTEM.md');
  const trusted = isPiProjectTrusted({
    cwd,
    agentDir,
    env,
    extraArgs: opts?.extraArgs,
    trustOverride: opts?.trustOverride,
    projectTrusted: opts?.projectTrusted,
  });
  if (trusted && existsSync(projectPath)) {
    try {
      return { path: projectPath, content: readFileSync(projectPath, 'utf-8') };
    } catch {
      // ignore read failure
    }
  }

  // 2. User level
  const globalPath = join(agentDir, 'APPEND_SYSTEM.md');
  if (existsSync(globalPath)) {
    try {
      return { path: globalPath, content: readFileSync(globalPath, 'utf-8') };
    } catch {
      // ignore read failure
    }
  }

  return undefined;
}

/**
 * Normalize and validate an OMP profile name matching @oh-my-pi/pi-utils dirs.
 * Empty string, whitespace, or "default" sentinel resolves to undefined (default profile).
 */
export function normalizeOmpProfileName(profile: string | undefined): string | undefined {
  const normalized = profile?.trim();
  if (!normalized || normalized === 'default') return undefined;
  return normalized;
}

/**
 * Resolve the active profile from the two profile env vars:
 * OMP_PROFILE is canonical and takes precedence; PI_PROFILE is legacy fallback.
 * An explicitly empty or default OMP_PROFILE selects default profile without consulting PI_PROFILE.
 */
export function resolveOmpProfileEnv(omp: string | undefined, pi: string | undefined): string | undefined {
  return normalizeOmpProfileName(omp !== undefined ? omp : pi);
}

/**
 * Discovers an existing APPEND_SYSTEM.md for oh-my-pi (omp) according to OMP's discovery rules:
 * 1. Project level: candidate project dirs in cwd: .omp, .claude, .codex, .gemini.
 * 2. User level: candidate user dir for active profile:
 *    profile ? configDir/profiles/<profile>/agent : configDir/agent.
 *    No cross-profile fallback and no ~/.omp/APPEND_SYSTEM.md fallback.
 */
export function discoverOmpAppendSystemPrompt(opts?: {
  cwd?: string;
  homeDir?: string;
  configDir?: string;
  profile?: string;
  env?: NodeJS.ProcessEnv;
}): DiscoveredAppendPrompt | undefined {
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ? resolve(opts.cwd) : process.cwd();
  const home = opts?.homeDir ? resolve(expandTilde(opts.homeDir)) : homedir();

  // 1. Project level candidates
  const projectDirs = ['.omp', '.claude', '.codex', '.gemini'];
  for (const dir of projectDirs) {
    const candidate = join(cwd, dir, 'APPEND_SYSTEM.md');
    if (existsSync(candidate)) {
      try {
        return { path: candidate, content: readFileSync(candidate, 'utf-8') };
      } catch {
        // ignore read failure
      }
    }
  }

  // 2. User level candidates
  const configDir = opts?.configDir || env.PI_CONFIG_DIR || '.omp';
  const profile = opts?.profile ?? resolveOmpProfileEnv(env.OMP_PROFILE, env.PI_PROFILE);
  const userAgentDir = profile
    ? join(home, configDir, 'profiles', profile, 'agent')
    : join(home, configDir, 'agent');

  const candidate = join(userAgentDir, 'APPEND_SYSTEM.md');
  if (existsSync(candidate)) {
    try {
      return { path: candidate, content: readFileSync(candidate, 'utf-8') };
    } catch {
      // ignore read failure
    }
  }

  return undefined;
}
