import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OncallGroupStore, type OncallGroupSource } from '../src/services/oncall-group-store.js';
import { normalizeOncallGroupPolicy } from '../src/services/oncall-group-policy.js';
import { createNativeOncallLink, readOncallChoices, validateOncallSelection } from '../src/services/oncall-platform.js';
import { createOncallGroup, loadOncallGroupTarget, saveOncallGroupTarget } from '../src/services/oncall-group-client.js';
import { OncallFormStore } from '../src/services/oncall-form-store.js';

const dirs: string[] = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), 'oncall-session-')); dirs.push(dir); return dir; }
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); vi.useRealTimers(); });
const source: OncallGroupSource = { appId: 'app', sessionId: 'session', chatId: 'oc_group', messageId: 'om_a1', questionId: 'om_q1', answer: 'answer' };
const target = { endpoint: 'https://oncall.example.test/gateway/api/inf/v1/chat/', tenantId: 12, typeId: 34, region: 'old', emailDomain: 'example.test' };
const response = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));

describe('session Oncall request ownership', () => {
  it('shares a request across rounds, preserves unknown outcomes and isolates new sessions and bots', () => {
    const dir = temp(); const store = new OncallGroupStore(dir);
    expect(store.claim(source, 'ou_owner')).toBe(true);
    const claim = store.getRequest(source)!;
    store.finish(source, { status: 'unknown' }, claim.attemptId);
    store.finish(source, { status: 'failed' }, claim.attemptId);
    const otherRound = { ...source, questionId: 'om_q2', messageId: 'om_a2' };
    expect(new OncallGroupStore(dir).claim(otherRound, 'ou_other')).toBe(false);
    expect(store.getRequest(otherRound)?.status).toBe('unknown');
    expect(() => store.finish(source, { status: 'succeeded', openChatId: 'oc_wrong' }, 'stale')).toThrow();
    expect(store.claim({ ...source, sessionId: 'other' })).toBe(true);
    expect(store.claim({ ...source, appId: 'other' })).toBe(true);
  });
  it('freezes the exact known messages at submission and rejects a second group binding', () => {
    const store = new OncallGroupStore(temp());
    store.registerTurn('app', 'session', 'om_q1'); store.recordSource({ ...source, turnNumber: 1 });
    store.claim(source, 'ou_owner'); const attempt = store.getRequest(source)!.attemptId;
    store.registerTurn('app', 'session', 'om_q2'); store.recordSource({ ...source, questionId: 'om_q2', messageId: 'om_a2', turnNumber: 2 });
    expect(store.getRequest(source)?.messageIdsSnapshot).toEqual(['om_q1', 'om_a1']);
    store.finish(source, { status: 'succeeded', flowId: '1', openChatId: 'oc_created' }, attempt);
    expect(() => store.finish(source, { status: 'succeeded', flowId: '2', openChatId: 'oc_other' }, attempt)).toThrow();
    expect(store.claim(source)).toBe(false);
  });
  it('merges and persists delivered receipts from old per-question requests bound to the same group', () => {
    const dir = temp(); const store = new OncallGroupStore(dir);
    const second = { ...source, questionId: 'om_q2', messageId: 'om_a2' };
    for (const turn of [source, second]) { store.registerTurn('app', 'session', turn.questionId); store.recordSource(turn); }
    for (const [index, turn] of [source, second].entries()) {
      const old = { ...turn, sessionId: undefined };
      store.claim(old, 'ou_owner');
      store.finish(old, { status: 'succeeded', openChatId: 'oc_created', attemptId: `old-${index}`, submittedAtMs: 1000 + index,
        forwardMode: 'individual', questionId: turn.questionId, sourceMessageId: turn.messageId,
        messageIdsSnapshot: [turn.questionId, turn.messageId], forwarded: [turn.questionId, turn.messageId],
        forwardedMessageIds: { [turn.questionId]: `om_receipt${index}`, [turn.messageId]: `om_receipt${index}` } });
    }
    const merged = store.getRequest(second)!;
    expect(merged.openChatId).toBe('oc_created');
    expect(merged.forwarded).toEqual(expect.arrayContaining(['om_q1', 'om_a1', 'om_q2', 'om_a2']));
    expect(merged.forwardedMessageIds).toEqual({ om_q1: 'om_receipt0', om_a1: 'om_receipt0', om_q2: 'om_receipt1', om_a2: 'om_receipt1' });
    store.finish(second, { ...merged, conversationScopePending: false }, merged.attemptId);
    const restored = new OncallGroupStore(dir);
    expect(restored.getRequest(source)?.forwardedMessageIds).toEqual(merged.forwardedMessageIds);
    expect(restored.getRequest(source)?.forwarded).toEqual(merged.forwarded);
    expect(restored.claim(source, 'ou_owner')).toBe(false);
  });

  it('does not reactivate an older entry when its final answer arrives late', () => {
    const store = new OncallGroupStore(temp());
    expect(store.registerTurn('app', 'session', 'om_q1')).toBe(1);
    expect(store.registerTurn('app', 'session', 'om_q1')).toBe(1);
    store.recordSource({ ...source, turnNumber: 1 });
    const newer = { ...source, questionId: 'om_q2', messageId: 'om_a2', turnNumber: 2 };
    store.registerTurn('app', 'session', 'om_q2'); store.recordSource(newer);
    store.recordSource({ ...source, turnNumber: 1, answer: 'late final' });
    expect(store.isLatest(source)).toBe(false); expect(store.isLatest(newer)).toBe(true);
    expect(() => store.recordSource({ ...source, sessionId: 'other' })).toThrow();
  });
  it('keeps the later final card when an older progress card in the same turn redraws after restart', () => {
    const dir = temp(); const store = new OncallGroupStore(dir);
    store.registerTurn('app', 'session', 'om_q1');
    store.recordSource({ ...source, turnNumber: 1 });
    const final = { ...source, messageId: 'om_final', answer: 'final' };
    store.recordSource(final);
    const restored = new OncallGroupStore(dir);
    restored.recordSource({ ...source, turnNumber: 1, answer: 'late progress' });
    expect(restored.isLatest(source)).toBe(false); expect(restored.isLatest(final)).toBe(true);
    restored.recordSource({ ...final, answer: 'updated final' });
    expect(restored.latest('app', 'session')?.answer).toBe('updated final');
  });
  it.each(['succeeded', 'pending', 'unknown'] as const)('preserves legacy %s dedupe when a proven source gains a session identity', status => {
    const store = new OncallGroupStore(temp());
    const old = { ...source, sessionId: undefined };
    store.claim(old); store.finish(old, { status, ...(status === 'succeeded' ? { openChatId: 'oc_original', flowId: 'old' } : {}) });
    store.recordSource(source);
    expect(store.claim(source)).toBe(false);
    expect(store.getRequest(source)?.status).toBe(status === 'succeeded' ? 'succeeded' : 'unknown');
    if (status === 'succeeded') expect(store.getRequest(source)).toMatchObject({ openChatId: 'oc_original', forwardMode: 'none', conversationScopePending: false });
  });
  it('keeps the delivered answer and links when a later non-final update re-indexes the same card', () => {
    const store = new OncallGroupStore(temp());
    store.registerTurn('app', 'session', 'om_q1');
    store.recordSource({ ...source, answer: '', turnNumber: 1 });
    store.recordSource({ ...source, answer: 'final answer', turnNumber: 1, nativeLink: 'https://applink.example.test/native', dispatchAttempt: 2 });
    store.recordSource({ ...source, answer: '', turnNumber: undefined, nativeLink: undefined, dispatchAttempt: undefined });
    expect(store.findSource('app', source.messageId)).toMatchObject({ answer: 'final answer', turnNumber: 1, nativeLink: 'https://applink.example.test/native', dispatchAttempt: 2 });
    expect(store.latest('app', 'session')?.answer).toBe('final answer');
  });
  it('scans pending handoffs without expanding sessions that have no request', () => {
    const store = new OncallGroupStore(temp());
    const sessions = ['s1', 's2', 's3', 's4', 'tracked', 'adopted'].map((sessionId, index) => ({ ...source, sessionId, questionId: `om_q${index}`, messageId: `om_a${index}` }));
    for (const item of sessions) store.recordSource(item);
    const tracked = sessions[4]!;
    store.claim(tracked, 'ou_owner', { messageIds: [tracked.questionId], cutoffMs: Date.now() });
    store.finish(tracked, { status: 'succeeded', openChatId: 'oc_tracked' }, store.getRequest(tracked)!.attemptId);
    const old = { ...sessions[5]!, sessionId: undefined };
    store.claim(old, 'ou_owner');
    store.finish(old, { status: 'succeeded', openChatId: 'oc_adopted', attemptId: 'old', submittedAtMs: Date.now(), forwardMode: 'individual', messageIdsSnapshot: [old.questionId], forwarded: [] });
    const expand = vi.spyOn(OncallGroupStore.prototype, 'sessionSources');
    expect(store.pendingHandoffs('app').map(item => item.sessionId).sort()).toEqual(['adopted', 'tracked']);
    expect(expand).toHaveBeenCalledTimes(1);
    expand.mockRestore();
  });
  it('permits an explicit retry only for a confirmed rejection, with a new attempt owner', () => {
    const store = new OncallGroupStore(temp()); store.claim(source);
    const prior = store.getRequest(source)!.attemptId;
    store.finish(source, { status: 'failed' }, prior); expect(store.claim(source)).toBe(true);
    expect(store.getRequest(source)!.attemptId).not.toBe(prior);
    expect(() => store.finish(source, { status: 'succeeded', openChatId: 'oc_late' }, prior)).toThrow();
  });
});

