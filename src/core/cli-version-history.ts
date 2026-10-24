/**
 * Persisted per-runtime CLI version transitions.
 *
 * The daemon's version cache lives in memory, so an upgrade that lands across a
 * daemon restart — the usual case, CLIs such as Grok Build update themselves in
 * the background and the next restart is the daemon's first look — used to log
 * only "CLI version: 1.0.67", with nothing remembering it had been 1.0.62 the
 * day before. Startup-stall notices read this to say "just upgraded to x.y.z",
 * which is usually the real explanation for a CLI that suddenly stops starting.
 *
 * One small JSON file shared by every daemon on the host (keys are runtime
 * installation keys, which are the same across bots using the same binary).
 * Each write re-reads the file first and only touches its own key; two daemons
 * racing on the same transition write equivalent records.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

const HISTORY_FILE = 'cli-version-history.json';
/** How long after a detected version change a startup stall is reported as
 *  "just upgraded". 3 days: a daily scheduled task's next run, even when the
 *  upgrade lands right before a weekend. */
export const RECENT_CLI_UPGRADE_WINDOW_MS = 3 * 24 * 60 * 60_000;

export interface CliVersionRecord {
  version: string;
  previousVersion?: string;
  changedAtMs?: number;
}

export interface CliUpgrade {
  from: string;
  to: string;
}

/** `1.0.67 (2fe064390d07) [stable]` → `1.0.67`; falls back to the trimmed raw
 *  string so CLIs with non-numeric versions still compare. Build hashes and
 *  channel tags are not version changes (the daemon has logged
 *  "1.0.67 (…) → 1.0.67 (…) [stable]" as an "update"). */
export function normalizeCliVersion(raw: string): string {
  const m = /\d+(?:\.\d+)+(?:-[0-9A-Za-z.]+)?/.exec(raw);
  return m ? m[0] : raw.trim();
}

function historyPath(dataDir: string): string {
  return join(dataDir, HISTORY_FILE);
}

function readHistory(dataDir: string): Record<string, CliVersionRecord> {
  try {
    const parsed = JSON.parse(readFileSync(historyPath(dataDir), 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Record the version observed for `runtimeKey`; returns the stored record.
 *  Best-effort: an unreadable/unwritable file never throws. */
export function noteObservedCliVersion(
  runtimeKey: string,
  rawVersion: string,
  opts: { dataDir?: string; nowMs?: number } = {},
): CliVersionRecord | undefined {
  const version = normalizeCliVersion(rawVersion);
  if (!version) return undefined;
  const dataDir = opts.dataDir ?? config.session.dataDir;
  try {
    const history = readHistory(dataDir);
    const prior = history[runtimeKey];
    if (prior && typeof prior.version === 'string' && prior.version === version) return prior;
    const next: CliVersionRecord = prior && typeof prior.version === 'string'
      ? { version, previousVersion: prior.version, changedAtMs: opts.nowMs ?? Date.now() }
      // First sighting: no transition is known, so never claim an upgrade.
      : { version };
    history[runtimeKey] = next;
    atomicWriteFileSync(historyPath(dataDir), `${JSON.stringify(history, null, 2)}\n`);
    return next;
  } catch {
    return undefined;
  }
}

/** The upgrade to mention in a startup-stall notice, if the runtime changed
 *  version within {@link RECENT_CLI_UPGRADE_WINDOW_MS}. */
export function recentCliUpgrade(
  runtimeKey: string,
  opts: { dataDir?: string; nowMs?: number; windowMs?: number } = {},
): CliUpgrade | undefined {
  const record = readHistory(opts.dataDir ?? config.session.dataDir)[runtimeKey];
  if (!record?.previousVersion || typeof record.changedAtMs !== 'number') return undefined;
  const age = (opts.nowMs ?? Date.now()) - record.changedAtMs;
  if (age < 0 || age > (opts.windowMs ?? RECENT_CLI_UPGRADE_WINDOW_MS)) return undefined;
  return { from: record.previousVersion, to: record.version };
}
