import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  WORKFLOW_DAEMON_IPC_BODY_LIMIT_BYTES,
  WORKFLOW_DAEMON_IPC_HEADERS,
  canonicalWorkflowDaemonIpcMaterial,
  canonicalWorkflowDaemonIpcResponseMaterial,
  createWorkflowDaemonIpcNonceStore,
  signWorkflowDaemonIpcRequest,
  signWorkflowDaemonIpcResponse,
  verifyWorkflowDaemonIpcResponse,
  verifyWorkflowDaemonIpcRequest,
  type WorkflowDaemonIpcClock,
  type WorkflowDaemonIpcTarget,
} from '../src/workflows/v3/daemon-ipc-auth.js';

const SECRET = 'workflow-ipc-test-secret';
const NOW = 1_700_000_000_123;
const TS = String(NOW);
const NONCE = 'n'.repeat(43);
const BOOT = 'b'.repeat(43);
const TARGET: WorkflowDaemonIpcTarget = {
  larkAppId: 'cli_test',
  ipcPort: 32_123,
  bootInstanceId: BOOT,
};

function fixedClock(now = NOW): WorkflowDaemonIpcClock {
  return { now: () => now };
}

function makeRequest(input: {
  body?: string | Uint8Array;
  method?: string;
  pathWithQuery?: string;
  target?: WorkflowDaemonIpcTarget;
  timestamp?: string;
  nonce?: string;
  secret?: string;
  signedBody?: string | Uint8Array;
  signedMethod?: string;
  signedPath?: string;
  signedTarget?: WorkflowDaemonIpcTarget;
  headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
  localPort?: number;
} = {}): IncomingMessage {
  const body = input.body ?? '';
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  const method = input.method ?? 'POST';
  const pathWithQuery = input.pathWithQuery ?? '/__workflow-ipc/v1/runs/run-1/start';
  const target = input.target ?? TARGET;
  const timestamp = input.timestamp ?? TS;
  const nonce = input.nonce ?? NONCE;
  const signature = signWorkflowDaemonIpcRequest({
    secret: input.secret ?? SECRET,
    timestamp,
    nonce,
    method: input.signedMethod ?? method,
    pathWithQuery: input.signedPath ?? pathWithQuery,
    body: input.signedBody ?? bytes,
    target: input.signedTarget ?? target,
  });
  const headers: Record<string, string | string[] | undefined> = {
    [WORKFLOW_DAEMON_IPC_HEADERS.timestamp]: timestamp,
    [WORKFLOW_DAEMON_IPC_HEADERS.nonce]: nonce,
    [WORKFLOW_DAEMON_IPC_HEADERS.signature]: signature,
    ...input.headers,
  };
  const stream = Readable.from([bytes]);
  return Object.assign(stream, {
    method,
    url: pathWithQuery,
    headers,
    socket: {
      remoteAddress: input.remoteAddress ?? '127.0.0.1',
      localPort: input.localPort ?? target.ipcPort,
    },
  }) as unknown as IncomingMessage;
}

async function verify(
  req: IncomingMessage,
  input: {
    target?: Omit<WorkflowDaemonIpcTarget, 'ipcPort'>;
    clock?: WorkflowDaemonIpcClock;
    maxBodyBytes?: number;
    bodyReadTimeoutMs?: number;
  } = {},
) {
  const clock = input.clock ?? fixedClock();
  return verifyWorkflowDaemonIpcRequest(req, {
    secret: SECRET,
    target: input.target ?? {
      larkAppId: TARGET.larkAppId,
      bootInstanceId: TARGET.bootInstanceId,
    },
    nonceStore: createWorkflowDaemonIpcNonceStore(clock),
    clock,
    ...(input.maxBodyBytes === undefined ? {} : { maxBodyBytes: input.maxBodyBytes }),
    ...(input.bodyReadTimeoutMs === undefined ? {} : { bodyReadTimeoutMs: input.bodyReadTimeoutMs }),
  });
}

