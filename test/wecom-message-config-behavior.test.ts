import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomBridge, type WecomBridgePolicy, type WecomCore } from '../src/im/wecom/gateway/bridge.js';
import { validateWecomMessageConfig } from '../src/im/wecom/config/message-config.js';
import { projectCoreOnlyProgress, rememberCoreOnlyGoal } from '../src/core/core-only-progress.js';
import { WecomDeliveryUncertainError } from '../src/im/wecom/protocol/types.js';
import type { WecomCardEvent, WecomInboundMessage, WecomTemplateCard } from '../src/im/wecom/protocol/types.js';
import type { TriggerResponse } from '../src/services/trigger-types.js';

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const message = (id = 'm', userId = 'alice', text = 'hello'): WecomInboundMessage => ({ messageId: id, userId, conversationId: 'g', chatType: 'group', text, attachments: [], replyContext: { requestId: `req-${id}` } });
function setup(initial: Partial<WecomBridgePolicy> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wecom-message-config-')); dirs.push(dir);
  const stateFile = join(dir, 'state.json');
  let policy: WecomBridgePolicy = { allowedUsers: ['alice', 'bob'], disableStreamingCard: false, cotEnabled: true, replyCardShowTools: true, ...initial };
  let result: TriggerResponse = { ok: true, state: 'completed', output: { content: 'answer' }, usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 3, cacheCreateTokens: 2 } };
  const core: WecomCore = {
    trigger: vi.fn(async request => ({ ok: true, triggerId: `turn-${request.source.requestId}`, target: { kind: 'turn', sessionId: request.target.sessionId ?? 'session' } })),
    result: vi.fn(async () => result), interrupt: vi.fn(async () => {}), close: vi.fn(async () => ({ ok: true })),
    progress: vi.fn(async (_sessionId, turnId) => ({ turnId, workerGeneration: 1, entries: [
      { kind: 'thinking' as const, text: 'reasoning' }, { kind: 'text' as const, text: 'narration' },
      { kind: 'tool_call' as const, id: 'tool', name: 'Read', args: '/workspace/a' }, { kind: 'tool_result' as const, id: 'tool', result: 'file result' },
    ] })),
  };
  const transport = { reply: vi.fn(async (_message: WecomInboundMessage, _text: string, _options?: { streamId?: string; finish?: boolean }) => {}), send: vi.fn(async (_id: string, _text: string) => {}),
    sendCard: vi.fn(async (_id: string, _card: WecomTemplateCard) => {}), updateCard: vi.fn(async (_event: WecomCardEvent, _card: WecomTemplateCard) => {}) };
  const create = (extra: { log?: (line: string) => void } = {}) => new WecomBridge({ botId: 'bot', stateFile, allowedUsers: ['alice'], policy: () => policy, core, transport, ...extra });
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const task = () => Object.values(state().tasks)[0] as any;
  const event = (key: string, input: Partial<WecomCardEvent> = {}): WecomCardEvent => ({ messageId: `e-${key}`, botId: 'bot', userId: 'alice', conversationId: 'g', chatType: 'group', requestId: 'callback', taskId: `${task().streamId}-final`, eventKey: key, receivedAt: Date.now(), ...input });
  return { core, transport, create, task, state, event, setPolicy: (next: Partial<WecomBridgePolicy>) => { policy = { ...policy, ...next }; }, setResult: (next: TriggerResponse) => { result = next; } };
}
const feedback = (extra: Record<string, unknown> = {}) => validateWecomMessageConfig({ feedback: { enabled: true, ...extra } }).feedback;