describe('Oncall configuration and platform adapters', () => {
  it('retains legacy defaults and validates both display choices without duplicating form fields', () => {
    expect(normalizeOncallGroupPolicy({})).toEqual({ enabled: false, chatIds: [] });
    for (const forwardMode of ['none', 'individual', 'merge']) expect(normalizeOncallGroupPolicy({ forwardMode })).toMatchObject({ forwardMode });
    for (const formDisplay of ['native', 'private_card', 'thread_card']) expect(normalizeOncallGroupPolicy({ flowMode: 'classify', formDisplay, button: { timing: 'first', minTurns: 3 } })).toMatchObject({ flowMode: 'classify', formDisplay });
    for (const bad of [{ forwardMode: 'invalid' }, { formDisplay: 'public' }, { button: { minTurns: 0 } }, { button: { minTurns: 1.5 } }, { button: { minTurns: 101 } }, { button: { text: 'other' } }, { defaultCategory: 5 }]) expect(() => normalizeOncallGroupPolicy(bad)).toThrow();
  });
  it('saves one target source without overwriting another bot or requiring legacy fixed values for native forms', () => {
    const dir = temp();
    writeFileSync(join(dir, 'oncall-group-targets.json'), JSON.stringify({ other: target, app: target }));
    const native = { endpoint: target.endpoint, tenantId: 56, emailDomain: target.emailDomain };
    saveOncallGroupTarget(dir, 'app', { tenantId: native.tenantId });
    expect(loadOncallGroupTarget(dir, 'app')).toEqual(native);
    expect(loadOncallGroupTarget(dir, 'other')).toEqual(target);
  });
  it('uses the platform AppLink, opens the launch step, prefills the question and discards fixed legacy selection', async () => {
    const page = new URL('https://oncall.example.test/chat?tenant=12&type=None&region=None');
    const appLink = 'https://applink.feishu.cn/client/web_url/open?url=' + encodeURIComponent(page.href);
    const fetcher = vi.fn().mockResolvedValue(response({ lark_dialog_url: appLink }));
    const link = new URL(await createNativeOncallLink(target, 'secret', '', 'question', 'feishu', fetcher));
    const native = new URL(link.searchParams.get('url')!);
    expect(link.searchParams.get('mode')).toBe('sidebar-semi');
    expect(native.searchParams.get('step')).toBe('launch-oncall');
    expect(native.searchParams.has('type')).toBe(false); expect(native.searchParams.has('region')).toBe(false);
    expect(JSON.parse(native.searchParams.get('context')!)).toEqual({ trigger_message: 'question' });
    expect(link.href).not.toContain('secret');
    expect(fetcher.mock.calls[0][1].redirect).toBe('error');
  });
  it('rejects cross-tenant links and invalid redirects', async () => {
    for (const url of ['https://evil.example/client/web_url/open?url=https%3A%2F%2Foncall.example.test%2Fchat%3Ftenant%3D12',
      'https://applink.feishu.cn/client/web_url/open?url=https%3A%2F%2Foncall.example.test%2Fchat%3Ftenant%3D56']) {
      await expect(createNativeOncallLink(target, 'secret', '', '', 'feishu', vi.fn().mockResolvedValue(response({ lark_dialog_url: url })))).rejects.toThrow();
    }
  });
  it('reloads platform choices on submit and refuses special actions, prerequisites or unmapped custom fields', async () => {
    const category = { id: 34, name: 'category', tenant_id: 12, type_action: 'create_chat', workflow_id: 10 };
    const fetcher = vi.fn().mockResolvedValueOnce(response({ region: { cn: [category] } }))
      .mockResolvedValueOnce(response({ tenant_id: 12, type_id: 34, config: '[]' }));
    await expect(validateOncallSelection(target, 'secret', 'actor', 'cn', 34, fetcher)).resolves.toMatchObject(category);
    for (const config of [{ ...category, type_action: 'redirect' }, { ...category, tenant_id: 99 }]) {
      await expect(validateOncallSelection(target, 'secret', 'actor', 'cn', 34, vi.fn().mockResolvedValue(response({ region: { cn: [config] } })))).rejects.toThrow();
    }
    const custom = vi.fn().mockResolvedValueOnce(response({ region: { cn: [category] } }))
      .mockResolvedValueOnce(response({ tenant_id: 12, type_id: 34, config: '[{"required":true}]' }));
    await expect(validateOncallSelection(target, 'secret', 'actor', 'cn', 34, custom)).rejects.toThrow();
  });
  it('submits the validated selection and verified actor rather than the legacy fixed target', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ oncall_flow_id: '123', open_chat_id: 'oc_created' }));
    await createOncallGroup(target, 'secret', 'actor', 'question', fetcher, { region: 'cn', typeId: 56, priority: 'P1' });
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body).toMatchObject({ tenant_id: 12, type_id: 56, region: 'cn', priority: 'P1' });
    expect(fetcher.mock.calls[0][1].headers['x-api-user']).toBe('actor');
  });
});

describe('personal Oncall draft isolation', () => {
  it('reuses only the same actor’s draft and rejects another actor after restart', async () => {
    const dir = temp(); const store = new OncallFormStore(dir);
    const input = { appId: 'app', ownerOpenId: 'ou_one', source, choices: { regions: {} }, region: '', priority: 'P2' as const, description: 'question' };
    const first = store.open(input); expect(store.open(input).id).toBe(first.id);
    expect(store.open({ ...input, ownerOpenId: 'ou_two' }).id).not.toBe(first.id);
    await expect(new OncallFormStore(dir).use('app', first.id, 'ou_two', async () => {})).rejects.toThrow();
    await store.use('app', first.id, 'ou_one', async draft => { draft.closed = true; });
    expect(store.open(input).id).not.toBe(first.id);
  });
});
