import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import YAML from 'yaml';

function parseConfigFile(filePath: string): any {
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    if (filePath.endsWith('.json')) {
      try {
        return JSON.parse(raw);
      } catch {
        return YAML.parse(raw);
      }
    }
    return YAML.parse(raw);
  } catch {
    return undefined;
  }
}

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
  const env = { ...process.env, ...opts?.env };
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
  const env = { ...process.env, ...opts?.env };
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
  enabledProviders?: string[];
  disabledProviders?: string[];
}): DiscoveredAppendPrompt | undefined {
  const env = { ...process.env, ...opts?.env };
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

  // 2. User level candidates (active OMP profile agent dir)
  const rawConfigDir = opts?.configDir || env.PI_CONFIG_DIR || '.omp';
  const configRoot = isAbsolute(rawConfigDir) ? rawConfigDir : join(home, rawConfigDir);
  const profile = opts?.profile ?? resolveOmpProfileEnv(env.OMP_PROFILE, env.PI_PROFILE);
  const userAgentDir = profile
    ? join(configRoot, 'profiles', profile, 'agent')
    : join(configRoot, 'agent');

  const candidate = join(userAgentDir, 'APPEND_SYSTEM.md');
  if (existsSync(candidate)) {
    try {
      return { path: candidate, content: readFileSync(candidate, 'utf-8') };
    } catch {
      // ignore read failure
    }
  }

  // 3. Foreign user config directories (.claude, .codex, .gemini)
  // Aligned with OMP 18.2.11 Settings & `isUserSourceEnabled`:
  // - disabledProviders takes absolute precedence (returns false).
  // - explicit enabledProviders (or wildcard '*' / 'all') enables the provider.
  // - CLAUDE_CONFIG_DIR enables claude (unless claude is disabled).
  // - otherwise foreign user source is opt-in and defaults to disabled.
  const enabledProviders = new Set<string>();
  const disabledProviders = new Set<string>();

  if (opts?.enabledProviders) {
    for (const p of opts.enabledProviders) enabledProviders.add(p.trim().toLowerCase());
  }
  if (opts?.disabledProviders) {
    for (const p of opts.disabledProviders) disabledProviders.add(p.trim().toLowerCase());
  }

  // OMP Settings loads YAML/JSON configs from:
  // 1. Active profile's agent directory (e.g. ~/.omp/agent/config.yml or ~/.omp/profiles/<name>/agent/config.yml)
  // 2. Project directory (e.g. <cwd>/.omp/config.yml)
  // 3. Legacy / root fallbacks
  const settingsCandidates: string[] = [
    join(userAgentDir, 'config.yml'),
    join(userAgentDir, 'config.yaml'),
    join(userAgentDir, 'settings.json'),
    join(cwd, '.omp', 'config.yml'),
    join(cwd, '.omp', 'config.yaml'),
    join(cwd, '.omp', 'settings.json'),
    join(configRoot, 'config.yml'),
    join(configRoot, 'config.yaml'),
    join(configRoot, 'settings.json'),
  ];
  for (const settingsFile of settingsCandidates) {
    const parsed = parseConfigFile(settingsFile);
    if (!parsed || typeof parsed !== 'object') continue;
    if (Array.isArray(parsed.enabledProviders)) {
      for (const p of parsed.enabledProviders) {
        if (typeof p === 'string') enabledProviders.add(p.trim().toLowerCase());
      }
    }
    if (Array.isArray(parsed.disabledProviders)) {
      for (const p of parsed.disabledProviders) {
        if (typeof p === 'string') disabledProviders.add(p.trim().toLowerCase());
      }
    }
  }

  const isProviderActive = (provider: 'claude' | 'codex' | 'gemini'): boolean => {
    if (disabledProviders.has(provider)) return false;
    if (enabledProviders.has(provider) || enabledProviders.has('*') || enabledProviders.has('all')) {
      return true;
    }
    if (provider === 'claude' && Boolean(env.CLAUDE_CONFIG_DIR?.trim())) {
      return true;
    }
    return false;
  };

  const claudeUserDir = env.CLAUDE_CONFIG_DIR?.trim()
    ? resolve(expandTilde(env.CLAUDE_CONFIG_DIR.trim()))
    : join(home, '.claude');

  const foreignProviders: Array<{ provider: 'claude' | 'codex' | 'gemini'; dir: string }> = [
    { provider: 'claude', dir: claudeUserDir },
    { provider: 'codex', dir: join(home, '.codex') },
    { provider: 'gemini', dir: join(home, '.gemini') },
  ];

  for (const { provider, dir } of foreignProviders) {
    if (!isProviderActive(provider)) continue;
    const foreignCandidate = join(dir, 'APPEND_SYSTEM.md');
    if (existsSync(foreignCandidate)) {
      try {
        return { path: foreignCandidate, content: readFileSync(foreignCandidate, 'utf-8') };
      } catch {
        // ignore read failure
      }
    }
  }

  return undefined;
}
