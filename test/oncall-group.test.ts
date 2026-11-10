import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeOncallGroupPolicy, oncallGroupEnabled } from '../src/services/oncall-group-policy.js';
import { OncallGroupStore, type OncallGroupSource } from '../src/services/oncall-group-store.js';
import { createOncallGroup, loadOncallGroupTarget, oncallUsername, type OncallGroupTarget } from '../src/services/oncall-group-client.js';
import { attachOncallGroupButton, buildOncallGroupColumn } from '../src/im/lark/oncall-group.js';
import { normalizeFeedbackPolicy } from '../src/services/feedback-policy.js';
import { buildFeedbackElement, renderFeedbackCard } from '../src/im/lark/skill-feedback-card.js';
import { buildTurnReplyCard } from '../src/im/lark/turn-reply-card.js';
import { createNativeOncallLink } from '../src/services/oncall-platform.js';
import { CARD_LATE_CHROME_RESERVE_BYTES } from '../src/im/lark/md-card.js';

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
  it.each([[null], [[]], [{ enabled: 'true' }], [{ chatIds: 'oc_a' }], [{ chatIds: ['../secret'] }], [{ endpoint: 'https://other.test' }]])('rejects malformed configuration %j', value => {
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
  it('calls the Oncall gateway with a service secret and the verified clicker', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { oncall_flow_id: 123, open_chat_id: 'oc_created' } })));
    await expect(createOncallGroup(target, 'test-secret', 'user', 'question + answer', fetcher)).resolves.toEqual({ flowId: '123', openChatId: 'oc_created' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe(target.endpoint);
    expect(request.redirect).toBe('error');
    expect(request.headers).toEqual({ 'content-type': 'application/json', Authorization: 'Bearer test-secret', 'x-api-user': 'user' });
    expect(JSON.parse(request.body)).toEqual({ tenant_id: 12, type_id: 34, region: 'nation', type: 'create_chat',
      priority: 'P2', source_type: 'open_api', source_location: 'botmux', trigger_message: 'question + answer' });
  });
  it('takes the platform endpoint and routing from each bot deployment', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { oncall_flow_id: 456, open_chat_id: 'oc_other' } })));
    const other = { ...target, endpoint: 'https://other-oncall.example.test/api/inf/v1/chat/', tenantId: 56, typeId: 78, region: 'sg' };
    await createOncallGroup(other, 'test-secret', 'other.user', 'other question', fetcher);
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe(other.endpoint);
    expect(request.headers.Authorization).toBe('Bearer test-secret');
    expect(JSON.parse(request.body)).toMatchObject({ tenant_id: 56, type_id: 78, region: 'sg' });
  });
  it.each([401, 403, 422])('reports HTTP %s as a confirmed rejection', async status => {
    await expect(createOncallGroup(target, 'secret', 'user', 'question', vi.fn().mockResolvedValue(new Response('', { status })))).rejects.toMatchObject({ uncertain: false });
  });
  it('marks timeout, malformed success, and server errors uncertain without retrying', async () => {
    for (const fetcher of [vi.fn().mockRejectedValue(new Error('timeout')), vi.fn().mockResolvedValue(new Response('{}')), vi.fn().mockResolvedValue(new Response('', { status: 500 }))]) {
      await expect(createOncallGroup(target, 'secret', 'user', 'question', fetcher)).rejects.toMatchObject({ uncertain: true });
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
    expect(card.body.elements[1].columns).toEqual((base.body.elements[1] as any).columns);
    expect(card.body.elements.at(-1).columns[0]).toMatchObject({ width: 'weighted' });
    expect(card.body.elements.at(-1).columns.at(-1).elements[0]).toMatchObject({
      text: { content: '转人工' }, type: 'default', size: 'small',
      behaviors: [{ type: 'callback', value: { action: 'oncall_group_create' } }],
    });
    expect(JSON.stringify(base)).not.toContain('oncall_group');
    expect(attach(card)).toEqual(card);
  });
  it('puts handoff status beside a small neutral group link', () => {
    const column = buildOncallGroupColumn({ href: 'https://applink.feishu.cn/client/chat/open?chatId=oc_fixture',
      status: '进入人工 Oncall 群', handoffStatus: '已发起人工 Oncall' });
    expect(column.direction).toBe('horizontal');
    expect(column.elements[0]).toMatchObject({ tag: 'button', type: 'default', size: 'small',
      behaviors: [{ type: 'open_url', default_url: 'https://applink.feishu.cn/client/chat/open?chatId=oc_fixture' }] });
    expect(column.elements[1]).toMatchObject({ tag: 'markdown', text_size: 'notation' });
  });
  it('keeps a native form link for a long question within the late card chrome reserve', async () => {
    const page = new URL('https://oncall.example.test/chat?tenant=12');
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: {
      lark_dialog_url: 'https://applink.feishu.cn/client/web_url/open?url=' + encodeURIComponent(page.href) } })));
    const question = '系统报错日志'.repeat(500);
    const href = await createNativeOncallLink(target, 'secret', '', question, 'feishu', fetcher);
    const prefill = JSON.parse(new URL(new URL(href).searchParams.get('url')!).searchParams.get('context')!).trigger_message;
    expect(prefill.endsWith('…') && question.startsWith(prefill.slice(0, -1))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(buildOncallGroupColumn({ href })))).toBeLessThan(CARD_LATE_CHROME_RESERVE_BYTES);
  });

  it('preserves the static button through feedback and secondary selections', () => {
    const negative = { result: policy.buttons.find(button => button.semantic === 'negative')!.key };
    const first = attach(renderFeedbackCard(base, policy, negative));
    const second = renderFeedbackCard(attach(base), policy, negative);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toContain('botmux_feedback_reasons');
    expect(JSON.stringify(first)).toContain('转人工');
    const reason = renderFeedbackCard(first, policy, { ...negative, reasonKey: 'wrong', comment: 'details' });
    for (const card of [first, second, reason] as any[]) {
      for (const id of ['botmux_feedback', 'botmux_feedback_reasons']) {
        expect(card.body.elements.find((element: any) => element.element_id === id).flex_mode).toBe('flow');
      }
    }
    expect(JSON.stringify(reason).match(/oncall_group_create/g)).toHaveLength(1);
    expect(JSON.stringify(reason)).toContain('已补充说明');
    expect(first.body.elements[0]).toEqual(base.body.elements[0]);
  });
  it('supports feedback-off and leaves disabled, unselected and private cards unchanged', () => {
    const raw = JSON.stringify(answerCard);
    expect(attach(answerCard).body.elements[1].columns.at(-1).elements[0].text.content).toBe('转人工');
    expect(attachOncallGroupButton(raw, undefined, 'oc_source')).toBe(raw);
    expect(attachOncallGroupButton(raw, { enabled: true, chatIds: ['oc_other'] }, 'oc_source')).toBe(raw);
    expect(attachOncallGroupButton(raw, { enabled: true, chatIds: ['oc_source'] }, 'oc_source', 'p2p')).toBe(raw);
  });
  it('restores the Oncall callback when Lark omits behaviors from a fetched card', () => {
    const fetched = attach(base);
    for (const column of fetched.body.elements.at(-1).columns) for (const element of column.elements) delete element.behaviors;
    const rendered: any = renderFeedbackCard(fetched, policy, { result: policy.buttons[0].key });
    expect(rendered.body.elements.at(-1).columns.at(-1)).toEqual(attach(base).body.elements.at(-1).columns.at(-1));
  });
  it.each([true, false])('keeps Oncall on overflow reply cards with feedback=%s', feedback => {
    const card = buildTurnReplyCard({
      version: 1, larkAppId: 'app', sessionId: 'session', turnId: 'om_question',
      mode: 'unified', chatId: 'oc_source', rootId: 'om_root', phase: 'completed',
      createdAtMs: 0, progress: [], tools: [], overflowMessageId: 'om_attachment',
      finalCard: JSON.stringify(attach(feedback ? base : answerCard)),
    }, { showProcess: true, showToolResults: true, canStop: false });
    expect(card.match(/oncall_group_create/g)).toHaveLength(1);
    expect(card).toContain('Markdown 附件');
    expect(card.includes('botmux_feedback')).toBe(feedback);
  });
});

