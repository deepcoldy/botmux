import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  source: undefined as any, reply: vi.fn(), mode: vi.fn(), detail: vi.fn(), threadId: vi.fn(),
  update: vi.fn(),
  botConfig: { feedback: { enabled: true, audience: 'everyone' } } as Record<string, unknown>,
}));
vi.mock('../src/services/skill-feedback-store.js', async original => ({
  ...await original<any>(), getSkillFeedbackStore: async () => mock.source,
}));
vi.mock('../src/im/lark/client.js', async original => ({
  ...await original<any>(), resolveUserUnionId: async () => ({}), replyMessage: mock.reply,
  getChatModeStrict: mock.mode, getMessageDetail: mock.detail, getMessageThreadId: mock.threadId,
  updateMessage: mock.update,
}));
vi.mock('../src/bot-registry.js', async original => ({
  ...await original<any>(), getBot: () => ({ config: mock.botConfig }),
}));

import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';
import { FeedbackExtensionStore } from '../src/services/feedback-extension-store.js';
import { readFeedbackExtensionConfig, saveFeedbackExtensionConfig } from '../src/services/feedback-extension-config.js';
import { handleFeedbackExtensionCard, sendFeedbackSurface, pendingFeedbackHookAuthorized, tickFeedbackExtensions } from '../src/services/feedback-extension-host.js';
import { createHash } from 'node:crypto';
import { normalizeFeedbackPolicy } from '../src/services/feedback-policy.js';
import { buildFeedbackSurface, defaultFeedbackTemplate } from '../src/services/feedback-template.js';
import { feedbackRefreshBudget, refreshFeedbackMessage } from '../src/services/feedback-refresh.js';

