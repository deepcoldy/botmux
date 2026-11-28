import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomBridge, type WecomCore } from '../src/im/wecom/gateway/bridge.js';
import { WECOM_SILENT_TURN_CLOSE } from '../src/im/wecom/gateway/bridge/tick.js';
import { validateWecomMessageConfig } from '../src/im/wecom/config/message-config.js';
import { WecomDeliveryUncertainError, type WecomInboundMessage, type WecomTemplateCard } from '../src/im/wecom/protocol/types.js';

/**
 * A turn the model ended with BOTMUX_NOTHING_TO_SEND settles in the core as a
 * completed result with empty output. The gateway must not put a reply into
 * the chat for it, must close what admission put in front of the requester
 * (a stream card), decided by what admission actually did, and must record the turn as finished exactly once — across restarts,
 * hangs and transport failures.
 */
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

type Mode = 'default-streaming' | 'final-only' | 'no-streaming';
const MODE_POLICY: Record<Mode, Record<string, unknown>> = {
  'default-streaming': {},
  'final-only': { replyCardMode: 'final-only' },
  'no-streaming': { disableStreamingCard: true },
};
const WITH_CARDS = { replyCardActions: true, feedback: validateWecomMessageConfig({ feedback: { enabled: true } }).feedback };
type Event = { kind: 'reply' | 'send' | 'card'; to?: string; text?: string; finish?: boolean; streamId?: string };

function harness(initial: Record<string, unknown>, content: string | (() => string), finalState = 'completed') {
  const dir = mkdtempSync(join(tmpdir(), 'wecom-silent-')); dirs.push(dir);
  const stateFile = join(dir, 'state.json');
  const events: Event[] = [];
  const transport = {
    reply: vi.fn(async (_m: WecomInboundMessage, text: string, o?: { streamId?: string; finish?: boolean }) => {
      events.push({ kind: 'reply', text, finish: o?.finish ?? true, streamId: o?.streamId });
    }),
    send: vi.fn(async (to: string, text: string) => { events.push({ kind: 'send', to, text }); }),
    sendCard: vi.fn(async (to: string, card: WecomTemplateCard) => { events.push({ kind: 'card', to, text: card.task_id }); }),
  };
  let done = false;
  let progressText = '';
  const core: WecomCore = {
    trigger: vi.fn(async () => ({ ok: true, triggerId: 't1', target: { kind: 'turn', sessionId: 's1' } })),
    result: vi.fn(async () => (done
      ? { ok: true, state: finalState, output: { content: typeof content === 'function' ? content() : content } } as any
      : { ok: true, state: 'running' })),
    // Visible progress text (rendered only while progress streaming is on).
    progress: vi.fn(async () => ({ turnId: 't1', workerGeneration: 1, dispatchAttempt: 1,
      entries: progressText ? [{ kind: 'text', text: progressText }] : [] } as any)),
    interrupt: vi.fn(async () => {}),
  };
  let current: Record<string, unknown> = { allowedUsers: ['alice'], ...initial };
  const policy = () => ({ ...current });
  const create = () => new WecomBridge({ botId: 'bot', stateFile, allowedUsers: ['alice'], transport, core, policy } as any);
  const message: WecomInboundMessage = { messageId: 'm1', userId: 'alice', conversationId: 'g1', chatType: 'group',
    text: 'hello', attachments: [], replyContext: { requestId: 'r1' } };
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const task = () => Object.values(state().tasks)[0] as any;
  const editTask = (edit: (t: any) => void) => {
    const s = state(); edit(Object.values(s.tasks)[0]); writeFileSync(stateFile, JSON.stringify(s));
  };
  return {
    create, transport, core, events, message, stateFile, task, editTask,
    finish: () => { done = true; },
    setPolicy: (p: Record<string, unknown>) => { current = { allowedUsers: ['alice'], ...p }; },
    setProgress: (text: string) => { progressText = text; },
  };
}
type Harness = ReturnType<typeof harness>;

/** Admission and the running poll, then the result; returns what the chat got after the turn completed. */
async function runToCompletion(h: Harness, bridge = h.create(), between?: () => void) {
  await bridge.receive(h.message);
  await bridge.tick();
  between?.();
  const before = h.events.length;
  h.finish();
  for (let i = 0; i < 3; i++) await bridge.tick();
  return { bridge, after: h.events.slice(before) };
}
const streamClose = (h: Harness, text: string): Event => ({ kind: 'reply', text, finish: true, streamId: h.task().streamId });

