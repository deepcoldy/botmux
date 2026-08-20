import { createHash } from 'node:crypto';
import type { DaemonSession } from './types.js';

export const SESSION_OWNER_REMINDER_STATES = [
  'idle',
  'dormant',
  'pending_repo',
  'tui_prompt',
  'agent_attention',
  'limited',
] as const;

export type SessionOwnerReminderState = typeof SESSION_OWNER_REMINDER_STATES[number];

export interface SessionOwnerReminderConfig {
  enabled: boolean;
  intervalMinutes: number;
  text: string;
  states: SessionOwnerReminderState[];
}

export interface SessionOwnerReminderRecord {
  sessionId: string;
  stateFingerprint: string;
  actionableSince: number;
  lastObservedActivityAt: number;
  lastRemindedAt?: number;
  retryAfterAt?: number;
}

export type SessionOwnerReminderRecords = Record<string, SessionOwnerReminderRecord>;

export const DEFAULT_SESSION_OWNER_REMINDER: SessionOwnerReminderConfig = {
  enabled: false,
  intervalMinutes: 30,
  text: '该会话已等待处理，请继续跟进。',
  states: [...SESSION_OWNER_REMINDER_STATES],
};

const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 10_080;
const MAX_TEXT_CHARS = 500;
const FAILURE_RETRY_MAX_MS = 5 * 60_000;

function isState(value: unknown): value is SessionOwnerReminderState {
  return typeof value === 'string'
    && (SESSION_OWNER_REMINDER_STATES as readonly string[]).includes(value);
}

/** Strict normalizer shared by config loading and write validation. */
export function normalizeSessionOwnerReminderConfig(
  raw: unknown,
): SessionOwnerReminderConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.enabled !== 'boolean') return undefined;
  if (!Number.isInteger(value.intervalMinutes)
    || (value.intervalMinutes as number) < MIN_INTERVAL_MINUTES
    || (value.intervalMinutes as number) > MAX_INTERVAL_MINUTES) return undefined;
  if (typeof value.text !== 'string') return undefined;
  const text = value.text.trim();
  if (!text || Array.from(text).length > MAX_TEXT_CHARS || /<\s*at\b/i.test(text)) return undefined;
  if (!Array.isArray(value.states)) return undefined;
  const states = [...new Set(value.states.filter(isState))];
  if (states.length !== value.states.length) return undefined;
  if (value.enabled && states.length === 0) return undefined;
  return {
    enabled: value.enabled,
    intervalMinutes: value.intervalMinutes as number,
    text,
    states,
  };
}

export function deriveSessionOwnerReminderStates(ds: DaemonSession): SessionOwnerReminderState[] {
  const states: SessionOwnerReminderState[] = [];
  const workerAlive = !!ds.worker && !ds.worker.killed;
  if (workerAlive && ds.lastScreenStatus === 'idle') states.push('idle');
  // A pre-spawn repository picker is its own actionable state, not a released
  // CLI. Likewise stale screen status belongs to the old worker lifetime.
  if (!workerAlive && !ds.pendingRepo) states.push('dormant');
  if (ds.pendingRepo) states.push('pending_repo');
  if (ds.tuiPromptCardId) states.push('tui_prompt');
  if (ds.agentAttention) states.push('agent_attention');
  if (workerAlive && ds.lastScreenStatus === 'limited') states.push('limited');
  return states;
}

/**
 * Observation fingerprint used both to detect a state transition (reset the
 * quiet period) and to seed the per-cycle delivery UUID. It must capture not
 * only WHICH runtime signals are present but also their INSTANCE identity for
 * the signals that get replaced in place while the label stays constant:
 *
 *   - `agent_attention` → a fresh `{kind, reason, at}` is written on every new
 *     attention raise, so key on `agentAttention.at`.
 *   - `tui_prompt`      → an old TUI prompt card is cleared and a new
 *     `tuiPromptCardId` set between scans, so key on that id.
 *
 * Without the instance component, the old signal being resolved and a brand-new
 * same-category signal appearing (e.g. a second, unrelated attention request)
 * would inherit the previous signal's elapsed quiet time and could @ the owner
 * almost immediately — undercutting the "give N minutes to handle THIS" promise.
 *
 * The remaining states (idle / dormant / pending_repo / limited) have no
 * distinct replaceable instance, so their label alone is a faithful key.
 *
 * INVARIANT: for a fixed instance the fingerprint is stable across scans, so a
 * within-cycle failed-send retry recomputes the SAME fingerprint → the same
 * delivery UUID → the existing Lark dedupe window still suppresses duplicates.
 * A new instance changes the fingerprint, which resets the record and thereby
 * starts a fresh cycle whose eventual UUID is legitimately different.
 */
