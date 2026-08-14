import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';
import { persistTurnTerminal } from '../src/services/turn-completion-events.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    botAppId: 'app_a', sessionId: 'session_a', turnId: 'turn_a', nativeSessionId: 'native_a',
    platform: 'lark', platformAppId: 'app_a', platformMessageId: 'om_a', chatId: 'chat_a',
    topicRootId: 'root_a', dispatchAttempt: 2, content: 'private final answer', contentRef: 'lark:om_a',
    cliId: 'codex', model: 'gpt-test', cardMode: 'feedback' as const, status: 'delivered' as const,
    usage: { inputTokens: 12, outputTokens: 4 },
    ...overrides,
  };
}

function terminal(overrides: Record<string, unknown> = {}) {
  return {
    botAppId: 'app_a', sessionId: 'session_a', turnId: 'turn_a', nativeSessionId: 'native_a',
    dispatchAttempt: 2, status: 'completed' as const, completedAt: '2026-08-11T12:00:00.000Z', durationMs: 321,
    usage: { inputTokens: 12, outputTokens: 4 },
    ...overrides,
  };
}

describe('durable turn.completed events', () => {
  it('correlates terminal-before-delivery, emits once, and stores no answer body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-turn-event-')); dirs.push(dir);
    const store = await SkillFeedbackStore.open(dir);

    expect(store.recordTurnTerminal(terminal({ nativeSessionId: undefined, usage: undefined }))).toBeUndefined();
    const savedDelivery = store.recordTurnDelivery(delivery());
    const events = store.listTurnCompletionEvents();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'turn.completed', version: 1, deliveryId: savedDelivery.deliveryId,
      payload: {
        type: 'turn.completed', version: 1, status: 'completed', deliveryId: savedDelivery.deliveryId,
        contentHash: expect.stringMatching(/^sha256:/), contentRef: 'lark:om_a',
        platform: 'lark', platformMessageId: 'om_a', platformAppId: 'app_a', chatId: 'chat_a', topicRootId: 'root_a',
        botAppId: 'app_a', sessionId: 'session_a', turnId: 'turn_a', nativeSessionId: 'native_a', dispatchAttempt: 2,
        durationMs: 321, usage: { inputTokens: 12, outputTokens: 4 }, cliId: 'codex', model: 'gpt-test',
      },
    });
    expect(events[0].payload).not.toHaveProperty('content');
    expect(JSON.stringify(events)).not.toContain('private final answer');
    expect(store.findDeliveryByPlatformMessage('lark', 'app_a', 'om_a')?.status).toBe('completed');
    store.close();
    expect(readFileSync(join(dir, 'botmux-feedback.sqlite'))).not.toContain('private final answer');
  });

  it('persists only a content-free feedback card template for callback reconstruction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-turn-event-')); dirs.push(dir);
    const store = await SkillFeedbackStore.open(dir);
    const answer = 'TOP SECRET answer body';
    const saved = store.recordTurnDelivery(delivery({
      content: answer,
      policy: {
        enabled: true, audience: 'requester', visibleSemantics: ['positive', 'progress', 'negative'],
        buttons: [
          { key: 'yes', label: 'Yes', semantic: 'positive', style: 'primary' },
          { key: 'progress', label: 'Progress', semantic: 'progress', style: 'default' },
          { key: 'no', label: 'No', semantic: 'negative', style: 'danger' },
        ],
        negativeFollowup: { reasons: [], comment: { enabled: false, required: false, placeholder: 'Explain', maxLength: 100 } },
        allowReselect: false,
      },
      baseCard: {
        schema: '2.0', config: { update_multi: true },
        body: { direction: 'vertical', elements: [
          { tag: 'markdown', content: answer },
          { tag: 'column_set', element_id: 'botmux_feedback', columns: [] },
          { tag: 'markdown', element_id: 'botmux_reply_footer', content: 'safe footer' },
        ] },
      },
    }));

    expect(JSON.stringify(saved.baseCard)).not.toContain(answer);
    expect((saved.baseCard as any).body.elements.map((element: any) => element.element_id)).toEqual([
      'botmux_feedback', 'botmux_reply_footer',
    ]);
    store.close();
    expect(readFileSync(join(dir, 'botmux-feedback.sqlite'))).not.toContain(answer);
  });

  it('correlates delivery-before-terminal and makes duplicate signals idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-turn-event-')); dirs.push(dir);
    const store = await SkillFeedbackStore.open(dir);
    const saved = store.recordTurnDelivery(delivery({ platformMessageId: 'om_order' }));
    const first = store.recordTurnTerminal(terminal());
    const duplicate = store.recordTurnTerminal(terminal({ completedAt: '2026-08-11T12:01:00.000Z' }));
    expect(duplicate?.eventId).toBe(first?.eventId);
    expect(store.listTurnCompletionEvents()).toHaveLength(1);
    expect(store.findDeliveryByPlatformMessage('lark', 'app_a', 'om_order')).toMatchObject({
      deliveryId: saved.deliveryId, status: 'completed', completedAt: '2026-08-11T12:00:00.000Z',
    });
    store.close();
  });

  it('correlates multiple canonical deliveries of one turn to the same terminal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-turn-event-')); dirs.push(dir);
    const store = await SkillFeedbackStore.open(dir);
    const first = store.recordTurnDelivery(delivery({
      platformMessageId: 'om_multi_a',
      correlationDiscriminator: 'om_multi_a',
    }));
    const second = store.recordTurnDelivery(delivery({
      platformMessageId: 'om_multi_b',
      correlationDiscriminator: 'om_multi_b',
      content: 'second canonical proactive final',
    }));

    store.recordTurnTerminal(terminal());

    expect(first.deliveryId).not.toBe(second.deliveryId);
    expect(store.listTurnCompletionEvents().map(event => event.deliveryId)).toEqual([
      first.deliveryId,
      second.deliveryId,
    ]);
    expect(store.listFeedbackEvents().filter(event => event.type === 'turn.completed')).toHaveLength(2);
    expect(store.findDeliveryByPlatformMessage('lark', 'app_a', 'om_multi_a')?.status).toBe('completed');
    expect(store.findDeliveryByPlatformMessage('lark', 'app_a', 'om_multi_b')?.status).toBe('completed');
    store.close();
  });

  it('uses a stable delivery id for retries even when answer content changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-turn-event-')); dirs.push(dir);
    const store = await SkillFeedbackStore.open(dir);
    const first = store.recordTurnDelivery(delivery({ platformMessageId: 'om_stable', content: 'first rendering' }));
    const retry = store.recordTurnDelivery(delivery({ platformMessageId: 'om_stable', content: 'retry rendering' }));
    expect(retry.deliveryId).toBe(first.deliveryId);
    expect(store.debugCounts()).toEqual({ responses: 1, deliveries: 1 });
    store.close();
  });

  it.each(['failed', 'cancelled', 'ambiguous'] as const)('maps %s terminal status without inventing optional metadata', async status => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-turn-event-')); dirs.push(dir);
    const store = await SkillFeedbackStore.open(dir);
    store.recordTurnDelivery(delivery({ platformMessageId: `om_${status}`, nativeSessionId: undefined, dispatchAttempt: undefined,
      contentRef: undefined, cliId: undefined, model: undefined, usage: undefined }));
    store.recordTurnTerminal(terminal({ nativeSessionId: undefined, dispatchAttempt: undefined, status, usage: undefined }));
    const payload = store.listTurnCompletionEvents()[0].payload;
    expect(payload.status).toBe(status);
    for (const key of ['nativeSessionId', 'dispatchAttempt', 'contentRef', 'cliId', 'model', 'usage']) {
      expect(payload).not.toHaveProperty(key);
    }
    store.close();
  });

  it('persists the worker terminal using only structured session/terminal facts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-turn-event-')); dirs.push(dir);
    const store = await SkillFeedbackStore.open(dir);
    store.recordTurnDelivery(delivery({ nativeSessionId: 'native_from_delivery' }));
    await persistTurnTerminal({
      dataDir: dir,
      botAppId: 'app_a',
      session: { sessionId: 'session_a' },
      terminal: { turnId: 'turn_a', dispatchAttempt: 2, status: 'completed' },
      store,
    });
    expect(store.listTurnCompletionEvents()[0].payload).toMatchObject({
      status: 'completed', nativeSessionId: 'native_from_delivery',
    });
    store.close();
  });

  it('rejects a conflicting duplicate terminal status', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-turn-event-')); dirs.push(dir);
    const store = await SkillFeedbackStore.open(dir);
    store.recordTurnTerminal(terminal({ status: 'failed' }));
    expect(() => store.recordTurnTerminal(terminal({ status: 'completed' }))).toThrow('turn_terminal_status_conflict');
    store.close();
  });
});
