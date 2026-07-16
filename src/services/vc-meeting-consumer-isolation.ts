import type { BackendType } from '../adapters/backend/types.js';

export type VcMeetingConsumerIsolationFailure =
  | 'sandbox_required'
  | 'platform_unsupported'
  | 'backend_unsupported';

export type VcMeetingConsumerIsolationResult =
  | { ok: true }
  | { ok: false; reason: VcMeetingConsumerIsolationFailure; error: string };

/**
 * VC meeting entries are untrusted input, while their consumer role can request
 * externally-visible side effects.  A receiver is therefore eligible only
 * when the whole CLI is inside the Linux bwrap boundary whose mandatory
 * credential masks and host-authorized outbox relay make the managed action
 * ledger the only credentialed Lark output path.
 *
 * macOS `sandbox: true` currently provides write isolation only; riff injects
 * the Lark app secret into the remote task; herdr/zellij are not wrapped by the
 * local bwrap implementation.  All are intentionally rejected instead of
 * treating a prompt instruction as a security boundary.
 */
export function evaluateVcMeetingConsumerIsolation(input: {
  sandbox: boolean | undefined;
  platform: NodeJS.Platform;
  backendType: BackendType;
}): VcMeetingConsumerIsolationResult {
  if (input.sandbox !== true) {
    return {
      ok: false,
      reason: 'sandbox_required',
      error: 'sandbox=true is required for untrusted meeting input',
    };
  }
  if (input.platform !== 'linux') {
    return {
      ok: false,
      reason: 'platform_unsupported',
      error: `managed side-effect isolation is unavailable on ${input.platform}`,
    };
  }
  if (input.backendType !== 'pty' && input.backendType !== 'tmux') {
    return {
      ok: false,
      reason: 'backend_unsupported',
      error: `backend ${input.backendType} cannot enforce the managed Lark output boundary`,
    };
  }
  return { ok: true };
}