describe('Workflow daemon IPC signing', () => {
  const goldenInput = {
    timestamp: '1700000000123',
    nonce: 'n'.repeat(43),
    method: 'post',
    pathWithQuery: '/__workflow-ipc/v1/runs/%E6%B5%81%E7%A8%8B/cancel?z=%E4%B8%AD%E6%96%87',
    body: '{"reason":"停止一下🚦"}',
    target: {
      larkAppId: 'cli_测试',
      ipcPort: 32_123,
      bootInstanceId: 'b'.repeat(43),
    },
  };

  it('freezes the canonical CJK material and signature as golden values', () => {
    expect(canonicalWorkflowDaemonIpcMaterial(goldenInput)).toBe(
      '["botmux-workflow-daemon-ipc/v1","1700000000123","nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","POST","/__workflow-ipc/v1/runs/%E6%B5%81%E7%A8%8B/cancel?z=%E4%B8%AD%E6%96%87","bde1d445c72314e5efe69e64f4572995d465c2016d1787b36aff7b425423c1da","cli_测试","32123","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]',
    );
    expect(signWorkflowDaemonIpcRequest({ secret: SECRET, ...goldenInput }))
      .toBe('Ve9pKdpnLIoznJWJKenVX7_pmZlh_UrvLHY89mG1Sp4');
  });

  it('freezes the authenticated CJK response material and signature', () => {
    const responseInput = {
      requestNonce: goldenInput.nonce,
      method: goldenInput.method,
      pathWithQuery: goldenInput.pathWithQuery,
      status: 202,
      body: '{"ok":true,"message":"已停止🚦"}',
      target: goldenInput.target,
    };
    expect(canonicalWorkflowDaemonIpcResponseMaterial(responseInput)).toBe(
      '["botmux-workflow-daemon-ipc/v1/response","nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","POST","/__workflow-ipc/v1/runs/%E6%B5%81%E7%A8%8B/cancel?z=%E4%B8%AD%E6%96%87","202","7cd0e4d8ed3fec1688119a3d463b4a94dbc1a644b7606044396ae0ca4fbcf6c7","cli_测试","32123","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]',
    );
    expect(signWorkflowDaemonIpcResponse({ secret: SECRET, ...responseInput }))
      .toBe('tMlx4zZ9qBkMXlyDJEasj_V9NZqpzHj1qL70hgWLaE4');
    const signature = signWorkflowDaemonIpcResponse({ secret: SECRET, ...responseInput });
    expect(verifyWorkflowDaemonIpcResponse({ secret: SECRET, ...responseInput, signature })).toBe(true);
    expect(verifyWorkflowDaemonIpcResponse({
      secret: SECRET,
      ...responseInput,
      body: `${responseInput.body} `,
      signature,
    })).toBe(false);
    expect(verifyWorkflowDaemonIpcResponse({
      secret: SECRET,
      ...responseInput,
      target: { ...responseInput.target, bootInstanceId: 'c'.repeat(43) },
      signature,
    })).toBe(false);
  });

  it('binds method, exact path/query, body bytes, app, port, and daemon boot', () => {
    const base = {
      secret: SECRET,
      timestamp: TS,
      nonce: NONCE,
      method: 'POST',
      pathWithQuery: '/__workflow-ipc/v1/runs/r/retry?x=1&y=2',
      body: '{"nodeId":"a"}',
      target: TARGET,
    };
    const original = signWorkflowDaemonIpcRequest(base);
    const variants = [
      { ...base, method: 'GET' },
      { ...base, pathWithQuery: '/__workflow-ipc/v1/runs/r/retry?y=2&x=1' },
      { ...base, body: '{"nodeId":"b"}' },
      { ...base, target: { ...TARGET, larkAppId: 'cli_other' } },
      { ...base, target: { ...TARGET, ipcPort: TARGET.ipcPort + 1 } },
      { ...base, target: { ...TARGET, bootInstanceId: 'c'.repeat(43) } },
    ];
    for (const variant of variants) {
      expect(signWorkflowDaemonIpcRequest(variant)).not.toBe(original);
    }
  });
});

