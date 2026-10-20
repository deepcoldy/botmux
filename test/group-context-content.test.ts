import { describe, expect, it } from 'vitest';
import {
  isGroupContextNoise,
  isUnavailableGroupContextCard,
  sanitizeGroupContextText,
  type GroupContextContentRecord,
} from '../src/services/group-context-content.js';

function record(overrides: Partial<GroupContextContentRecord> = {}): GroupContextContentRecord {
  return { senderType: 'bot', msgType: 'post', text: 'Working', ...overrides };
}

describe('group context content hygiene', () => {
  it.each(['Working', 'Completed'])('recognizes only the resource-free bot %s post as process noise', (text) => {
    expect(isGroupContextNoise(record({ text }))).toBe(true);
    expect(isGroupContextNoise(record({ text: ` ${text}\n` }))).toBe(true);
    expect(isGroupContextNoise(record({ text, senderType: 'user' }))).toBe(false);
    expect(isGroupContextNoise(record({ text: 'Working through the budget: keep it under 3000.' }))).toBe(false);
    expect(isGroupContextNoise(record({ text, resourceRefs: [{ type: 'image', key: 'sample-image' }] }))).toBe(false);
    expect(isGroupContextNoise(record({ text, msgType: 'image' }))).toBe(false);
  });

  it.each(['打开 Web 终端', 'Web terminal', '获取操作链接', '关闭会话'])('recognizes BotMux process cards containing %s', (action) => {
    const card = record({ msgType: 'interactive', text: `[卡片: 🖥️ Local session]\n${action}` });
    expect(isGroupContextNoise(card)).toBe(true);
    expect(isGroupContextNoise({ ...card, senderType: 'user' })).toBe(false);
    expect(isGroupContextNoise({ ...card, msgType: 'text' })).toBe(false);
    expect(isGroupContextNoise({ ...card, text: `[卡片: 行程答复]\n${action}是管理按钮，旅行预算为三千元。` })).toBe(false);
  });

  it('classifies empty bot and unknown tombstones as presentation noise unless they reference resources', () => {
    expect(isGroupContextNoise(record({ senderType: 'unknown', deleted: true, text: '  ' }))).toBe(true);
    expect(isGroupContextNoise(record({ senderType: 'bot', deleted: true, text: '' }))).toBe(true);
    expect(isGroupContextNoise(record({ senderType: 'unknown', deleted: true, text: '', resourceRefs: [{ type: 'image' }] }))).toBe(false);
    expect(isGroupContextNoise(record({ senderType: 'bot', deleted: true, text: '', resourceRefs: [{ type: 'image' }] }))).toBe(false);
    expect(isGroupContextNoise(record({ senderType: 'user', deleted: true, text: '' }))).toBe(false);
    expect(isGroupContextNoise(record({ senderType: 'unknown', deleted: false, text: '' }))).toBe(false);
  });

  it('recognizes retained process text on tombstones but keeps ordinary answer content', () => {
    expect(isGroupContextNoise(record({ text: 'Completed', deleted: true }))).toBe(true);
    expect(isGroupContextNoise(record({ msgType: 'interactive', text: '[卡片: 🖥️ Local session]\n关闭会话', deleted: true }))).toBe(true);
    expect(isGroupContextNoise(record({ text: 'The budget is 3000.', deleted: true }))).toBe(false);
  });

  it.each([
    '💭 **处理中 · 12.0s**\n正在处理你的请求…\n💭 PRIVATE_THINKING\n🔧 Read PRIVATE_TOOL',
    '[卡片: 验证结果]\n✅ **已完成 · 42.1s**\n答复正文\n📋 执行过程\nPRIVATE_PROCESS',
    '[卡片: 验证结果]\n[标签: 结论]\n✅ **已完成 · 42.1s**\n答复正文\n📋 执行过程\nPRIVATE_PROCESS',
    '🙋 **Waiting for your response · 1.0s**\nWhich repository?\nPRIVATE_PROCESS',
    '[卡片: 🖥️ Codex · task — 工作中]\nPRIVATE_PROCESS',
  ])('requires authoritative rehydration for an unprojected runtime envelope: %s', (text) => {
    const legacy = record({ msgType: 'interactive', text });
    expect(isUnavailableGroupContextCard(legacy)).toBe(true);
    expect(isUnavailableGroupContextCard({ ...legacy, cardContentVersion: 1 })).toBe(false);
    expect(isUnavailableGroupContextCard({ ...legacy, cardContentVersion: 2 })).toBe(true);
    expect(isUnavailableGroupContextCard({ ...legacy, senderType: 'user' })).toBe(false);
    expect(isUnavailableGroupContextCard({ ...legacy, msgType: 'text' })).toBe(false);
    expect(isGroupContextNoise({ ...legacy, deleted: true })).toBe(true);
  });

  it.each([
    'Working through the budget: keep it under 3000.',
    '正在工作，但预算审批仍然必须由用户确认。',
    '[卡片: 行程答复]\nWorking\n预算为三千元。',
    '[卡片: 行程答复]\n正在工作\n预算为三千元。',
    '先前卡片显示：\n💭 **处理中 · 12.0s**\n这是用户引用的状态。',
    '💭 **Working on the budget**\nThe limit is 3000.',
    '✅ **已完成预算评估 · 42.1s**\n预算为三千元。',
    '✅ **Working · 12.0s**\nA foreign card uses its own heading.',
    '[卡片: 🖥️ 电脑采购计划]\n预算为三千元。',
  ])('preserves ordinary authored bot card content without keyword filtering: %s', (text) => {
    const authored = record({ msgType: 'interactive', text });
    expect(isUnavailableGroupContextCard(authored)).toBe(false);
    expect(isGroupContextNoise(authored)).toBe(false);
  });

  it('recognizes the exact deleted card placeholder only for resource-free nonuser records', () => {
    const placeholder = record({ msgType: 'interactive', text: '[卡片]', deleted: true });
    expect(isGroupContextNoise(placeholder)).toBe(true);
    expect(isGroupContextNoise({ ...placeholder, senderType: 'unknown' })).toBe(true);
    expect(isGroupContextNoise({ ...placeholder, senderType: 'user' })).toBe(false);
    expect(isGroupContextNoise({ ...placeholder, deleted: false })).toBe(false);
    expect(isGroupContextNoise({ ...placeholder, resourceRefs: [{ type: 'image' }] })).toBe(false);
    expect(isGroupContextNoise({ ...placeholder, text: '[卡片] Actual answer content' })).toBe(false);
  });

  it.each([
    '请升级至最新版本客户端',
    '[图片 1]\n请升级至最新版本客户端',
    '请升级至最新版本客户端，以查看内容',
    '[图片 1]请升级至最新版本客户端，以查看内容',
    '[图片 1]请升级至最新版本客户端，以查看内容。',
  ])('recognizes unread card fallback %s without hiding prose quotes', (text) => {
    expect(isUnavailableGroupContextCard(record({ msgType: 'interactive', text }))).toBe(true);
    expect(isUnavailableGroupContextCard(record({ senderType: 'user', msgType: 'text', text }))).toBe(false);
    expect(isUnavailableGroupContextCard(record({ senderType: 'user', msgType: 'interactive', text }))).toBe(false);
    expect(isUnavailableGroupContextCard(record({ msgType: 'interactive', text: `${text}。实际答复是预算三千元。` }))).toBe(false);
    expect(isUnavailableGroupContextCard(record({ msgType: 'interactive', text: '[卡片: 答复]\n预算不能超过三千元。' }))).toBe(false);
  });

  it('masks only exact control query values and preserves UTF-16 offsets', () => {
    const text = 'https://example.invalid/session?viewToken=FAKE_VIEW_123&controlToken=FAKE_CONTROL_456&operationToken=FAKE_OPERATION_789#section';
    const sanitized = sanitizeGroupContextText(text);
    expect(sanitized).toBe('https://example.invalid/session?viewToken=*************&controlToken=****************&operationToken=******************#section');
    expect(sanitized.length).toBe(text.length);
    expect(sanitized).not.toContain('FAKE_VIEW_123');
    expect(sanitizeGroupContextText('https://example.invalid/?viewToken=🧪&token=travel-value')).toBe('https://example.invalid/?viewToken=**&token=travel-value');
  });

  it('keeps ordinary URL tokens and quoted non-query names unchanged', () => {
    const text = 'https://travel.example.invalid/?token=booking-code&accessToken=public-demo&previewToken=demo&ViewToken=case-sensitive; viewToken=not-a-query';
    expect(sanitizeGroupContextText(text)).toBe(text);
  });

  it('handles quoted and HTML-escaped query delimiters without crossing URL boundaries', () => {
    expect(sanitizeGroupContextText('("https://example.invalid/?viewToken=FAKE_ONE&amp;controlToken=FAKE_TWO") next'))
      .toBe('("https://example.invalid/?viewToken=********&amp;controlToken=********") next');
  });
});
