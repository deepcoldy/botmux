/**
 * Issuance ledger for main-session turns the run-owning daemon opens to hand
 * a workflow run's own events to its main bot (`workflow-event:<runId>:<seq>`,
 * design §13.1 / §13.6).
 *
 * Like `isScheduledTurnLive` for scheduled turns, the turn id alone proves
 * nothing: a `workflow-event:` turn is recognised only when the daemon that
 * owns the run recorded, before starting the turn, exactly which session it
 * issued it to. Records are create-once files under the run directory (host
 * state; masked from sandboxed CLIs). The issuer is the main-wake wiring
 * (`core/workflow-main-wake.ts`): it records the turn in the trigger's
 * write-ahead hook, right before the turn reaches the session's worker, so a
 * record exists exactly for wake turns that were handed to a worker — and the
 * create-once file is also what keeps one event from waking the bot twice.
 */

import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { fsyncDirectorySyncPortable } from '../../utils/fs-durability.js';

export interface V3MainWakeRecord {
  runId: string;
  eventSeq: number;
  turnId: string;
  sessionId: string;
  larkAppId: string;
  chatId: string;
  rootMessageId?: string;
  /** Epoch ms. */
  issuedAt: number;
  /** The session's turn pointers when the wake turn was issued. A later
   *  human inbound message advances them past both these values and the
   *  wake turn's own id — the wake turn then no longer owns the session, and
   *  a request from it is authenticated as that newer message's turn instead
   *  (its sender: the initiator stays direct, anyone else proposes).
   *
   *  Contract for the issuer (the M6 wake-up): it MUST record this
   *  snapshot when it opens the wake turn. A record without it counts as
   *  overtaken whenever the session has any pointer (the verifier cannot
   *  tell an old pointer from a newer message), so the wake turn would never
   *  act for the initiator.
   *
   *  Synthetic turns: a pointer an unattended daemon-minted turn moved
   *  (`trg_` report relay, another `workflow-event:` wake, `schedule:`) does
   *  not count as overtaking — nobody interjected — so such a turn queued
   *  behind the wake turn leaves it acting. Only those prefixes are exempt
   *  (`isUnattendedSyntheticTurnId`); every other pointer still counts. */
  turnPointersAtIssue?: { quoteTargetId?: string; currentReplyTargetTurnId?: string };
}

const MAIN_WAKES_DIR = 'main-wakes';

function recordPath(runDir: string, eventSeq: number): string {
  if (!Number.isSafeInteger(eventSeq) || eventSeq < 1) throw new Error(`invalid wake event position ${eventSeq}`);
  return join(runDir, MAIN_WAKES_DIR, `${eventSeq}.json`);
}

/** Daemon side: record a wake turn before starting it. Create-once — a second
 *  issue for the same event position is refused. */
export function recordV3MainWakeIssued(runDir: string, record: V3MainWakeRecord): void {
  const dir = join(runDir, MAIN_WAKES_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('main-wakes must be a real directory');
  const fd = openSync(
    recordPath(runDir, record.eventSeq),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectorySyncPortable(dir);
}

/** The issued record for one event position, or undefined. */
export function readV3MainWakeIssued(runDir: string, eventSeq: number): V3MainWakeRecord | undefined {
  const path = recordPath(runDir, eventSeq);
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<V3MainWakeRecord>;
    if (
      typeof raw.runId !== 'string' || raw.eventSeq !== eventSeq || typeof raw.turnId !== 'string' ||
      typeof raw.sessionId !== 'string' || typeof raw.larkAppId !== 'string' || typeof raw.chatId !== 'string' ||
      typeof raw.issuedAt !== 'number'
    ) return undefined;
    return raw as V3MainWakeRecord;
  } catch {
    return undefined;
  }
}

/** Daemon side: take back the record of a wake turn the session's worker
 *  provably never received (it refused the input synchronously, before
 *  accepting it) so the event can be issued again. Only the exact turn this
 *  caller recorded is removed. */
export function retractV3MainWakeIssued(runDir: string, eventSeq: number, turnId: string): boolean {
  const issued = readV3MainWakeIssued(runDir, eventSeq);
  if (!issued || issued.turnId !== turnId) return false;
  unlinkSync(recordPath(runDir, eventSeq));
  fsyncDirectorySyncPortable(join(runDir, MAIN_WAKES_DIR));
  return true;
}
