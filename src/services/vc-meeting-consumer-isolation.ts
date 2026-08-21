import type { BackendType } from '../adapters/backend/types.js';

export type VcMeetingConsumerIsolationFailure =
  | 'platform_unsupported'
  | 'backend_unsupported';

export type VcMeetingConsumerIsolationResult =
  | { ok: true; isolated: boolean }
  | { ok: false; reason: VcMeetingConsumerIsolationFailure; error: string };

/**
 * Decide whether a bot may act as a VC meeting consumer, and whether the
 * managed side-effect boundary is actually in force for it.
 *
 * Meeting transcripts/chat are untrusted multi-party input, and the consumer is
 * an AI process holding this bot's ambient Lark credential. The Linux bwrap
 * sandbox is what masks that credential and forces every outbound action
 * through the host-authorized outbox relay + managed action ledger.
 *
 * POLICY (operator owns the choice — see plan B):
 *  - `sandbox` not requested → the consumer runs UNSANDBOXED and is still
 *    eligible. `isolated: false` signals that the credential is exposed to
 *    meeting input, so callers surface an explicit risk notice. This is the
 *    default; it does not silently pretend a boundary exists.
 *  - `sandbox` requested + Linux + pty/tmux → the boundary is real:
 *    `{ ok: true, isolated: true }`.
 *  - `sandbox` requested but UNDELIVERABLE (macOS Seatbelt has no host relay and
 *    still exposes the send credential; riff runs remotely; herdr/zellij aren't
 *    wrapped by the local bwrap impl) → FAIL CLOSED. An explicit isolation
 *    request must never be silently downgraded to unsandboxed; the operator has
 *    to either turn sandbox off (informed) or move to a Linux pty/tmux backend.
 */
export function evaluateVcMeetingConsumerIsolation(input: {
  sandbox: boolean | undefined;
  platform: NodeJS.Platform;
  backendType: BackendType;
}): VcMeetingConsumerIsolationResult {
  if (input.sandbox !== true) {
    // Plan B: no sandbox requested → allowed, but not isolated.
    return { ok: true, isolated: false };
  }
  // Sandbox WAS requested; it must be delivered or refused, never faked.
  if (input.platform !== 'linux') {
    return {
      ok: false,
      reason: 'platform_unsupported',
      error: `sandbox was requested but managed side-effect isolation is unavailable on ${input.platform}; turn sandbox off to run the meeting consumer unsandboxed, or use a Linux pty/tmux backend`,
    };
  }
  if (input.backendType !== 'pty' && input.backendType !== 'tmux') {
    return {
      ok: false,
      reason: 'backend_unsupported',
      error: `sandbox was requested but backend ${input.backendType} cannot enforce the managed Lark output boundary; turn sandbox off to run unsandboxed, or use a pty/tmux backend`,
    };
  }
  return { ok: true, isolated: true };
}
