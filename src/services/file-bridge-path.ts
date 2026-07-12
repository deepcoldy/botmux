/**
 * Pure path lookup for file-based structured-bridge CLIs (JSONL / events).
 *
 * Converges the duplicated isCoco/isPi/isGrok/isTraex/codex switch trees in
 * the worker timer + notify paths. Does NOT own attach mode, watchers, or
 * SQLite bridges (hermes/mtr) — those stay on dedicated worker paths.
 *
 * Lookup order: sessionId (when provided) first, then pid. Returns the first
 * existing path, or undefined.
 */
import { existsSync } from 'node:fs';
import { findCodexRolloutByPid, findCodexRolloutBySessionId } from './codex-transcript.js';
import { findTraexRolloutByPid, findTraexRolloutBySessionId } from './traex-transcript.js';
import { cocoEventsPathForSession, findCocoSessionByPid } from './coco-transcript.js';
import { findPiTranscriptByPid, findPiTranscriptBySessionId } from './pi-transcript.js';
import { findGrokSessionByPid, findGrokUpdatesBySessionId } from './grok-transcript.js';
import { findCursorTranscriptByChatId, findCursorTranscriptByPid } from './cursor-transcript.js';

export interface FileBridgePathOpts {
  sessionId?: string;
  cwd?: string;
  pid?: number;
}

/** Resolve a transcript/events path for a file-backed structured-bridge CLI. */
export function resolveFileBridgePath(
  cliId: string | undefined,
  opts: FileBridgePathOpts,
): string | undefined {
  if (!cliId) return undefined;
  const { sessionId, cwd, pid } = opts;

  if (sessionId) {
    const bySid = resolveBySessionId(cliId, sessionId, cwd);
    if (bySid) return bySid;
  }
  if (pid != null && Number.isInteger(pid) && pid > 0) {
    return resolveByPid(cliId, pid);
  }
  return undefined;
}

function resolveBySessionId(cliId: string, sessionId: string, cwd?: string): string | undefined {
  switch (cliId) {
    case 'coco': {
      const p = cocoEventsPathForSession(sessionId);
      return existsSync(p) ? p : undefined;
    }
    case 'pi':
      return findPiTranscriptBySessionId(sessionId, cwd);
    case 'grok':
      return findGrokUpdatesBySessionId(sessionId, cwd);
    case 'traex':
      return findTraexRolloutBySessionId(sessionId);
    case 'cursor':
      return findCursorTranscriptByChatId(sessionId);
    case 'codex':
      return findCodexRolloutBySessionId(sessionId);
    default:
      return undefined;
  }
}

function resolveByPid(cliId: string, pid: number): string | undefined {
  switch (cliId) {
    case 'coco': {
      const probed = findCocoSessionByPid(pid);
      return probed && existsSync(probed.eventsPath) ? probed.eventsPath : undefined;
    }
    case 'pi':
      return findPiTranscriptByPid(pid)?.path;
    case 'grok': {
      const probed = findGrokSessionByPid(pid);
      return probed && existsSync(probed.updatesPath) ? probed.updatesPath : undefined;
    }
    case 'traex':
      return findTraexRolloutByPid(pid)?.path;
    case 'cursor':
      return findCursorTranscriptByPid(pid)?.path;
    case 'codex':
      return findCodexRolloutByPid(pid)?.path;
    default:
      return undefined;
  }
}
