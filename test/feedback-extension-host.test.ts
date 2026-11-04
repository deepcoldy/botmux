import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ source: undefined as any }));
vi.mock('../src/services/skill-feedback-store.js', async original => ({
  ...await original<any>(), getSkillFeedbackStore: async () => mock.source,
}));
vi.mock('../src/im/lark/client.js', async original => ({
  ...await original<any>(), resolveUserUnionId: async () => ({}),
}));
vi.mock('../src/bot-registry.js', async original => ({
  ...await original<any>(), getBot: () => ({ config: { feedback: { enabled: true, audience: 'everyone' } } }),
}));

import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';
import { FeedbackExtensionStore } from '../src/services/feedback-extension-store.js';
import { readFeedbackExtensionConfig, saveFeedbackExtensionConfig } from '../src/services/feedback-extension-config.js';
import { handleFeedbackExtensionCard } from '../src/services/feedback-extension-host.js';
import { normalizeFeedbackPolicy } from '../src/services/feedback-policy.js';
import { buildFeedbackSurface, defaultFeedbackTemplate } from '../src/services/feedback-template.js';

const dispose: Array<() => void> = [];
afterEach(() => { for (const close of dispose.splice(0)) close(); });

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'feedback-host-'));
  const source = await SkillFeedbackStore.open(directory);
  const extensions = await FeedbackExtensionStore.open(directory);
  dispose.push(() => { source.close(); extensions.close(); rmSync(directory, { recursive: true, force: true }); });
  mock.source = source;
  const initial = await readFeedbackExtensionConfig(directory);
  await saveFeedbackExtensionConfig(directory, initial.version, {
    ...initial, actions: [{ id: 'help', label: 'Help', hookId: 'hook' }],
    hooks: [{ id: 'hook', version: 1, protocolVersion: 1, hostId: initial.hostId, command: ['/bin/echo'],
      cwd: '/tmp', allowedBotAppIds: ['app'], allowedChatIds: ['chat'], allowedActionIds: ['help'],
      timeoutMs: 1000, concurrency: 1, envRefs: {}, enabled: true }],
  }, 'test-admin');
  const policy = normalizeFeedbackPolicy({ enabled: true, audience: 'everyone', allowReselect: true });
  const template = defaultFeedbackTemplate();
  template.elements = template.elements.map(element => element.slot === 'feedbackButtons' ? { ...element, layout: 'vertical' } : element);
  const card = buildFeedbackSurface({ template, policy, preview: false, round: 1, answerUrl: 'https://example.com/answer' });
  const delivery = source.recordTurnDelivery({ botAppId: 'app', sessionId: 'session', turnId: 'turn',
    platform: 'lark', platformAppId: 'app', platformMessageId: 'answer', chatId: 'chat', topicRootId: 'question',
    content: 'answer', cardMode: 'feedback', status: 'delivered', policy, baseCard: card });
  extensions.bindSurface('app', 'surface', { appId: 'app', answerMessageId: 'answer', chatId: 'chat',
    subjectId: 'question', answerId: 'turn', deliveryId: delivery.deliveryId, round: 1, card,
    templateId: template.id, actions: [{ id: 'help', label: 'Help', hookId: 'hook' }] });
  const callback = (action: string, values: Record<string, string> = {}) => ({
    operator: { open_id: 'ou_human' }, context: { open_message_id: 'surface', open_chat_id: 'chat' },
    action: { value: { action, ...values } },
  });
  return { directory, source, extensions, policy, callback };
}

describe('feedback extension host callback', () => {
  it('rejects non-human operator IDs before registering custom actions', async () => {
    const data = await fixture();
    const click = data.callback('feedback_custom_action', { action_id: 'help' });
    click.operator.open_id = 'cli_bot_actor';
    const response = await handleFeedbackExtensionCard(click, 'app', data.directory);
    expect(response.toast.type).toBe('error');
    expect(data.extensions.claim('hook', Date.now(), 1000)).toBeUndefined();
  });
  it('preserves a vertical feedback surface while updating the original delivery', async () => {
    const data = await fixture();
    const response = await handleFeedbackExtensionCard(data.callback('feedback_submit', { result: data.policy.buttons[0].key }), 'app', data.directory);
    const element = response.card.data.body.elements.find((item: any) => item.element_id === 'botmux_feedback');
    expect(element.columns).toHaveLength(1);
    expect(element.columns[0].elements).toHaveLength(3);
    const original = data.source.findDeliveryByPlatformMessage('lark', 'app', 'answer')!;
    expect(data.source.getLatestFeedback(original.deliveryId, 'ou_human')?.result).toBe(data.policy.buttons[0].key);
  });
  it('uses a one-use visible confirmation to retry a pre-effect failure', async () => {
    const data = await fixture();
    const click = data.callback('feedback_custom_action', { action_id: 'help' });
    await handleFeedbackExtensionCard(click, 'app', data.directory);
    const job = data.extensions.claim('hook', Date.now(), 10000)!;
    data.extensions.settle(job.id, job.token!, 'failed_before_effect', {});
    const prompt = await handleFeedbackExtensionCard(click, 'app', data.directory);
    expect(data.extensions.claim('hook', Date.now(), 10000)).toBeUndefined();
    const retry = prompt.card.data.body.elements.at(-1).behaviors[0].value;
    await handleFeedbackExtensionCard(data.callback(retry.action, retry), 'app', data.directory);
    expect(data.extensions.claim('hook', Date.now(), 10000)?.id).toBe(job.id);
    await handleFeedbackExtensionCard(data.callback(retry.action, retry), 'app', data.directory);
    expect(data.extensions.claim('hook', Date.now(), 10000)).toBeUndefined();
  });
});
