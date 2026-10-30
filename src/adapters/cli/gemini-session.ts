import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Gemini CLI (verified on 0.66.0) keeps one session per file under
 * `<home>/.gemini/tmp/<project>/chats/session-<time>-<first 8 of id>.jsonl`,
 * where `<project>` is the short name `projects.json` maps the working dir to,
 * and the first line is the session metadata (`{"sessionId": …}`).
 *
 * - `--session-id <uuid>` starts a new session with that id (exit 42 if a file
 *   with that id already exists for the project);
 * - `--resume <uuid>` resumes it, but only within the same project and only a
 *   session with resumable content (at least one user message); anything else
 *   exits 42 ("No previous sessions found" / "Invalid session identifier").
 *
 * So botmux can name the session itself (its session id is a UUID) and must
 * check the file before asking Gemini to resume it.
 */

/** `GEMINI_CLI_HOME` replaces the home dir Gemini resolves `.gemini` under. */
export function geminiDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.GEMINI_CLI_HOME?.trim() || homedir(), '.gemini');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Gemini only accepts a UUID as a session id. */
export function isGeminiSessionId(id: string | undefined): id is string {
  return !!id && UUID_RE.test(id);
}

/** The project short name Gemini uses for `workingDir`, from projects.json. */
function geminiProjectName(workingDir: string, gDir: string): string | undefined {
  let projects: Record<string, string>;
  try {
    const parsed = JSON.parse(readFileSync(join(gDir, 'projects.json'), 'utf8')) as { projects?: unknown };
    if (!parsed.projects || typeof parsed.projects !== 'object') return undefined;
    projects = parsed.projects as Record<string, string>;
  } catch { return undefined; }
  const keys = [resolve(workingDir)];
  try { keys.push(realpathSync(workingDir)); } catch { /* lexical only */ }
  for (const key of keys) {
    const name = projects[key];
    if (typeof name === 'string' && name && !name.includes('/') && name !== '.' && name !== '..') return name;
  }
  return undefined;
}

function firstLine(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(0, nl) : text;
  } finally {
    closeSync(fd);
  }
}

export interface GeminiSessionFile {
  path: string;
  /** Has at least one user message: Gemini resumes only such a session. */
  resumable: boolean;
}

/** The session file of `sessionId` for `workingDir`, if Gemini has one. */
export function findGeminiSessionFile(
  sessionId: string,
  workingDir: string,
  env: NodeJS.ProcessEnv = process.env,
): GeminiSessionFile | undefined {
  if (!isGeminiSessionId(sessionId)) return undefined;
  const gDir = geminiDir(env);
  const project = geminiProjectName(workingDir, gDir);
  if (!project) return undefined;
  const chats = join(gDir, 'tmp', project, 'chats');
  let names: string[];
  try { names = readdirSync(chats); } catch { return undefined; }
  const short = sessionId.slice(0, 8).toLowerCase();
  for (const name of names) {
    if (!name.startsWith('session-') || !(name.endsWith(`-${short}.jsonl`) || name.endsWith(`-${short}.json`))) continue;
    const path = join(chats, name);
    try {
      const meta = JSON.parse(firstLine(path)) as { sessionId?: unknown };
      if (meta.sessionId !== sessionId) continue;
      const text = readFileSync(path, 'utf8');
      return { path, resumable: /"type"\s*:\s*"user"/.test(text) };
    } catch { continue; }
  }
  return undefined;
}