const dispose: Array<() => void> = [];
afterEach(() => {
  for (const close of dispose.splice(0)) close();
  mock.botConfig = { feedback: { enabled: true, audience: 'everyone' } };
  mock.reply.mockReset();
  mock.mode.mockReset();
  mock.detail.mockReset();
  mock.threadId.mockReset();
  mock.update.mockReset();
  vi.useRealTimers();
});

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
  it('keeps a newer revision queued until a timed-out old patch actually finishes', async () => {
    const data = await fixture();
    vi.useFakeTimers();
    data.extensions.dirtySurface('app', 'late-surface', { result: 'old' });
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const old = data.extensions.dirtySurfaces('app').find(item => item.messageId === 'late-surface')!;
    const pending = refreshFeedbackMessage({ store: data.extensions, appId: 'app', messageId: old.messageId,
      kind: 'dirty', revision: old.revision, budget: feedbackRefreshBudget(), run });
    await vi.advanceTimersByTimeAsync(1001);
    await pending;
    data.extensions.dirtySurface('app', old.messageId, { result: 'new' });
    const latest = data.extensions.dirtySurfaces('app').find(item => item.messageId === old.messageId)!;
    await vi.advanceTimersByTimeAsync(6000);
    await refreshFeedbackMessage({ store: data.extensions, appId: 'app', messageId: old.messageId,
      kind: 'dirty', revision: latest.revision, budget: feedbackRefreshBudget(), run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(data.extensions.dirtySurfaces('app').find(item => item.messageId === old.messageId)?.revision).toBe(latest.revision);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await refreshFeedbackMessage({ store: data.extensions, appId: 'app', messageId: old.messageId,
      kind: 'dirty', revision: latest.revision, budget: feedbackRefreshBudget(), run: async () => {} });
    expect(data.extensions.dirtySurfaces('app').filter(item => item.messageId === old.messageId)).toEqual([]);
  });
  it('refreshes a pending request only after a fresh click across a pause and resume between ticks', async () => {
    const data = await fixture();
    mock.botConfig.feedbackPresentation = { default: { enabled: true, actionIds: ['help'] }, rules: [] };
    const click = data.callback('feedback_custom_action', { action_id: 'help' });
    await handleFeedbackExtensionCard(click, 'app', data.directory);
    const initial = await readFeedbackExtensionConfig(data.directory);
    await saveFeedbackExtensionConfig(data.directory, initial.version, {
      ...initial, hooks: [{ ...initial.hooks[0], version: 2, enabled: false }],
    }, 'test-admin');
    const paused = await readFeedbackExtensionConfig(data.directory);
    await saveFeedbackExtensionConfig(data.directory, paused.version, {
      ...paused, hooks: [{ ...paused.hooks[0], version: 3, enabled: true }],
    }, 'test-admin');
    await handleFeedbackExtensionCard(click, 'app', data.directory);
    const jobId = createHash('sha256').update(JSON.stringify(['app', 'chat', 'question', 'help'])).digest('hex');
    expect(data.extensions.job(jobId)).toMatchObject({ status: 'pending', payload: { hookVersion: 3 } });
    expect(data.extensions.claim('hook', Date.now(), 10000)?.id).toBe(jobId);
  });
  it('allows a new click after a hook pause but preserves an explicit revocation', async () => {
    const data = await fixture();
    mock.botConfig.feedbackPresentation = { default: { enabled: true, actionIds: ['help'] }, rules: [] };
    const initial = await readFeedbackExtensionConfig(data.directory);
    await saveFeedbackExtensionConfig(data.directory, initial.version, {
      ...initial, hooks: [{ ...initial.hooks[0], version: 2, enabled: false }],
    }, 'test-admin');
    const click = data.callback('feedback_custom_action', { action_id: 'help' });
    const paused = await handleFeedbackExtensionCard(click, 'app', data.directory);
    expect(paused.toast.type).toBe('error');
    const jobId = createHash('sha256').update(JSON.stringify(['app', 'chat', 'question', 'help'])).digest('hex');
    expect(data.extensions.job(jobId)).toMatchObject({ status: 'blocked', result: { recoverable: true } });
    const current = await readFeedbackExtensionConfig(data.directory);
    await saveFeedbackExtensionConfig(data.directory, current.version, {
      ...current, hooks: [{ ...current.hooks[0], version: 3, enabled: true }],
    }, 'test-admin');
    await handleFeedbackExtensionCard(click, 'app', data.directory);
    const resumed = data.extensions.claim('hook', Date.now(), 10000)!;
    expect(resumed.id).toBe(jobId);
    expect(resumed.payload.hookVersion).toBe(3);
    data.extensions.settle(resumed.id, resumed.token!, 'blocked', { reason: 'revoked', recoverable: false });
    const revoked = await handleFeedbackExtensionCard(click, 'app', data.directory);
    expect(revoked.toast.type).toBe('error');
    expect(data.extensions.job(jobId)?.status).toBe('blocked');
  });
  it('does not revive a paused request after its registered command changes', async () => {
    const data = await fixture();
    const initial = await readFeedbackExtensionConfig(data.directory);
    await saveFeedbackExtensionConfig(data.directory, initial.version, {
      ...initial, hooks: [{ ...initial.hooks[0], version: 2, enabled: false }],
    }, 'test-admin');
    const click = data.callback('feedback_custom_action', { action_id: 'help' });
    await handleFeedbackExtensionCard(click, 'app', data.directory);
    const current = await readFeedbackExtensionConfig(data.directory);
    await saveFeedbackExtensionConfig(data.directory, current.version, {
      ...current, hooks: [{ ...current.hooks[0], version: 3, enabled: true, command: ['/bin/false'] }],
    }, 'test-admin');
    expect((await handleFeedbackExtensionCard(click, 'app', data.directory)).toast.type).toBe('error');
    const jobId = createHash('sha256').update(JSON.stringify(['app', 'chat', 'question', 'help'])).digest('hex');
    expect(data.extensions.job(jobId)?.status).toBe('blocked');
  });
  it('bounds slow refresh work without expiring a healthy hook claimed in the same tick', async () => {
    const data = await fixture();
    mock.botConfig.feedbackPresentation = { default: { enabled: true, actionIds: ['help'] }, rules: [] };
    const current = await readFeedbackExtensionConfig(data.directory);
    await saveFeedbackExtensionConfig(data.directory, current.version, { ...current, hooks: [{
      ...current.hooks[0], version: 2, timeoutMs: 5000, command: [process.execPath, '-e',
        "let data='';process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>{const input=JSON.parse(data);process.stdout.write(JSON.stringify({schemaVersion:1,executionId:input.executionId,outcome:'succeeded',publicMessage:'ok',receiptRefs:['file:ok']}));});"],
    }] }, 'test-admin');
    const binding = data.extensions.surface('app', 'surface')!;
    for (let index = 0; index < 40; index++) {
      const messageId = `slow-${index}`;
      data.extensions.bindSurface('app', messageId, binding);
      data.extensions.dirtySurface('app', messageId, {});
    }
    mock.update.mockImplementation(() => new Promise(() => {}));
    await handleFeedbackExtensionCard(data.callback('feedback_custom_action', { action_id: 'help' }), 'app', data.directory);
    const started = Date.now();
    await tickFeedbackExtensions(data.directory, 'app');
    expect(Date.now() - started).toBeLessThan(5000);
    const jobId = createHash('sha256').update(JSON.stringify(['app', 'chat', 'question', 'help'])).digest('hex');
    expect(data.extensions.job(jobId)?.status).toBe('succeeded');
    expect(mock.update.mock.calls.length).toBeLessThan(5);
  });
  it('terminates deleted-message refreshes and does not recreate them on later feedback', async () => {
    const data = await fixture();
    mock.update.mockRejectedValue({ response: { status: 400, data: { code: 230011 } } });
    data.extensions.dirtySurface('app', 'surface', { result: 'incorrect' });
    await tickFeedbackExtensions(data.directory, 'app');
    data.extensions.dirtySurface('app', 'surface', { result: 'conclusive_usable' });
    await tickFeedbackExtensions(data.directory, 'app');
    expect(mock.update).toHaveBeenCalledTimes(1);
    expect(data.extensions.dirtySurfaces('app')).toEqual([]);
  });
  it('backs off transient refreshes across ticks', async () => {
    const data = await fixture();
    mock.update.mockRejectedValue({ response: { status: 503 } });
    data.extensions.dirtySurface('app', 'surface', { result: 'incorrect' });
    await tickFeedbackExtensions(data.directory, 'app');
    await tickFeedbackExtensions(data.directory, 'app');
    expect(mock.update).toHaveBeenCalledTimes(1);
    expect(data.extensions.dirtySurfaces('app')).toHaveLength(1);
  });
  it('abandons repeated transient errors and preserves retry state across reopening', async () => {
    const data = await fixture();
    mock.update.mockRejectedValue({ response: { status: 503 } });
    data.extensions.dirtySurface('app', 'surface', {});
    const clock = vi.spyOn(Date, 'now');
    let now = Date.now();
    clock.mockImplementation(() => now);
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        await tickFeedbackExtensions(data.directory, 'app');
        const reopened = await FeedbackExtensionStore.open(data.directory);
        expect(reopened.refreshDue('app', 'surface', 'dirty', now)).toBe(false);
        reopened.close();
        now += 300001;
      }
      await tickFeedbackExtensions(data.directory, 'app');
      expect(mock.update).toHaveBeenCalledTimes(5);
      expect(data.extensions.dirtySurfaces('app')).toEqual([]);
    } finally { clock.mockRestore(); }
  });
  it('terminates an unreachable inline cleanup as well as a separate surface', async () => {
    const data = await fixture();
    data.extensions.ingest('cleanup', 0, [{ sequence: 1, eventId: 'cleanup-event', jobs: [{
      id: 'cleanup-job', kind: 'surface', payload: { appId: 'app', mode: 'separate', answerMessageId: 'deleted-answer' },
    }] }]);
    const claim = data.extensions.claim('surface', Date.now(), 10000)!;
    data.extensions.completeSurface(claim.id, claim.token!, 'cleanup-surface', Date.now());
    mock.detail.mockRejectedValue({ response: { status: 403 } });
    await tickFeedbackExtensions(data.directory, 'app');
    await tickFeedbackExtensions(data.directory, 'app');
    expect(mock.detail).toHaveBeenCalledTimes(1);
    expect(data.extensions.inlineCleanups('app')).toEqual([]);
  });
  it('does not process historical refresh rows after the extension file is removed', async () => {
    const data = await fixture();
    data.extensions.dirtySurface('app', 'surface', {});
    unlinkSync(join(data.directory, 'feedback-extensions.json'));
    await tickFeedbackExtensions(data.directory, 'app');
    expect(mock.update).not.toHaveBeenCalled();
  });
  it('isolates a missing template while expiring old jobs and refreshing unrelated cards', async () => {
    const data = await fixture();
    data.extensions.activate('app', '2000-01-01T00:00:00Z');
    mock.botConfig.feedbackPresentation = { default: { enabled: true, templateId: 'missing' }, rules: [] };
    data.extensions.requestAction({ requestId: 'expired', actor: 'user', job: { id: 'expired', kind: 'hook', payload: {} } });
    data.extensions.claim('hook', 0, 1);
    const current = await readFeedbackExtensionConfig(data.directory);
    await saveFeedbackExtensionConfig(data.directory, current.version, { ...current, subscriptions: [{
      id: 'subscription', appId: 'app', chatId: 'chat', buttonKey: 'conclusive_usable', hookId: 'hook',
    }], hooks: [{
      ...current.hooks[0], version: 2, command: [process.execPath, '-e',
        "let data='';process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>{const input=JSON.parse(data);process.stdout.write(JSON.stringify({schemaVersion:1,executionId:input.executionId,outcome:'succeeded',publicMessage:'ok',receiptRefs:['file:ok']}));});"],
    }] }, 'test-admin');
    data.extensions.requestAction({ requestId: 'healthy', actor: 'user', job: {
      id: 'healthy', kind: 'hook', payload: { appId: 'app', hookId: 'hook', hookVersion: 2, event: {
        schemaVersion: 1, executionId: 'healthy', eventId: 'healthy', idempotencyKey: 'healthy',
        type: 'feedback.revised', occurredAt: new Date().toISOString(), bot: { appId: 'app' },
        scope: { chatId: 'chat' }, action: null, feedback: { buttonKey: 'conclusive_usable' }, actor: {}, contextRef: null,
      } },
    } });
    data.source.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: 'turn', status: 'completed' });
    data.extensions.dirtySurface('app', 'surface', {});
    await expect(tickFeedbackExtensions(data.directory, 'app')).resolves.toBeUndefined();
    expect(data.extensions.job('expired')?.status).toBe('unknown');
    expect(mock.update).toHaveBeenCalledTimes(1);
    expect(data.extensions.job('healthy')?.status).toBe('succeeded');
  });
  it('does not execute a queued subscription after the binding is removed', () => {
    const config = { version: 1, hostId: 'host', templates: [], hooks: [], actions: [], presentations: {},
      subscriptions: [{ id: 'sub', appId: 'app', chatId: 'chat', buttonKey: 'helpful', hookId: 'hook' }] };
    const event = { type: 'feedback.revised', bot: { appId: 'app' }, scope: { chatId: 'chat' },
      feedback: { buttonKey: 'helpful' }, action: null };
    expect(pendingFeedbackHookAuthorized(config, 'hook', event)).toBe(true);
    expect(pendingFeedbackHookAuthorized({ ...config, subscriptions: [] }, 'hook', event)).toBe(false);
  });
  it.each([['group', false], ['topic', true]] as const)('routes %s feedback replies without inventing a thread', async (mode, inThread) => {
    mock.mode.mockResolvedValue(mode);
    mock.detail.mockResolvedValue({ items: [{ chat_id: 'chat' }] });
    mock.reply.mockResolvedValue('surface');
    await sendFeedbackSurface('app', { chatId: 'chat', subjectId: 'question', card: { schema: '2.0' }, operationId: 'operation' });
    expect(mock.reply).toHaveBeenLastCalledWith('app', 'question', '{"schema":"2.0"}', 'interactive', inThread, 'operation');
  });
  it('refuses an unknown chat mode or a mismatched source rather than sending to a guessed scope', async () => {
    mock.reply.mockClear();
    mock.detail.mockResolvedValue({ items: [{ chat_id: 'other-chat' }] });
    await expect(sendFeedbackSurface('app', { chatId: 'chat', subjectId: 'question', card: {}, operationId: 'op' })).rejects.toThrow();
    mock.detail.mockResolvedValue({ items: [{ chat_id: 'chat' }] });
    mock.mode.mockResolvedValue('unknown');
    await expect(sendFeedbackSurface('app', { chatId: 'chat', subjectId: 'question', card: {}, operationId: 'op' })).rejects.toThrow();
    expect(mock.reply).not.toHaveBeenCalled();
  });
  it('passes a fresh authorization fence into the transport write boundary', async () => {
    mock.mode.mockResolvedValue('topic');
    mock.detail.mockResolvedValue({ items: [{ chat_id: 'chat' }] });
    mock.reply.mockImplementationOnce(async (...args: any[]) => {
      await args[7].beforeWrite();
      throw new Error('write should not be reached');
    });
    await expect(sendFeedbackSurface('app', { chatId: 'chat', subjectId: 'question', card: {}, operationId: 'op',
      beforeWrite: async () => { throw new Error('revoked'); } })).rejects.toThrow('revoked');
  });
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
  it('authorizes a hook click when the presentation rule lives in bot config, not only the extension file', async () => {
    const data = await fixture();
    mock.botConfig = { feedback: { enabled: true, audience: 'everyone' },
      feedbackPresentation: { default: { enabled: true, rounds: [1], mode: 'separate', actionIds: ['help'] }, rules: [] } };
    const current = await readFeedbackExtensionConfig(data.directory);
    await saveFeedbackExtensionConfig(data.directory, current.version, { ...current, hooks: [{
      ...current.hooks[0], version: 2, timeoutMs: 5000, command: [process.execPath, '-e',
        "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const i=JSON.parse(d);process.stdout.write(JSON.stringify({schemaVersion:1,executionId:i.executionId,outcome:'succeeded',publicMessage:'ok',receiptRefs:['file:x']}));});"],
    }] }, 'test-admin');
    await handleFeedbackExtensionCard(data.callback('feedback_custom_action', { action_id: 'help' }), 'app', data.directory);
    await tickFeedbackExtensions(data.directory, 'app');
    const jobId = createHash('sha256').update(JSON.stringify(['app', 'chat', 'question', 'help'])).digest('hex');
    expect(data.extensions.job(jobId)).toMatchObject({ status: 'succeeded' });
  });
  it('lets an explicit extension-file presentation disable an action that bot config enables', async () => {
    const data = await fixture();
    mock.botConfig = { feedback: { enabled: true, audience: 'everyone' },
      feedbackPresentation: { default: { enabled: true, rounds: [1], mode: 'separate', actionIds: ['help'] }, rules: [] } };
    const current = await readFeedbackExtensionConfig(data.directory);
    await saveFeedbackExtensionConfig(data.directory, current.version, { ...current,
      presentations: { app: { default: { enabled: false }, rules: [] } } }, 'test-admin');
    await handleFeedbackExtensionCard(data.callback('feedback_custom_action', { action_id: 'help' }), 'app', data.directory);
    await tickFeedbackExtensions(data.directory, 'app');
    const jobId = createHash('sha256').update(JSON.stringify(['app', 'chat', 'question', 'help'])).digest('hex');
    expect(data.extensions.job(jobId)).toMatchObject({ status: 'blocked' });
  });
  it('does not ingest a surface job when the extension file explicitly disables a rule that bot config enables', async () => {
    const data = await fixture();
    mock.botConfig = { feedback: { enabled: true, audience: 'everyone' },
      feedbackPresentation: { default: { enabled: true, rounds: [1], mode: 'separate' }, rules: [] } };
    const current = await readFeedbackExtensionConfig(data.directory);
    await saveFeedbackExtensionConfig(data.directory, current.version, { ...current,
      presentations: { app: { default: { enabled: false }, rules: [] } } }, 'test-admin');
    data.extensions.activate('app', '2000-01-01T00:00:00.000Z');
    data.source.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: 'turn', status: 'completed' });
    // Stub the whole send path so sendFeedbackSurface reaches the write
    // boundary, and mirror the real client.ts contract: beforeWrite runs
    // before the message is sent (args[7] is the options bag).
    mock.detail.mockResolvedValue({ items: [{ chat_id: 'chat' }] });
    mock.mode.mockResolvedValue('group');
    mock.threadId.mockResolvedValue(undefined);
    mock.reply.mockImplementation(async (...args: any[]) => { await args[7]?.beforeWrite?.(); return 'surface-msg'; });
    await tickFeedbackExtensions(data.directory, 'app');
    expect(mock.reply).not.toHaveBeenCalled();
    expect(data.extensions.jobsForApp('app').filter(job => job.kind === 'surface')).toHaveLength(0);
  });
});
