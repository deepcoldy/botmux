/**
 * Inputs a worker had accepted from the daemon but not yet written to its CLI
 * when the daemon shut it down (`botmux restart`, daemon crash).
 *
 * The daemon stops tracking an ordinary Lark turn once the worker receipts it,
 * and a persistent pane keeps the CLI alive across the restart — so an input
 * still queued in the worker (waiting for the CLI's first prompt, or behind a
 * running turn) used to vanish with the worker: the card said received, the
 * CLI never saw it. The exiting worker saves those inputs here; the next
 * worker of the same session takes them back and delivers them, or — past
 * {@link UNSENT_INPUT_MAX_AGE_MS} — reports them as not delivered.
 *
 * Taking moves the file aside (`<path>.taken`) instead of deleting it; the
 * taker removes it once every input is written to its CLI
 * ({@link settleTakenUnsentInputs}). A `.taken` file found by a later worker
 * means its predecessor died part-way: which inputs reached the CLI is
 * unknown, so they are reported as unconfirmed — neither dropped silently nor
 * typed in twice.
 *
 * Only plain inputs are saved: durable / meeting / Codex App / continuation /
 * queued-activation / at-most-once inputs have their own recovery owners or
 * must never be replayed (see {@link isUnsentInputReplayable}).
 */
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { isJsonObject, readJsonFileSoft } from '../utils/json-file.js';
import type { PendingCliInput } from '../utils/pending-input-queue.js';

/** Same bound as the pending-turn journal (BRIDGE_TURN_RESTORE_MAX_AGE_MS): a
 *  message from a day ago typed into a conversation that has moved on is
 *  noise; it is reported instead. */
export const UNSENT_INPUT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface UnsentInputFile {
  version: 1;
  /** The earliest save of any input in the file. */
  savedAtMs: number;
  inputs: PendingCliInput[];
  /** When each input was first saved, aligned with `inputs`; only written when
   *  they differ, i.e. a worker appended behind an earlier one. */
  inputSavedAtMs?: number[];
}

interface SavedUnsentInput {
  input: PendingCliInput;
  savedAtMs: number;
}

export function isUnsentInputReplayable(item: PendingCliInput): boolean {
  return item.dispatchAttempt === undefined
    && !item.noReplay
    && !item.durablePrimaryInbox
    && !item.vcMeetingImTurnOrigin
    && !item.codexAppInput
    && !item.codexAppDispatchId
    && !item.queuedActivationToken
    && !item.taskContinuation
    && !item.mojoLivePatch
    && typeof item.content === 'string'
    && item.content.length > 0;
}

/** The journal a worker of `sessionId` writes under its SESSION_DATA_DIR,
 *  which the daemon sets to its own session data dir. Read by the daemon to
 *  tell whether an exiting worker left inputs for a successor. */
export function unsentInputJournalFile(dataDir: string, sessionId: string): string {
  return join(dataDir, 'turn-marks', `${sessionId}.unsent.json`);
}

/** Saved inputs no worker has taken back yet. */
export function hasUnsentInputs(path: string): boolean {
  return (readUnsentInputFile(path)?.length ?? 0) > 0;
}

/** Save the replayable inputs (nothing to save removes any older file). */
export function saveUnsentInputs(path: string, items: readonly PendingCliInput[], nowMs: number = Date.now()): number {
  const inputs = items.filter(isUnsentInputReplayable);
  if (inputs.length === 0) {
    rmSync(path, { force: true });
    return 0;
  }
  writeUnsentInputFile(path, inputs.map(input => ({ input, savedAtMs: nowMs })));
  return inputs.length;
}

/** Save the replayable inputs behind the ones an earlier worker saved and no
 *  worker has taken back yet. Each input keeps the time it was first saved, so
 *  {@link UNSENT_INPUT_MAX_AGE_MS} applies to it on its own. */
export function appendUnsentInputs(path: string, items: readonly PendingCliInput[], nowMs: number = Date.now()): number {
  const inputs = items.filter(isUnsentInputReplayable);
  if (inputs.length === 0) return 0;
  writeUnsentInputFile(path, [...(readUnsentInputFile(path) ?? []), ...inputs.map(input => ({ input, savedAtMs: nowMs }))]);
  return inputs.length;
}

function writeUnsentInputFile(path: string, entries: readonly SavedUnsentInput[]): void {
  const savedAtMs = Math.min(...entries.map(entry => entry.savedAtMs));
  const payload: UnsentInputFile = { version: 1, savedAtMs, inputs: entries.map(entry => entry.input) };
  if (entries.some(entry => entry.savedAtMs !== savedAtMs)) payload.inputSavedAtMs = entries.map(entry => entry.savedAtMs);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(payload)}\n`, { mode: 0o600, followTargetSymlink: false });
}

function takenPath(path: string): string {
  return `${path}.taken`;
}

function readUnsentInputFile(path: string): SavedUnsentInput[] | null {
  const parsed = readJsonFileSoft<UnsentInputFile | null>(path, {
    fallback: () => null,
    validate: (v): v is UnsentInputFile =>
      isJsonObject(v) && v.version === 1 && typeof v.savedAtMs === 'number' && Array.isArray(v.inputs),
    label: 'unsent-input-journal',
  });
  if (!parsed) return null;
  const times = Array.isArray(parsed.inputSavedAtMs) && parsed.inputSavedAtMs.length === parsed.inputs.length
    ? parsed.inputSavedAtMs : undefined;
  return parsed.inputs.flatMap((item, index) => isJsonObject(item) && isUnsentInputReplayable(item as PendingCliInput)
    ? [{ input: item as PendingCliInput, savedAtMs: typeof times?.[index] === 'number' ? times[index] : parsed.savedAtMs }]
    : []);
}

/** Take the saved inputs back: `inputs` to deliver (they move aside until
 *  {@link settleTakenUnsentInputs}), `expired` — those saved longer ago than
 *  `maxAgeMs`, and `unconfirmed` — inputs a previous taker may or may not have
 *  written before it died. */
export function takeUnsentInputs(
  path: string,
  opts: { nowMs?: number; maxAgeMs?: number } = {},
): { inputs: PendingCliInput[]; expired: PendingCliInput[]; unconfirmed: PendingCliInput[] } {
  const stale = readUnsentInputFile(takenPath(path));
  rmSync(takenPath(path), { force: true });
  const unconfirmed = stale?.map(entry => entry.input) ?? [];
  const saved = readUnsentInputFile(path) ?? [];
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? UNSENT_INPUT_MAX_AGE_MS;
  const fresh = saved.filter(entry => nowMs - entry.savedAtMs <= maxAgeMs);
  const expired = saved.filter(entry => nowMs - entry.savedAtMs > maxAgeMs).map(entry => entry.input);
  if (fresh.length === 0) {
    rmSync(path, { force: true });
    return { inputs: [], expired, unconfirmed };
  }
  // A later taker reports what is set aside as unconfirmed: only the inputs handed out.
  if (expired.length > 0) writeUnsentInputFile(path, fresh);
  renameSync(path, takenPath(path));
  return { inputs: fresh.map(entry => entry.input), expired, unconfirmed };
}

/** Every taken input reached the CLI (or was handed on again by a save). */
export function settleTakenUnsentInputs(path: string): void {
  rmSync(takenPath(path), { force: true });
}
