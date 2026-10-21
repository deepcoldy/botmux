import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { __setLoopbackTransportForTests } from '../../src/core/loopback-fetch.js';
import {
  MANAGED_ORIGIN_PROOF_DOMAIN,
  writeManagedOriginAttestationProof,
} from '../../src/core/managed-origin-attestation.js';
import { findExecutableLinkRefs } from '../../src/services/link-ref-resolver.js';

// The >MAX_STRING_LENGTH regression uses a sparse attachment to prove the CLI
// never decodes it as UTF-8. Keep the later upload path lightweight: production
// uploadFile still asks fs for bytes, but this fixture only needs to exercise
// routing and captures the resulting file message rather than uploading 512MiB.
const stubbedLargeUpload = process.env.BOTMUX_TEST_STUB_LARGE_FILE_UPLOAD;
if (stubbedLargeUpload) {
  const originalReadFileSync = fs.readFileSync.bind(fs);
  fs.readFileSync = ((path: fs.PathOrFileDescriptor, options?: unknown) => {
    if (String(path) === stubbedLargeUpload && options === undefined) {
      return Buffer.from('fixture-upload');
    }
    return originalReadFileSync(path, options as never);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
}

const topicLookups = new Map<string, number>();

(defaultHttpInstance as any).defaults.adapter = async (config: any) => {
  const url = new URL(config.url, 'https://open.feishu.cn');
  const method = String(config.method).toUpperCase();
  let data;
  if (url.pathname.includes('/auth/')) {
    data = { code: 0, tenant_access_token: 'test-token', expire: 7200 };
  } else if (url.pathname.includes('/im/v1/files')) {
    data = process.env.BOTMUX_TEST_FAIL_FILE_UPLOAD === '1'
      ? { code: 99991400, msg: 'upload rejected by test' }
      : { code: 0, data: { file_key: 'file_test_upload' } };
  } else if (url.pathname.includes('/im/v1/images') && process.env.BOTMUX_TEST_ALLOW_IMAGE_UPLOAD === '1') {
    data = { code: 0, data: { image_key: 'img_test_upload' } };
  } else if (url.pathname.includes('/im/v1/messages') && ['POST', 'PATCH'].includes(method)) {
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    console.log('CAPTURE_REPLY=' + JSON.stringify({ method, path: url.pathname, body }));
    data = { code: 0, data: { message_id: 'om_separate_message' } };
  } else if (url.pathname.includes('/cardkit/v1/cards/') && method === 'PUT') {
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    console.log('CAPTURE_REPLY=' + JSON.stringify({ method, path: url.pathname, body }));
    data = { code: 0, data: {} };
  } else if (url.pathname.includes('/im/v1/messages/') && process.env.BOTMUX_TEST_TOPIC_STATE) {
    const state = process.env.BOTMUX_TEST_TOPIC_STATE;
    data = { code: 0, data: { items: state === 'missing' ? [] : [{
      message_id: url.pathname.split('/').at(-1),
      ...(state === 'unknown' ? {} : { deleted: state === 'deleted' }),
      body: { content: '{"text":"hello"}' },
    }] } };
  } else if (url.pathname.includes('/im/v1/messages/') && process.env.BOTMUX_TEST_TOPIC_STATES) {
    const id = url.pathname.split('/').at(-1)!;
    const states = JSON.parse(process.env.BOTMUX_TEST_TOPIC_STATES);
    const count = (topicLookups.get(id) ?? 0) + 1;
    topicLookups.set(id, count);
    console.log('CAPTURE_TOPIC=' + JSON.stringify({ id, count }));
    const state = states[id] ?? 'live';
    if (state === 'error') throw new Error('topic lookup unavailable');
    data = state === 'withdrawn-code' ? { code: 230011, msg: 'withdrawn' }
      : { code: 0, data: { items: [{ message_id: id, chat_id: 'oc_test',
        deleted: state === 'withdrawn' || (state === 'withdraw-after-preflight' && count > 1),
        body: { content: '{"text":"hello"}' } }] } };
  } else if (url.pathname.includes('/im/v1/messages/')) {
    // BOTMUX_TEST_THREAD_ID: the looked-up message now belongs to that topic.
    const threadId = process.env.BOTMUX_TEST_THREAD_ID;
    data = { code: 0, data: { items: [{ message_id: 'om_turn', body: { content: '{"text":"hello"}' },
      ...(threadId ? { thread_id: threadId } : {}) }] } };
  } else if (url.pathname.includes('/im/v1/chats/')) {
    data = { code: 0, data: { chat_mode: 'group', chat_type: 'private' } };
  } else {
    throw new Error(`Unexpected test HTTP request: ${method} ${url.pathname}`);
  }
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};
if (process.env.BOTMUX_TEST_DURABLE_SEND === '1' || process.env.BOTMUX_TEST_LINK_REF_URL) {
  __setLoopbackTransportForTests(async (url, init) => {
    const target = new URL(url);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    if (target.pathname.endsWith('/api/session-origin/attest')
      && process.env.BOTMUX_TEST_MANAGED_ORIGIN === '1') {
      console.log('CAPTURE_ATTEST=' + JSON.stringify({ method: init.method, path: target.pathname, body }));
      writeManagedOriginAttestationProof({
        dataDir: process.env.SESSION_DATA_DIR!,
        proof: {
          domain: MANAGED_ORIGIN_PROOF_DOMAIN,
          version: 1,
          nonce: body.nonce,
          channelId: body.channelId,
          sessionId: body.sessionId,
          turnId: process.env.BOTMUX_TURN_ID!,
          ...(process.env.BOTMUX_TEST_ATTEST_LINK_REF_MODE === 'none'
            ? {}
            : { linkRefMode: 'enabled' as const }),
          requiresCodexAppLedger: false,
          issuedAtMs: Date.now(),
        },
      });
      return new Response(null, { status: 200 });
    }
    if (target.pathname.endsWith('/link-refs/resolve')) {
      console.log('CAPTURE_LINK_REF_RESOLVE=' + JSON.stringify({
        method: init.method,
        path: target.pathname,
        body,
      }));
      const exactUrl = process.env.BOTMUX_TEST_LINK_REF_URL;
      const acceptedRef = process.env.BOTMUX_TEST_LINK_REF_ID;
      const resolved = new Map(exactUrl && acceptedRef ? [[acceptedRef, exactUrl]] : []);
      const expand = (value: string): string => findExecutableLinkRefs(value).expand(resolved);
      const walk = (value: unknown): unknown => {
        if (typeof value === 'string') return expand(value);
        if (Array.isArray(value)) return value.map(walk);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]));
      };
      try {
        const payload = body?.payload ?? {};
        return new Response(JSON.stringify({
          ok: true,
          payload: {
            ...(payload.text === undefined ? {} : { text: expand(payload.text) }),
            ...(payload.preparedText === undefined ? {} : { preparedText: expand(payload.preparedText) }),
            ...(payload.card === undefined ? {} : { card: walk(payload.card) }),
            ...(payload.completionProposal === undefined
              ? {}
              : { completionProposal: walk(payload.completionProposal) }),
            ...(payload.expectedLinks === undefined
              ? {}
              : { expectedLinks: payload.expectedLinks.map(expand) }),
            refCount: 1,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
          ? String((error as { code: unknown }).code)
          : 'link_ref_unknown';
        return new Response(JSON.stringify({ ok: false, error: code }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    console.log('CAPTURE_DURABLE=' + JSON.stringify({
      method: init.method,
      path: target.pathname,
      body,
    }));
    return new Response(JSON.stringify({
      ok: true,
      kind: 'delivered',
      messageId: 'om_durable_message',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}
if (process.env.BOTMUX_TEST_REPLY_RENDER_SNAPSHOT) {
  __setLoopbackTransportForTests(async (url) => {
    const target = new URL(url);
    if (!target.pathname.endsWith('/reply-render-snapshot')) throw new Error(`Unexpected render test route: ${target.pathname}`);
    console.log('CAPTURE_RENDER_QUERY=' + target.search);
    return new Response(JSON.stringify({ snapshot: JSON.parse(process.env.BOTMUX_TEST_REPLY_RENDER_SNAPSHOT!) }), { status: 200 });
  });
}
if (process.env.BOTMUX_TEST_DEFERRED_TOPIC_DAEMON === '1') {
  // The real daemon claim handler behind the loopback route, with the session
  // the daemon would hold and a provider lookup that reports what this fixture
  // published (or BOTMUX_TEST_DEFERRED_ROOT_FACTS to simulate a forged root).
  const { DeferredTopicClaimRegistry, parseDeferredTopicClaimRequest } = await import('../../src/core/deferred-topic-claim.js');
  const { readDeferredTopicBinding, writeDeferredTopicBinding } = await import('../../src/core/deferred-topic-binding.js');
  const daemonDataDir = process.env.BOTMUX_TEST_DAEMON_DATA_DIR!;
  const ds = JSON.parse(process.env.BOTMUX_TEST_DEFERRED_DAEMON_SESSION!);
  const registry = new DeferredTopicClaimRegistry({
    readBinding: id => readDeferredTopicBinding(daemonDataDir, id),
    writeBinding: b => writeDeferredTopicBinding(daemonDataDir, b),
    lookupRoot: async () => JSON.parse(process.env.BOTMUX_TEST_DEFERRED_ROOT_FACTS ?? 'null')
      ?? { chatId: ds.chatId, senderAppId: ds.larkAppId, isReply: false, createdAtMs: Date.now() },
  });
  __setLoopbackTransportForTests(async (url, init) => {
    const target = new URL(url);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    console.log('CAPTURE_DAEMON=' + JSON.stringify({ method: init.method, path: target.pathname, body }));
    if (!target.pathname.endsWith('/deferred-topic')) throw new Error(`Unexpected daemon request ${target.pathname}`);
    const request = parseDeferredTopicClaimRequest(body ?? {});
    const result = request
      ? await registry.handle(ds, request)
      : { ok: false, status: 400, error: 'invalid_deferred_topic_request' };
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : (result as { status: number }).status,
      headers: { 'content-type': 'application/json' },
    });
  });
}
// Any non-SDK network request also fails closed; this fixture never contacts Feishu.
globalThis.fetch = async () => { throw new Error('Unexpected test fetch'); };
process.argv = [process.execPath, './src/cli.ts', ...process.argv.slice(2)];
await import('../../src/cli.js');
