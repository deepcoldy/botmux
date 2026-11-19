/** Defaults are resolved once, when a meeting is created, never on restore. */
export interface VcMeetingListenerPolicy {
  rawMessages: boolean;
  finalSummary: boolean;
  allowSummarySharing: boolean;
}
export const DEFAULT_VC_MEETING_LISTENER_POLICY: Readonly<VcMeetingListenerPolicy> = Object.freeze({
  rawMessages: true,
  finalSummary: false,
  allowSummarySharing: false,
});

export function normalizeVcMeetingListenerPolicy(raw: unknown): Partial<VcMeetingListenerPolicy> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('listenerPolicy must be an object');
  const result: Partial<VcMeetingListenerPolicy> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(DEFAULT_VC_MEETING_LISTENER_POLICY, key) || typeof value !== 'boolean') {
      throw new Error(`invalid listenerPolicy field: ${key}`);
    }
    result[key as keyof VcMeetingListenerPolicy] = value;
  }
  return result;
}

export function resolveVcMeetingListenerPolicy(
  global?: Partial<VcMeetingListenerPolicy>, bot?: Partial<VcMeetingListenerPolicy>,
): VcMeetingListenerPolicy {
  return { ...DEFAULT_VC_MEETING_LISTENER_POLICY,
    ...normalizeVcMeetingListenerPolicy(global), ...normalizeVcMeetingListenerPolicy(bot) };
}

export function vcMeetingListenerPoliciesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(resolveVcMeetingListenerPolicy(normalizeVcMeetingListenerPolicy(a)))
    === JSON.stringify(resolveVcMeetingListenerPolicy(normalizeVcMeetingListenerPolicy(b)));
}

/** An anchored, standalone human command, never a search through quoted text.
 * The normal mention gate still decides whether this turn is admitted. */
export function vcMeetingSummaryShareTarget(input: {
  enabled: boolean; senderType?: string; messageType?: string; text: string; quoted: boolean;
  meetingId?: string; meetingNo?: string;
}): string | undefined {
  if (!input.enabled || input.senderType !== 'user' || input.messageType !== 'text' || input.quoted) return undefined;
  const match = /^(?:会议纪要转发|share meeting summary)(?:\s+meeting:([A-Za-z0-9_-]{1,128}))?\s+(oc_[A-Za-z0-9_-]{1,128})$/u.exec(input.text.trim());
  if (!match || (match[1] && match[1] !== input.meetingId && match[1] !== input.meetingNo)) return undefined;
  return match[2];
}
