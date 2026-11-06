import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDispatchReportBinding, verifyDispatchReportBinding } from '../src/core/dispatch-report-binding.js';
import {
  deliverReportSourceReply,
  buildReportReplyContext,
  appendReportReplyReference,
  MAX_REPORT_REPLY_REFERENCES,
} from '../src/core/report-source-reply.js';

const secret = 'test-binding-secret';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'source-reply-')); dirs.push(dataDir);
  const binding = createDispatchReportBinding(secret, {
    dispatchRoot: 'om_task', targetLarkAppId: 'cli_source', targetSessionId: 'session-source',
    targetChatId: 'oc_source', targetScope: 'thread', sourceName: 'Review',
    issuedAt: '2026-11-05T00:00:00Z',
    reply: { rootMessageId: 'om_original', sourceTurnId: 'om_request', reporterLarkAppId: 'cli_project' },
  });
  const session = { sessionId: 'session-source', chatId: 'oc_source', rootMessageId: 'om_original',
    quoteTargetId: 'om_request', reportReplyInputId: 'om_request', status: 'active' };
  const posted: string[] = [];
  const references: { messageId: string; dispatchRoot: string }[] = [];
  return { dataDir, binding, session, posted, references,
    request: { dispatchRoot: 'om_task', binding, sourceLarkAppId: 'cli_project', content: '完成\n\n| 项目 | 结果 |\n| --- | --- |\n| A | 通过 |' },
    deps: { dataDir, secret, selfLarkAppId: 'cli_source',
      session: () => session,
      publish: async (content: string) => { posted.push(content); return 'om_answer'; },
      remember: async (reference: { messageId: string; dispatchRoot: string }) => { references.push(reference); },
    },
  };
}

describe('source topic result delivery', () => {
  it('leaves legacy input context empty and rejects empty reports without a provider call', async () => {
    const f = fixture();
    expect(buildReportReplyContext(undefined)).toBe('');
    expect((await deliverReportSourceReply({ ...f.request, content: '  ' }, f.deps)).status).toBe(400);
    expect(f.posted).toEqual([]);
  });
  it('publishes the exact result once and records a reference without starting a model turn', async () => {
    const f = fixture();
    const first = await deliverReportSourceReply(f.request, f.deps);
    const second = await deliverReportSourceReply(f.request, f.deps);
    expect(first).toMatchObject({ status: 200, body: { ok: true, delivery: 'reply', publishedMessageId: 'om_answer' } });
    expect(second).toEqual(first);
    expect(f.posted).toEqual([f.request.content]);
    expect(f.references).toEqual([{ messageId: 'om_answer', dispatchRoot: 'om_task' }]);
    expect(buildReportReplyContext(f.references)).toContain('om_answer');
  });
  it('protects the source root and delivery policy with the host signature', async () => {
    const f = fixture();
    const forged = structuredClone(f.binding);
    forged.payload.reply!.rootMessageId = 'om_other';
    expect(verifyDispatchReportBinding(secret, 'om_task', forged)).toBeNull();
    expect((await deliverReportSourceReply({ ...f.request, binding: forged }, f.deps)).status).toBe(403);
    expect(f.posted).toEqual([]);
  });
  it('rejects a different reporter and never redirects into another topic', async () => {
    const f = fixture();
    expect((await deliverReportSourceReply({ ...f.request, sourceLarkAppId: 'cli_other' }, f.deps)).status).toBe(403);
    f.session.rootMessageId = 'om_other';
    expect((await deliverReportSourceReply(f.request, f.deps)).status).toBe(409);
    expect(f.posted).toEqual([]);
  });
  it('returns a changed-source receipt after a new user message instead of blindly posting', async () => {
    const f = fixture(); f.session.quoteTargetId = 'om_cancel';
    expect(await deliverReportSourceReply(f.request, f.deps)).toMatchObject({
      status: 409, body: { error: 'report_reply_source_changed' },
    });
    expect(f.posted).toEqual([]);
  });
  it('rejects a stop input even when the quoted model turn stays unchanged', async () => {
    const f = fixture(); f.session.reportReplyInputId = 'om_stop';
    expect((await deliverReportSourceReply(f.request, f.deps)).status).toBe(409);
    expect(f.posted).toEqual([]);
  });
  it('retains an unknown provider outcome and does not publish again on retry', async () => {
    const f = fixture();
    const deps = { ...f.deps, publish: async (content: string) => { f.posted.push(content); throw new Error('response lost'); } };
    expect((await deliverReportSourceReply(f.request, deps)).status).toBe(502);
    expect((await deliverReportSourceReply(f.request, deps)).status).toBe(409);
    expect(f.posted).toEqual([f.request.content]);
  });
  it('recovers reference persistence after publication without repeating the message', async () => {
    const f = fixture();
    expect((await deliverReportSourceReply(f.request, { ...f.deps, remember: async () => { throw new Error('store unavailable'); } })).status).toBe(502);
    expect((await deliverReportSourceReply(f.request, f.deps)).status).toBe(200);
    expect(f.posted).toHaveLength(1);
    expect(f.references).toEqual([{ messageId: 'om_answer', dispatchRoot: 'om_task' }]);
  });
  it('replays a completed receipt after a new input without creating another message', async () => {
    const f = fixture();
    expect((await deliverReportSourceReply(f.request, f.deps)).status).toBe(200);
    f.session.quoteTargetId = 'om_followup';
    expect((await deliverReportSourceReply(f.request, f.deps)).status).toBe(200);
    expect(f.posted).toHaveLength(1);
  });
  it('rechecks cancellation immediately at the provider boundary', async () => {
    const f = fixture();
    const result = await deliverReportSourceReply(f.request, { ...f.deps,
      publish: async (_content, target) => {
        f.session.quoteTargetId = 'om_cancel';
        target.beforeWrite();
        throw new Error('unreachable');
      },
    });
    expect(result).toMatchObject({ status: 409, body: { error: 'report_reply_source_changed' } });
    expect(f.posted).toEqual([]);
  });
  it('does not direct-post into a thread whose session is no longer active', async () => {
    const f = fixture(); f.session.status = 'closed';
    expect(await deliverReportSourceReply(f.request, f.deps)).toMatchObject({
      status: 409, body: { error: 'report_reply_source_changed' },
    });
    expect(f.posted).toEqual([]);
  });
});