describe('a silent turn posts no reply', () => {
  it.each([
    ['default-streaming', ''],
    ['default-streaming', ' \n\t '],
    ['default-streaming', '​'],
    ['final-only', ''],
    ['no-streaming', ''],
  ] as const)('%s, content %j: only what closes the admission notice', async (mode, content) => {
    const h = harness({ ...MODE_POLICY[mode], ...WITH_CARDS }, content);
    const { after } = await runToCompletion(h);
    const expected: Record<Mode, Event[]> = {
      'default-streaming': [streamClose(h, WECOM_SILENT_TURN_CLOSE)],
      'final-only': [],
      'no-streaming': [],
    };
    expect(after).toEqual(expected[mode]);
    expect(h.task()).toMatchObject({ delivered: true, silent: true, result: '' });
  });

  it('a turn with an answer still gets it (the same harness is not blind)', async () => {
    const h = harness({ replyCardMode: 'final-only', ...WITH_CARDS }, 'real answer');
    const { after } = await runToCompletion(h);
    expect(after.filter(e => e.kind === 'reply').map(e => e.text)).toEqual(['real answer']);
    expect(after.some(e => e.kind === 'card')).toBe(true);
    expect(h.task().silent).toBeUndefined();
  });

  it.each([['failed'], ['interrupted']] as const)('a %s turn with no output still reports its state', async (state) => {
    const silentLike = harness({ replyCardMode: 'final-only' }, '', state);
    const { after } = await runToCompletion(silentLike);
    expect(after).toHaveLength(1);
    expect(after[0].text).not.toBe(WECOM_SILENT_TURN_CLOSE);
    expect(silentLike.task().silent).toBeUndefined();
  });

  it('later ticks and a restart add nothing', async () => {
    for (const mode of ['default-streaming', 'no-streaming'] as const) {
      const h = harness({ ...MODE_POLICY[mode], ...WITH_CARDS }, '');
      await runToCompletion(h);
      const count = h.events.length;
      const restarted = h.create();
      for (let i = 0; i < 3; i++) await restarted.tick();
      expect(h.events.length, mode).toBe(count);
    }
  });
});

describe('the close follows what admission did, not the policy at completion', () => {
  it.each([
    ['default-streaming', 'final-only'],
    ['default-streaming', 'no-streaming'],
  ] as const)('a card opened under %s is still closed after a switch to %s', async (from, to) => {
    const h = harness(MODE_POLICY[from], '');
    const { after } = await runToCompletion(h, h.create(), () => h.setPolicy(MODE_POLICY[to]));
    expect(after).toEqual([streamClose(h, WECOM_SILENT_TURN_CLOSE)]);
  });

  it.each([
    ['final-only', 'default-streaming'],
    ['no-streaming', 'default-streaming'],
  ] as const)('nothing is posted when admitted under %s and switched to %s', async (from, to) => {
    const h = harness(MODE_POLICY[from], '');
    const { after } = await runToCompletion(h, h.create(), () => h.setPolicy(MODE_POLICY[to]));
    expect(after).toEqual([]);
  });

  it('a single chat opened a stream card there, and that card is closed', async () => {
    const h = harness({}, '');
    const bridge = h.create();
    await bridge.receive({ ...h.message, chatType: 'single', conversationId: 'alice' });
    await bridge.tick();
    const before = h.events.length;
    h.finish();
    for (let i = 0; i < 2; i++) await bridge.tick();
    expect(h.events.slice(before)).toEqual([streamClose(h, WECOM_SILENT_TURN_CLOSE)]);
  });

  it.each(['default-streaming'] as const)(
    '%s: an admission notice that never went out (crash after the admission save) is not followed by a close', async (mode) => {
      const h = harness(MODE_POLICY[mode], '');
      // The admission notice hangs: the process dies with it in flight.
      h.transport.reply.mockImplementationOnce(() => new Promise<void>(() => {}));
      void h.create().receive(h.message);
      await vi.waitFor(() => expect(Object.keys(JSON.parse(readFileSync(h.stateFile, 'utf8')).tasks)).toHaveLength(1));
      const restarted = h.create();
      await restarted.tick();
      const before = h.events.length;
      h.finish();
      for (let i = 0; i < 2; i++) await restarted.tick();
      expect(h.events.slice(before)).toEqual([]);
      expect(h.task()).toMatchObject({ delivered: true, silent: true });
    });

  it('a private "正在处理…" an earlier version sent from a group is followed by nothing, neither in the group nor privately', async () => {
    const h = harness({}, '');
    const bridge = h.create();
    await bridge.receive(h.message);
    await bridge.tick();
    // As the private-card build admitted it: a private notice, acknowledged.
    h.editTask(t => { t.admissionNotice = 'private'; t.admissionNoticeSent = true; t.deliveryPrivate = true; });
    const restarted = h.create();
    const before = h.events.length;
    h.finish();
    for (let i = 0; i < 2; i++) await restarted.tick();
    expect(h.events.slice(before)).toEqual([]);
    expect(h.task()).toMatchObject({ delivered: true, silent: true });
  });
});

