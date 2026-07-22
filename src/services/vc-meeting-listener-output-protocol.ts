/**
 * Internal control envelope for automatic listener-visible meeting output.
 *
 * The model decides semantic relevance from its role and conversation state;
 * botmux only enforces whether a visible message exists. The control envelope
 * is never rendered to Lark and intentionally carries no score, fingerprint,
 * cadence, or incident-specific fields.
 */

export const VC_MEETING_LISTENER_OUTPUT_CONTRACT =
  'Final answer transport contract (higher priority than role instructions): '
  + 'return exactly one JSON object and no surrounding prose. '
  + 'Use {"decision":"skip"} when no listener-group message should be published. '
  + 'Use {"decision":"publish","content":"<message markdown>"} when a message should be published. '
  + 'Put only the user-visible message in content; never send or explain the control JSON. '
  + 'Judge timing and semantic novelty from the configured role and full meeting context. '
  + 'A correction to previously stated information (including time, owner, scope, status, or conclusion) '
  + 'is new information and must not be suppressed merely because most surrounding text is unchanged.';

export const VC_MEETING_CONTROLLED_OUTPUT_INSTRUCTION_VERSION = 'meeting-consumer-v2' as const;

/** Frozen on the delivery receipt so a pre-upgrade v1 retry may still emit its
 * historical plain final output while v2+ deliveries fail closed on envelopes. */
export type VcMeetingListenerOutputProtocol = 'plain' | 'decision_v1';

export function vcMeetingListenerOutputProtocolForInstructionVersion(
  instructionVersion: string,
): VcMeetingListenerOutputProtocol {
  return instructionVersion === VC_MEETING_CONTROLLED_OUTPUT_INSTRUCTION_VERSION
    ? 'decision_v1'
    : 'plain';
}

export type VcMeetingListenerOutputDecision =
  | { ok: true; decision: 'skip' }
  | { ok: true; decision: 'publish'; content: string }
  | { ok: false; reason: 'invalid_json' | 'invalid_shape' };

function unwrapJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return match ? match[1]!.trim() : trimmed;
}

export function parseVcMeetingListenerOutput(
  raw: string,
): VcMeetingListenerOutputDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapJsonFence(raw));
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid_shape' };
  }
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (value.decision === 'skip') {
    return keys.length === 1 && keys[0] === 'decision'
      ? { ok: true, decision: 'skip' }
      : { ok: false, reason: 'invalid_shape' };
  }
  if (value.decision === 'publish') {
    if (keys.length !== 2
      || keys[0] !== 'content'
      || keys[1] !== 'decision'
      || typeof value.content !== 'string'
      || !value.content.trim()) {
      return { ok: false, reason: 'invalid_shape' };
    }
    return { ok: true, decision: 'publish', content: value.content.trim() };
  }
  return { ok: false, reason: 'invalid_shape' };
}