export function sessionOwnerReminderObservationFingerprint(
  ds: DaemonSession,
  states: SessionOwnerReminderState[],
): string {
  return states
    .map(state => {
      if (state === 'agent_attention') return `agent_attention:${ds.agentAttention?.at ?? ''}`;
      if (state === 'tui_prompt') return `tui_prompt:${ds.tuiPromptCardId ?? ''}`;
      return state;
    })
    .join(',');
}

export interface SessionOwnerReminderControllerDeps {
  load(): SessionOwnerReminderRecords;
  save(records: SessionOwnerReminderRecords): void;
  send(ds: DaemonSession, text: string, uuid: string): Promise<void>;
  canSend(ds: DaemonSession): boolean;
  onError?(ds: DaemonSession, error: unknown): void;
}

function recordsSnapshot(value: unknown): string {
  return JSON.stringify(value);
}

export function sessionOwnerReminderDeliveryUuid(
  sessionId: string,
  stateFingerprint: string,
  dueBase: number,
): string {
  const digest = createHash('sha256')
    .update(`${sessionId}\0${stateFingerprint}\0${dueBase}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `owner-reminder-${digest}`;
}

/** Durable, deterministic scan engine. Scheduling and Lark IO are injected. */
export class SessionOwnerReminderController {
  constructor(private readonly deps: SessionOwnerReminderControllerDeps) {}

  async scan(
    sessions: Iterable<DaemonSession>,
    config: SessionOwnerReminderConfig,
    now: number = Date.now(),
  ): Promise<void> {
    const current = this.deps.load();
    const before = recordsSnapshot(current);
    if (!config.enabled || config.states.length === 0) {
      if (Object.keys(current).length > 0) this.deps.save({});
      return;
    }

    const configured = new Set(config.states);
    const seen = new Set<string>();
    const intervalMs = config.intervalMinutes * 60_000;

    for (const ds of sessions) {
      const sessionId = ds.session.sessionId;
      if (ds.session.status !== 'active'
        || ds.session.queued === true
        || (ds.scope ?? ds.session.scope) !== 'thread'
        || !ds.session.ownerOpenId
        || !this.deps.canSend(ds)) {
        delete current[sessionId];
        continue;
      }

      const projectedStates = deriveSessionOwnerReminderStates(ds);
      const matched = projectedStates.filter(state => configured.has(state));
      if (matched.length === 0) {
        delete current[sessionId];
        continue;
      }
      seen.add(sessionId);
      // Eligibility follows the configured subset, but timer resets follow the
      // complete runtime state. An unselected attention signal still represents
      // a state transition and starts a fresh quiet period. The fingerprint also
      // captures instance identity (attention.at / tuiPromptCardId) so a NEW
      // same-category signal replacing a resolved one resets the timer instead
      // of inheriting the old quiet period — see the fingerprint helper above.
      const stateFingerprint = sessionOwnerReminderObservationFingerprint(ds, projectedStates);
      const activityAt = Number.isFinite(ds.lastMessageAt) ? ds.lastMessageAt : 0;
      let record = current[sessionId];

      if (!record
        || record.stateFingerprint !== stateFingerprint
        || activityAt > record.lastObservedActivityAt) {
        record = current[sessionId] = {
          sessionId,
          stateFingerprint,
          actionableSince: Math.max(now, activityAt),
          lastObservedActivityAt: activityAt,
        };
        continue;
      }

      const dueBase = record.lastRemindedAt ?? record.actionableSince;
      if (now - dueBase < intervalMs) continue;
      if (record.retryAfterAt !== undefined && now < record.retryAfterAt) continue;

      try {
        await this.deps.send(
          ds,
          config.text,
          sessionOwnerReminderDeliveryUuid(sessionId, stateFingerprint, dueBase),
        );
        record.lastRemindedAt = now;
        record.retryAfterAt = undefined;
      } catch (error) {
        record.retryAfterAt = now + Math.max(60_000, Math.min(intervalMs, FAILURE_RETRY_MAX_MS));
        this.deps.onError?.(ds, error);
      }
    }

    for (const sessionId of Object.keys(current)) {
      if (!seen.has(sessionId)) delete current[sessionId];
    }
    if (recordsSnapshot(current) !== before) this.deps.save(current);
  }
}
