/**
 * Restart-intent breadcrumb: a small file written just before an *intentional*
 * restart (manual `botmux restart`, or an auto-update that restarts to apply).
 * On the next daemon startup the primary daemon consumes it to decide whether
 * to DM the owner a restart summary.
 *
 * A pm2 crash-autorestart (or machine reboot) writes no breadcrumb, so the
 * fresh daemon stays silent — this is how we distinguish "crash" from
 * "intentional restart" without a debounce. See core/maintenance.ts and
 * core/restart-report.ts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

export type RestartKind = 'manual' | 'update';

export interface RestartIntent {
  kind: RestartKind;
  /** Present for kind==='update': the changelog/version delta to report. */
  oldVersion?: string;
  newVersion?: string;
  /** ISO 8601 timestamp the breadcrumb was written. */
  at: string;
}

const FILE = 'restart-intent.json';

/** Breadcrumbs older than this are stale (an aborted/failed restart left it)
 *  and never produce a report. */
export const RESTART_INTENT_FRESH_MS = 10 * 60_000;

export function restartIntentPathIn(dir: string): string {
  return join(dir, FILE);
}

export function writeRestartIntentTo(dir: string, intent: RestartIntent): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = restartIntentPathIn(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(intent, null, 2) + '\n');
  renameSync(tmp, path);
}

function readRaw(dir: string): RestartIntent | null {
  const path = restartIntentPathIn(dir);
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, 'utf-8'));
    if (v && typeof v === 'object' && typeof v.kind === 'string' && typeof v.at === 'string') {
      return v as RestartIntent;
    }
  } catch {
    /* corrupt → treated as absent (and cleaned up by consume) */
  }
  return null;
}

function isFresh(intent: RestartIntent, nowMs: number): boolean {
  const at = Date.parse(intent.at);
  return Number.isFinite(at) && Math.abs(nowMs - at) <= RESTART_INTENT_FRESH_MS;
}

/** Read + delete the breadcrumb. Always deletes (fresh, stale, or corrupt) so
 *  it fires at most once and never lingers into a later restart. Returns the
 *  intent only when it is fresh. */
export function consumeRestartIntentTo(dir: string, nowMs: number): RestartIntent | null {
  const intent = readRaw(dir);
  const path = restartIntentPathIn(dir);
  if (existsSync(path)) {
    try { rmSync(path); } catch { /* best-effort */ }
  }
  if (!intent) return null;
  return isFresh(intent, nowMs) ? intent : null;
}

/** Write a `manual` breadcrumb only when no *fresh* breadcrumb already exists —
 *  so a maintenance-written `update` breadcrumb is not clobbered
 *  by the `botmux restart` it spawns. */
export function writeManualIntentIfAbsentTo(dir: string, nowMs: number, atIso: string): void {
  const existing = readRaw(dir);
  if (existing && isFresh(existing, nowMs)) return;
  writeRestartIntentTo(dir, { kind: 'manual', at: atIso });
}

// ---- default-dir wrappers (production wiring) ----

export function writeRestartIntent(intent: RestartIntent): void {
  writeRestartIntentTo(config.session.dataDir, intent);
}

export function consumeRestartIntent(nowMs: number = Date.now()): RestartIntent | null {
  return consumeRestartIntentTo(config.session.dataDir, nowMs);
}

export function writeManualIntentIfAbsent(nowMs: number = Date.now()): void {
  writeManualIntentIfAbsentTo(config.session.dataDir, nowMs, new Date(nowMs).toISOString());
}
