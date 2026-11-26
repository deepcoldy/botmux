import { describe, expect, it } from 'vitest';
import {
  openRelayedTurnReplyRequest,
  RELAYED_TURN_REPLY_MAX_BYTES,
  SESSION_TURN_REPLY_RAW_TEXT_CAP,
  sealRelayedTurnReplyRequest,
  signRelayedTurnReplyResponse,
  verifyRelayedTurnReplyRequestProof,
  verifyRelayedTurnReplyResponse,
  type RelayedTurnReplyKey,
} from '../src/core/relayed-turn-reply.js';

const CAP = 'ab12cd34'.repeat(8);
const HOST = 'host-ipc-secret-for-relay-tests';
const capabilityKey: RelayedTurnReplyKey = { kind: 'capability', material: CAP };
const hostKey: RelayedTurnReplyKey = { kind: 'host', material: HOST };
const payload = {
  expectedTurnId: 'turn-a',
  replies: [{ messageId: 'om_real', responseKind: 'final' as const, at: 1_700_000_000_000, text: 'private reply body' }],
};

describe('relayed turn-reply encrypted wire envelope', () => {
  it.each([capabilityKey, hostKey])('round-trips only with the correct $kind key and authenticates exact responses', key => {
    const sealed = sealRelayedTurnReplyRequest({ key, sessionId: 'sess-a', payload, dispatchAttempt: 1 });
    const serialized = JSON.stringify({ body: sealed.body, headers: sealed.headers });
    expect(serialized).not.toContain(key.material);
    expect(serialized).not.toContain('private reply body');
    expect(verifyRelayedTurnReplyRequestProof({ key, sessionId: 'sess-a', auth: sealed.auth })).toBe(true);
    expect(openRelayedTurnReplyRequest({ key, sessionId: 'sess-a', auth: sealed.auth, body: sealed.body }))
      .toEqual(payload);

    const wrong = key.kind === 'capability' ? hostKey : capabilityKey;
    expect(verifyRelayedTurnReplyRequestProof({ key: wrong, sessionId: 'sess-a', auth: sealed.auth })).toBe(false);
    expect(openRelayedTurnReplyRequest({ key: wrong, sessionId: 'sess-a', auth: sealed.auth, body: sealed.body }))
      .toBeUndefined();

    const raw = JSON.stringify({ ok: true, recorded: 1, duplicates: 0, staged: true });
    const signature = signRelayedTurnReplyResponse({
      key, sessionId: 'sess-a', turnId: 'turn-a', dispatchAttempt: 1,
      requestNonce: sealed.auth.requestNonce, status: 200, raw,
    });
    expect(verifyRelayedTurnReplyResponse({
      key, sessionId: 'sess-a', turnId: 'turn-a', dispatchAttempt: 1,
      requestNonce: sealed.auth.requestNonce, status: 200, raw, signature,
    })).toBe(true);
    expect(verifyRelayedTurnReplyResponse({
      key, sessionId: 'sess-a', turnId: 'turn-a', dispatchAttempt: 1,
      requestNonce: sealed.auth.requestNonce, status: 200, raw: `${raw} `, signature,
    })).toBe(false);
    expect(verifyRelayedTurnReplyResponse({
      key, sessionId: 'sess-a', turnId: 'turn-a', dispatchAttempt: 1,
      requestNonce: sealed.auth.requestNonce, status: 403, raw, signature,
    })).toBe(false);
  });

  it('rejects ciphertext and request-tuple tampering instead of decrypting attacker content', () => {
    const sealed = sealRelayedTurnReplyRequest({ key: capabilityKey, sessionId: 'sess-a', payload });
    const tampered = { ...sealed.body };
    tampered.sealed = `${tampered.sealed.slice(0, -1)}${tampered.sealed.endsWith('A') ? 'B' : 'A'}`;
    expect(openRelayedTurnReplyRequest({ key: capabilityKey, sessionId: 'sess-a', auth: sealed.auth, body: tampered }))
      .toBeUndefined();
    expect(verifyRelayedTurnReplyRequestProof({
      key: capabilityKey,
      sessionId: 'sess-a',
      auth: { ...sealed.auth, turnId: 'turn-other' },
    })).toBe(false);
    expect(verifyRelayedTurnReplyRequestProof({
      key: capabilityKey,
      sessionId: 'sess-other',
      auth: sealed.auth,
    })).toBe(false);
  });

  it('keeps the largest accepted CJK reply within the HTTP body cap after encryption', () => {
    const sealed = sealRelayedTurnReplyRequest({
      key: capabilityKey,
      sessionId: 'sess-a',
      payload: {
        expectedTurnId: 'turn-a',
        replies: [{ messageId: 'om_cjk', responseKind: 'final', at: 1_700_000_000_000, text: '测'.repeat(SESSION_TURN_REPLY_RAW_TEXT_CAP) }],
      },
    });
    expect(Buffer.byteLength(JSON.stringify(sealed.body), 'utf8')).toBeLessThanOrEqual(RELAYED_TURN_REPLY_MAX_BYTES);
    expect(openRelayedTurnReplyRequest({ key: capabilityKey, sessionId: 'sess-a', auth: sealed.auth, body: sealed.body }))
      .not.toBeUndefined();
  });
});
