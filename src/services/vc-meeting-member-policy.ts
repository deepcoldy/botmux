import type {
  VcMeetingConsumerManagedSink,
  VcMeetingConsumerProfileFilter,
} from '../types.js';
import type { VcMeetingActivityType } from '../vc-agent/types.js';

export const VC_MEETING_LEGACY_MEMBER_ID = 'meeting_assistant';
export const VC_MEETING_LEGACY_MEMBER_ROLE = 'meeting_assistant';
export const VC_MEETING_OUTPUT_CAPABILITY = 'meeting.output.request';
export const VC_MEETING_LISTENER_OUTPUT_CAPABILITY = 'listener.output.request';

const ACTIVITY_TYPES = [
  'participant_joined',
  'participant_left',
  'chat_received',
  'transcript_received',
  'magic_share_started',
  'magic_share_ended',
] as const satisfies readonly VcMeetingActivityType[];

const MANAGED_SINKS = [
  'meeting_text',
  'meeting_voice',
] as const satisfies readonly VcMeetingConsumerManagedSink[];

export interface VcMeetingMemberPolicyInput {
  memberId: string;
  role: string;
  membershipGeneration: number;
  responseMode: 'silent' | 'listener_thread';
  filter?: unknown;
  capabilities?: unknown;
  ownedSinks?: unknown;
  sinkOwnerGeneration?: unknown;
}

export interface VcMeetingMemberPolicySnapshot {
  filter?: VcMeetingConsumerProfileFilter;
  capabilities: string[];
  ownedSinks: VcMeetingConsumerManagedSink[];
  sinkOwnerGeneration: number;
}

function canonicalStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) return undefined;
    out.add(item.trim());
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

function canonicalFilter(value: unknown): VcMeetingConsumerProfileFilter | undefined | false {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== 'activityTypes')) return false;
  if (record.activityTypes === undefined) return undefined;
  const activityTypes = canonicalStringList(record.activityTypes);
  if (!activityTypes
    || activityTypes.some(type => !(ACTIVITY_TYPES as readonly string[]).includes(type))) return false;
  return activityTypes.length > 0
    ? { activityTypes: activityTypes as VcMeetingActivityType[] }
    : undefined;
}

export function isExactVcMeetingLegacyMemberIdentity(input: {
  memberId: string;
  role: string;
}): boolean {
  return input.memberId === VC_MEETING_LEGACY_MEMBER_ID
    && input.role === VC_MEETING_LEGACY_MEMBER_ROLE;
}

/**
 * Canonicalize the authorization/filter snapshot carried by a membership
 * projection. Lists are sorted and deduplicated so semantically equivalent
 * projections cannot conflict merely because a caller changed list order.
 *
 * The only missing-field migration is the exact MA-P0 meeting_assistant
 * record. Arbitrary members never inherit output capability or sink ownership.
 */
export function normalizeVcMeetingMemberPolicy(
  input: VcMeetingMemberPolicyInput,
): VcMeetingMemberPolicySnapshot | undefined {
  const allPolicyFieldsMissing = input.filter === undefined
    && input.capabilities === undefined
    && input.ownedSinks === undefined
    && input.sinkOwnerGeneration === undefined;
  const exactLegacy = isExactVcMeetingLegacyMemberIdentity(input);
  if (allPolicyFieldsMissing) {
    if (!exactLegacy) return undefined;
    return {
      capabilities: [VC_MEETING_OUTPUT_CAPABILITY, 'meeting.read'].sort((a, b) => a.localeCompare(b)),
      ownedSinks: [...MANAGED_SINKS],
      sinkOwnerGeneration: input.membershipGeneration,
    };
  }

  const filter = canonicalFilter(input.filter);
  const capabilities = canonicalStringList(input.capabilities);
  const ownedSinks = canonicalStringList(input.ownedSinks);
  if (filter === false || !capabilities || !ownedSinks) return undefined;
  if (ownedSinks.some(sink => !(MANAGED_SINKS as readonly string[]).includes(sink))) return undefined;
  if (!Number.isSafeInteger(input.sinkOwnerGeneration)
    || (input.sinkOwnerGeneration as number) <= 0) return undefined;
  if (ownedSinks.length > 0 && !capabilities.includes(VC_MEETING_OUTPUT_CAPABILITY)) return undefined;
  if (input.responseMode === 'listener_thread'
    && !exactLegacy
    && !capabilities.includes(VC_MEETING_LISTENER_OUTPUT_CAPABILITY)) return undefined;
  return {
    ...(filter ? { filter } : {}),
    capabilities,
    ownedSinks: ownedSinks as VcMeetingConsumerManagedSink[],
    sinkOwnerGeneration: input.sinkOwnerGeneration as number,
  };
}

export function vcMeetingMemberFilterEquals(
  a: VcMeetingConsumerProfileFilter | undefined,
  b: VcMeetingConsumerProfileFilter | undefined,
): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

export function vcMeetingCanonicalStringListsEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
