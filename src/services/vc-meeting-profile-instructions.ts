import { createHash } from 'node:crypto';
import type {
  VcMeetingConsumerProfileConfig,
  VcMeetingConsumerProfileFilter,
} from '../types.js';

export const VC_MEETING_PROFILE_INSTRUCTIONS_MAX_CHARS = 8_000;

const RESERVED_INSTRUCTION_MARKER_TOKEN = 'botmux_role_instructions';

export type VcMeetingProfileInstructionsNormalizationResult =
  | { ok: true; instructions?: string }
  | { ok: false; error: string };

/**
 * Canonicalize the trusted, operator-authored instructions stored on a VC
 * consumer profile. The delimiters are daemon-owned so profile text can never
 * forge the boundary between the custom role and the fixed safety contract.
 */
export function normalizeVcMeetingProfileInstructions(
  raw: unknown,
): VcMeetingProfileInstructionsNormalizationResult {
  if (raw === undefined) return { ok: true };
  if (typeof raw !== 'string') {
    return { ok: false, error: 'must be a string when present' };
  }
  const instructions = raw.replace(/\r\n?/g, '\n').trim();
  if (!instructions) return { ok: true };
  if (instructions.length > VC_MEETING_PROFILE_INSTRUCTIONS_MAX_CHARS) {
    return {
      ok: false,
      error: `must be at most ${VC_MEETING_PROFILE_INSTRUCTIONS_MAX_CHARS} characters`,
    };
  }
  // C0 controls are not useful in an instruction document and can create
  // ambiguous terminal/log rendering. LF and TAB are the only exceptions.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(instructions)) {
    return { ok: false, error: 'contains a disallowed control character' };
  }
  // Reject the reserved token itself, not only the two exact tags. XML-like
  // whitespace/case variants such as `</botmux_role_instructions >` or
  // `<botmux_role_instructions\t>` are LLM-equivalent fence boundaries even
  // though they are not byte-identical to the emitted wrapper.
  if (instructions.toLowerCase().includes(RESERVED_INSTRUCTION_MARKER_TOKEN)) {
    return { ok: false, error: 'contains a reserved botmux instruction marker' };
  }
  return { ok: true, instructions };
}

function canonicalFilter(filter: VcMeetingConsumerProfileFilter | undefined): VcMeetingConsumerProfileFilter | 'all' {
  const activityTypes = filter?.activityTypes;
  if (!activityTypes?.length) return 'all';
  return { activityTypes: [...new Set(activityTypes)].sort() };
}

/**
 * Content-addressed version for delivery-stream semantics. Omitting the
 * `instructions` property when the normalized value is absent deliberately
 * preserves the exact pre-instructions role/filter hash.
 */
export function computeVcMeetingConsumerProfileHash(
  profile: Pick<VcMeetingConsumerProfileConfig, 'role' | 'filter' | 'instructions'>,
): string {
  const role = profile.role.trim();
  if (!role) throw new Error('profile role must be a non-empty string');
  const normalized = normalizeVcMeetingProfileInstructions(profile.instructions);
  if (!normalized.ok) throw new Error(`invalid profile instructions: ${normalized.error}`);
  const filter = canonicalFilter(profile.filter);
  const semanticProfile = normalized.instructions === undefined
    ? { role, filter }
    : { role, filter, instructions: normalized.instructions };
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(semanticProfile), 'utf8')
    .digest('hex')}`;
}
