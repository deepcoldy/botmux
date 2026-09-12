import { describe, expect, it } from 'vitest';

import {
  DISPATCH_LAUNCH_SCHEMA_VERSION,
  canonicalizeDispatchLaunchKickoff,
} from '../src/core/dispatch-launch-contract.js';
import { parseDispatchLaunchIpcBody } from '../src/core/dispatch-launch-ipc-body.js';

const dispatchId = `dl_${'a'.repeat(32)}`;
const digest = `sha256:${'b'.repeat(64)}`;

describe('dispatch launch IPC body parser', () => {
  it('accepts only canonical prepare JSON and binds route id through the contract body', () => {
    const request = {
      schemaVersion: DISPATCH_LAUNCH_SCHEMA_VERSION, protocol: 'v1' as const, dispatchId,
      source: { larkAppId: 'cli_source', sessionId: 'session', turnId: 'turn' },
      targetLarkAppId: 'cli_target', chatId: 'oc_chat',
      kickoff: canonicalizeDispatchLaunchKickoff({
        title: 'Task', brief: 'Brief', sourceDisplay: 'Source', targetLarkAppId: 'cli_target',
      }),
      requestedOverride: { model: 'gpt-5.6-sol' },
      expiresAt: '2026-09-03T10:05:00.000Z',
    };
    expect(parseDispatchLaunchIpcBody('prepare', JSON.stringify(request))).toEqual({
      ok: true, body: { mutation: 'prepare', value: request },
    });
    expect(parseDispatchLaunchIpcBody('prepare', ` ${JSON.stringify(request)}`))
      .toEqual({ ok: false, error: 'bad_json' });
    expect(parseDispatchLaunchIpcBody('prepare', JSON.stringify({ ...request, unknown: true })))
      .toEqual({ ok: false, error: 'bad_body' });
  });

  it('validates strict start and cancel bodies', () => {
    const start = {
      schemaVersion: DISPATCH_LAUNCH_SCHEMA_VERSION, protocol: 'v1' as const, dispatchId,
      kickoffDigest: digest, policyDigest: digest, launchIdentityDigest: digest,
    };
    expect(parseDispatchLaunchIpcBody('start', JSON.stringify(start))).toMatchObject({ ok: true });
    expect(parseDispatchLaunchIpcBody('cancel', JSON.stringify({
      schemaVersion: DISPATCH_LAUNCH_SCHEMA_VERSION, protocol: 'v1', dispatchId, reason: 'cancelled',
    }))).toMatchObject({ ok: true });
    expect(parseDispatchLaunchIpcBody('start', '{}')).toEqual({ ok: false, error: 'bad_body' });
  });
});