describe('source reply retry after the source session drifts', () => {
  // The message may already exist in the source topic while the source session
  // row is gone/changed (topic closed, daemon restart, pointers advanced). A
  // retry must judge by the durable journal, never by live session state:
  // replay a settled receipt, keep an unknown outcome, and turn reference
  // recovery failure into a plain 502 — never a "proven unsent" 409 that would
  // make the relay layer start another source model turn with the same result.
  function driftFixture() {
    const f = fixture();
    let session: typeof f.session | undefined = f.session;
    let rememberFails = false;
    let publishLosesResponse = false;
    const deps = {
      ...f.deps,
      session: () => session,
      publish: async (content: string) => {
        f.posted.push(content);
        if (publishLosesResponse) throw new Error('response lost');
        return 'om_answer';
      },
      remember: async (reference: { messageId: string; dispatchRoot: string }) => {
        if (!session) throw new Error('session row is gone');
        if (rememberFails) throw new Error('store unavailable');
        f.references.push(reference);
      },
    };
    return {
      request: f.request, deps, posted: f.posted, references: f.references,
      drift() { session = undefined; },
      failRemember() { rememberFails = true; },
      losePublishResponse() { publishLosesResponse = true; },
    };
  }

  it('replays a settled receipt after the session disappears without resending or a model-turn 409', async () => {
    const f = driftFixture();
    expect((await deliverReportSourceReply(f.request, f.deps)).status).toBe(200);
    f.drift();
    const retry = await deliverReportSourceReply(f.request, f.deps);
    expect(retry).toMatchObject({ status: 200, body: { publishedMessageId: 'om_answer' } });
    expect(f.posted).toHaveLength(1);
  });

  it('keeps post-publication reference recovery at the direct sink as 502 when the session row is gone', async () => {
    const f = driftFixture();
    f.failRemember();
    expect((await deliverReportSourceReply(f.request, f.deps)).status).toBe(502);
    expect(f.posted).toHaveLength(1);
    f.drift();
    const retry = await deliverReportSourceReply(f.request, f.deps);
    expect(retry.status).toBe(502);
    expect(retry.body.error).not.toBe('report_reply_source_changed');
    expect(retry.body.publishedMessageId).toBe('om_answer');
    expect(f.posted).toHaveLength(1);
  });

  it('keeps a pending (unknown) journal unknown after drift instead of reporting proven-unsent', async () => {
    const f = driftFixture();
    f.losePublishResponse();
    expect((await deliverReportSourceReply(f.request, f.deps)).status).toBe(502);
    expect(f.posted).toHaveLength(1);
    f.drift();
    const retry = await deliverReportSourceReply(f.request, f.deps);
    expect(retry).toMatchObject({ status: 409, body: { error: 'report_publication_unknown' } });
    expect(f.posted).toHaveLength(1);
  });
});

describe('report reply reference list', () => {
  const ref = (messageId: string) => ({ messageId, dispatchRoot: `om_${messageId}` });
  it('appends new references and reports the change', () => {
    const result = appendReportReplyReference([ref('om_a')], ref('om_b'));
    expect(result.changed).toBe(true);
    expect(result.references.map(item => item.messageId)).toEqual(['om_a', 'om_b']);
  });
  it('treats a duplicate messageId as unchanged and does not grow the list', () => {
    const existing = [ref('om_a')];
    const result = appendReportReplyReference(existing, ref('om_a'));
    expect(result.changed).toBe(false);
    expect(result.references.map(item => item.messageId)).toEqual(['om_a']);
    expect(result.references).not.toBe(existing);
  });
  it('accepts an undefined list and never writes back an identical list as changed', () => {
    const empty = appendReportReplyReference(undefined, ref('om_a'));
    expect(empty.changed).toBe(true);
    expect(appendReportReplyReference(empty.references, ref('om_a')).changed).toBe(false);
  });
  it('keeps only the newest references at the bound so long sessions cannot grow the prompt forever', () => {
    let list: readonly { messageId: string; dispatchRoot: string }[] = [];
    for (let i = 0; i < MAX_REPORT_REPLY_REFERENCES + 5; i++) {
      const result = appendReportReplyReference(list, ref(`om_${i}`));
      expect(result.changed).toBe(true);
      list = result.references;
    }
    expect(list).toHaveLength(MAX_REPORT_REPLY_REFERENCES);
    expect(list[0]!.messageId).toBe('om_5');
    expect(list.at(-1)!.messageId).toBe(`om_${MAX_REPORT_REPLY_REFERENCES + 4}`);
  });
});
