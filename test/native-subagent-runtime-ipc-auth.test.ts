import { describe, expect, it } from 'vitest';
import {
  createNativeSubagentRuntimeNonceStore,
  nativeSubagentRuntimeCapabilityHeaders,
  readNativeSubagentRuntimeResponseProof,
  readBoundedNativeSubagentRuntimeResponse,
  signNativeSubagentRuntimeResponse,
  verifyNativeSubagentRuntimeCapabilityRequest,
  verifyNativeSubagentRuntimeResponse,
  writeNativeSubagentRuntimeResponseProof,
} from '../src/core/native-subagent-runtime-ipc-auth.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CAPABILITY = 'ab'.repeat(32);
const HOST_SECRET = 'host-secret';
const NOW = 1_788_192_000_000;
const NONCE = 'aa'.repeat(32);
const BOOT_ID = 'B'.repeat(43);
const APP_ID = 'app-native-runtime';
const BASE = {
  method: 'POST',
  path: '/api/sessions/session-1/native-subagent-runtime',
  port: 4310,
  sessionId: 'session-1',
  turnId: 'turn-1',
  dispatchAttempt: 3,
  larkAppId: APP_ID,
  bootInstanceId: BOOT_ID,
};

describe('native subagent runtime IPC authentication', () => {
  it('authenticates a capability request once and binds every authority field', () => {
    const headers = nativeSubagentRuntimeCapabilityHeaders({
      ...BASE, capability: CAPABILITY, timestamp: String(NOW), nonce: NONCE,
    });
    const nonceStore = createNativeSubagentRuntimeNonceStore({ now: () => NOW });
    const verify = (overrides: Partial<typeof BASE> = {}) => verifyNativeSubagentRuntimeCapabilityRequest({
      ...BASE, ...overrides, capability: CAPABILITY, headers, remoteAddress: '127.0.0.1',
      nonceStore, nowMs: NOW,
    });

    expect(verify()).toEqual({ ok: true, nonce: NONCE });
    expect(verify()).toEqual({ ok: false, reason: 'replay' });

    for (const overrides of [
      { path: '/api/sessions/session-2/native-subagent-runtime' },
      { port: 4311 },
      { sessionId: 'session-2' },
      { turnId: 'turn-2' },
      { dispatchAttempt: 4 },
      { larkAppId: 'other-app' },
      { bootInstanceId: 'C'.repeat(43) },
    ]) {
      const freshStore = createNativeSubagentRuntimeNonceStore({ now: () => NOW });
      expect(verifyNativeSubagentRuntimeCapabilityRequest({
        ...BASE, ...overrides, capability: CAPABILITY, headers, remoteAddress: '127.0.0.1',
        nonceStore: freshStore, nowMs: NOW,
      })).toEqual({ ok: false, reason: 'signature_mismatch' });
    }
  });

  it('rejects stale timestamps, malformed proof headers, and non-loopback callers', () => {
    const headers = nativeSubagentRuntimeCapabilityHeaders({
      ...BASE, capability: CAPABILITY, timestamp: String(NOW - 60_001), nonce: NONCE,
    });
    const nonceStore = createNativeSubagentRuntimeNonceStore({ now: () => NOW });
    expect(verifyNativeSubagentRuntimeCapabilityRequest({
      ...BASE, capability: CAPABILITY, headers, remoteAddress: '127.0.0.1', nonceStore, nowMs: NOW,
    })).toEqual({ ok: false, reason: 'timestamp_out_of_window' });
    expect(verifyNativeSubagentRuntimeCapabilityRequest({
      ...BASE, capability: CAPABILITY, headers: {}, remoteAddress: '127.0.0.1', nonceStore, nowMs: NOW,
    })).toEqual({ ok: false, reason: 'missing_or_malformed_header' });
    expect(verifyNativeSubagentRuntimeCapabilityRequest({
      ...BASE, capability: CAPABILITY, headers, remoteAddress: '10.0.0.8', nonceStore, nowMs: NOW,
    })).toEqual({ ok: false, reason: 'remote_not_loopback' });
  });

  it.each([HOST_SECRET, CAPABILITY])(
    'authenticates responses and binds nonce, route, port, status, body, and live tuple',
    (key) => {
      const body = JSON.stringify({ ok: true, policy: { model: { mode: 'custom', value: 'GPT-5.5' } } });
      const input = {
        ...BASE, key,
        requestNonce: NONCE, status: 200, body,
      };
      const signature = signNativeSubagentRuntimeResponse(input);
      expect(verifyNativeSubagentRuntimeResponse({ ...input, signature })).toBe(true);
      const mutations = [
        { requestNonce: 'B'.repeat(43) },
        { path: '/wrong' },
        { port: 4311 },
        { status: 201 },
        { body: `${body} ` },
        { sessionId: 'session-2' },
        { larkAppId: 'other-app' },
        { bootInstanceId: 'C'.repeat(43) },
        { turnId: 'turn-2' },
        { dispatchAttempt: 4 },
      ];
      for (const mutation of mutations) {
        expect(verifyNativeSubagentRuntimeResponse({ ...input, ...mutation, signature })).toBe(false);
      }
    },
  );

  it('keeps the replay cache bounded with constant-time lookup semantics', () => {
    const store = createNativeSubagentRuntimeNonceStore({ now: () => NOW }, 3);
    expect(store.add('0'.repeat(64), NOW + 60_000)).toBe(true);
    expect(store.add('1'.repeat(64), NOW + 60_000)).toBe(true);
    expect(store.add('2'.repeat(64), NOW + 60_000)).toBe(true);
    expect(store.add('3'.repeat(64), NOW + 60_000)).toBe(false);
    expect(store.size()).toBe(3);
    expect(store.has('0'.repeat(64))).toBe(true);
    expect(store.has('3'.repeat(64))).toBe(false);
  });

  it('accepts only a host-written proof for the exact response and daemon boot', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'native-runtime-proof-'));
    const channelId = '77'.repeat(32);
    const body = JSON.stringify({ ok: true, policy: { model: { mode: 'custom', value: 'GPT-5.5' } } });
    try {
      writeNativeSubagentRuntimeResponseProof({
        dataDir, channelId, nonce: NONCE, issuedAtMs: NOW,
        response: { ...BASE, status: 200, body },
      });
      expect(readNativeSubagentRuntimeResponseProof({
        dataDir, channelId, nonce: NONCE, nowMs: NOW,
        response: { ...BASE, status: 200, body },
      })).toBe(true);
      expect(readNativeSubagentRuntimeResponseProof({
        dataDir, channelId, nonce: NONCE, nowMs: NOW,
        response: { ...BASE, status: 201, body },
      })).toBe(false);
      expect(readNativeSubagentRuntimeResponseProof({
        dataDir, channelId, nonce: NONCE, nowMs: NOW,
        response: { ...BASE, bootInstanceId: 'C'.repeat(43), status: 200, body },
      })).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('bounded native subagent runtime responses', () => {
  it('reads at most 16 KiB and cancels an oversized never-ending stream', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() { cancelled = true; },
    }), { status: 200 });

    await expect(readBoundedNativeSubagentRuntimeResponse(response)).rejects.toThrow(/too large/i);
    expect(cancelled).toBe(true);
  });

  it('returns exact UTF-8 bytes below the limit', async () => {
    const body = JSON.stringify({ ok: true, marker: '你好' });
    await expect(readBoundedNativeSubagentRuntimeResponse(new Response(body))).resolves.toBe(body);
  });
});