describe('a stream card opened by progress frames, not by the admission notice', () => {
  const PROGRESS_ON = { disableStreamingCard: false };
  const single = (h: Harness): WecomInboundMessage => ({ ...h.message, chatType: 'single', conversationId: 'alice' });
  /** Admission, then progress frames under `running` policy, then the turn ends. */
  async function run(opts: {
    admitted: Record<string, unknown>; running: Record<string, unknown>; chat?: 'group' | 'single';
    admissionFails?: boolean; restartBeforeEnd?: boolean;
  }) {
    const h = harness(opts.admitted, '');
    let bridge = h.create();
    // e.g. transport not authenticated during a reconnect: a plain error, not an unacknowledged frame.
    if (opts.admissionFails) h.transport.reply.mockRejectedValueOnce(new Error('not authenticated'));
    await bridge.receive(opts.chat === 'single' ? single(h) : h.message);
    await bridge.tick();
    h.setPolicy(opts.running);
    for (const step of ['步骤 1', '步骤 2']) {
      h.setProgress(step);
      await bridge.tick();
    }
    if (opts.restartBeforeEnd) bridge = h.create();
    const before = h.events.length;
    h.finish();
    for (let i = 0; i < 2; i++) await bridge.tick();
    return { h, after: h.events.slice(before).filter(e => e.kind !== 'card') };
  }
  const progressFrames = (h: Harness) => h.events.filter(e => e.kind === 'reply' && e.finish === false && e.text !== '正在处理…');

  it.each([
    ['final-only', 'group'], ['final-only', 'single'], ['no-streaming', 'group'], ['no-streaming', 'single'],
  ] as const)('admitted %s (no card) in a %s chat, progress streaming turned on mid-turn: the silent turn closes the card', async (mode, chat) => {
    const { h, after } = await run({ admitted: MODE_POLICY[mode], running: PROGRESS_ON, chat });
    expect(progressFrames(h).map(e => e.text)).toEqual(['步骤 1', '步骤 2']);
    expect(after).toEqual([streamClose(h, WECOM_SILENT_TURN_CLOSE)]);
  });

  it('admission notice failed with a plain error, later progress frames opened the card: the silent turn closes it', async () => {
    const { h, after } = await run({ admitted: PROGRESS_ON, running: PROGRESS_ON, admissionFails: true });
    expect(h.task().admissionNoticeSent).toBeUndefined();
    expect(after.filter(e => e.kind === 'reply')).toEqual([streamClose(h, WECOM_SILENT_TURN_CLOSE)]);
  });

  it('the confirmation survives a restart before the turn ends', async () => {
    const { h, after } = await run({ admitted: MODE_POLICY['final-only'], running: PROGRESS_ON, restartBeforeEnd: true });
    expect(after).toEqual([streamClose(h, WECOM_SILENT_TURN_CLOSE)]);
  });

  it.each(['rejected', 'unacknowledged'] as const)('a %s progress frame confirms nothing: nothing is posted', async (fault) => {
    const h = harness(MODE_POLICY['final-only'], '');
    let bridge = h.create();
    await bridge.receive(h.message);
    await bridge.tick();
    h.setPolicy(PROGRESS_ON);
    h.setProgress('步骤 1');
    if (fault === 'rejected') {
      h.transport.reply.mockRejectedValueOnce(new WecomDeliveryUncertainError('ACK timed out'));
      await bridge.tick();
    } else {
      // The frame never comes back: the process dies with it in flight.
      h.transport.reply.mockImplementationOnce(() => new Promise<void>(() => {}));
      void bridge.tick();
      await vi.waitFor(() => expect(h.transport.reply).toHaveBeenCalledTimes(1));
      bridge = h.create();
    }
    h.setProgress('');
    h.setPolicy(MODE_POLICY['final-only']);
    const before = h.events.length;
    h.finish();
    for (let i = 0; i < 2; i++) await bridge.tick();
    expect(h.events.slice(before)).toEqual([]);
    expect(h.task()).toMatchObject({ delivered: true, silent: true });
  });

});

