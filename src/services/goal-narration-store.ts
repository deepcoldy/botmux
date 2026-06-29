/**
 * services/goal-narration-store.ts — a best-effort, per-goal append log of the
 * human-readable narration events that {@link ../verified-delivery/narration.ts}
 * emits to the goal group (人类决策到达 / accept / reject / escalate / help).
 *
 * Purpose: give the dashboard goal board the SAME clean event stream the chat
 * shows, including the one event that is NOT a ledger fact — 「人类决策到达」.
 * The ledger stays the truth source for delivery state; this is only an
 * observability mirror (chat ⇄ dashboard parity), so it is intentionally
 * best-effort: atomic per-goal writes (no corruption), tolerant reads, and a
 * small per-goal cap. Lost updates under rare cross-process concurrency are
 * acceptable for an observation log.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';

export interface GoalNarrationRecord {
  goalChatId: string;
  /** Narration event type: human-decision | accepted | rejected | escalated | help. */
  type: string;
  taskId?: string;
  /** The rendered human-readable narration text (same as the chat card). */
  text: string;
  ts: number;
}

/** Keep the per-goal log small — this is a recent-activity view, not an archive. */
const MAX_PER_GOAL = 50;

function dir(): string {
  return join(config.session.dataDir, 'goal-narrations');
}

/** chatId → safe filename (oc_… is already safe; guard anything unexpected). */
function safeName(goalChatId: string): string {
  return goalChatId.replace(/[^A-Za-z0-9_-]/g, '_');
}

function storePath(goalChatId: string): string {
  return join(dir(), `${safeName(goalChatId)}.json`);
}

function load(goalChatId: string): GoalNarrationRecord[] {
  const fp = storePath(goalChatId);
  if (!existsSync(fp)) return [];
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as GoalNarrationRecord[]) : [];
  } catch (err) {
    logger.warn(`[goal-narration-store] read failed for ${safeName(goalChatId)}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** Append one narration event to its goal's log (best-effort; never throws). */
export function recordGoalNarration(rec: GoalNarrationRecord): void {
  try {
    mkdirSync(dir(), { recursive: true });
    const all = load(rec.goalChatId);
    all.push(rec);
    const trimmed = all.slice(-MAX_PER_GOAL);
    atomicWriteFileSync(storePath(rec.goalChatId), JSON.stringify(trimmed, null, 2));
  } catch (err) {
    logger.warn(`[goal-narration-store] write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Recent narration events for one goal, newest first (default last 20). */
export function readGoalNarrations(goalChatId: string, limit = 20): GoalNarrationRecord[] {
  const all = load(goalChatId);
  return all.slice(-limit).reverse();
}

/** Goal chatIds that have a narration log (for board read-model joins). */
export function listGoalNarrationChatIds(): Set<string> {
  const out = new Set<string>();
  try {
    for (const f of readdirSync(dir())) {
      if (f.endsWith('.json')) out.add(f.slice(0, -'.json'.length));
    }
  } catch { /* dir may not exist yet */ }
  return out;
}
