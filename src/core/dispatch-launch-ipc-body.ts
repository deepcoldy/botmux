import {
  parseDispatchLaunchCancelRequest,
  parseDispatchLaunchPrepareRequest,
  parseDispatchLaunchStartRequest,
  type DispatchLaunchCancelRequestV1,
  type DispatchLaunchPrepareRequestV1,
  type DispatchLaunchStartRequestV1,
} from './dispatch-launch-contract.js';

export type DispatchLaunchIpcMutation = 'prepare' | 'start' | 'cancel';

export type DispatchLaunchIpcBody =
  | { mutation: 'prepare'; value: DispatchLaunchPrepareRequestV1 }
  | { mutation: 'start'; value: DispatchLaunchStartRequestV1 }
  | { mutation: 'cancel'; value: DispatchLaunchCancelRequestV1 };

export type DispatchLaunchIpcBodyResult =
  | { ok: true; body: DispatchLaunchIpcBody }
  | { ok: false; error: 'bad_json' | 'bad_body' };

/** Parse only canonical JSON, so the bytes authenticated by HMAC have one meaning. */
export function parseDispatchLaunchIpcBody(
  mutation: DispatchLaunchIpcMutation,
  bodyRaw: string,
): DispatchLaunchIpcBodyResult {
  let parsed: unknown;
  if (!bodyRaw) return { ok: false, error: 'bad_json' };
  try {
    parsed = JSON.parse(bodyRaw) as unknown;
  } catch {
    return { ok: false, error: 'bad_json' };
  }
  if (JSON.stringify(parsed) !== bodyRaw) return { ok: false, error: 'bad_json' };
  try {
    if (mutation === 'prepare') {
      return { ok: true, body: { mutation, value: parseDispatchLaunchPrepareRequest(parsed) } };
    }
    if (mutation === 'start') {
      return { ok: true, body: { mutation, value: parseDispatchLaunchStartRequest(parsed) } };
    }
    return { ok: true, body: { mutation, value: parseDispatchLaunchCancelRequest(parsed) } };
  } catch {
    return { ok: false, error: 'bad_body' };
  }
}
