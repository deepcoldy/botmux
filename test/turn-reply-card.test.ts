import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import { TurnReplyCardStore, type TurnReplyCardRecord, type TurnReplyCardTransport } from '../src/services/turn-reply-card.js';
import { buildTurnReplyCard, publicReplyCardActivity, publicReplyCardTools } from '../src/im/lark/turn-reply-card.js';
import { TURN_REPLY_CARD_MAX_BYTES, turnReplyCardRequestBytes } from '../src/im/lark/turn-reply-card-size.js';
import { stampBotmuxCallbackMarkers } from '../src/im/lark/callback-button-marker.js';
import type { CotEntry } from '../src/types.js';
import { buildCanonicalFinalReplyCard } from '../src/im/lark/md-card.js';
import { shouldSuppressBridgeEmit } from '../src/services/bridge-fallback-gate.js';
import { extractCardContent } from '../src/im/lark/message-parser.js';
import { extractCotEntries } from '../src/services/claude-transcript.js';

const key = { larkAppId: 'app_test', sessionId: 'session', turnId: 'om_turn' };
const input = { mode: 'unified' as const, chatId: 'oc_chat', rootId: 'om_root' };
const presentation = { showProcess: true, showToolResults: true, canStop: true };
const finalEvent = (text = '完整答复', source: 'explicit' | 'bridge' = 'explicit') => ({
  kind: 'final' as const, text, card: buildCanonicalFinalReplyCard({ markdown: text }), source,
});

