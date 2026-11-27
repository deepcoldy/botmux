/**
 * Cross-daemon busy heartbeat. botmux runs one daemon process per bot, but a
 * restart (auto-restart / auto-update) takes them all down at once — so the
 * "is anything mid-CLI-turn right now?" gate must see across processes, not
 * just the primary daemon's own sessions.
 *
 * Each daemon periodically writes `<dataDir>/heartbeats/<larkAppId>.json` with
 * its count of actively-working sessions. The primary daemon reads them all;
 * any fresh heartbeat with busyCount > 0 blocks a maintenance restart.
 * A daemon that is down leaves a stale file, which is ignored (restarting is
 * safe when a daemon isn't even running).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { config } from '../config.js';
import { wecomRoot } from '../im/wecom/config/discovery.js';
import { wecomFleetDesiredStatePath } from '../im/wecom/config/fleet-desired-state.js';
import { listWecomFleetConnections } from '../im/wecom/config/fleet-members.js';

export interface Heartbeat {
  larkAppId: string;
  busyCount: number;
  at: string; // ISO 8601
}

/** A heartbeat older than this is treated as "daemon not reporting" → ignored.
 *  Daemons should write well within this window (≈ every 15s). */
export const HEARTBEAT_FRESH_MS = 60_000;

export function heartbeatDirIn(dir: string): string {
  return join(dir, 'heartbeats');
}

export function writeHeartbeatTo(dir: string, larkAppId: string, busyCount: number, atIso: string): void {
  const hbDir = heartbeatDirIn(dir);
  if (!existsSync(hbDir)) mkdirSync(hbDir, { recursive: true });
  const path = join(hbDir, `${sanitize(larkAppId)}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  const beat: Heartbeat = { larkAppId, busyCount, at: atIso };
  writeFileSync(tmp, JSON.stringify(beat));
  renameSync(tmp, path);
}

/** True iff any daemon reports a fresh heartbeat with at least one busy session. */
export function anyDaemonBusyTo(dir: string, nowMs: number, freshMs: number = HEARTBEAT_FRESH_MS): boolean {
  const hbDir = heartbeatDirIn(dir);
  if (!existsSync(hbDir)) return false;
  let files: string[];
  try { files = readdirSync(hbDir); } catch { return false; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    if (beatIsBusy(readBeat(join(hbDir, f)), nowMs, freshMs)) return true;
  }
  return false;
}

function beatIsBusy(beat: Heartbeat | null, nowMs: number, freshMs: number): boolean {
  if (!beat) return false;
  const at = Date.parse(beat.at);
  if (!Number.isFinite(at)) return false;
  if (nowMs - at > freshMs) return false; // stale → ignore
  return beat.busyCount > 0;
}

/**
 * WeCom connections each run their own core daemon, which writes this same
 * heartbeat into its own state directory:
 * `<managedCore.stateDir>/heartbeats/<managedCore.botId>.json`. A fleet restart
 * takes those cores down with the Feishu daemons, so the gate has to see their
 * turns too — but only for connections the fleet runs (desired `running`): a
 * gateway someone runs in a terminal is not touched by `botmux restart` and must
 * not hold an update back.
 *
 * A host that has never run a WeCom connection under the fleet has no
 * desired-state file; that one existence check is all it pays. Anything that
 * cannot be read counts as "not busy" and nothing here throws: an exception in
 * the gate would stop the Feishu fleet's auto-update.
 */
export function anyWecomCoreBusyIn(
  wecomRootDir: string,
  nowMs: number,
  freshMs: number = HEARTBEAT_FRESH_MS,
  listConnections: typeof listWecomFleetConnections = listWecomFleetConnections,
): boolean {
  try {
    if (!existsSync(wecomFleetDesiredStatePath(wecomRootDir))) return false;
    for (const connection of listConnections(wecomRootDir)) {
      if (connection.desired !== 'running' || connection.config.presence !== 'present') continue;
      const core = managedCoreOf(connection.config.text);
      if (!core) continue;
      const beatFile = join(heartbeatDirIn(core.stateDir), `${sanitize(core.botId)}.json`);
      if (beatIsBusy(readBeat(beatFile), nowMs, freshMs)) return true;
    }
  } catch {
    /* unreadable WeCom state → not busy */
  }
  return false;
}

/** The managed core a WeCom configuration runs, or undefined (external core, or unreadable). */
function managedCoreOf(configText: string): { stateDir: string; botId: string } | undefined {
  try {
    const managedCore = JSON.parse(configText)?.managedCore;
    if (!managedCore || typeof managedCore !== 'object') return undefined;
    const { stateDir, botId } = managedCore as { stateDir?: unknown; botId?: unknown };
    if (typeof stateDir !== 'string' || !isAbsolute(stateDir) || typeof botId !== 'string' || !botId) return undefined;
    return { stateDir: resolve(stateDir), botId };
  } catch {
    return undefined;
  }
}

function readBeat(path: string): Heartbeat | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf-8'));
    if (v && typeof v === 'object' && typeof v.busyCount === 'number' && typeof v.at === 'string') {
      return v as Heartbeat;
    }
  } catch {
    /* corrupt/partial write → ignore */
  }
  return null;
}

/** App ids are already filesystem-safe (cli_…), but guard against separators. */
function sanitize(larkAppId: string): string {
  return larkAppId.replace(/[^A-Za-z0-9._-]/g, '_');
}

// ---- default-dir wrappers (production wiring) ----

export function writeHeartbeat(larkAppId: string, busyCount: number): void {
  writeHeartbeatTo(config.session.dataDir, larkAppId, busyCount, new Date().toISOString());
}

/** The maintenance gate: a busy Feishu daemon, or a busy core of a WeCom
 *  connection the fleet runs (both go down with a fleet restart). */
export function anyDaemonBusy(nowMs: number = Date.now()): boolean {
  return anyDaemonBusyTo(config.session.dataDir, nowMs) || anyWecomCoreBusyIn(wecomRoot(), nowMs);
}
