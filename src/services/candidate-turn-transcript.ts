import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CliId } from '../adapters/cli/types.js';
import { candidateRuntimeCliId } from './candidate-runtime-contract.js';
import { cocoEventsPathForSession, drainCocoEvents } from './coco-transcript.js';
import {
  drainCodexRollout,
  findCodexRolloutBySessionId,
  type CodexBridgeEvent,
} from './codex-transcript.js';
import { drainTraexRollout, findTraexRolloutBySessionId } from './traex-transcript.js';
import type { CandidateTurnReceipt } from './candidate-turn-durability.js';

export type CandidateTurnTranscriptReconciliation =
  | { kind: 'not_found' }
  | { kind: 'submitted'; nativeSessionId: string; transcriptRef: string }
  | { kind: 'completed'; nativeSessionId: string; submitTranscriptRef: string; terminalTranscriptRef: string; output: string };

/** CoCo's explicit --session-id is the BotMux Session id for a fresh
 * Candidate spawn. Keep that binding here so worker IPC, restart recovery and
 * transcript lookup cannot disagree when no adapter-discovered id exists. */
export function candidateCocoTranscriptEvidence(input: {
  botmuxSessionId: string;
  cliSessionId?: string;
  transcriptRef?: string;
}): { nativeSessionId: string; transcriptRef: string } {
  const nativeSessionId = input.cliSessionId?.trim() || input.botmuxSessionId.trim();
  if (!nativeSessionId) throw new Error('Candidate CoCo native Session identity gap');
  return {
    nativeSessionId,
    transcriptRef: input.transcriptRef ?? cocoEventsPathForSession(nativeSessionId),
  };
}

function normalize(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function reconcileRolloutEvents(
  receipt: CandidateTurnReceipt,
  nativeSessionId: string,
  events: readonly CodexBridgeEvent[],
): CandidateTurnTranscriptReconciliation {
  const acceptedAtMs = Date.parse(receipt.createdAt);
  const expected = normalize(receipt.prompt);
  const userIndex = events.findIndex(event => event.kind === 'user'
    && normalize(event.text) === expected
    && (!Number.isFinite(acceptedAtMs) || event.timestampMs >= acceptedAtMs - 5_000));
  if (userIndex < 0) return { kind: 'not_found' };
  const user = events[userIndex]!;
  for (let index = userIndex + 1; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.kind === 'user') break;
    if (event.kind === 'assistant_final') {
      if (event.terminalStatus && event.terminalStatus !== 'completed') {
        return { kind: 'submitted', nativeSessionId, transcriptRef: user.uuid };
      }
      return {
        kind: 'completed',
        nativeSessionId,
        submitTranscriptRef: user.uuid,
        terminalTranscriptRef: event.uuid,
        output: event.text,
      };
    }
  }
  return { kind: 'submitted', nativeSessionId, transcriptRef: user.uuid };
}

export interface CandidateRuntimeTranscriptOptions {
  runtimeName: CliId;
  nativeSessionId: string;
  transcriptRef?: string;
  dataDir?: string;
  botmuxSessionId?: string;
}

/** Resolve Runtime acceptance from its durable user record. A PTY write is
 * intentionally insufficient: every adapter must expose an exact prompt match
 * in its native transcript before worker IPC may claim `turn_submitted`. */
export function candidateRuntimeSubmissionEvidence(input: {
  runtimeName: CliId;
  nativeSessionId: string;
  transcriptPath: string;
  expectedPrompt: string;
}): { nativeSessionId: string; transcriptRef: string } | undefined {
  const cliId = candidateRuntimeCliId(input.runtimeName);
  const events = cliId === 'traex'
    ? drainTraexRollout(input.transcriptPath, 0).events
    : cliId === 'codex'
      ? drainCodexRollout(input.transcriptPath, 0).events
      : cliId === 'coco'
        ? drainCocoEvents(input.transcriptPath, 0).events
        : [];
  const expected = normalize(input.expectedPrompt);
  const user = events.find(event => event.kind === 'user' && normalize(event.text) === expected);
  return user
    ? { nativeSessionId: input.nativeSessionId, transcriptRef: user.uuid }
    : undefined;
}

/** Rebuild one Candidate turn from the durable transcript owned by the
 * Runtime selected in the frozen release contract. Release-facing `coco`
 * currently selects BotMux's TRAE adapter, so restart recovery must follow
 * that same mapping instead of consulting the legacy Coco events file. */
export function reconcileCandidateRuntimeTranscript(
  receipt: CandidateTurnReceipt,
  options: CandidateRuntimeTranscriptOptions,
): CandidateTurnTranscriptReconciliation {
  const cliId = candidateRuntimeCliId(options.runtimeName);
  const explicitPath = options.transcriptRef && existsSync(options.transcriptRef)
    ? options.transcriptRef
    : undefined;
  if (cliId === 'traex') {
    const isolatedRoot = options.dataDir && options.botmuxSessionId
      ? join(options.dataDir, 'candidate-runtime', options.botmuxSessionId, 'home', '.trae', 'cli', 'sessions')
      : undefined;
    const rollout = explicitPath
      ?? findTraexRolloutBySessionId(options.nativeSessionId, isolatedRoot);
    if (!rollout) return { kind: 'not_found' };
    return reconcileRolloutEvents(
      receipt,
      options.nativeSessionId,
      drainTraexRollout(rollout, 0).events,
    );
  }
  if (cliId === 'codex') {
    const isolatedRoot = options.dataDir && options.botmuxSessionId
      ? join(options.dataDir, 'candidate-runtime', options.botmuxSessionId, 'home', '.codex', 'sessions')
      : undefined;
    const rollout = explicitPath
      ?? findCodexRolloutBySessionId(options.nativeSessionId, isolatedRoot);
    if (!rollout) return { kind: 'not_found' };
    return reconcileRolloutEvents(
      receipt,
      options.nativeSessionId,
      drainCodexRollout(rollout, 0).events,
    );
  }
  return { kind: 'not_found' };
}

/** Rebuild one Candidate turn from CoCo's durable native transcript. The
 * exact frozen prompt and acceptance time fence repeated text from older
 * turns; PTY/screen state is never consulted. */
export function reconcileCandidateCocoTranscript(
  receipt: CandidateTurnReceipt,
  nativeSessionId: string,
  eventsPath = cocoEventsPathForSession(nativeSessionId),
): CandidateTurnTranscriptReconciliation {
  const events = drainCocoEvents(eventsPath, 0).events;
  const acceptedAtMs = Date.parse(receipt.createdAt);
  const expected = normalize(receipt.prompt);
  const userIndex = events.findIndex(event => event.kind === 'user'
    && normalize(event.text) === expected
    && (!Number.isFinite(acceptedAtMs) || event.timestampMs >= acceptedAtMs - 5_000));
  if (userIndex < 0) return { kind: 'not_found' };
  const user = events[userIndex]!;
  for (let index = userIndex + 1; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.kind === 'user') break;
    if (event.kind === 'assistant_final') {
      return {
        kind: 'completed',
        nativeSessionId,
        submitTranscriptRef: user.uuid,
        terminalTranscriptRef: event.uuid,
        output: event.text,
      };
    }
  }
  return { kind: 'submitted', nativeSessionId, transcriptRef: user.uuid };
}