describe('one reply card per turn', () => {
  let dir: string;
  let store: TurnReplyCardStore;
  let cards: Map<string, string>;
  let io: TurnReplyCardTransport;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-reply-test-'));
    store = new TurnReplyCardStore(dir);
    cards = new Map();
    io = {
      render: record => buildTurnReplyCard(record, presentation),
      beforeEffect: vi.fn(), isWithdrawn: error => error instanceof Error && error.message === 'withdrawn',
      send: vi.fn(async (content, uuid) => { cards.set(uuid, content); return uuid; }),
      patch: vi.fn(async (id, content) => { if (!cards.has(id)) throw Error('unknown card'); cards.set(id, content); }),
    };
    await store.prepare(key, input);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('updates tools, progress and final in the original message, then preserves it for the next turn', async () => {
    const start = await store.update(key, { kind: 'start' }, io);
    await store.update(key, { kind: 'progress', text: '正在检查仓库' }, io);
    await store.update(key, { kind: 'tools', tools: [{ id: 't1', name: 'Read', subject: 'README.md', result: 'contents' }] }, io);
    const final = await store.update(key, finalEvent(), io);
    await store.update(key, { kind: 'terminal', phase: 'completed', durationMs: 1400 }, io);
    expect(final.messageId).toBe(start.messageId);
    expect(io.send).toHaveBeenCalledTimes(1);
    const body = cards.get(start.messageId!)!;
    expect(body).toContain('完整答复');
    expect(body).toContain('正在检查仓库');
    expect(body).toContain('README.md');
    expect(body).toContain('collapsible_panel');
    const historyText = extractCardContent(body);
    expect(historyText).toContain('完整答复');
    expect(historyText).toContain('README.md');
    expect(body).not.toContain('stop_turn');
    const nextKey = { ...key, turnId: 'om_next' };
    await store.prepare(nextKey, input);
    await store.update(nextKey, { kind: 'start' }, io);
    expect(cards.size).toBe(2);
    expect(cards.get(start.messageId!)).toBe(body);
  });

  it('retains tools across a burst of progress patches without losing stored history or creating another message', async () => {
    const tools = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, name: `TOOL_${i}`, subject: '' }));
    const start = await store.update(key, { kind: 'tools', tools }, io);
    for (let i = 0; i < 30; i++) {
      await store.update(key, { kind: 'progress', text: `PROGRESS_${i}` }, io);
    }
    await store.update(key, finalEvent(), io);
    await store.update(key, { kind: 'terminal', phase: 'completed' }, io);
    expect(io.send).toHaveBeenCalledTimes(1);
    expect(new Set(vi.mocked(io.patch).mock.calls.map(([id]) => id))).toEqual(new Set([start.messageId]));
    const final = new TurnReplyCardStore(dir).read(key)!;
    expect(final.progress).toHaveLength(30);
    expect(final.activity).toHaveLength(35);
    expect(final.tools).toEqual(tools);
    const body = cards.get(start.messageId!)!;
    expect(body).toContain('完整答复');
    for (const tool of tools) expect(body).toContain(`**${tool.name}**`);
    expect(body).toContain('PROGRESS_29');
    expect(body).toContain('PROGRESS_0');
  });

  it.each([false, true])('preserves interim narration in the same card with extended thinking=%s', async withThinking => {
    const entries: CotEntry[] = [
      { kind: 'text', text: '先检查项目配置' },
      { kind: 'tool_call', id: 'read', name: 'Read', args: '{}', subject: 'config.ts' },
      { kind: 'tool_result', id: 'read', result: 'config contents' },
      { kind: 'text', text: '配置已确认，继续运行测试' },
      { kind: 'tool_call', id: 'test', name: 'Bash', args: '{}', subject: 'bun run test' },
      ...(withThinking ? [{ kind: 'thinking' as const, text: '确认两项检查的结果一致' }] : []),
    ];
    const update = (snapshot: CotEntry[]) => store.update(key, {
      kind: 'tools', tools: publicReplyCardTools(snapshot, true), activity: publicReplyCardActivity(snapshot),
    }, io);
    const started = await update(entries.slice(0, 3));
    await update(entries);
    await update(entries); // Repeated cumulative snapshots must not duplicate narration.

    const persisted = new TurnReplyCardStore(dir).read(key)!;
    expect(persisted.activity?.map(item => item.kind)).toEqual([
      'thinking', 'tool', 'thinking', 'tool', ...(withThinking ? ['thinking'] : []),
    ]);
    const narration = ['先检查项目配置', '配置已确认，继续运行测试', ...(withThinking ? ['确认两项检查的结果一致'] : [])];
    expect(persisted.activity?.flatMap(item => item.kind === 'thinking' ? [item.text] : [])).toEqual(narration);
    expect(persisted.tools).toEqual([
      { id: 'read', name: 'Read', subject: 'config.ts', completed: true, result: 'config contents' },
      { id: 'test', name: 'Bash', subject: 'bun run test' },
    ]);
    for (const text of narration) expect(cards.get(started.messageId!)).toContain(text);

    await store.update(key, finalEvent(), io);
    await store.update(key, { kind: 'terminal', phase: 'completed' }, io);
    expect(io.send).toHaveBeenCalledTimes(1);
    const finished = new TurnReplyCardStore(dir).read(key)!;
    expect(finished.messageId).toBe(started.messageId);
    expect(finished.finalText).toBe('完整答复');
    const history = extractCardContent(cards.get(started.messageId!)!);
    for (const text of narration) expect(history.split(text)).toHaveLength(2);
    const hidden = buildTurnReplyCard(finished, { ...presentation, showProcess: false });
    expect(hidden).toContain('完整答复');
    for (const text of narration) expect(hidden).not.toContain(text);
  });

  it('truncates only the card view of oversized CLI activity without sending an extra file or losing stored text', async () => {
    const narration = '旁白\n'.repeat(5000);
    const subject = '完整命令参数'.repeat(1000);
    const result = '完整工具结果\n'.repeat(5000);
    const entries: CotEntry[] = [
      { kind: 'text', text: narration },
      { kind: 'tool_call', id: 'long', name: 'Bash', args: '{}', subject },
      { kind: 'tool_result', id: 'long', result },
    ];
    io.sendOverflow = vi.fn(async () => 'om_unwanted');
    const start = await store.update(key, { kind: 'tools', tools: publicReplyCardTools(entries, true), activity: publicReplyCardActivity(entries) }, io);
    await store.update(key, { kind: 'progress', text: '正在整理结果' }, io);
    await store.update(key, finalEvent(), io);
    await store.update(key, { kind: 'terminal', phase: 'completed' }, io);
    expect(io.send).toHaveBeenCalledTimes(1);
    expect(io.sendOverflow).not.toHaveBeenCalled();
    for (const [, body] of vi.mocked(io.patch).mock.calls) {
      expect(body).toContain('已截断');
      expect(turnReplyCardRequestBytes(body, input.chatId)).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
    }
    const saved = new TurnReplyCardStore(dir).read(key)!;
    expect(saved.activity).toContainEqual({ kind: 'thinking', id: 'thinking:0', text: narration });
    expect(saved.tools).toEqual([{ id: 'long', name: 'Bash', subject, result, completed: true }]);
    expect(saved.finalDelivered).toBe(true);
    expect(cards.get(start.messageId!)!).toContain('完整答复');
  });

  it('serializes independent publishers and fences progress after final delivery', async () => {
    const secondProcess = new TurnReplyCardStore(dir);
    let release!: () => void;
    const sending = new Promise<void>(resolve => { release = resolve; });
    const sendStarted = Promise.withResolvers<void>();
    io.send = vi.fn(async (content, uuid) => {
      sendStarted.resolve(); await sending;
      cards.set(uuid, content); return uuid;
    });
    const pendingProgress = store.update(key, { kind: 'progress', text: '进度' }, io);
    await sendStarted.promise;
    const pendingFinal = secondProcess.update(key, finalEvent(), io);
    release();
    await Promise.all([pendingProgress, pendingFinal]);
    await store.update(key, { kind: 'tools', tools: [] }, io);
    expect(io.send).toHaveBeenCalledTimes(1);
    expect([...cards.values()][0]).toContain('完整答复');
    expect(store.read(key)?.finalDelivered).toBe(true);
  });

  it('retries an uncertain first send with its original body and idempotency key', async () => {
    let first = true;
    const requests: { content: string; uuid: string }[] = [];
    io.send = vi.fn(async (content, uuid) => {
      requests.push({ content, uuid }); cards.set(uuid, content);
      if (first) { first = false; throw new Error('connection reset after acceptance'); }
      return uuid;
    });
    await expect(store.update(key, { kind: 'progress', text: '初始进度' }, io)).rejects.toThrow('connection reset');
    const restarted = new TurnReplyCardStore(dir);
    await restarted.update(key, finalEvent(), io);
    expect(requests[0]).toEqual(requests[1]);
    expect(cards.size).toBe(1);
    expect([...cards.values()][0]).toContain('完整答复');
  });

  it('does not claim a final was delivered when its PATCH failed', async () => {
    await store.update(key, { kind: 'start' }, io);
    const patch = io.patch;
    io.patch = vi.fn().mockRejectedValue(new Error('temporary error'));
    await expect(store.update(key, finalEvent(), io)).rejects.toThrow('temporary error');
    expect(store.read(key)?.finalDelivered).not.toBe(true);
    io.patch = patch;
    await store.update(key, finalEvent(), io);
    expect(store.read(key)?.finalDelivered).toBe(true);
    expect(io.send).toHaveBeenCalledTimes(1);
  });

  it('retries an unacknowledged terminal PATCH after restart without changing settled facts', async () => {
    const started = await store.update(key, { kind: 'start' }, io);
    const patch = io.patch;
    io.patch = vi.fn().mockRejectedValueOnce(new Error('temporary terminal error')).mockImplementation(patch);
    await expect(store.update(key, { kind: 'terminal', phase: 'completed', durationMs: 1400 }, io))
      .rejects.toThrow('temporary terminal error');
    expect(store.read(key)?.phase).toBe('completed');
    expect(cards.get(started.messageId!)!).toContain('处理中');

    const restarted = new TurnReplyCardStore(dir);
    await restarted.update(key, { kind: 'terminal', phase: 'failed', durationMs: 9000 }, io);
    expect(cards.get(started.messageId!)!).toContain('已完成 · 1.4s');
    expect(cards.get(started.messageId!)!).not.toContain('执行失败');
    expect(io.send).toHaveBeenCalledTimes(1);
    expect(io.patch).toHaveBeenCalledTimes(2);
  });

  it('does not recreate a user-withdrawn card', async () => {
    await store.update(key, { kind: 'start' }, io);
    io.patch = vi.fn().mockRejectedValue(new Error('withdrawn'));
    await expect(store.update(key, finalEvent(), io)).rejects.toThrow('withdrawn');
    await expect(store.update(key, finalEvent(), io)).rejects.toThrow('automatic recreation');
    expect(io.send).toHaveBeenCalledTimes(1);
  });

  it('rejects a destination change before publishing to another chat', async () => {
    await expect(store.prepare(key, { ...input, chatId: 'oc_other' })).rejects.toThrow('destination changed');
    expect(io.send).not.toHaveBeenCalled();
  });

  it('preserves all long untyped progress in an attachment when the turn ends', async () => {
    const text = '本轮已经完成的工作。'.repeat(1000);
    io.sendOverflow = vi.fn(async () => 'om_record');
    await store.update(key, { kind: 'progress', text }, io);
    await store.update(key, { kind: 'terminal', phase: 'completed' }, io);
    expect(io.sendOverflow).toHaveBeenCalledWith(text, expect.any(String));
    expect([...cards.values()][0]).toContain('Markdown 附件');
    expect(store.read(key)?.finalSource).toBeUndefined();
  });

  it('final-only accepts progress without a fabricated delivery or message ID', async () => {
    const finalOnly = { ...key, turnId: 'om_quiet' };
    await store.prepare(finalOnly, { ...input, mode: 'final-only' });
    const progress = await store.update(finalOnly, { kind: 'progress', text: '检查完文件' }, io);
    expect(progress.delivered).toBe(false);
    expect(progress.messageId).toBeUndefined();
    expect(io.send).not.toHaveBeenCalled();
    const final = await store.update(finalOnly, finalEvent(), io);
    expect(final.delivered).toBe(true);
    expect(cards.get(final.messageId!)!).toContain('检查完文件');
    expect(io.send).toHaveBeenCalledTimes(1);
  });

  it('handles terminal-before-final without adding a second message', async () => {
    await store.update(key, { kind: 'terminal', phase: 'completed', durationMs: 2000 }, io);
    await store.update(key, finalEvent(), io);
    expect(io.send).toHaveBeenCalledTimes(1);
    expect([...cards.values()][0]).toContain('完整答复');
    expect([...cards.values()][0]).toContain('2.0s');
  });

  it.each([false, true])('replaces a progress attachment with the actual late final (long=%s)', async long => {
    const progress = '公开进度'.repeat(1000);
    const answer = long ? '这是最终答复'.repeat(3000) : '这是实际最终答复';
    const attachments = new Map<string, string>();
    // Match Feishu's UUID deduplication: an existing UUID returns the old file.
    io.sendOverflow = vi.fn(async (text, uuid) => {
      if (!attachments.has(uuid)) attachments.set(uuid, text);
      return uuid;
    });
    const start = await store.update(key, { kind: 'progress', text: progress }, io);
    await store.update(key, { kind: 'terminal', phase: 'completed' }, io);
    const progressAttachment = store.read(key)!.overflowMessageId!;
    expect(attachments.get(progressAttachment)).toBe(progress);
    const restored = new TurnReplyCardStore(dir);
    await restored.update(key, finalEvent(answer), io);
    await restored.update(key, finalEvent(answer), io);
    const final = restored.read(key)!;
    expect(final.finalDelivered).toBe(true);
    expect(final.messageId).toBe(start.messageId);
    expect(io.send).toHaveBeenCalledTimes(1);
    const body = cards.get(start.messageId!)!;
    if (long) {
      expect(attachments.get(final.overflowMessageId!)).toBe(answer);
      expect(final.overflowMessageId).not.toBe(progressAttachment);
      expect(io.sendOverflow).toHaveBeenCalledTimes(2);
      expect(body).toContain('Markdown 附件');
    } else {
      expect(final.overflowMessageId).toBeUndefined();
      expect(body).toContain(answer);
      expect(body).not.toContain('Markdown 附件');
      expect(io.sendOverflow).toHaveBeenCalledTimes(1);
    }
    expect(turnReplyCardRequestBytes(body, input.chatId)).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
  });

  it('reuses the attachment UUID after an uncertain send and renews it for a corrected undelivered final', async () => {
    const firstAnswer = '第一次长答复'.repeat(3000);
    const correctedAnswer = '修正后的长答复'.repeat(3000);
    const attachments = new Map<string, string>();
    const start = await store.update(key, { kind: 'start' }, io);
    let uncertain = true;
    io.sendOverflow = vi.fn(async (text, uuid) => {
      if (!attachments.has(uuid)) attachments.set(uuid, text);
      if (uncertain) { uncertain = false; throw new Error('uncertain file response'); }
      return uuid;
    });
    await expect(store.update(key, finalEvent(firstAnswer), io)).rejects.toThrow('uncertain file response');
    const restored = new TurnReplyCardStore(dir);
    vi.mocked(io.patch).mockRejectedValueOnce(new Error('temporary PATCH failure'));
    await expect(restored.update(key, finalEvent(firstAnswer), io)).rejects.toThrow('temporary PATCH failure');
    const calls = vi.mocked(io.sendOverflow).mock.calls;
    expect(calls[0]).toEqual(calls[1]);
    expect(attachments.size).toBe(1);
    expect(restored.read(key)!.finalDelivered).not.toBe(true);
    await restored.update(key, finalEvent(correctedAnswer), io);
    const final = restored.read(key)!;
    expect(attachments.size).toBe(2);
    expect(attachments.get(final.overflowMessageId!)).toBe(correctedAnswer);
    expect(final.finalDelivered).toBe(true);
    expect(final.messageId).toBe(start.messageId);
    expect(io.send).toHaveBeenCalledTimes(1);
  });

  it('acknowledges bridge fallback without replacing an explicit final', async () => {
    await store.update(key, finalEvent('用户已经收到的最终答复'), io);
    await store.update(key, finalEvent('更长的终端叙述'.repeat(100), 'bridge'), io);
    expect([...cards.values()][0]).toContain('用户已经收到的最终答复');
    expect([...cards.values()][0]).not.toContain('更长的终端叙述');
    expect(io.send).toHaveBeenCalledTimes(1);
  });

  it('retains the first mode and isolates app, session, turn and attempt', async () => {
    expect((await store.prepare(key, { ...input, mode: 'final-only' })).mode).toBe('unified');
    for (const alternate of [{ ...key, larkAppId: 'app_other' }, { ...key, sessionId: 'other' }, { ...key, dispatchAttempt: 1 }]) {
      expect(store.read(alternate)).toBeUndefined();
      await store.prepare(alternate, input);
      await store.update(alternate, finalEvent(), io);
    }
    expect(cards.size).toBe(3);
  });

  it('exports a large CJK answer in full and sends a bounded summary card once', async () => {
    const text = '这是完整的回答内容。'.repeat(6000);
    await store.update(key, { kind: 'tools', tools: [{ id: 't', name: 'Read', subject: 'large.txt', result: '长输出'.repeat(20_000) }] }, io);
    io.sendOverflow = vi.fn(async () => 'om_full_answer');
    await store.update(key, finalEvent(text), io);
    await store.update(key, finalEvent(text), io);
    expect(io.sendOverflow).toHaveBeenCalledTimes(1);
    expect(io.sendOverflow).toHaveBeenCalledWith(text, expect.any(String));
    const card = [...cards.values()][0];
    expect(turnReplyCardRequestBytes(card, input.chatId)).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
    expect(card).toContain('完整答复较长');
    expect(card).toContain('已截断');
    expect(store.read(key)?.finalText).toBe(text);
  });

  it('checks current authority again before a provider effect', async () => {
    io.beforeEffect = vi.fn().mockImplementation(() => { throw new Error('stale worker'); });
    await expect(store.update(key, finalEvent(), io)).rejects.toThrow('stale worker');
    expect(io.send).not.toHaveBeenCalled();
    expect(io.patch).not.toHaveBeenCalled();
  });
});