describe('WeCom message configuration uses real bridge delivery', () => {
  it.each([{ disableStreamingCard: true }, { replyCardMode: 'final-only' as const }])('suppresses live stream and preserves final answer: %j', async policy => {
    const f = setup(policy), bridge = f.create();
    f.setResult({ ok: true, state: 'running' });
    await bridge.receive(message()); await bridge.tick();
    expect(f.transport.reply).not.toHaveBeenCalled();
    f.setResult({ ok: true, state: 'completed', output: { content: 'finished' } }); await bridge.tick();
    expect(f.transport.reply.mock.calls.map(call => call[1])).toEqual(['finished']);
    expect(f.transport.reply.mock.calls[0][2]?.finish).toBe(true);
  });
  it('renders thinking and tools with independent switches and a distinct legacy delivery', async () => {
    const f = setup({ replyCardMode: 'unified' }), bridge = f.create(); f.setResult({ ok: true, state: 'running' });
    await bridge.receive(message()); await bridge.tick();
    expect(f.transport.reply.mock.calls.at(-1)?.[1]).toContain('reasoning');
    expect(f.transport.reply.mock.calls.at(-1)?.[1]).toContain('Read');
    f.setPolicy({ cotEnabled: false, replyCardShowTools: false }); await bridge.tick();
    expect(f.transport.reply.mock.calls.at(-1)?.[1]).toBe('narration');
    f.setPolicy({ replyCardMode: 'legacy', cotEnabled: true }); await bridge.tick();
    expect(f.transport.send.mock.calls.at(-1)?.[1]).toContain('reasoning');
    expect(f.transport.send.mock.calls.at(-1)?.[1]).not.toContain('file result');
  });
  it('uses real result usage, elapsed time and configured footer gates', async () => {
    vi.useFakeTimers(); const f = setup({ showReplyTiming: true, usageDisplay: 'footer', replyFooterEnabled: true, brandLabel: 'custom brand', model: 'model-a' }), bridge = f.create();
    await bridge.receive(message()); await vi.advanceTimersByTimeAsync(1500); await bridge.tick();
    const final = f.transport.reply.mock.calls.at(-1)![1];
    expect(final).toContain('1.5'); expect(final).toContain('12'); expect(final).toContain('model-a'); expect(final).toContain('custom brand'); expect(final).toContain('alice');
    f.setPolicy({ usageDisplay: 'off', replyFooterBrand: false, replyFooterModel: false, replyFooterRecipients: false, showReplyTiming: false });
    await bridge.receive(message('m2')); await bridge.tick(); expect(f.transport.reply.mock.calls.at(-1)?.[1]).toBe('answer');
  });
  it('honors no-progress timeout and one durable notice per turn without changing other CLIs', async () => {
    vi.useFakeTimers(); const f = setup({ cli: 'codex-app', noProgressNotify: { enabled: true, timeoutMs: 10_000 } }), bridge = f.create();
    vi.mocked(f.core.progress!).mockResolvedValue(undefined); f.setResult({ ok: true, state: 'running' });
    await bridge.receive(message()); await bridge.tick(); await vi.advanceTimersByTimeAsync(9999); await bridge.tick(); expect(f.transport.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await bridge.tick(); expect(f.transport.send).toHaveBeenCalledTimes(1);
    await f.create().tick(); await vi.advanceTimersByTimeAsync(60_000); await bridge.tick(); expect(f.transport.send).toHaveBeenCalledTimes(1);
    f.setPolicy({ cli: 'claude' }); await bridge.receive(message('bob-turn', 'bob')); await vi.advanceTimersByTimeAsync(60_000); await bridge.tick(); expect(f.transport.send).toHaveBeenCalledTimes(1);
  });
  it('checks revocation after an awaited progress lookup and stops instead of publishing', async () => {
    const f = setup(), bridge = f.create(); f.setResult({ ok: true, state: 'running' });
    let release!: (value: any) => void; vi.mocked(f.core.progress!).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    await bridge.receive(message()); const ticking = bridge.tick();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.setPolicy({ blockedUsers: ['alice'] }); release({ turnId: 'turn-m', workerGeneration: 1, entries: [{ kind: 'text', text: 'private progress' }] }); await ticking;
    expect(f.core.interrupt).toHaveBeenCalledWith('session', 'turn-m');
    expect(f.transport.reply.mock.calls.flatMap(call => call[1])).not.toContain('private progress'); expect(f.task().revoked).toBe(true);
  });
  it('sanitizes progress and metadata through the same local-address policy', async () => {
    const f = setup({ hideLocalAddresses: true, workingDirectory: '/workspace', brandLabel: '/workspace/secret', replyFooterEnabled: true }), bridge = f.create(); f.setResult({ ok: true, state: 'running' });
    await bridge.receive(message()); await bridge.tick(); expect(f.transport.reply.mock.calls.at(-1)?.[1]).not.toContain('/workspace/a');
    f.setResult({ ok: true, state: 'completed', output: { content: 'http://127.0.0.1:8844 /workspace/secret' } }); await bridge.tick();
    expect(f.transport.reply.mock.calls.at(-1)?.[1]).not.toContain('/workspace/secret'); expect(f.transport.reply.mock.calls.at(-1)?.[1]).not.toContain('127.0.0.1');
  });
});

describe('WeCom native feedback identity and generation fences', () => {
  it('persists custom feedback, suppresses event replay and applies allowReselect', async () => {
    const f = setup({ feedback: feedback({ allowReselect: true }) }), bridge = f.create(); await bridge.receive(message()); await bridge.tick();
    const card = f.transport.sendCard.mock.calls.at(-1)![1]; expect(card.button_list?.map(button => button.key)).toContain('feedback:conclusive_usable');
    const event = f.event('feedback:conclusive_usable'); await bridge.receiveCardEvent(event); await bridge.receiveCardEvent(event);
    expect(f.task().feedback.alice.revision).toBe(1); expect(f.transport.updateCard).toHaveBeenCalledTimes(1);
    expect(f.transport.updateCard.mock.calls.at(-1)?.[1].button_list?.length).toBeGreaterThan(0);
    await f.create().receiveCardEvent(f.event('feedback:effective_progress', { messageId: 'reselect' })); expect(f.task().feedback.alice.revision).toBe(2);
    f.setPolicy({ feedback: feedback({ allowReselect: false }) }); await bridge.receiveCardEvent(f.event('feedback:incorrect', { messageId: 'no-reselect' })); expect(f.task().feedback.alice.revision).toBe(2);
  });
  it.each(['wrong bot','wrong chat','wrong user','expired event','revoked'])('rejects %s before writing feedback or invoking control', async scenario => {
    const f = setup({ feedback: feedback(), replyCardActions: true }), bridge = f.create(); await bridge.receive(message()); await bridge.tick();
    const event = f.event('feedback:conclusive_usable');
    if (scenario === 'wrong bot') event.botId = 'other';
    if (scenario === 'wrong chat') event.conversationId = 'other';
    if (scenario === 'wrong user') event.userId = 'bob';
    if (scenario === 'expired event') event.receivedAt -= 5000;
    if (scenario === 'revoked') f.setPolicy({ allowedUsers: ['bob'] });
    await bridge.receiveCardEvent(event); expect(f.task().feedback).toBeUndefined(); expect(f.transport.updateCard).not.toHaveBeenCalled(); expect(f.core.close).not.toHaveBeenCalled();
  });
  it('requires both current gateway ACL and frozen/current reviewer policies; everyone grants no controls', async () => {
    const f = setup({ feedback: feedback({ audience: 'reviewers', reviewers: ['bob'] }), replyCardActions: true }), bridge = f.create(); await bridge.receive(message()); await bridge.tick();
    await bridge.receiveCardEvent(f.event('feedback:conclusive_usable', { userId: 'alice' })); expect(f.task().feedback).toBeUndefined();
    await bridge.receiveCardEvent(f.event('feedback:conclusive_usable', { userId: 'bob' })); expect(f.task().feedback.bob.semantic).toBe('positive');
    f.setPolicy({ feedback: feedback({ audience: 'everyone' }) });
    await bridge.receiveCardEvent(f.event('action:close', { messageId: 'bob-close', userId: 'bob' })); expect(f.core.close).not.toHaveBeenCalled();
    f.setPolicy({ blockedUsers: ['bob'] }); await bridge.receiveCardEvent(f.event('feedback:incorrect', { messageId: 'blocked', userId: 'bob' })); expect(f.task().feedback.bob.semantic).toBe('positive');
  });
  it('records required negative reason and bounded explicit comment without dispatching a new CLI turn', async () => {
    const f = setup({ feedback: feedback({ negativeFollowup: { reasons: [{ key: 'wrong', label: '不准确' }], comment: { required: true, maxLength: 10 } } }) }), bridge = f.create(); await bridge.receive(message()); await bridge.tick();
    await bridge.receiveCardEvent(f.event('feedback:incorrect')); expect(f.task().feedback.alice.pending).toBe(true);
    expect(f.transport.updateCard.mock.calls.at(-1)?.[1].button_list?.[0].key).toBe('reason:wrong');
    await bridge.receiveCardEvent(f.event('reason:wrong')); expect(f.task().feedback.alice.pending).toBe(true);
    await bridge.receive(message('comment', 'alice', `/feedback ${f.task().streamId}-final inaccurate`));
    expect(f.task().feedback.alice).toMatchObject({ pending: false, reason: 'wrong', comment: 'inaccurate' }); expect(f.core.trigger).toHaveBeenCalledTimes(1);
  });
  it('stops exact running turn, hides configured buttons, and refuses a callback whose actor loses ACL while poll waits', async () => {
    const f = setup({ replyCardActions: true }), bridge = f.create(); f.setResult({ ok: true, state: 'running' });
    await bridge.receive(message()); await bridge.tick();
    const running = f.transport.sendCard.mock.calls[0][1]; expect(running.button_list?.map(button => button.key)).toEqual(['action:terminal', 'action:stop']);
    f.setPolicy({ hiddenStreamingCardButtons: ['stop'] }); await bridge.receiveCardEvent(f.event('action:stop', { taskId: running.task_id })); expect(f.core.interrupt).not.toHaveBeenCalled();
    f.setPolicy({ hiddenStreamingCardButtons: [] });
    let release!: (value: TriggerResponse) => void; vi.mocked(f.core.result).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const ticking = bridge.tick(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const control = bridge.receiveCardEvent(f.event('action:stop', { messageId: 'stop-during-poll', taskId: running.task_id }));
    expect(f.transport.updateCard).toHaveBeenCalledTimes(1); // ACK precedes the blocked core lane.
    f.setPolicy({ allowedUsers: ['bob'] }); release({ ok: true, state: 'running' }); await ticking; await control;
    expect(f.core.interrupt).toHaveBeenCalledTimes(1); // revocation cleanup only; callback lane rechecks ACL.
  });
});

it('projects only current pending generation and rejects stale thinking attempts', () => {
  const base = { workerGeneration: 2, asyncTriggerResults: new Map([['t', { status: 'pending' as const, createdAt: 0 }]]), principalLaneRunningTurn: { turnId: 't', workerGeneration: 2 }, lastThinkingUpdate: { turnId: 't', dispatchAttempt: 1, workerGeneration: 2, entries: [{ kind: 'text' as const, text: 'old attempt' }] }, turnDispatchAttemptHighWater: { turnId: 't', dispatchAttempt: 2 } };
  expect(projectCoreOnlyProgress(base, 't')?.entries).toEqual([]);
  expect(projectCoreOnlyProgress({ ...base, principalLaneRunningTurn: { turnId: 't', workerGeneration: 1 } }, 't')).toBeUndefined();
  expect(projectCoreOnlyProgress(base, 'other')).toBeUndefined();
  expect(projectCoreOnlyProgress({ ...base, turnDispatchAttemptHighWater: { turnId: 't', dispatchAttempt: 1 } }, 't')?.entries[0]).toMatchObject({ text: 'old attempt' });
});

it('shows only a current native goal, uses native time and never infers completion from task state', async () => {
  const f = setup({ goalStatusCard: true }), bridge = f.create();
  const ds = { initConfig: { apiOnly: true }, workerGeneration: 3, asyncTriggerResults: new Map([['turn-m', { status: 'pending' as const, createdAt: Date.now() }]]), principalLaneRunningTurn: { turnId: 'turn-m', workerGeneration: 3 }, turnDispatchAttemptHighWater: { turnId: 'turn-m', dispatchAttempt: 2 } };
  const goal = { objective: 'complete the migration', status: 'active', createdAt: 1, updatedAt: 2, timeUsedSeconds: 42 };
  expect(rememberCoreOnlyGoal(ds, { goal, turnId: 'old', dispatchAttempt: 2 }, 3)).toBe(false);
  expect(rememberCoreOnlyGoal(ds, { goal, turnId: 'turn-m', dispatchAttempt: 1 }, 3)).toBe(false);
  expect(rememberCoreOnlyGoal(ds, { goal, turnId: 'turn-m', dispatchAttempt: 2 }, 2)).toBe(false);
  expect(rememberCoreOnlyGoal(ds, { goal, turnId: 'turn-m', dispatchAttempt: 2 }, 3)).toBe(true);
  vi.mocked(f.core.progress!).mockImplementation(async (_sid, turnId) => projectCoreOnlyProgress(ds, turnId)); f.setResult({ ok: true, state: 'running' });
  await bridge.receive(message()); await bridge.tick();
  expect(f.transport.reply.mock.calls.at(-1)?.[1]).toContain('complete the migration'); expect(f.transport.reply.mock.calls.at(-1)?.[1]).toContain('42');
  expect(rememberCoreOnlyGoal(ds, { goal: { ...goal, status: 'complete', timeUsedSeconds: 50 }, turnId: 'turn-m', dispatchAttempt: 2 }, 3)).toBe(true);
  await bridge.tick(); expect(f.transport.reply.mock.calls.at(-1)?.[1]).toContain('complete'); expect(f.transport.reply.mock.calls.at(-1)?.[1]).toContain('50');
  f.setPolicy({ goalStatusCard: false }); await bridge.tick();
  expect(f.transport.reply.mock.calls.at(-1)?.[1]).not.toContain('complete the migration');
  const calls = f.transport.reply.mock.calls.length; await bridge.tick(); expect(f.transport.reply).toHaveBeenCalledTimes(calls);
  expect(projectCoreOnlyProgress({ ...ds, principalLaneRunningTurn: { turnId: 'new', workerGeneration: 3 } }, 'turn-m')).toBeUndefined();
});

it('does not replay a final answer while an auxiliary card ACK is pending across restart', async () => {
  const f = setup({ feedback: feedback() }), bridge = f.create();
  let release!: () => void; f.transport.sendCard.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  await bridge.receive(message()); const ticking = bridge.tick(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(f.task().delivered).toBe(true);
  const finalCount = f.transport.reply.mock.calls.filter(call => call[2]?.finish).length;
  await f.create().tick(); expect(f.transport.reply.mock.calls.filter(call => call[2]?.finish)).toHaveLength(finalCount);
  release(); await ticking;
});

it('retains a no-progress uncertain write across restart instead of duplicating an accepted notification', async () => {
  vi.useFakeTimers(); const f = setup({ cli: 'codex-app', noProgressNotify: { enabled: true, timeoutMs: 10000 } }), bridge = f.create();
  f.setResult({ ok: true, state: 'running' }); vi.mocked(f.core.progress!).mockResolvedValue(undefined);
  f.transport.send.mockRejectedValueOnce(new WecomDeliveryUncertainError('ACK lost'));
  await bridge.receive(message()); await vi.advanceTimersByTimeAsync(10000); await bridge.tick();
  await vi.advanceTimersByTimeAsync(10000); await f.create().tick(); expect(f.transport.send).toHaveBeenCalledTimes(1);
});

it('allows feedback on a historical delivered answer while rejecting its stale close action', async () => {
  const f = setup({ feedback: feedback({ allowReselect: true }), replyCardActions: true }), bridge = f.create();
  await bridge.receive(message()); await bridge.tick(); const oldEvent = f.event('feedback:conclusive_usable');
  await bridge.receive(message('new-turn')); await bridge.tick();
  await bridge.receiveCardEvent(oldEvent); expect(f.task().feedback.alice.semantic).toBe('positive');
  await bridge.receiveCardEvent({ ...oldEvent, messageId: 'old-action', eventKey: 'action:close' }); expect(f.core.close).not.toHaveBeenCalled();
});

it('applies configured feedback semantics, button labels, disable switch and live reviewer removal', async () => {
  const configured = feedback({ audience: 'reviewers', reviewers: ['bob'], visibleSemantics: ['positive', 'negative'], buttons: [
    { key: 'good', label: 'Good custom label', semantic: 'positive' }, { key: 'bad', label: 'Bad custom label', semantic: 'negative' },
  ] });
  const f = setup({ feedback: configured }), bridge = f.create(); await bridge.receive(message()); await bridge.tick();
  expect(f.transport.sendCard.mock.calls.at(-1)?.[1].button_list?.map(button => [button.key, button.text])).toEqual([['feedback:good', 'Good custom label'], ['feedback:bad', 'Bad custom label']]);
  f.setPolicy({ feedback: feedback({ audience: 'reviewers', reviewers: ['alice'] }) });
  await bridge.receiveCardEvent(f.event('feedback:good', { userId: 'bob' })); expect(f.task().feedback).toBeUndefined();
  f.setPolicy({ feedback: { enabled: false } });
  await bridge.receiveCardEvent(f.event('feedback:good', { userId: 'bob', messageId: 'disabled' })); expect(f.task().feedback).toBeUndefined();
});

it('honors each footer switch independently and preserves usage accounting when display is disabled', async () => {
  const f = setup({ replyFooterEnabled: true, usageDisplay: 'footer', brandLabel: 'distinct-brand', model: 'distinct-model' }), bridge = f.create();
  await bridge.receive(message()); await bridge.tick();
  const fields = [ ['replyFooterBrand', 'distinct-brand'], ['replyFooterModel', 'distinct-model'], ['replyFooterUsage', 'tokens'], ['replyFooterRecipients', 'alice'] ] as const;
  for (const [field, hidden] of fields) {
    f.setPolicy({ replyFooterBrand: true, replyFooterModel: true, replyFooterUsage: true, replyFooterRecipients: true, [field]: false });
    await bridge.receive(message(field)); await bridge.tick(); expect(f.transport.reply.mock.calls.at(-1)?.[1]).not.toContain(hidden);
  }
  f.setPolicy({ replyFooterEnabled: false }); await bridge.receive(message('no-footer')); await bridge.tick(); expect(f.transport.reply.mock.calls.at(-1)?.[1]).toBe('answer');
  expect(f.task().usage.inputTokens).toBe(12);
});

it('enables CLI notices only via cliEnabled and honors the App mute independently', async () => {
  vi.useFakeTimers(); const f = setup({ cli: 'codex', noProgressNotify: { enabled: false, cliEnabled: false, timeoutMs: 10000 } }), bridge = f.create();
  f.setResult({ ok: true, state: 'running' }); vi.mocked(f.core.progress!).mockResolvedValue(undefined);
  await bridge.receive(message()); await vi.advanceTimersByTimeAsync(10000); await bridge.tick(); expect(f.transport.send).not.toHaveBeenCalled();
  f.setPolicy({ noProgressNotify: { enabled: false, cliEnabled: true, timeoutMs: 10000 } }); await bridge.tick(); expect(f.transport.send).toHaveBeenCalledTimes(1);
  f.setPolicy({ cli: 'codex-app' }); await bridge.receive(message('app-muted', 'bob')); await vi.advanceTimersByTimeAsync(10000); await bridge.tick(); expect(f.transport.send).toHaveBeenCalledTimes(1);
});

// Mutation: letting an ask-dispatch failure escape (no try around dispatchWecomAsks) turns the progress and
// notice assertions red; dropping the logged latch, or never clearing it, turns the log count red.
it('keeps progress and the no-progress notice going while the core rejects its ask endpoints, logging each run of failures once', async () => {
  vi.useFakeTimers(); const f = setup({ cli: 'codex-app', noProgressNotify: { enabled: true, timeoutMs: 10_000 } });
  const log = vi.fn(), bridge = f.create({ log });
  let asksFail = true;
  // An external core answers the ask endpoints with an HTTP error on every tick.
  Object.assign(f.core, {
    asks: vi.fn(async () => { if (asksFail) throw new Error('core API HTTP 401'); return []; }),
    answerAsk: vi.fn(async () => ({ outcome: 'delivered' })),
  });
  f.setResult({ ok: true, state: 'running' });
  await bridge.receive(message()); await bridge.tick();
  expect(f.core.asks).toHaveBeenCalled();
  expect(f.transport.reply.mock.calls.some(call => call[1].includes('narration'))).toBe(true);
  await vi.advanceTimersByTimeAsync(10_000); await bridge.tick();
  expect(f.transport.send).toHaveBeenCalledTimes(1);
  await bridge.tick(); await bridge.tick();
  expect(log).toHaveBeenCalledTimes(1);
  asksFail = false; await bridge.tick(); expect(log).toHaveBeenCalledTimes(1);
  asksFail = true; await bridge.tick(); await bridge.tick(); expect(log).toHaveBeenCalledTimes(2);
});

// Mutation: taking the default timeout from the policy read before the progress frame (policy.cli) turns this red.
it('judges the no-progress notice and its default timeout from one read of the configuration', async () => {
  vi.useFakeTimers(); const start = Date.now();
  const f = setup({ cli: 'codex-app', noProgressNotify: { enabled: true, cliEnabled: true } }), bridge = f.create();
  let step = 0;
  vi.mocked(f.core.progress!).mockImplementation(async (_sessionId, turnId) => ({ turnId, workerGeneration: 1, lastProgressAtMs: start, entries: [{ kind: 'text' as const, text: `step ${++step}` }] }));
  f.setResult({ ok: true, state: 'running' });
  await bridge.receive(message()); await bridge.tick();
  // The connection is switched to the Codex CLI while this tick posts its progress frame.
  f.transport.reply.mockImplementationOnce(async () => { f.setPolicy({ cli: 'codex' }); });
  await vi.advanceTimersByTimeAsync(100_000); await bridge.tick();
  expect(f.transport.send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200_000); await bridge.tick();
  expect(f.transport.send).toHaveBeenCalledTimes(1);
});

it('keeps no-progress timing independent from hidden presentation and later disclosure of the same snapshot', async () => {
  vi.useFakeTimers(); const f = setup({ disableStreamingCard: true, cotEnabled: false, replyCardShowTools: false, cli: 'codex-app', noProgressNotify: { enabled: true, timeoutMs: 10000 } }), bridge = f.create();
  f.setResult({ ok: true, state: 'running' }); await bridge.receive(message()); await bridge.tick();
  await vi.advanceTimersByTimeAsync(10000); await bridge.tick(); expect(f.transport.send).toHaveBeenCalledTimes(1); expect(f.transport.reply).not.toHaveBeenCalled();
  f.setPolicy({ disableStreamingCard: false, cotEnabled: true, replyCardShowTools: true }); await bridge.tick();
  expect(f.transport.reply.mock.calls.at(-1)?.[1]).toContain('reasoning'); expect(f.transport.send).toHaveBeenCalledTimes(1);
});