describe('verifyWorkflowDaemonIpcRequest', () => {
  it('accepts exact bytes once and returns the body for the route to parse', async () => {
    const body = '{"reason":"停止"}';
    const out = await verify(makeRequest({ body, pathWithQuery: '/__workflow-ipc/v1/runs/r/cancel' }));
    expect(out).toEqual({ ok: true, bodyRaw: body, nonce: NONCE, target: TARGET });
  });

  it('lets exactly one concurrent request win for the same nonce', async () => {
    const clock = fixedClock();
    const store = createWorkflowDaemonIpcNonceStore(clock);
    const options = {
      secret: SECRET,
      target: { larkAppId: TARGET.larkAppId, bootInstanceId: TARGET.bootInstanceId },
      nonceStore: store,
      clock,
    };
    const [a, b] = await Promise.all([
      verifyWorkflowDaemonIpcRequest(makeRequest(), options),
      verifyWorkflowDaemonIpcRequest(makeRequest(), options),
    ]);
    expect([a, b].filter((result) => result.ok)).toHaveLength(1);
    expect([a, b].filter((result) => !result.ok && result.reason === 'replay')).toHaveLength(1);
  });

  it('rejects an old-boot credential even with a fresh post-restart nonce store', async () => {
    const out = await verify(makeRequest(), {
      target: { larkAppId: TARGET.larkAppId, bootInstanceId: 'z'.repeat(43) },
    });
    expect(out).toEqual({ ok: false, reason: 'signature_mismatch', httpStatus: 401 });
  });

  it.each([
    ['missing timestamp', { [WORKFLOW_DAEMON_IPC_HEADERS.timestamp]: undefined }],
    ['duplicate timestamp', { [WORKFLOW_DAEMON_IPC_HEADERS.timestamp]: [TS, TS] }],
    ['non-canonical timestamp', { [WORKFLOW_DAEMON_IPC_HEADERS.timestamp]: `0${TS}` }],
    ['fractional timestamp', { [WORKFLOW_DAEMON_IPC_HEADERS.timestamp]: `${TS}.5` }],
    ['short nonce', { [WORKFLOW_DAEMON_IPC_HEADERS.nonce]: 'n'.repeat(42) }],
    ['non-base64url signature', { [WORKFLOW_DAEMON_IPC_HEADERS.signature]: '!'.repeat(43) }],
  ])('rejects malformed headers: %s', async (_name, headers) => {
    const out = await verify(makeRequest({ headers }));
    expect(out).toEqual({ ok: false, reason: 'missing_or_malformed_header', httpStatus: 401 });
  });

  it('rejects method, path, body, app, and port tampering', async () => {
    const requests = [
      makeRequest({ signedMethod: 'GET' }),
      makeRequest({ signedPath: '/__workflow-ipc/v1/runs/other/start' }),
      makeRequest({ body: '{}', signedBody: '{"changed":true}' }),
      makeRequest({ signedTarget: { ...TARGET, larkAppId: 'cli_other' } }),
      makeRequest({ signedTarget: { ...TARGET, ipcPort: TARGET.ipcPort + 1 } }),
    ];
    for (const req of requests) {
      const out = await verify(req);
      expect(out).toEqual({ ok: false, reason: 'signature_mismatch', httpStatus: 401 });
    }
  });

  it('rejects stale and future timestamps outside the symmetric window', async () => {
    for (const timestamp of [String(NOW - 60_001), String(NOW + 60_001)]) {
      const out = await verify(makeRequest({ timestamp }));
      expect(out).toEqual({ ok: false, reason: 'timestamp_out_of_window', httpStatus: 401 });
    }
  });

  it('rejects non-loopback peers before accepting a credential', async () => {
    const out = await verify(makeRequest({ remoteAddress: '192.0.2.10' }));
    expect(out).toEqual({ ok: false, reason: 'remote_not_loopback', httpStatus: 403 });
  });

  it('fails closed when the local daemon audience is unavailable', async () => {
    const out = await verify(makeRequest({ localPort: 0 }));
    expect(out).toEqual({ ok: false, reason: 'target_identity_unavailable', httpStatus: 503 });
  });

  it('rejects a declared or streamed body above the 16 KiB cap', async () => {
    const declared = await verify(makeRequest({
      headers: { 'content-length': String(WORKFLOW_DAEMON_IPC_BODY_LIMIT_BYTES + 1) },
    }));
    expect(declared).toEqual({ ok: false, reason: 'body_too_large', httpStatus: 413 });

    const streamed = await verify(makeRequest({
      body: 'x'.repeat(WORKFLOW_DAEMON_IPC_BODY_LIMIT_BYTES + 1),
    }));
    expect(streamed).toEqual({ ok: false, reason: 'body_too_large', httpStatus: 413 });
  });

  it('rejects Content-Length ambiguity or a declared/actual byte mismatch', async () => {
    const mismatched = await verify(makeRequest({
      body: '{}',
      headers: { 'content-length': '999' },
    }));
    expect(mismatched).toEqual({
      ok: false,
      reason: 'body_length_mismatch',
      httpStatus: 400,
    });

    const ambiguous = await verify(makeRequest({
      body: '{}',
      headers: { 'content-length': '2', 'transfer-encoding': 'chunked' },
    }));
    expect(ambiguous).toEqual({
      ok: false,
      reason: 'body_length_mismatch',
      httpStatus: 400,
    });
  });

  it('bounds a stalled body read before any nonce is consumed', async () => {
    const req = makeRequest({ body: '{}' });
    const stalled = new Readable({ read() { /* intentionally never produces bytes */ } });
    Object.assign(stalled, {
      method: req.method,
      url: req.url,
      headers: req.headers,
      socket: req.socket,
    });
    const out = await verify(stalled as unknown as IncomingMessage, { bodyReadTimeoutMs: 5 });
    expect(out).toEqual({ ok: false, reason: 'body_read_timeout', httpStatus: 408 });
  });

  it('rejects invalid UTF-8 even when the signature covers those exact bytes', async () => {
    const invalidUtf8 = Buffer.from([0xc3, 0x28]);
    const out = await verify(makeRequest({ body: invalidUtf8 }));
    expect(out).toEqual({ ok: false, reason: 'body_not_utf8', httpStatus: 400 });
  });
});
