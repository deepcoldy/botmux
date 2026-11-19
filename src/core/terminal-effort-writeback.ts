import type { Session } from '../types.js';
import type { DaemonSession } from './types.js';
import type { TerminalEffortChoice } from '../services/terminal-effort-choice.js';
import { TERMINAL_EFFORT_CHOICE_WINDOW_MS, terminalEffortPreferenceKey } from '../services/terminal-effort-choice.js';
import { isNativeReasoningEffort } from '../services/native-reasoning-observation.js';
import type { CodexReasoningEffort } from '../services/codex-reasoning-effort.js';

const savedChoices = new WeakMap<DaemonSession, string>();
function savedKey(ds: DaemonSession, nonce: string): string {
  return JSON.stringify([ds.workerGeneration, ds.session.cliSessionId, ds.localProcessAttestation?.cliSpawnGeneration, nonce]);
}
const explicitPreferenceEdits = new WeakMap<DaemonSession, number>();
/** An explicit card/command edit that happened after terminal intent wins. */
export function noteExplicitEffortPreferenceEdit(ds: DaemonSession, atMs = Date.now()): void {
  explicitPreferenceEdits.set(ds, atMs);
}
export function terminalEffortChoiceWasSaved(ds: DaemonSession, nonce: string): boolean {
  return savedChoices.get(ds) === savedKey(ds, nonce);
}
type Source = { worker: DaemonSession['worker']; workerGeneration: number | undefined; cliId: string };
type Observation = { reasoningEffort: unknown; claudeSessionId?: string; nativeSessionId?: string;
  cliId?: string; cliSpawnGeneration?: number; model?: string; observedAtMs?: number; source?: string; userSelection?: TerminalEffortChoice };
type Mutate = (ids: readonly string[], change: (rows: Map<string, Session>) => void,
  options?: { nonblocking?: boolean }) => { rows: Map<string, Session> };

/** A successful Grok selection can precede Botmux's static catalog (for
 * example Grok 4.7 xhigh). Reuse that fact only for its exact resumed model. */
export function hasConfirmedNativeGrokEffort(session: Session, model: string | undefined): boolean {
  const edit = session.terminalEffortPreferenceEdit;
  return session.cliId === 'grok' && !session.dispatchLaunchSpec && !session.adoptedFrom && !!model
    && edit?.source === 'terminal'
    && edit.nativeSessionId === session.cliSessionId && edit.nativeModel?.toLowerCase() === model.toLowerCase()
    && edit.nativeEffort === session.reasoningEffort && edit.nativeEffort === 'xhigh'
    && edit.nativeSnapshotHash === JSON.parse(terminalEffortPreferenceKey(session))[4];
}

/** Save a confirmed user choice, leaving runtime/card observations independent.
 * The durable transaction commits before either the store cache or ds is changed. */