describe('tasks admitted before the admission notice was recorded', () => {
  async function legacy(mode: Mode, edit: (t: any) => void) {
    const h = harness(MODE_POLICY[mode], '');
    const bridge = h.create();
    await bridge.receive(h.message);
    await bridge.tick();
    // State as the previous build saved it: no admission record.
    h.editTask(t => { delete t.admissionNotice; delete t.admissionNoticeSent; edit(t); });
    const restarted = h.create();
    const before = h.events.length;
    h.finish();
    for (let i = 0; i < 2; i++) await restarted.tick();
    return { h, after: h.events.slice(before) };
  }

  it('post nothing when nothing shows a card exists, in any mode', async () => {
    for (const mode of ['default-streaming', 'final-only'] as const) {
      const { h, after } = await legacy(mode, () => {});
      expect(after, mode).toEqual([]);
      expect(h.task(), mode).toMatchObject({ delivered: true, silent: true });
    }
  });

  it('close the stream card when progress was already streamed into it', async () => {
    const { h, after } = await legacy('default-streaming', t => { t.progressText = 'working on it'; });
    expect(after).toEqual([streamClose(h, WECOM_SILENT_TURN_CLOSE)]);
  });

});

describe('tasks an earlier version admitted with a feature since removed', () => {
  it('a task admitted for private delivery from a group is answered in the group it came from', async () => {
    const h = harness({ replyCardMode: 'final-only' }, 'the answer');
    const bridge = h.create();
    await bridge.receive(h.message);
    await bridge.tick();
    h.editTask(t => { t.deliveryPrivate = true; });
    const restarted = h.create();
    const before = h.events.length;
    h.finish();
    for (let i = 0; i < 2; i++) await restarted.tick();
    const after = h.events.slice(before).filter(e => e.kind !== 'card');
    expect(after).toEqual([{ kind: 'reply', text: 'the answer', finish: true, streamId: h.task().streamId }]);
    expect(h.transport.send).not.toHaveBeenCalled();
  });

  it.each(['delivered', 'uncertain', 'sending'] as const)(
    'a task carrying a reply the model sent itself (%s) is answered by the automatic reply', async (status) => {
      const h = harness({ replyCardMode: 'final-only' }, 'the answer');
      const bridge = h.create();
      await bridge.receive(h.message);
      await bridge.tick();
      h.editTask(t => { t.nativeDelivery = { capability: 'c'.repeat(64), expiresAt: Date.now() + 60000, status }; });
      const restarted = h.create();
      const before = h.events.length;
      h.finish();
      for (let i = 0; i < 2; i++) await restarted.tick();
      expect(h.events.slice(before).filter(e => e.kind === 'reply').map(e => e.text)).toEqual(['the answer']);
      expect(h.task()).toMatchObject({ delivered: true });
    });
});