describe('Oncall button with a voice-only chrome row', () => {
  it('keeps voice controls and anchors the Oncall action at the bottom right', () => {
    const card = {
      schema: '2.0',
      body: { elements: [
        { tag: 'markdown', content: 'answer' },
        { tag: 'hr' },
        { tag: 'column_set', element_id: 'botmux_reply_actions', flex_mode: 'none', columns: [
          { tag: 'column', width: 'weighted', elements: [{ tag: 'markdown', element_id: 'botmux_reply_footer', content: 'f' }] },
          { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '🔊 语音总结' }, behaviors: [{ type: 'callback', value: { action: 'voice_summary' } }] }] },
        ] },
      ] },
    };
    const attached = JSON.parse(attachOncallGroupButton(JSON.stringify(card), { enabled: true, chatIds: ['oc_source'] }, 'oc_source'));
    const row = attached.body.elements.find((e: any) => e.element_id === 'botmux_reply_actions');
    expect(row.columns).toHaveLength(3);
    expect(row.columns[1].elements[0].behaviors[0].value.action).toBe('voice_summary');
    expect(attached.body.elements.at(-1).columns.at(-1).elements[0].behaviors[0].value.action).toBe('oncall_group_create');
    expect(attached.body.elements.at(-1).element_id).toBe('botmux_reply_actions');
  });
});
