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

/**
 * Checks if a directory is marked as trusted in Pi's trust store (`agentDir/trust.json`).
 */
export function isPiProjectTrusted(cwd: string, agentDir: string): boolean {
  const trustPath = join(resolve(agentDir), 'trust.json');
  if (!existsSync(trustPath)) return false;
  try {
    const raw = readFileSync(trustPath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    return findNearestTrustEntry(data as Record<string, unknown>, cwd) === true;
  } catch {
    return false;
  }
}

/**
 * Discovers an existing APPEND_SYSTEM.md for Pi according to Pi's discovery rules:
 * 1. Project level: join(cwd, '.pi', 'APPEND_SYSTEM.md') - requires project trust in trust.json.
 * 2. User level: join(agentDir, 'APPEND_SYSTEM.md').
 */
export function discoverPiAppendSystemPrompt(opts?: {
  cwd?: string;
  agentDir?: string;
}): DiscoveredAppendPrompt | undefined {
  const cwd = opts?.cwd ? resolve(opts.cwd) : process.cwd();
  const rawAgentDir = opts?.agentDir
    || process.env.PI_CODING_AGENT_DIR
    || process.env.PI_AGENT_DIR
    || join(homedir(), '.pi', 'agent');
  const agentDir = resolve(expandTilde(rawAgentDir));

  // 1. Project level (only if trusted)
  const projectPath = join(cwd, '.pi', 'APPEND_SYSTEM.md');
  if (isPiProjectTrusted(cwd, agentDir) && existsSync(projectPath)) {
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
 * Discovers an existing APPEND_SYSTEM.md for oh-my-pi (omp) according to OMP's discovery rules:
 * 1. Project level: candidate project dirs in cwd: .omp, .claude, .codex, .gemini.
 * 2. User level: candidate user dirs: profile agent dir, configDir/agent, ~/.omp/APPEND_SYSTEM.md.
 */
export function discoverOmpAppendSystemPrompt(opts?: {
  cwd?: string;
  homeDir?: string;
  configDir?: string;
  profile?: string;
}): DiscoveredAppendPrompt | undefined {
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
  const configDir = opts?.configDir || process.env.PI_CONFIG_DIR || '.omp';
  const profile = opts?.profile ?? process.env.PI_PROFILE;
  const userCandidates: string[] = [];
  if (profile) {
    userCandidates.push(join(home, configDir, 'profiles', profile, 'agent', 'APPEND_SYSTEM.md'));
  }
  userCandidates.push(
    join(home, configDir, 'agent', 'APPEND_SYSTEM.md'),
    join(home, '.omp', 'APPEND_SYSTEM.md'),
  );

  for (const candidate of userCandidates) {
    if (existsSync(candidate)) {
      try {
        return { path: candidate, content: readFileSync(candidate, 'utf-8') };
      } catch {
        // ignore read failure
      }
    }
  }

  return undefined;
}