describe('a silent turn is finished exactly once', () => {
  it('a restart while the closing frame is in flight sends it once more, then never again', async () => {
    const h = harness({}, '');
    const bridge = h.create();
    await bridge.receive(h.message);
    await bridge.tick();
    h.transport.reply.mockImplementationOnce(() => new Promise<void>(() => {}));
    h.finish();
    void bridge.tick();
    await vi.waitFor(() => expect(h.task().streamCloseAttempts).toBe(1));
    expect(h.task().delivered).toBeUndefined();
    const second = h.create();
    for (let i = 0; i < 2; i++) await second.tick();
    const third = h.create();
    for (let i = 0; i < 2; i++) await third.tick();
    const closes = h.transport.reply.mock.calls.filter(c => c[2]?.finish === true);
    expect(closes).toHaveLength(2);
    expect(new Set(closes.map(c => `${c[1]}|${c[2]?.streamId}`)).size).toBe(1);
    expect(h.task()).toMatchObject({ delivered: true, streamCloseAttempts: 2 });
    expect(h.transport.send).not.toHaveBeenCalled();
  });

  it('a closing frame that hangs on every start is given up after the second attempt', async () => {
    const h = harness({}, '');
    const bridge = h.create();
    await bridge.receive(h.message);
    await bridge.tick();
    h.transport.reply.mockImplementation(async (_m, _text, o) => {
      if (o?.finish === true) await new Promise<void>(() => {});
    });
    h.finish();
    void bridge.tick();
    await vi.waitFor(() => expect(h.task().streamCloseAttempts).toBe(1));
    void h.create().tick();
    await vi.waitFor(() => expect(h.task().streamCloseAttempts).toBe(2));
    const third = h.create();
    for (let i = 0; i < 2; i++) await third.tick();
    expect(h.transport.reply.mock.calls.filter(c => c[2]?.finish === true)).toHaveLength(2);
    expect(h.task()).toMatchObject({ delivered: true, streamCloseAttempts: 2 });
    expect(h.transport.send).not.toHaveBeenCalled();
  });

  it('a failed closing frame is not retried and falls back to nothing', async () => {
    const h = harness({}, '');
    const bridge = h.create();
    await bridge.receive(h.message);
    await bridge.tick();
    h.transport.reply.mockRejectedValueOnce(new WecomDeliveryUncertainError('ACK timed out'));
    h.finish();
    await bridge.tick();
    await h.create().tick();
    expect(h.transport.reply.mock.calls.filter(c => c[2]?.finish === true)).toHaveLength(1);
    expect(h.transport.send).not.toHaveBeenCalled();
    expect(h.task()).toMatchObject({ delivered: true, silent: true });
  });

  it('a restart after the silent result was recorded but before delivery delivers nothing more than once', async () => {
    const h = harness({ replyCardMode: 'final-only' }, '');
    const bridge = h.create();
    await bridge.receive(h.message);
    await bridge.tick();
    h.finish();
    await bridge.tick();
    h.editTask(t => { delete t.delivered; });
    const before = h.events.length;
    await h.create().tick();
    expect(h.events.slice(before)).toEqual([]);
    expect(h.task()).toMatchObject({ delivered: true, silent: true });
    expect(h.core.result).toHaveBeenCalledTimes(2);
  });

  it('no long-task or no-progress notice follows a silent turn, however much time passes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness({
      replyCardMode: 'final-only', cli: 'codex-app', noProgressNotify: { enabled: true, timeoutMs: 1000 }, longTaskReminder: { enabled: true, minutes: 1 },
    }, '');
    const bridge = h.create();
    await runToCompletion(h, bridge);
    const count = h.events.length;
    vi.setSystemTime(Date.now() + 24 * 3600_000);
    for (let i = 0; i < 3; i++) await bridge.tick();
    expect(h.events.length).toBe(count);
  });

  it('a requester who lost authorization before delivery gets nothing', async () => {
    const h = harness({}, '');
    const { after } = await runToCompletion(h, h.create(), () => h.setPolicy({ allowedUsers: [] }));
    expect(after).toEqual([]);
    expect(h.task().revoked).toBe(true);
  });

  it('/status afterwards reports no running task, as for a delivered answer', async () => {
    const replies: string[] = [];
    for (const content of ['', 'real answer']) {
      const h = harness({ replyCardMode: 'final-only' }, content);
      const bridge = h.create();
      await runToCompletion(h, bridge);
      await bridge.receive({ ...h.message, messageId: 'm-status', text: '/status' });
      replies.push(h.events.at(-1)!.text!);
    }
    expect(replies[0]).toBe(replies[1]);
  });
});

describe('what a silent turn leaves for later turns', () => {
  it('a silent /summary keeps the previous summary memory', async () => {
    const work = mkdtempSync(join(tmpdir(), 'wecom-silent-work-')); dirs.push(work);
    const h = harness({ replyCardMode: 'final-only', summaryMemory: true, summaryMemoryPath: 'mem.md', workingDirectory: work }, '');
    writeFileSync(join(work, 'mem.md'), 'PREVIOUS SUMMARY');
    const bridge = h.create();
    await bridge.receive({ ...h.message, text: '/summary' });
    await bridge.tick();
    h.finish();
    for (let i = 0; i < 2; i++) await bridge.tick();
    expect(h.task()).toMatchObject({ delivered: true, silent: true });
    expect(readFileSync(join(work, 'mem.md'), 'utf8')).toBe('PREVIOUS SUMMARY');
  });

  it('the observed-conversation summary marks a silent turn, never as an empty line', async () => {
    const botLine = async (content: string) => {
      const h = harness({ replyCardMode: 'final-only' }, content);
      const bridge = h.create();
      await bridge.receive(h.message);
      await bridge.tick();
      h.finish();
      for (let i = 0; i < 2; i++) await bridge.tick();
      let prompt = '';
      h.core.trigger = vi.fn(async (request: any) => { prompt = request.envelope.rawText; return { ok: true, triggerId: 't2', target: { kind: 'turn', sessionId: 's1' } }; });
      await bridge.receive({ ...h.message, messageId: 'm-sum', text: '/summary' });
      await bridge.tick();
      return /机器人：(.*)/.exec(prompt)?.[1] ?? '';
    };
    const answered = await botLine('real answer');
    const silent = await botLine('');
    expect(answered).toBe('real answer');
    expect(silent.trim()).not.toBe('');
    expect(silent).not.toBe(answered);
  });
});
