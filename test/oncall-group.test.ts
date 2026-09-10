import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeOncallGroupPolicy, oncallGroupEnabled } from '../src/services/oncall-group-policy.js';
import { OncallGroupStore, type OncallGroupSource } from '../src/services/oncall-group-store.js';
import { createOncallGroup, loadOncallGroupTarget, oncallUsername, type OncallGroupTarget } from '../src/services/oncall-group-client.js';
import { attachOncallGroupButton } from '../src/im/lark/oncall-group.js';
import { normalizeFeedbackPolicy } from '../src/services/feedback-policy.js';
import { buildFeedbackElement, renderFeedbackCard } from '../src/im/lark/skill-feedback-card.js';

const dirs: string[] = [];
const temporary = () => { const dir = mkdtempSync(join(tmpdir(), 'oncall-group-')); dirs.push(dir); return dir; };
afterEach(() => { vi.unstubAllEnvs(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
const source: OncallGroupSource = { appId: 'app', chatId: 'oc_source', messageId: 'om_reply', questionId: 'om_question', answer: 'answer' };
const answerCard = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'answer' }] } };
const target: OncallGroupTarget = { endpoint: 'https://oncall.example.test/api/inf/v1/chat/', tenantId: 12, typeId: 34, region: 'nation', emailDomain: 'example.test' };

describe('Oncall button configuration', () => {
  it('is opt-in and scopes only to selected groups', () => {
    expect(normalizeOncallGroupPolicy({})).toEqual({ enabled: false, chatIds: [] });
    expect(oncallGroupEnabled(undefined, 'oc_a')).toBe(false);
    expect(oncallGroupEnabled({ enabled: true, chatIds: [] }, 'oc_a')).toBe(false);
    const policy = normalizeOncallGroupPolicy({ enabled: true, chatIds: ['oc_a', 'oc_a'] });
    expect(policy.chatIds).toEqual(['oc_a']);
    expect(oncallGroupEnabled(policy, 'oc_a')).toBe(true);
    expect(oncallGroupEnabled(policy, 'oc_b')).toBe(false);
    expect(oncallGroupEnabled({ ...policy, enabled: false }, 'oc_a')).toBe(false);
  });
  it.each([null, [], { enabled: 'true' }, { chatIds: 'oc_a' }, { chatIds: ['../secret'] }, { endpoint: 'https://other.test' }])('rejects malformed configuration %j', value => {
    expect(() => normalizeOncallGroupPolicy(value)).toThrow();
  });
});

describe('Oncall group requests', () => {
  it('persists sources without changing the feedback store', () => {
    const dir = temporary();
    const store = new OncallGroupStore(dir);
    store.recordSource(source);
    expect(new OncallGroupStore(dir).findSource('app', 'om_reply')).toEqual(source);
    expect(store.findSource('other', 'om_reply')).toBeUndefined();
    expect(store.findSource('app', '../../secret')).toBeUndefined();
  });
  it('deduplicates across cards, store instances and restarts for the same question', () => {
    const dir = temporary();
    const store = new OncallGroupStore(dir);
    expect(store.claim(source)).toBe(true);
    expect(new OncallGroupStore(dir).claim({ ...source, messageId: 'om_second_reply' })).toBe(false);
    store.finish(source, { status: 'succeeded', flowId: '123', openChatId: 'oc_created' });
    expect(new OncallGroupStore(dir).claim(source)).toBe(false);
    expect(store.getRequest(source)).toMatchObject({ status: 'succeeded', openChatId: 'oc_created' });
    expect(store.claim({ ...source, questionId: 'om_other_question' })).toBe(true);
    expect(store.claim({ ...source, appId: 'other' })).toBe(true);
  });
  it('allows confirmed failures to retry, but never retries uncertain results', () => {
    const store = new OncallGroupStore(temporary());
    store.claim(source);
    store.finish(source, { status: 'failed' });
    expect(store.claim(source)).toBe(true);
    store.finish(source, { status: 'unknown' });
    expect(store.claim(source)).toBe(false);
  });
});