describe('public process and fallback compatibility', () => {
  function processRecord(toolCount: number, textCount: number): TurnReplyCardRecord {
    const tools = Array.from({ length: toolCount }, (_, i) => ({ id: `t${i}`, name: `TOOL_${i}`, subject: '', completed: true }));
    const progress = Array.from({ length: textCount }, (_, i) => `PROGRESS_${i}`);
    return {
      ...key, ...input, version: 1, phase: 'completed', createdAtMs: 0, tools, progress,
      activity: [
        ...tools.map(tool => ({ kind: 'tool' as const, id: tool.id })),
        ...progress.map((text, i) => ({ kind: 'progress' as const, id: `p${i}`, text })),
      ],
      finalCard: buildCanonicalFinalReplyCard({ markdown: '完整答复' }),
    };
  }

  function processPanel(record: TurnReplyCardRecord, options = presentation) {
    const card = JSON.parse(buildTurnReplyCard(record, options));
    return card.body.elements.find((element: any) => element.tag === 'collapsible_panel');
  }

  it('keeps the latest nonempty narration outside the collapsed panel after subsequent tool events', () => {
    const record = processRecord(2, 0);
    record.phase = 'working';
    delete record.finalCard;
    record.activity = [
      { kind: 'thinking', id: 'a', text: 'NARRATION_A' }, { kind: 'tool', id: 't0' },
      { kind: 'thinking', id: 'b', text: 'NARRATION_B' }, { kind: 'tool', id: 't1' },
      { kind: 'thinking', id: 'empty', text: '  \n' },
    ];
    const original = structuredClone(record);
    const card = JSON.parse(buildTurnReplyCard(record, presentation));
    const live: string[] = card.body.elements.filter((element: any) => element.tag === 'markdown').map((element: any) => element.content);
    expect(live).toContain('💭 NARRATION_B');
    expect(live.join('\n')).not.toContain('NARRATION_A');
    expect(live.join('\n')).toContain('**TOOL_1**');
    const panel = card.body.elements.find((element: any) => element.tag === 'collapsible_panel');
    expect(panel.expanded).toBe(false);
    expect(panel.elements[0].content).toContain('NARRATION_A');
    expect(panel.elements[0].content).toContain('NARRATION_B');
    expect(record).toEqual(original);
  });

  it.each(['hidden', 'pending-ask', 'final', 'completed', 'failed', 'cancelled'] as const)(
    'does not retain live narration in the %s view', view => {
      const record = processRecord(1, 0);
      record.phase = 'working';
      if (view !== 'final') delete record.finalCard;
      record.activity = [{ kind: 'thinking', id: 'a', text: 'NARRATION_A' }, { kind: 'tool', id: 't0' }];
      if (view === 'completed' || view === 'failed' || view === 'cancelled') record.phase = view;
      if (view === 'pending-ask') record.asks = [{ ask: {
        askId: 'a1', nonce: 'nonce', larkAppId: key.larkAppId, chatId: input.chatId,
        rootMessageId: input.rootId, sessionId: key.sessionId, createdAt: 0, deadlineAt: 10_000, settled: false,
        questions: [{ prompt: '继续吗？', multiSelect: false, options: [{ key: 'yes', label: '继续' }, { key: 'no', label: '停止' }] }],
      } }];
      const card = JSON.parse(buildTurnReplyCard(record, { ...presentation, showProcess: view !== 'hidden' }));
      const live = card.body.elements.filter((element: any) => element.tag === 'markdown').map((element: any) => element.content).join('\n');
      expect(live).not.toContain('NARRATION_A');
      if (view === 'pending-ask') expect(live).toContain('继续吗');
      if (view === 'final') expect(live).toContain('完整答复');
      if (view === 'hidden') expect(JSON.stringify(card)).not.toContain('NARRATION_A');
      else expect(JSON.stringify(card)).toContain('NARRATION_A');
    },
  );

  it.each([[5, 30], [15, 15], [100, 5], [0, 100]])(
    'shows all %i tools and %i progress entries when the whole card fits', (tools, texts) => {
      const record = processRecord(tools, texts);
      const original = structuredClone(record);
      const panel = processPanel(record);
      const history: string = panel.elements[0].content;
      expect(history.match(/\*\*TOOL_\d+\*\*/g) ?? []).toHaveLength(tools);
      expect(history.match(/PROGRESS_\d+/g) ?? []).toHaveLength(texts);
      expect(history.match(/\*\*TOOL_\d+\*\*|PROGRESS_\d+/g)).toEqual([
        ...record.tools.map(tool => `**${tool.name}**`), ...record.progress,
      ]);
      expect(history).not.toContain('已截断');
      expect(panel.header.title.content).toBe(tools ? `📋 执行过程（${tools} 次工具调用）` : '📋 执行过程');
      expect(record).toEqual(original);
    },
  );

  it('preserves process content beyond 7000 bytes, including long individual entries, when the card fits', () => {
    const record = processRecord(1, 2);
    const narration = '旁白内容'.repeat(400);
    record.tools[0].subject = 'tool subject '.repeat(100);
    record.tools[0].result = 'tool output '.repeat(400);
    record.activity = [
      { kind: 'thinking', id: 'n', text: narration }, { kind: 'tool', id: 't0' },
      ...record.progress.map((text, i) => ({ kind: 'progress' as const, id: `p${i}`, text: text + '进度内容'.repeat(100) })),
    ];
    const card = buildTurnReplyCard(record, presentation);
    const history: string = processPanel(record).elements[0].content;
    expect(Buffer.byteLength(history)).toBeGreaterThan(7000);
    expect(history).toContain(narration);
    expect(history).toContain(record.tools[0].subject);
    expect(history).toContain(record.tools[0].result);
    expect(history).not.toContain('已截断');
    expect(turnReplyCardRequestBytes(card, record.chatId)).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
  });

  it.each(['progress', 'thinking'] as const)('truncates overflowing %s while retaining a late tool and the final answer', kind => {
    const record = processRecord(1, 80);
    record.activity = [
      ...record.progress.map((text, i) => ({ kind, id: `p${i}`, text: `${text} ${'中文<>&🧠\\"'.repeat(200)}` })),
      { kind: 'tool', id: 't0' },
    ];
    const original = structuredClone(record);
    const card = buildTurnReplyCard(record, presentation);
    const history: string = processPanel(record).elements[0].content;
    expect(history).toContain('**TOOL_0**');
    expect(history).toContain('PROGRESS_79');
    expect(history).not.toContain('PROGRESS_0');
    expect(history.indexOf('PROGRESS_79')).toBeLessThan(history.indexOf('**TOOL_0**'));
    expect(history).toContain('已截断');
    expect(history).not.toContain('\uFFFD');
    expect(history).not.toContain('<');
    expect(card).toContain('完整答复');
    expect(turnReplyCardRequestBytes(card, record.chatId)).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
    expect(record).toEqual(original);
  });

  it('shares available card space across tools and text, with honest counts and original order', () => {
    const record = processRecord(80, 80);
    record.tools.forEach(tool => { tool.result = '输出'.repeat(300); });
    record.activity = record.tools.flatMap((tool, i) => [
      { kind: 'progress', id: `p${i}`, text: `${record.progress[i]} ${'进度'.repeat(300)}` },
      { kind: 'tool', id: tool.id },
    ]);
    const panel = processPanel(record);
    const history: string = panel.elements[0].content;
    const shownTools = (history.match(/\*\*TOOL_\d+\*\*/g) ?? []).length;
    expect(shownTools).toBeGreaterThan(0);
    expect(shownTools).toBeLessThan(80);
    expect(history).toContain('PROGRESS_79');
    expect(history).toContain('**TOOL_79**');
    const numbers = [...history.matchAll(/PROGRESS_(\d+)|\*\*TOOL_(\d+)\*\*/g)].map(match => Number(match[1] ?? match[2]));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(panel.header.title.content).toBe(`📋 执行过程（已展示 ${shownTools} / 80 次工具调用）`);
    expect(turnReplyCardRequestBytes(buildTurnReplyCard(record, presentation), record.chatId)).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
  });

  it('borrows unused narration space for tools when the whole card overflows', () => {
    const record = processRecord(100, 0);
    const output = 'x'.repeat(800);
    record.tools.forEach(tool => { tool.result = output; });
    const narration = ['NARRATION_A', 'NARRATION_B', 'NARRATION_C'];
    record.activity!.push(...narration.map(text => ({ kind: 'thinking' as const, id: text, text })));
    const card = buildTurnReplyCard(record, presentation);
    const panel = JSON.parse(card).body.elements.find((element: any) => element.tag === 'collapsible_panel');
    const history: string = panel.elements[0].content;
    const shownTools = (history.match(/\*\*TOOL_\d+\*\*/g) ?? []).length;
    // Even without labels or card overhead, half the entire request cannot
    // hold more than this many outputs. Showing more requires budget lending.
    const halfCardToolLimit = Math.floor(TURN_REPLY_CARD_MAX_BYTES / 2 / Buffer.byteLength(output));
    expect(shownTools).toBeGreaterThan(halfCardToolLimit);
    expect(history.split(output).length - 1).toBe(shownTools);
    expect(history).toContain('**TOOL_99**');
    for (const text of narration) expect(history).toContain(text);
    expect(history).toContain('已截断');
    expect(panel.header.title.content).toBe(`📋 执行过程（已展示 ${shownTools} / 100 次工具调用）`);
    expect(turnReplyCardRequestBytes(card, record.chatId)).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
  });

  it.each(['```', '~~~~'])( 'closes a truncated %s code fence before later tools and the notice', fence => {
    const record = processRecord(1, 0);
    record.activity = [
      { kind: 'thinking', id: 'code', text: `运行示例\n${fence}text\n${'代码行\n'.repeat(10_000)}${fence}` },
      { kind: 'tool', id: 't0' },
    ];
    const history = processPanel(record).elements[0].content;
    const tokens = new MarkdownIt().parse(history, {});
    const code = tokens.find(token => token.type === 'fence');
    expect(code).toBeDefined();
    expect(code!.content).not.toContain('TOOL_0');
    expect(code!.content).not.toContain('已截断');
    const outsideCode = tokens.filter(token => token.type === 'inline').map(token => token.content).join('\n');
    expect(outsideCode).toContain('**TOOL_0**');
    expect(outsideCode).toContain('已截断');
    expect(turnReplyCardRequestBytes(buildTurnReplyCard(record, presentation), record.chatId)).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
  });

  it.each(['```', '~~~~'])('contains a code fence cut by upstream tool-result extraction (%s)', fence => {
    const record = processRecord(0, 0);
    const entries: CotEntry[] = [
      { kind: 'tool_call', id: 'read', name: 'Read', args: '{}', subject: 'example.md' },
      ...extractCotEntries({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read',
        content: `文件片段\n${fence}ts\n${'const example = 1;\n'.repeat(200)}${fence}`,
      }] } }),
      { kind: 'tool_call', id: 'next', name: 'NEXT_TOOL', args: '{}' },
    ];
    record.tools = publicReplyCardTools(entries, true);
    record.activity = publicReplyCardActivity(entries);
    const original = structuredClone(record);
    const history = processPanel(record).elements[0].content;
    const tokens = new MarkdownIt().parse(history, {});
    expect(tokens.find(token => token.type === 'fence')!.content).not.toContain('NEXT_TOOL');
    const outsideCode = tokens.filter(token => token.type === 'inline').map(token => token.content).join('\n');
    expect(outsideCode).toContain('**NEXT_TOOL**');
    expect(history).not.toContain('已截断'); // Whole card fits; upstream supplied the partial block.
    expect(record).toEqual(original);
  });

  it.each(['```echo hello```', '````code with ``` inside````'])(
    'keeps inline code %s from opening a block around later tools', inline => {
      const record = processRecord(2, 0);
      record.tools[0].result = inline;
      const history = processPanel(record).elements[0].content;
      const tokens = new MarkdownIt().parse(history, {});
      expect(tokens.some(token => token.type === 'fence')).toBe(false);
      expect(tokens.filter(token => token.type === 'inline').map(token => token.content).join('\n')).toContain('**TOOL_1**');
      expect(history).toContain(inline);
    },
  );

  it('gives a long final answer priority and keeps hidden-process semantics under truncation', () => {
    const record = processRecord(5, 80);
    record.activity = record.activity!.map(item => item.kind === 'progress' ? { ...item, text: item.text + 'x'.repeat(500) } : item);
    const count = () => (processPanel(record).elements[0].content.match(/PROGRESS_\d+/g) ?? []).length;
    const before = count();
    const finalText = '完整答复'.repeat(1400);
    record.finalCard = buildCanonicalFinalReplyCard({ markdown: finalText });
    const card = buildTurnReplyCard(record, presentation);
    expect(count()).toBeLessThan(before);
    expect(card).toContain(finalText);
    expect(turnReplyCardRequestBytes(card, record.chatId)).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
    const hidden = processPanel(record, { ...presentation, showProcess: false });
    expect(hidden.header.title.content).toBe('📋 本轮记录');
    expect(hidden.elements[0].content).toContain('已截断');
    expect(JSON.stringify(hidden)).not.toMatch(/TOOL_|次工具调用/);
    const english = JSON.parse(buildTurnReplyCard(record, { ...presentation, locale: 'en' }));
    expect(english.body.elements.find((element: any) => element.tag === 'collapsible_panel').elements[0].content).toContain('truncated');
  });

  it('counts stamped callbacks and both JSON serialization layers in its size estimate', () => {
    const raw = JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'button',
      text: { tag: 'plain_text', content: '中文\n"\\'.repeat(100) },
      behaviors: [{ type: 'callback', value: { action: 'stop_turn' } }],
    }] } });
    const content = stampBotmuxCallbackMarkers(raw);
    const create = { msg_type: 'interactive', content, receive_id: input.chatId, uuid: 'brc_' + 'a'.repeat(32) };
    const reply = { msg_type: 'interactive', content, reply_in_thread: true, uuid: create.uuid };
    expect(content).toContain('__bm_cb');
    expect(turnReplyCardRequestBytes(raw, input.chatId)).toBe(Math.max(
      Buffer.byteLength(JSON.stringify(create)), Buffer.byteLength(JSON.stringify(reply)),
    ));
    expect(turnReplyCardRequestBytes(raw, input.chatId)).toBeGreaterThan(Buffer.byteLength(raw));
  });

  it('keeps responsive width and distinguishes tool types inside a shaded, collapsed activity panel', () => {
    const toolOutput = 'file contents\n\n```ts\nconst value = 1;\n\nconsole.log(value);\n```';
    const card = JSON.parse(buildTurnReplyCard({
      ...key, ...input, version: 1, phase: 'working', createdAtMs: 0, progress: [],
      tools: [
        { id: 'read', name: 'Read', subject: 'README.md', completed: true, result: toolOutput },
        { id: 'search', name: 'mcp__web__search', subject: 'card schema', completed: true },
        { id: 'bash', name: 'Bash', subject: 'bun run build', completed: true },
        { id: 'exec', name: 'exec_command', subject: 'bun run test' },
        { id: 'other', name: 'custom_tool', subject: 'custom input' },
      ],
    }, presentation));
    expect(card.config.width_mode).toBe('fill');
    expect(card.body.elements[0].content).toBe('💭 **处理中**');
    const panel = card.body.elements.find((element: any) => element.tag === 'collapsible_panel');
    expect(panel).toMatchObject({ expanded: false, background_color: 'grey-50', border: { corner_radius: '8px' } });
    expect(panel.header).toMatchObject({
      title: { content: '📋 执行过程（5 次工具调用）' },
      background_color: 'grey-50', icon_position: 'right', icon_expanded_angle: -180,
    });
    const history = panel.elements[0].content;
    expect(history).toContain('📖 **Read** ✓');
    expect(history).toContain('🔍 **mcp__web__search** ✓');
    expect(history).toContain('💻 **Bash** ✓');
    expect(history).toContain('💻 **exec_command** · bun run test');
    expect(history).toContain('🔧 **custom_tool**');
    expect(history).toContain(`README.md\n${toolOutput}\n🔍`);
    expect(history).toContain('card schema\n💻');
    expect(history).toContain('bun run build\n💻');
    expect(history).toContain('bun run test\n🔧');
  });

  it('keeps the canonical final card and public progress while hiding tools and their counts', () => {
    const finalCard = buildCanonicalFinalReplyCard({ markdown: '完整答复' });
    const canonical = JSON.parse(finalCard);
    const card = JSON.parse(buildTurnReplyCard({
      ...key, ...input, version: 1, phase: 'completed', createdAtMs: 0, durationMs: 1200,
      progress: ['检查完成'], finalCard,
      tools: [{ id: 't', name: 'Read', subject: 'secret.txt', result: 'hidden output' }],
    }, { ...presentation, showProcess: false }));
    expect(card.config).toEqual(canonical.config);
    expect(card.header).toEqual(canonical.header);
    for (const element of canonical.body.elements) expect(card.body.elements).toContainEqual(element);
    expect(card.body.elements[0].content).toBe('✅ **已完成 · 1.2s**');
    const panel = card.body.elements.find((element: any) => element.tag === 'collapsible_panel');
    expect(panel.header.title.content).toBe('📋 本轮记录');
    expect(panel.elements[0].content).toBe('💬 检查完成');
    expect(JSON.stringify(card)).not.toMatch(/secret.txt|hidden output|次工具调用|stop_turn/);
  });

  it('shows a distinct failure state and localized activity header without exposing hidden outputs', () => {
    const body = buildTurnReplyCard({
      ...key, ...input, version: 1, phase: 'failed', createdAtMs: 0, durationMs: 1400, progress: [],
      tools: [{ id: 't', name: 'apply_patch', subject: 'src/index.ts', result: 'hidden output' }],
    }, { ...presentation, locale: 'en', showToolResults: false });
    expect(JSON.parse(body).body.elements[0].content).toBe('❌ **Failed · 1.4s**');
    expect(body).toContain('📋 Activity (1 tool call)');
    expect(body).toContain('✏️ **apply_patch**');
    expect(body).not.toContain('hidden output');
    expect(body).not.toContain('stop_turn');
  });

  it('omits raw thinking, permits results to be hidden and neutralizes tool mentions', () => {
    const tools = publicReplyCardTools([
      { kind: 'thinking', text: 'private reasoning' },
      { kind: 'tool_call', id: 't', name: 'Read', args: '{}', subject: '<at id=ou_test></at>' },
      { kind: 'tool_result', id: 't', result: 'sensitive tool output' },
    ], false);
    expect(tools).toHaveLength(1);
    expect(tools[0].result).toBeUndefined();
    const card = buildTurnReplyCard({ ...key, ...input, version: 1, phase: 'working', createdAtMs: 0, progress: [], tools }, presentation);
    expect(card).not.toContain('private reasoning');
    expect(card).not.toContain('<at');
    expect(card).not.toContain('sensitive tool output');
  });

  it('a managed progress marker cannot suppress the final; legacy sends retain their behavior', () => {
    const turn = { markTimeMs: 100, isLocal: false, finalText: '答案' };
    const marker = { sentAtMs: 200, contentLength: 5000 };
    expect(shouldSuppressBridgeEmit(turn, undefined, [{ ...marker, replyCardResponseKind: 'progress' }], false)).toBe(false);
    expect(shouldSuppressBridgeEmit(turn, undefined, [{ ...marker, replyCardResponseKind: 'final' }], false)).toBe(true);
    expect(shouldSuppressBridgeEmit(turn, undefined, [marker], false)).toBe(true);
  });
});
