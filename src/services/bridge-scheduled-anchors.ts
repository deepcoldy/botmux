/**
 * Durable store of built-in CronCreate task → Lark topic anchors.
 *
 * The bridge attribution queue (`BridgeTurnQueue`) keeps the
 * scheduledTaskId → reply-anchor map in worker memory. CronCreate tasks are
 * session-scoped and outlive the WORKER: under a persistent (tmux) backend a
 * worker restart only detaches observation — Claude and its scheduled jobs
 * keep running. Without persistence the new worker loses every task's
 * create-time topic, and a later message in a DIFFERENT topic would make the
 * first post-restart fire route into that wrong topic. This file makes the
 * anchors survive that restart, mirroring the pending-turn journal in
 * bridge-turn-journal.ts (atomic tmp+rename, per-session file).
 *
 * A task created from a local-terminal turn (no Lark turn involved) has anchor
 * null: the worker then omits replyTurnId and the daemon uses its default
 * routing. Recording null explicitly (vs. omitting the key) matters — it
 * proves the task WAS observed, so recovery must not borrow a later topic's
 * anchor for it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** CronCreate jobs auto-expire after 7 days; a bounded store also has to
 *  survive pathological create storms. Oldest entries shed first. */
const MAX_ANCHOR_ENTRIES = 64;

export interface ScheduledTaskAnchorRecord {
  /** Lark turn id whose topic this task reports into; null when created from
   *  a local-terminal turn with no Lark context. */
  anchor: string | null;
  createdAtMs: number;
}

interface ScheduledTaskAnchorFile {
  version: 1;
  tasks: Record<string, ScheduledTaskAnchorRecord>;
}

export function readScheduledTaskAnchors(path: string): Map<string, string | undefined> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return new Map();
  }
  try {
    const parsed = JSON.parse(raw) as ScheduledTaskAnchorFile;
    if (parsed?.version !== 1 || typeof parsed.tasks !== 'object' || parsed.tasks === null) {
      return new Map();
    }
    const out = new Map<string, string | undefined>();
    for (const [taskId, rec] of Object.entries(parsed.tasks)) {
      if (!taskId || !rec || typeof rec !== 'object') continue;
      if (rec.anchor !== null && typeof rec.anchor !== 'string') continue;
      out.set(taskId, rec.anchor ?? undefined);
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Persist (or overwrite) one task's anchor. Read-modify-write keeps the
 *  store self-contained so the worker doesn't have to mirror it in memory. */
export function upsertScheduledTaskAnchor(
  path: string,
  taskId: string,
  anchor: string | undefined,
  nowMs: number = Date.now(),
): void {
  const tasks: Record<string, ScheduledTaskAnchorRecord> = {};
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as ScheduledTaskAnchorFile;
    if (parsed?.version === 1 && typeof parsed.tasks === 'object' && parsed.tasks !== null) {
      Object.assign(tasks, parsed.tasks);
    }
  } catch { /* missing/corrupt → start fresh */ }

  tasks[taskId] = { anchor: anchor ?? null, createdAtMs: nowMs };

  const entries = Object.entries(tasks)
    .sort((a, b) => a[1].createdAtMs - b[1].createdAtMs);
  const bounded = entries.length > MAX_ANCHOR_ENTRIES
    ? entries.slice(entries.length - MAX_ANCHOR_ENTRIES)
    : entries;
  const payload: ScheduledTaskAnchorFile = {
    version: 1,
    tasks: Object.fromEntries(bounded),
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  renameSync(tmpPath, path);
}
