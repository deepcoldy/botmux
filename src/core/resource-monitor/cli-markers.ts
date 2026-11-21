import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config.js';
import type { CliMarkerInfo } from './attribution.js';

/**
 * Parse one `.botmux-cli-pids/<pid>` marker.
 *
 * Legacy markers contain only the session id; current markers are JSON with
 * `sessionId` + the process birth stamp (`procStart`). The birth stamp is what
 * lets a consumer reject a recycled pid — the marker file itself is written by
 * the worker (and is therefore not a security proof), so callers MUST validate
 * the stamp against the live `/proc/<pid>/stat` before trusting it.
 */
export function parseCliPidMarker(raw: string): CliMarkerInfo | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { sessionId?: unknown; procStart?: unknown };
    return typeof parsed.sessionId === 'string' && parsed.sessionId
      ? {
        sessionId: parsed.sessionId,
        ...(typeof parsed.procStart === 'string' && parsed.procStart ? { procStart: parsed.procStart } : {}),
      }
      : null;
  } catch {
    return { sessionId: trimmed };
  }
}

/** Read every numeric CLI pid marker. Corrupt/legacy rows are ignored or
 *  normalized; callers still validate `procStart` against the live process. */
export function readCliPidMarkers(dataDir = config.session.dataDir): Map<number, CliMarkerInfo> {
  const out = new Map<number, CliMarkerInfo>();
  const dir = join(dataDir, '.botmux-cli-pids');
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return out;
  }
  for (const file of files) {
    if (!/^\d+$/.test(file)) continue;
    try {
      const marker = parseCliPidMarker(readFileSync(join(dir, file), 'utf8'));
      if (marker) out.set(Number(file), marker);
    } catch {
      // Ignore stale or corrupt markers; attribution remains unknown.
    }
  }
  return out;
}