describe('Oncall platform client', () => {
  it('loads server-only routing and requires the configured email domain', () => {
    const dir = temporary();
    writeFileSync(join(dir, 'oncall-group-targets.json'), JSON.stringify({ app: target }));
    expect(loadOncallGroupTarget(dir, 'app')).toEqual(target);
    expect(oncallUsername('user.name@example.test', target)).toBe('user.name');
    expect(() => oncallUsername('user.name@other.test', target)).toThrow();
    expect(() => oncallUsername(undefined, target)).toThrow();
    expect(() => loadOncallGroupTarget(dir, 'other')).toThrow();
    writeFileSync(join(dir, 'oncall-group-targets.json'), JSON.stringify({ app: { ...target, endpoint: 'http://unsafe.test' } }));
    expect(() => loadOncallGroupTarget(dir, 'app')).toThrow();
  });
  it('calls BytedOncall directly with a service JWT and the verified clicker', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { oncall_flow_id: 123, open_chat_id: 'oc_created' } })));
    await expect(createOncallGroup(target, 'test-token', 'user', 'question + answer', fetcher)).resolves.toEqual({ flowId: '123', openChatId: 'oc_created' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe(target.endpoint);
    expect(request.redirect).toBe('error');
    expect(request.headers).toEqual({ 'content-type': 'application/json', 'x-jwt-token': 'test-token', 'x-api-user': 'user' });
    expect(JSON.parse(request.body)).toEqual({ tenant_id: 12, type_id: 34, region: 'nation', type: 'create_chat',
      priority: 'P2', source_type: 'open_api', source_location: 'botmux', trigger_message: 'question + answer' });
  });
  it('takes the platform endpoint and routing from each bot deployment', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { oncall_flow_id: 456, open_chat_id: 'oc_other' } })));
    const other = { ...target, endpoint: 'https://other-oncall.example.test/api/inf/v1/chat/', tenantId: 56, typeId: 78, region: 'sg' };
    await createOncallGroup(other, 'other-jwt', 'other.user', 'other question', fetcher);
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe(other.endpoint);
    expect(request.headers['x-jwt-token']).toBe('other-jwt');
    expect(JSON.parse(request.body)).toMatchObject({ tenant_id: 56, type_id: 78, region: 'sg' });
  });
  it.each([401, 403, 422])('reports HTTP %s as a confirmed rejection', async status => {
    await expect(createOncallGroup(target, 'token', 'user', 'question', vi.fn().mockResolvedValue(new Response('', { status })))).rejects.toMatchObject({ uncertain: false });
  });
  it('marks timeout, malformed success, and server errors uncertain without retrying', async () => {
    for (const fetcher of [vi.fn().mockRejectedValue(new Error('timeout')), vi.fn().mockResolvedValue(new Response('{}')), vi.fn().mockResolvedValue(new Response('', { status: 500 }))]) {
      await expect(createOncallGroup(target, 'token', 'user', 'question', fetcher)).rejects.toMatchObject({ uncertain: true });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});

describe('Oncall and feedback card composition', () => {
  const attach = (card: Record<string, unknown>) => JSON.parse(attachOncallGroupButton(JSON.stringify(card), { enabled: true, chatIds: ['oc_source'] }, 'oc_source'));
  const policy = normalizeFeedbackPolicy({ enabled: true, negativeFollowup: { reasons: [{ key: 'wrong', label: '结论错误' }] } });
  const base = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'answer' }, buildFeedbackElement(policy), { tag: 'markdown', element_id: 'botmux_reply_footer', content: 'footer' }] } };
  it('appends exactly one button to the right without mutating existing controls', () => {
    const card = attach(base);
    expect(card.body.elements[1].flex_mode).toBe('flow');
    expect(card.body.elements[1].columns.slice(0, -1)).toEqual((base.body.elements[1] as any).columns);
    expect(card.body.elements[1].columns.at(-1).elements[0]).toMatchObject({
      text: { content: '拉起 Oncall 群' }, type: 'primary_text',
      icon: { tag: 'standard_icon', token: 'chat_outlined' },
      behaviors: [{ type: 'callback', value: { action: 'oncall_group_create' } }],
    });
    expect(JSON.stringify(base)).not.toContain('oncall_group');
    expect(attach(card)).toEqual(card);
  });
  it('preserves the static button through feedback and secondary selections', () => {
    const negative = { result: policy.buttons.find(button => button.semantic === 'negative')!.key };
    const first = attach(renderFeedbackCard(base, policy, negative));
    const second = renderFeedbackCard(attach(base), policy, negative);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toContain('botmux_feedback_reasons');
    expect(JSON.stringify(first)).toContain('拉起 Oncall 群');
    const reason = renderFeedbackCard(first, policy, { ...negative, reasonKey: 'wrong', comment: 'details' });
    expect(JSON.stringify(reason).match(/oncall_group_create/g)).toHaveLength(1);
    expect(JSON.stringify(reason)).toContain('已补充说明');
    expect(first.body.elements[0]).toEqual(base.body.elements[0]);
  });
  it('supports feedback-off and leaves disabled, unselected and private cards unchanged', () => {
    const raw = JSON.stringify(answerCard);
    expect(attach(answerCard).body.elements[1].columns[0].elements[0].text.content).toBe('拉起 Oncall 群');
    expect(attachOncallGroupButton(raw, undefined, 'oc_source')).toBe(raw);
    expect(attachOncallGroupButton(raw, { enabled: true, chatIds: ['oc_other'] }, 'oc_source')).toBe(raw);
    expect(attachOncallGroupButton(raw, { enabled: true, chatIds: ['oc_source'] }, 'oc_source', 'p2p')).toBe(raw);
  });
  it('restores the Oncall callback when Lark omits behaviors from a fetched card', () => {
    const fetched = attach(base);
    for (const column of fetched.body.elements[1].columns) delete column.elements[0].behaviors;
    const rendered: any = renderFeedbackCard(fetched, policy, { result: policy.buttons[0].key });
    expect(rendered.body.elements[1].columns.at(-1)).toEqual(attach(base).body.elements[1].columns.at(-1));
  });
});