export function persistTerminalEffortChoice(ds: DaemonSession, observation: Observation, source: Source,
  options: { enabled: boolean; enableEpoch?: number; mutate: Mutate; supportsEffort: (cli: string, model: string | undefined, effort: CodexReasoningEffort) => boolean; now?: number },
): boolean {
  const choice = observation.userSelection;
  const now = options.now ?? Date.now();
  if (!options.enabled || !choice || !source.worker || !source.workerGeneration
    || !Number.isSafeInteger(choice.enableEpoch) || choice.enableEpoch !== (options.enableEpoch ?? 0)
    || typeof choice.expectedPreference !== 'string' || choice.expectedPreference.length > 4096
    || ds.worker !== source.worker || ds.workerGeneration !== source.workerGeneration
    || ds.session.workerGeneration !== source.workerGeneration
    || !['claude-code', 'codex', 'traex', 'grok'].includes(source.cliId)
    || choice.cliId !== source.cliId || (observation.cliId !== undefined && observation.cliId !== source.cliId)
    || !ds.session.cliSessionId || choice.nativeSessionId !== ds.session.cliSessionId
    || (observation.claudeSessionId ?? observation.nativeSessionId) !== ds.session.cliSessionId
    || !Number.isSafeInteger(choice.cliSpawnGeneration) || choice.cliSpawnGeneration < 1
    || choice.cliSpawnGeneration !== ds.localProcessAttestation?.cliSpawnGeneration
    || (observation.cliSpawnGeneration !== undefined && observation.cliSpawnGeneration !== choice.cliSpawnGeneration)
    || !isNativeReasoningEffort(choice.requestedEffort) || observation.reasoningEffort !== choice.requestedEffort
    || typeof choice.nonce !== 'string' || !choice.nonce || choice.nonce.length > 512
    || !['terminal-input', 'claude-command'].includes(choice.source)
    || (choice.source === 'claude-command' && source.cliId !== 'claude-code')
    || (source.cliId === 'grok' && observation.source !== 'native-summary')
    || (['codex', 'traex'].includes(source.cliId) && !['native-settings', 'native-footer'].includes(observation.source ?? ''))
    || !Number.isFinite(choice.requestedAtMs) || !Number.isFinite(choice.confirmedAtMs)
    || choice.requestedAtMs <= 0 || choice.confirmedAtMs < choice.requestedAtMs || choice.confirmedAtMs > now
    || now - choice.requestedAtMs > TERMINAL_EFFORT_CHOICE_WINDOW_MS
    || (observation.observedAtMs !== undefined && observation.observedAtMs !== choice.confirmedAtMs)
    || (explicitPreferenceEdits.get(ds) ?? 0) >= choice.requestedAtMs
    || (ds.nativeReasoningObservation?.nativeSessionId === choice.nativeSessionId
      && ds.nativeReasoningObservation.workerGeneration === source.workerGeneration
      && (ds.nativeReasoningObservation.observedAtMs ?? 0) > choice.confirmedAtMs)
    || savedChoices.get(ds) === savedKey(ds, choice.nonce) || ds.session.status !== 'active'
    || ds.adoptedFrom || ds.session.adoptedFrom || ds.initConfig?.adoptMode
    || ds.session.dispatchLaunchSpec) return false;
  const model = ds.activeModel ?? ds.session.model;
  if (choice.model && model && choice.model.toLowerCase() !== model.toLowerCase()) return false;
  const nativeGrokXhigh = source.cliId === 'grok' && choice.requestedEffort === 'xhigh'
    && observation.source === 'native-summary' && choice.model === model && observation.model === model
    && /^grok-\d+\.\d+(?:-|$)/i.test(model ?? '');
  if (!options.supportsEffort(source.cliId, model, choice.requestedEffort) && !nativeGrokXhigh) return false;
  const before = ds.session;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const committed = options.mutate([before.sessionId], rows => {
    const row = rows.get(before.sessionId);
    const previousTerminal = row?.terminalEffortPreferenceEdit;
    const captured = JSON.parse(choice.expectedPreference);
    const current = row ? JSON.parse(terminalEffortPreferenceKey(row)) : undefined;
    // A previous terminal choice may commit while a newer terminal choice is
    // waiting for native confirmation. It is not an intervening manual edit.
    const olderTerminalWrite = previousTerminal?.source === 'terminal'
      && previousTerminal.enableEpoch === choice.enableEpoch
      && previousTerminal.requestedAtMs !== undefined && previousTerminal.requestedAtMs < choice.requestedAtMs
      && Array.isArray(captured) && Array.isArray(current)
      && same(captured[3], current[3]) && captured[4] === current[4] && captured[5] === current[5]
      && same(captured[2] ? { ...captured[2], effort: undefined } : null, current[2] ? { ...current[2], effort: undefined } : null);
    // A newer card/API choice or runtime replacement wins over this observation.
    if (!row || row.cliSessionId !== choice.nativeSessionId || row.workerGeneration !== source.workerGeneration
      || row.cliId !== source.cliId || row.status !== 'active'
      || row.dispatchLaunchSpec || row.adoptedFrom
      || (terminalEffortPreferenceKey(row) !== choice.expectedPreference && !olderTerminalWrite)
      || row.reasoningEffort !== before.reasoningEffort || !same(row.cliLaunchSnapshot, before.cliLaunchSnapshot)
      || !same(row.modelPin, before.modelPin)) throw new Error('terminal_effort_selection_stale');
    row.reasoningEffort = choice.requestedEffort;
    if (row.cliLaunchSnapshot) row.cliLaunchSnapshot.reasoningEffort = choice.requestedEffort;
    const topic = row.topicReasoningEffort;
    if (source.cliId === 'traex' && topic && topic.model.toLowerCase() === model?.toLowerCase()) {
      topic.effort = choice.requestedEffort;
    }
    row.terminalEffortPreferenceEdit = { atMs: now, source: 'terminal', requestedAtMs: choice.requestedAtMs, enableEpoch: choice.enableEpoch };
    if (nativeGrokXhigh) Object.assign(row.terminalEffortPreferenceEdit, {
      nativeSessionId: choice.nativeSessionId, nativeModel: model, nativeEffort: choice.requestedEffort,
      nativeSnapshotHash: JSON.parse(terminalEffortPreferenceKey(row))[4],
    });
    // modelPin remains authoritative on launch; never modify or clear it.
  }, { nonblocking: true });
  const row = committed.rows.get(before.sessionId);
  if (!row) throw new Error('terminal_effort_writeback_missing_committed_row');
  Object.assign(ds.session, row);
  savedChoices.set(ds, savedKey(ds, choice.nonce));
  return true;
}
