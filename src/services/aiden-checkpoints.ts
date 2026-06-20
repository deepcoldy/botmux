import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const FALLBACK_SCAN_LIMIT = 200;

export function aidenCheckpointsRoot(): string {
  return join(homedir(), '.aiden', 'checkpoints');
}

export function aidenWorkspaceKey(cwd: string): string {
  const expanded = cwd.startsWith('~/') ? join(homedir(), cwd.slice(2)) : cwd;
  return createHash('sha256').update(resolve(expanded)).digest('hex').slice(0, 12);
}

function checkpointPathFromSessionDir(sessionDir: string): string | undefined {
  try {
    if (!statSync(sessionDir).isDirectory()) return undefined;
    const latestPath = join(sessionDir, 'latest.json');
    const latest = JSON.parse(readFileSync(latestPath, 'utf8'));
    const checkpointId = typeof latest?.latest === 'string' ? latest.latest : undefined;
    if (!checkpointId) return undefined;
    const checkpointPath = join(sessionDir, `${checkpointId}.json`);
    return existsSync(checkpointPath) ? checkpointPath : undefined;
  } catch {
    return undefined;
  }
}

function workspaceDirs(root: string, cwd?: string): string[] {
  if (cwd) return [join(root, aidenWorkspaceKey(cwd))];
  let workspaces: string[];
  try { workspaces = readdirSync(root); } catch { return []; }
  return workspaces.map((workspace) => join(root, workspace));
}

export function findAidenLatestCheckpointBySessionId(
  sessionId: string,
  root: string = aidenCheckpointsRoot(),
  cwd?: string,
): string | undefined {
  if (!sessionId || !existsSync(root)) return undefined;
  for (const workspaceDir of workspaceDirs(root, cwd)) {
    const sessionDir = join(workspaceDir, sessionId);
    if (!existsSync(sessionDir)) continue;
    const checkpointPath = checkpointPathFromSessionDir(sessionDir);
    if (checkpointPath) return checkpointPath;
  }
  return undefined;
}

export function findAidenLatestCheckpointByBotmuxSessionId(
  botmuxSessionId: string,
  root: string = aidenCheckpointsRoot(),
  cwd?: string,
): string | undefined {
  if (!botmuxSessionId || !existsSync(root)) return undefined;
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const workspaceDir of workspaceDirs(root, cwd)) {
    let sessions: string[];
    try { sessions = readdirSync(workspaceDir); } catch { continue; }
    for (const session of sessions) {
      const checkpointPath = checkpointPathFromSessionDir(join(workspaceDir, session));
      if (!checkpointPath) continue;
      try {
        candidates.push({ path: checkpointPath, mtimeMs: statSync(checkpointPath).mtimeMs });
      } catch {
        continue;
      }
    }
  }

  const marker = JSON.stringify(botmuxSessionId).slice(1, -1);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates.slice(0, FALLBACK_SCAN_LIMIT)) {
    try {
      if (readFileSync(candidate.path, 'utf8').includes(marker)) return candidate.path;
    } catch {
      continue;
    }
  }
  return undefined;
}
