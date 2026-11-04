import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * Kimi Code (verified on 0.31.0) resumes a session with `--session <id>`
 * (`-S`), but only one that already exists: ids are `session_<uuid>` minted
 * by Kimi itself, and naming a new session is not possible ("Session … not
 * found"). Each session is listed in `<home>/session_index.jsonl`
 * (`{ sessionId, sessionDir, workDir }`) and keeps its conversation in
 * `<sessionDir>/agents/main/wire.jsonl`.
 *
 * botmux finds the Kimi session of a botmux session the way it does for
 * OpenCode: the routing envelope of every botmux prompt carries
 * `<session_id>{botmux id}</session_id>`, so the newest session for this
 * working dir whose wire log contains that text is the one to resume. A
 * zero-injection session carries no envelope and cannot be found; it starts
 * fresh, as before.
 */

/** `KIMI_CODE_HOME` relocates Kimi's whole data dir. */
export function kimiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.KIMI_CODE_HOME?.trim() || join(homedir(), '.kimi-code');
}

const KIMI_SESSION_ID_RE = /^session_[A-Za-z0-9._-]+$/;

export function isKimiSessionId(id: string | undefined): id is string {
  return !!id && KIMI_SESSION_ID_RE.test(id);
}

interface IndexEntry { sessionId: string; sessionDir: string; workDir?: string }

function readIndex(home: string): IndexEntry[] {
  let text: string;
  try { text = readFileSync(join(home, 'session_index.jsonl'), 'utf8'); } catch { return []; }
  const deleted = new Set<string>();
  const entries: IndexEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { sessionId?: unknown; sessionDir?: unknown; workDir?: unknown; deleted?: unknown };
      if (typeof row.sessionId !== 'string' || !isKimiSessionId(row.sessionId)) continue;
      if (row.deleted === true) { deleted.add(row.sessionId); continue; }
      if (typeof row.sessionDir !== 'string') continue;
      entries.push({ sessionId: row.sessionId, sessionDir: row.sessionDir, workDir: typeof row.workDir === 'string' ? row.workDir : undefined });
    } catch { /* torn line */ }
  }
  return entries.filter(e => !deleted.has(e.sessionId));
}

function sameDir(a: string, b: string): boolean {
  const variants = (p: string) => {
    const out = [resolve(p)];
    try { out.push(realpathSync(p)); } catch { /* lexical only */ }
    return out;
  };
  const left = variants(a);
  return variants(b).some(v => left.includes(v));
}

/**
 * The Kimi session id that belongs to `botmuxSessionId` in `workingDir`, or
 * undefined. Newest first: a later index line wins over an earlier one.
 */
export function findKimiSessionForBotmuxSession(
  botmuxSessionId: string,
  workingDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!botmuxSessionId) return undefined;
  const home = kimiHome(env);
  const sessionsRoot = resolve(join(home, 'sessions')) + sep;
  const marker = `<session_id>${botmuxSessionId}</session_id>`;
  const entries = readIndex(home).reverse();
  for (const entry of entries) {
    if (workingDir && entry.workDir && !sameDir(entry.workDir, workingDir)) continue;
    const dir = resolve(entry.sessionDir);
    // Same containment rule Kimi applies to index entries.
    if (!dir.startsWith(sessionsRoot) || dir.split(sep).pop() !== entry.sessionId) continue;
    let wire: string;
    try { wire = readFileSync(join(dir, 'agents', 'main', 'wire.jsonl'), 'utf8'); } catch { continue; }
    if (wire.includes(marker)) return entry.sessionId;
  }
  return undefined;
}
