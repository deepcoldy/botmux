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
import { dirname } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { isJsonObject, readJsonFileSoft } from '../utils/json-file.js';
import type { PendingCliInput } from '../utils/pending-input-queue.js';

/** Same bound as the pending-turn journal (BRIDGE_TURN_RESTORE_MAX_AGE_MS): a
 *  message from a day ago typed into a conversation that has moved on is
 *  noise; it is reported instead. */
export const UNSENT_INPUT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface UnsentInputFile {
  version: 1;
  savedAtMs: number;
  inputs: PendingCliInput[];
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

/** Save the replayable inputs (nothing to save removes any older file). */
export function saveUnsentInputs(path: string, items: readonly PendingCliInput[], nowMs: number = Date.now()): number {
  const inputs = items.filter(isUnsentInputReplayable);
  if (inputs.length === 0) {
    rmSync(path, { force: true });
    return 0;
  }
  const payload: UnsentInputFile = { version: 1, savedAtMs: nowMs, inputs };
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(payload)}\n`, { mode: 0o600, followTargetSymlink: false });
  return inputs.length;
}

function takenPath(path: string): string {
  return `${path}.taken`;
}

function readUnsentInputFile(path: string): { savedAtMs: number; inputs: PendingCliInput[] } | null {
  const parsed = readJsonFileSoft<UnsentInputFile | null>(path, {
    fallback: () => null,
    validate: (v): v is UnsentInputFile =>
      isJsonObject(v) && v.version === 1 && typeof v.savedAtMs === 'number' && Array.isArray(v.inputs),
    label: 'unsent-input-journal',
  });
  if (!parsed) return null;
  return {
    savedAtMs: parsed.savedAtMs,
    inputs: parsed.inputs.filter(item => isJsonObject(item) && isUnsentInputReplayable(item as PendingCliInput)),
  };
}

/** Take the saved inputs back: `inputs` to deliver (the file moves aside until
 *  {@link settleTakenUnsentInputs}), `expired` when saved longer ago than
 *  `maxAgeMs`, and `unconfirmed` — inputs a previous taker may or may not have
 *  written before it died. */
export function takeUnsentInputs(
  path: string,
  opts: { nowMs?: number; maxAgeMs?: number } = {},
): { inputs: PendingCliInput[]; expired: PendingCliInput[]; unconfirmed: PendingCliInput[] } {
  const stale = readUnsentInputFile(takenPath(path));
  rmSync(takenPath(path), { force: true });
  const unconfirmed = stale?.inputs ?? [];
  const saved = readUnsentInputFile(path);
  if (!saved || saved.inputs.length === 0) {
    rmSync(path, { force: true });
    return { inputs: [], expired: [], unconfirmed };
  }
  const fresh = (opts.nowMs ?? Date.now()) - saved.savedAtMs <= (opts.maxAgeMs ?? UNSENT_INPUT_MAX_AGE_MS);
  if (!fresh) {
    rmSync(path, { force: true });
    return { inputs: [], expired: saved.inputs, unconfirmed };
  }
  renameSync(path, takenPath(path));
  return { inputs: saved.inputs, expired: [], unconfirmed };
}

/** Every taken input reached the CLI (or was handed on again by a save). */
export function settleTakenUnsentInputs(path: string): void {
  rmSync(takenPath(path), { force: true });
}
