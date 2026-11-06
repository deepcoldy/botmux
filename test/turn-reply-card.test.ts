import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import { TurnReplyCardStore, type TurnReplyCardRecord, type TurnReplyCardTransport } from '../src/services/turn-reply-card.js';
import { buildTurnReplyCard, publicReplyCardActivity, publicReplyCardTools, replyCardPresentation } from '../src/im/lark/turn-reply-card.js';
import { parseBotConfigsFromText } from '../src/bot-registry.js';
import { TURN_REPLY_CARD_MAX_BYTES, turnReplyCardRequestBytes } from '../src/im/lark/turn-reply-card-size.js';
import { stampBotmuxCallbackMarkers } from '../src/im/lark/callback-button-marker.js';
import type { CotEntry } from '../src/types.js';
import { buildCanonicalFinalReplyCard } from '../src/im/lark/md-card.js';
import { cardMarkdownImageReferences, FEISHU_IMG_KEY } from '../src/im/lark/card-markdown-image-references.js';
import { shouldSuppressBridgeEmit } from '../src/services/bridge-fallback-gate.js';
import { extractCardContent } from '../src/im/lark/message-parser.js';
import { extractCotEntries } from '../src/services/claude-transcript.js';

const key = { larkAppId: 'app_test', sessionId: 'session', turnId: 'om_turn' };
const input = { mode: 'unified' as const, chatId: 'oc_chat', rootId: 'om_root' };
const presentation = { showProcess: true, showToolResults: true, canStop: true };
const finalEvent = (text = '完整答复', source: 'explicit' | 'bridge' = 'explicit') => ({
  kind: 'final' as const, text, card: buildCanonicalFinalReplyCard({ markdown: text }), source,
});

it('reads the unified card tool visibility from bot config, defaulting to visible', () => {
  const configs = parseBotConfigsFromText(JSON.stringify([
    { larkAppId: 'app_hidden', larkAppSecret: 'secret', replyCardShowTools: false },
    { larkAppId: 'app_default', larkAppSecret: 'secret' },
  ]));
  expect(replyCardPresentation(configs[0], 'oc_any').showTools).toBe(false);
  expect(replyCardPresentation(configs[1], 'oc_any').showTools).toBe(true);
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

  it.each(['completed', 'failed', 'cancelled', 'ambiguous', 'superseded'] as const)(
    'replays an unacknowledged %s PATCH without changing terminal facts or creating a card', async phase => {
      await store.update(key, { kind: 'start' }, io);
      vi.mocked(io.patch).mockRejectedValueOnce(new Error('PATCH unavailable'));
      await expect(store.update(key, { kind: 'terminal', phase, durationMs: 1234, completedAtMs: 5678 }, io))
        .rejects.toThrow('PATCH unavailable');
      const before = store.read(key)!;
      expect(before.pendingPatch).toMatchObject({ final: false });
      expect(before.pendingPatch?.content).not.toBe(before.lastCard);
      await new TurnReplyCardStore(dir).update(key, { kind: 'recover' }, io);
      const after = store.read(key)!;
      expect(after).toMatchObject({ phase, durationMs: 1234, completedAtMs: 5678,
        messageId: before.messageId, lastCard: before.pendingPatch!.content });
      expect(after.pendingPatch).toBeUndefined();
      expect(io.send).toHaveBeenCalledTimes(1);
      expect(cards.get(after.messageId!)).toBe(before.pendingPatch!.content);
      const patches = vi.mocked(io.patch).mock.calls.length;
      await store.update(key, { kind: 'recover' }, io);
      expect(io.patch).toHaveBeenCalledTimes(patches);
    },
  );

  it('replays the same PATCH after its remote acceptance was not acknowledged', async () => {
    await store.update(key, { kind: 'start' }, io);
    const patch = io.patch;
    io.patch = vi.fn(async (id, content) => { await patch(id, content); throw new Error('ACK lost'); });
    await expect(store.update(key, { kind: 'terminal', phase: 'cancelled' }, io)).rejects.toThrow('ACK lost');
    const pending = store.read(key)!.pendingPatch!;
    io.patch = vi.fn(patch);
    vi.mocked(io.patch).mockClear();
    await new TurnReplyCardStore(dir).update(key, { kind: 'recover' }, io);
    expect(io.patch).toHaveBeenCalledExactlyOnceWith(store.read(key)!.messageId, pending.content);
    expect(cards.size).toBe(1);
  });

  it('recovers an undelivered final and its existing overflow attachment without uploading again', async () => {
    await store.update(key, { kind: 'start' }, io);
    io.sendOverflow = vi.fn(async () => 'om_file');
    vi.mocked(io.patch).mockRejectedValue(new Error('PATCH unavailable'));
    await expect(store.update(key, finalEvent('Long answer '.repeat(8000)), io)).rejects.toThrow('PATCH unavailable');
    await expect(store.update(key, { kind: 'terminal', phase: 'completed' }, io)).rejects.toThrow('PATCH unavailable');
    expect(store.read(key)).toMatchObject({ phase: 'completed', overflowMessageId: 'om_file', pendingPatch: { final: true } });
    expect(store.read(key)?.finalDelivered).not.toBe(true);
    vi.mocked(io.patch).mockImplementation(async (id, content) => { cards.set(id, content); });
    await new TurnReplyCardStore(dir).update(key, { kind: 'recover' }, io);
    expect(store.read(key)).toMatchObject({ phase: 'completed', finalDelivered: true, overflowMessageId: 'om_file' });
    expect(store.read(key)?.pendingPatch).toBeUndefined();
    expect(io.sendOverflow).toHaveBeenCalledTimes(1);
    expect(io.send).toHaveBeenCalledTimes(1);
  });

  it('retains a failed recovery for another attempt and never recreates a withdrawn card', async () => {
    await store.update(key, { kind: 'start' }, io);
    vi.mocked(io.patch).mockRejectedValue(new Error('PATCH unavailable'));
    await expect(store.update(key, { kind: 'terminal', phase: 'cancelled' }, io)).rejects.toThrow();
    await expect(store.update(key, { kind: 'recover' }, io)).rejects.toThrow('PATCH unavailable');
    expect(store.read(key)?.pendingPatch).toBeDefined();
    vi.mocked(io.patch).mockRejectedValue(new Error('withdrawn'));
    await expect(store.update(key, { kind: 'recover' }, io)).rejects.toThrow('withdrawn');
    expect(store.read(key)?.withdrawn).toBe(true);
    vi.mocked(io.patch).mockClear();
    await store.update(key, { kind: 'recover' }, io);
    expect(io.patch).not.toHaveBeenCalled();
    expect(io.send).toHaveBeenCalledTimes(1);
  });

  it('persists image fallback during recovery before an unknown PATCH result', async () => {
    await store.update(key, { kind: 'start' }, io);
    vi.mocked(io.patch).mockRejectedValue(new Error('PATCH unavailable'));
    await expect(store.update(key, finalEvent('Answer. ![Preview](img_v3_rejected)'), io)).rejects.toThrow();
    await expect(store.update(key, { kind: 'terminal', phase: 'completed' }, io)).rejects.toThrow();
    vi.mocked(io.patch).mockImplementation(async (id, content) => {
      if (content.includes('![Preview]')) throw new Error('ErrCode: 200570; card contains invalid image keys (code: 230099)');
      cards.set(id, content);
      throw new Error('ACK lost');
    });
    await expect(store.update(key, { kind: 'recover' }, io)).rejects.toThrow('ACK lost');
    const pending = store.read(key)!.pendingPatch!;
    expect(pending.content).toContain('[Image omitted]');
    expect(pending.content).not.toContain('![Preview]');
    vi.mocked(io.patch).mockImplementation(async (id, content) => { cards.set(id, content); });
    await store.update(key, { kind: 'recover' }, io);
    expect(store.read(key)).toMatchObject({ phase: 'completed', omitImages: true, finalDelivered: true, lastCard: pending.content });
    expect(cards.size).toBe(1);
  });

  it('does not replay an obsolete payload when a newer revision fails before rendering', async () => {
    await store.update(key, { kind: 'start' }, io);
    vi.mocked(io.patch).mockRejectedValueOnce(new Error('PATCH unavailable'));
    await expect(store.update(key, { kind: 'progress', text: 'Old progress' }, io)).rejects.toThrow();
    const render = io.render;
    io.render = () => { throw new Error('render failed'); };
    await expect(store.update(key, { kind: 'terminal', phase: 'cancelled' }, io)).rejects.toThrow('render failed');
    io.render = render;
    vi.mocked(io.patch).mockClear();
    await store.update(key, { kind: 'recover' }, io);
    expect(io.patch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(io.patch).mock.calls[0][1]).toContain('已停止');
    expect(store.read(key)).toMatchObject({ phase: 'cancelled' });
    expect(store.read(key)?.pendingPatch).toBeUndefined();
  });

  it('keeps an undelivered final hidden when recovering a legacy ambiguous record', async () => {
    await store.update(key, { kind: 'start' }, io);
    vi.mocked(io.patch).mockRejectedValue(new Error('PATCH unavailable'));
    await expect(store.update(key, finalEvent('LEGACY-UNDELIVERED-ANSWER'), io)).rejects.toThrow();
    await expect(store.update(key, { kind: 'terminal', phase: 'ambiguous' }, io)).rejects.toThrow();
    const legacy = store.read(key)!;
    delete legacy.pendingPatch;
    delete legacy.publishPending;
    writeFileSync(join(store.directory, `${store.id(key)}.json`), JSON.stringify(legacy));
    vi.mocked(io.patch).mockImplementation(async (id, content) => { cards.set(id, content); });
    await store.update(key, { kind: 'recover' }, io);
    expect(store.read(key)?.phase).toBe('ambiguous');
    expect(store.read(key)?.finalDelivered).not.toBe(true);
    expect(cards.get(legacy.messageId!)).not.toContain('LEGACY-UNDELIVERED-ANSWER');
  });

  it.each(['render', 'journal'] as const)('preserves legacy final visibility after a recovery %s failure', async failure => {
    await store.update(key, { kind: 'start' }, io);
    vi.mocked(io.patch).mockRejectedValue(new Error('PATCH unavailable'));
    await expect(store.update(key, finalEvent('LEGACY-UNDELIVERED-ANSWER'), io)).rejects.toThrow();
    await expect(store.update(key, { kind: 'terminal', phase: 'ambiguous' }, io)).rejects.toThrow();
    const legacy = store.read(key)!;
    delete legacy.pendingPatch;
    delete legacy.publishPending;
    writeFileSync(join(store.directory, `${store.id(key)}.json`), JSON.stringify(legacy));
    const render = io.render;
    const write = (store as any).write.bind(store);
    let restore: () => void;
    if (failure === 'render') {
      io.render = () => { throw new Error('recovery interrupted'); };
      restore = () => { io.render = render; };
    } else {
      const fault = vi.spyOn(store as any, 'write').mockImplementation((k: any, record: any) => {
        if (record.pendingPatch) throw new Error('recovery interrupted');
        return write(k, record);
      });
      restore = () => fault.mockRestore();
    }
    await expect(store.update(key, { kind: 'recover' }, io)).rejects.toThrow('recovery interrupted');
    expect(store.read(key)).toMatchObject({ publishPending: true, recoveryHideFinal: true });
    restore();
    vi.mocked(io.patch).mockImplementation(async (id, content) => { cards.set(id, content); });
    await new TurnReplyCardStore(dir).update(key, { kind: 'recover' }, io);
    expect(store.read(key)?.finalDelivered).not.toBe(true);
    expect(cards.get(legacy.messageId!)).not.toContain('LEGACY-UNDELIVERED-ANSWER');
    expect(store.read(key)?.publishPending).toBeUndefined();
    expect(store.read(key)?.recoveryHideFinal).toBeUndefined();
  });

  it('replaying the ambiguous settle card never marks an unseen final as delivered', async () => {
    await store.update(key, { kind: 'start' }, io);
    vi.mocked(io.patch).mockRejectedValue(new Error('PATCH unavailable'));
    // A non-terminal turn whose final PATCH was never acknowledged; the process
    // dies before the terminal event, so startup recovery settles the still-
    // working card as ambiguous and hides the unproven final.
    await expect(store.update(key, finalEvent('UNSEEN-ANSWER-PROBE'), io)).rejects.toThrow();
    expect(store.read(key)?.phase).toBe('working');
    await expect(store.update(key, { kind: 'recover' }, io)).rejects.toThrow();
    expect(store.read(key)).toMatchObject({ phase: 'ambiguous', pendingPatch: { final: false } });
    vi.mocked(io.patch).mockImplementation(async (id, content) => { cards.set(id, content); });
    await new TurnReplyCardStore(dir).update(key, { kind: 'recover' }, io);
    expect(store.read(key)?.finalDelivered).not.toBe(true);
    expect(cards.get(store.read(key)!.messageId!)).not.toContain('UNSEEN-ANSWER-PROBE');
  });

  it('settles a superseded turn after its in-flight initial POST is acknowledged', async () => {
    let acknowledge!: () => void;
    const send = io.send;
    io.send = vi.fn(async (content, uuid) => {
      await new Promise<void>(resolve => { acknowledge = resolve; });
      return send(content, uuid);
    });
    const start = store.update(key, { kind: 'start' }, io);
    await vi.waitFor(() => expect(io.send).toHaveBeenCalledTimes(1));
    const supersede = store.update(key, { kind: 'terminal', phase: 'superseded' }, io);
    acknowledge();
    await start;
    const retired = await supersede;
    expect(retired.record.phase).toBe('superseded');
    expect(cards.size).toBe(1);
    expect(io.send).toHaveBeenCalledTimes(1);
    expect(cards.get(retired.messageId!)).toContain('已由后续消息接续');
  });

  it('replays an unknown initial POST with its original UUID before marking it superseded', async () => {
    const send = io.send;
    io.send = vi.fn(async (content, uuid) => {
      await send(content, uuid);
      throw new Error('connection lost after acceptance');
    });
    await expect(store.update(key, { kind: 'start' }, io)).rejects.toThrow('connection lost');
    const original = vi.mocked(io.send).mock.calls[0];
    io.send = vi.fn(send);
    const retired = await new TurnReplyCardStore(dir).update(key, { kind: 'terminal', phase: 'superseded' }, io);
    expect(vi.mocked(io.send).mock.calls[0]).toEqual(original);
    expect(cards.size).toBe(1);
    expect(retired.record.pendingCreate).toBeUndefined();
    expect(cards.get(retired.messageId!)).toContain('已由后续消息接续');
  });

  it.each([false, true])('persists an image-free final after provider rejection with an existing card=%s', async existing => {
    if (existing) await store.update(key, { kind: 'start' }, io);
    const send = io.send;
    const patch = io.patch;
    const rejectImages = (content: string) => {
      if (content.includes('![Preview]')) {
        throw new Error('ErrCode: 200570; card contains invalid image keys (code: 230099)');
      }
    };
    io.send = vi.fn(async (content, uuid) => { rejectImages(content); return send(content, uuid); });
    io.patch = vi.fn(async (id, content) => { rejectImages(content); return patch(id, content); });
    const final = await store.update(key, finalEvent('Answer. ![Preview](img_v3_rejected)', 'bridge'), io);
    expect(final.delivered).toBe(true);
    expect(final.card).toContain('Answer.');
    expect(final.card).toContain('[Image omitted]');
    expect(final.record.finalCard).not.toContain('![Preview]');
    expect(final.record.lastCard).toBe(final.card);
    expect(cards.size).toBe(1);
    if (!existing) {
      expect(vi.mocked(io.send).mock.calls.map(call => call[1])).toEqual([final.messageId, final.messageId]);
      expect(io.patch).not.toHaveBeenCalled();
    }
    const recovered = new TurnReplyCardStore(dir);
    const terminal = await recovered.update(key, { kind: 'terminal', phase: 'completed' }, io);
    expect(terminal.messageId).toBe(final.messageId);
    expect(terminal.card).not.toContain('![Preview]');
    expect(terminal.card).toContain('Answer.');
    expect(terminal.record.finalDelivered).toBe(true);
    expect(terminal.record.lastCard).toBe(cards.get(final.messageId ?? ''));
    expect(cards.size).toBe(1);
  });

  it.each([false, true])('recovers an unknown image-free delivery result with an existing card=%s', async existing => {
    if (existing) await store.update(key, { kind: 'start' }, io);
    const send = io.send;
    const patch = io.patch;
    const requests: { content: string; identity: string }[] = [];
    let disconnect = true;
    const deliver = async (content: string, identity: string) => {
      requests.push({ content, identity });
      if (content.includes('![Preview]')) {
        throw new Error('ErrCode: 200570; card contains invalid image keys (code: 230099)');
      }
      if (existing) await patch(identity, content);
      else await send(content, identity);
      if (disconnect) { disconnect = false; throw new Error('connection reset after acceptance'); }
      return identity;
    };
    io.send = (content, uuid) => deliver(content, uuid);
    io.patch = async (id, content) => { await deliver(content, id); };
    const event = finalEvent('Answer. ![Preview](img_v3_rejected)', 'bridge');
    await expect(store.update(key, event, io)).rejects.toThrow('connection reset');
    expect(store.read(key)?.finalDelivered).not.toBe(true);
    const recovered = new TurnReplyCardStore(dir);
    const final = await recovered.update(key, event, io);
    expect(requests).toHaveLength(3);
    expect(requests[2].identity).toBe(requests[1].identity);
    // POST retries freeze the exact body; PATCH may refresh elapsed time.
    if (!existing) expect(requests[2]).toEqual(requests[1]);
    expect(requests[2].content).not.toContain('![Preview]');
    expect(requests[2].content).toContain('Answer.');
    expect(final.record.finalCard).not.toContain('![Preview]');
    expect(final.record.lastCard).toBe(requests[2].content);
    expect(cards.size).toBe(1);
    expect(final.record.finalDelivered).toBe(true);
  });

  it.each([false, true])('rechecks ownership before an image fallback with an existing card=%s', async existing => {
    if (existing) await store.update(key, { kind: 'start' }, io);
    let owned = true;
    io.beforeEffect = () => { if (!owned) throw new Error('stale worker'); };
    const reject = vi.fn(async () => {
      owned = false;
      throw new Error('ErrCode: 200570; card contains invalid image keys (code: 230099)');
    });
    io.send = reject;
    io.patch = reject;
    await expect(store.update(key, finalEvent('Answer. ![Preview](img_v3_rejected)'), io)).rejects.toThrow('stale worker');
    expect(reject).toHaveBeenCalledOnce();
    expect(store.read(key)?.finalDelivered).not.toBe(true);
  });

  it('keeps the exact pending body after an unrelated card rejection', async () => {
    const send = io.send;
    io.send = vi.fn().mockRejectedValueOnce(new Error('Invalid card schema (code: 230099)')).mockImplementation(send);
    const event = finalEvent('Answer. ![Preview](img_v3_valid)');
    await expect(store.update(key, event, io)).rejects.toThrow('Invalid card schema');
    const pending = store.read(key)?.pendingCreate;
    expect(pending?.content).toContain('![Preview](img_v3_valid)');
    const final = await new TurnReplyCardStore(dir).update(key, event, io);
    expect(vi.mocked(io.send).mock.calls[1]).toEqual(vi.mocked(io.send).mock.calls[0]);
    expect(final.record.finalCard).toContain('![Preview](img_v3_valid)');
  });

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

  it('keeps thinking in unified cards while hiding tool calls and commands', async () => {
    io.render = record => buildTurnReplyCard(record, { ...presentation, showTools: false });
    const started = await store.update(key, { kind: 'start' }, io);
    await store.update(key, { kind: 'tools',
      tools: [{ id: 't1', name: 'ExecCommand', subject: 'SECRET_TOOL_COMMAND_MARKER', result: 'SECRET_RESULT_MARKER' }],
      activity: [
        { kind: 'thinking', id: 'thinking:1', text: 'VISIBLE_THINKING_MARKER' },
        { kind: 'tool', id: 't1' },
      ],
    }, io);
    const workingCard = cards.get(started.messageId!)!;
    const finalCard = (await store.update(key, finalEvent(), io)).card!;
    const completedCard = (await store.update(key, { kind: 'terminal', phase: 'completed' }, io)).card!;
    for (const card of [workingCard, finalCard, completedCard]) {
      expect(card).toContain('VISIBLE_THINKING_MARKER');
      expect(card).not.toContain('SECRET_TOOL_COMMAND_MARKER');
      expect(card).not.toContain('SECRET_RESULT_MARKER');
      expect(card).not.toContain('ExecCommand');
      // gate①: the panel title must not leak a tool count either.
      expect(card).not.toContain('次工具调用');
    }
    expect(store.read(key)?.tools).toHaveLength(1);
    // English rendering: singular "tool call" must be hidden too (covers both
    // "tool call" and "tool calls"); positive assertions pin the fixture.
    const hiddenEn = buildTurnReplyCard(store.read(key)!, { ...presentation, showTools: false, locale: 'en' });
    expect(hiddenEn).not.toContain('tool call');
    const shownZh = buildTurnReplyCard(store.read(key)!, { ...presentation, showTools: true });
    expect(shownZh).toContain('次工具调用');
    const shownEn = buildTurnReplyCard(store.read(key)!, { ...presentation, showTools: true, locale: 'en' });
    expect(shownEn).toContain('tool call');
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

  it('keeps final runtime identity in the footer without duplicating or replacing it on refresh', () => {
    const finalCard = buildCanonicalFinalReplyCard({ markdown: 'Answer',
      usage: { context: null, tokens: null, model: 'original-model', reasoningEffort: 'high' },
    });
    const card = JSON.parse(buildTurnReplyCard({
      ...key, ...input, version: 1, phase: 'completed', createdAtMs: 0, progress: [], tools: [], finalCard,
      usage: { context: null, tokens: null, model: 'later-model', reasoningEffort: 'low' },
    }, { ...presentation, showLiveUsage: true }));
    expect(JSON.stringify(card).match(/original-model/g)).toHaveLength(1);
    expect(JSON.stringify(card)).not.toContain('later-model');
    expect(card.body.elements.some((e: any) => e.element_id === 'botmux_turn_usage')).toBe(false);
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
    // The shared-context purpose extends the invisible footer signature only.
    const visibleElements = JSON.parse(JSON.stringify(card.body.elements).replace(/\u2063/g, ''));
    for (const element of canonical.body.elements) expect(visibleElements).toContainEqual(element);
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

  // Regression: process text (narration, thinking, tool labels/results) has no
  // image-upload path; image syntax left in the collapsed panel makes Feishu
  // reject the WHOLE card (230099/200570 invalid image keys, panel included),
  // after which the whole-card fallback removes the body's valid images too.
  describe('process panel image syntax boundary', () => {
    const bodyKey = 'img_v3_body_validkey_0001';

    // Mirrors Feishu's card validation: image tokens inside markdown widgets
    // (anywhere, including the collapsed process panel) plus native img tags.
    function auditCard(cardJson: string) {
      const card = JSON.parse(cardJson);
      const markdownContents: string[] = [];
      const nativeImgKeys: string[] = [];
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) { value.forEach(walk); return; }
        if (!value || typeof value !== 'object') return;
        const record = value as Record<string, unknown>;
        if (record.tag === 'markdown' && typeof record.content === 'string') markdownContents.push(record.content);
        if (record.tag === 'img' && typeof record.img_key === 'string') nativeImgKeys.push(record.img_key as string);
        Object.values(record).forEach(walk);
      };
      walk(card);
      const markdownImageSources = markdownContents.flatMap(content =>
        cardMarkdownImageReferences(content).map(reference => reference.source));
      const invalidMarkdownImageSources = markdownImageSources.filter(source => !FEISHU_IMG_KEY.test(source));
      const panel = card.body.elements.find((element: any) => element.tag === 'collapsible_panel');
      const panelMarkdown: string[] = [];
      const panelNativeImgKeys: string[] = [];
      if (panel) {
        const walkPanel = (value: unknown): void => {
          if (Array.isArray(value)) { value.forEach(walkPanel); return; }
          if (!value || typeof value !== 'object') return;
          const rec = value as Record<string, unknown>;
          if (rec.tag === 'markdown' && typeof rec.content === 'string') panelMarkdown.push(rec.content);
          if (rec.tag === 'img' && typeof rec.img_key === 'string') panelNativeImgKeys.push(rec.img_key as string);
          Object.values(rec).forEach(walkPanel);
        };
        walkPanel(panel);
      }
      const panelImageSources = panelMarkdown.flatMap(content =>
        cardMarkdownImageReferences(content).map(reference => reference.source));
      return {
        markdownImageSources, invalidMarkdownImageSources, nativeImgKeys, panelImageSources, panelNativeImgKeys,
        validBodyImageRefs: [...markdownImageSources.filter(source => FEISHU_IMG_KEY.test(source)), ...nativeImgKeys],
        panelContent: panel ? String(panel.elements[0].content) : '',
      };
    }

    function imageRecord(phase: TurnReplyCardRecord['phase'] = 'completed', withFinal = true): TurnReplyCardRecord {
      const record: TurnReplyCardRecord = {
        ...key, ...input, version: 1, phase, createdAtMs: 0,
        progress: ['旁白 ![图表](img:0) 结尾', '第二条进度 ![](img:0,1) 并排'],
        tools: [{
          id: 't0', name: 'bash', subject: 'show ![diagram](/tmp/diagram.png)', completed: true,
          result: '输出 ![截图](https://example.com/shot.png) 完成',
        }],
        activity: [
          { kind: 'thinking', id: 'th0', text: '思考 ![](img:0,1) 内联' },
          { kind: 'tool', id: 't0' },
          { kind: 'progress', id: 'p0', text: '旁白 ![图表](img:0) 结尾' },
          { kind: 'progress', id: 'p1', text: '第二条进度 ![](img:0,1) 并排' },
        ],
      };
      if (withFinal) record.finalCard = buildCanonicalFinalReplyCard({ markdown: `正文有效图片\n\n![](${bodyKey})` });
      return record;
    }

    it('neutralizes image syntax in thinking, progress, tool labels and results while keeping body images', () => {
      // This is the shape of every terminal PATCH: process panel and final body
      // coexist in one card, regardless of which side arrived first.
      const audit = auditCard(buildTurnReplyCard(imageRecord(), presentation));
      expect(audit.invalidMarkdownImageSources).toEqual([]);
      expect(audit.validBodyImageRefs).toEqual([bodyKey]);
      expect(audit.panelContent).toContain('[Image omitted]');
      // Transcript text around the removed tokens survives.
      expect(audit.panelContent).toContain('思考');
      expect(audit.panelContent).toContain('show ');
      expect(audit.panelContent).toContain(' 结尾');
      expect(audit.panelContent).toContain('输出 ');
      expect(audit.panelContent).toContain(' 完成');
    });

    it('sanitizes the live working view (narration and tool lines) before any final answer exists', () => {
      const cardJson = buildTurnReplyCard(imageRecord('working', false), presentation);
      const audit = auditCard(cardJson);
      expect(audit.invalidMarkdownImageSources).toEqual([]);
      expect(audit.validBodyImageRefs).toEqual([]);
      expect(cardJson).not.toContain('![');
    });

    it('strips key-shaped but unuploaded tokens from the process panel (hallucinated / another app key)', () => {
      // A token matching img_vN_… is NOT necessarily valid: models hallucinate
      // key-shaped strings, and keys are app-scoped so another app's key is
      // rejected here. The panel must strip ALL images, not only non-key ones.
      const alienKey = 'img_v3_02k_other_app_key_xyz789';
      const record = imageRecord();
      record.progress = [`引用他应用图片 ![图](${alienKey}) 结尾`];
      record.activity!.push({ kind: 'progress', id: 'p2', text: record.progress[0] });
      const audit = auditCard(buildTurnReplyCard(record, presentation));
      // The token survives only inside a now-ordinary LINK [图](key), which
      // Feishu does not validate as an image key — same shape the established
      // whole-card fallback emits. What matters: zero image tokens IN PANEL.
      expect(audit.panelImageSources).toEqual([]);
      expect(audit.panelNativeImgKeys).toEqual([]);
      expect(audit.panelContent).toContain('[Image omitted]');
      expect(audit.validBodyImageRefs).toEqual([bodyKey]);
    });

    it('strips key-shaped tokens on the single live progress branch, including the two-key image row', () => {
      // Regression for the working-phase gap: the latest single progress was
      // rendered through the BODY renderer, whose normalization keeps
      // key-shaped tokens and even promotes a two-key line to native img rows.
      const badA = 'img_v3_02k_hallucinated_key_aaaaaa';
      const badB = 'img_v3_02k_hallucinated_key_bbbbbb';
      const record = imageRecord('working', false);
      record.progress = [`预览 ![](${badA}) 尾\n\n![](${badA}) ![](${badB})`];
      record.tools = [];
      record.activity = [{ kind: 'progress', id: 'p0', text: record.progress[0] }];
      const cardJson = buildTurnReplyCard(record, presentation);
      const audit = auditCard(cardJson);
      expect(audit.markdownImageSources).toEqual([]);
      expect(audit.nativeImgKeys).toEqual([]);
      expect(cardJson).not.toContain('![');
      // The standalone two-key line must not have been promoted to a native
      // image row (no column_set carrying an img tag): audit already proves
      // zero native img keys above.
    });

    it('keeps stripping to a fixed point when replacement brackets resync an image out of a link destination (panel)', () => {
      // Nested-link carrier: the inner image is in the outer link's TEXT and
      // the key-shaped token is inert inside its DESTINATION. Replacing the
      // inner image inserts "[Image omitted] [" and re-forms the parse,
      // promoting the destination token to a live image on re-parse. A single
      // sanitizer pass leaked it and still rejected the whole card; the
      // fixed-point strip must leave zero image tokens in the panel.
      const alienKey = 'img_v3_02k_carrier_alien_key';
      const carrier = `x[![y](/tmp/y.png)!](![z](${alienKey}))`;
      const record = imageRecord();
      record.progress = [carrier];
      record.activity = [{ kind: 'progress', id: 'p0', text: carrier }];
      const audit = auditCard(buildTurnReplyCard(record, presentation));
      expect(audit.panelImageSources).toEqual([]);
      expect(audit.panelNativeImgKeys).toEqual([]);
      expect(audit.invalidMarkdownImageSources).toEqual([]);
      expect(audit.validBodyImageRefs).toEqual([bodyKey]);
    });

    it('keeps stripping to a fixed point on the live working branch carrier', () => {
      const alienKey = 'img_v3_02k_carrier_alien_key_live';
      const carrier = `x[![y](/tmp/y.png)!](![z](${alienKey}))`;
      const record = imageRecord('working', false);
      record.progress = [carrier];
      record.tools = [];
      record.activity = [{ kind: 'progress', id: 'p0', text: carrier }];
      const cardJson = buildTurnReplyCard(record, presentation);
      const audit = auditCard(cardJson);
      expect(audit.markdownImageSources).toEqual([]);
      expect(audit.nativeImgKeys).toEqual([]);
    });

    it('strips images that a display PREFIX makes live again by un-fencing the first line', () => {
      // Every process entry is rendered as `💬 `/`💭 ` + text, and tool lines are
      // joined with `\n`. That composition shifts line starts, so a leading
      // fence stops opening a block and image syntax that was inert inside it
      // becomes a live token AFTER the per-fragment strip already ran. Feishu
      // validates the composed card, so the assembled markdown must be clean.
      const alienKey = 'img_v3_02k_prefix_alien_key';
      const fenced = ['```markdown', `![架构图](${alienKey})`, '```'].join('\n');

      const panel = imageRecord();
      panel.progress = [fenced, '第二条'];
      panel.activity = [{ kind: 'progress', id: 'p0', text: fenced }, { kind: 'progress', id: 'p1', text: '第二条' }];
      const panelAudit = auditCard(buildTurnReplyCard(panel, presentation));
      expect(panelAudit.panelImageSources).toEqual([]);
      expect(panelAudit.invalidMarkdownImageSources).toEqual([]);
      expect(panelAudit.validBodyImageRefs).toEqual([bodyKey]);

      // Live thinking line has its own `💭 ` prefix in the body.
      const thinking = imageRecord('working', false);
      thinking.progress = ['处理中'];
      thinking.tools = [];
      thinking.activity = [{ kind: 'thinking', id: 'th0', text: fenced }];
      expect(auditCard(buildTurnReplyCard(thinking, presentation)).markdownImageSources).toEqual([]);

      // Tool lines are joined into one markdown element.
      const tools = imageRecord('working', false);
      tools.progress = ['处理中'];
      tools.tools = [{ id: 't0', name: 'bash', subject: fenced, result: fenced, completed: true }];
      tools.activity = [{ kind: 'tool', id: 't0' }];
      expect(auditCard(buildTurnReplyCard(tools, presentation)).markdownImageSources).toEqual([]);
    });

    it('strips images that the renderer’s own escaped-fence repair exposes on the live branch', () => {
      // The live branch feeds text to the BODY renderer, which first runs
      // `unescapeFenceLines`. A line of over-escaped backticks becomes a real
      // fence there, so image syntax that the sanitizer saw as inert code ends
      // up in prose and is rendered as a live image.
      const alienKey = 'img_v3_02k_escaped_fence_alien';
      const escaped = ['```', '\\`\\`\\`', `![架构图](${alienKey})`, '```'].join('\n');
      const record = imageRecord('working', false);
      record.progress = [escaped];
      record.tools = [];
      record.activity = [{ kind: 'progress', id: 'p0', text: escaped }];
      const audit = auditCard(buildTurnReplyCard(record, presentation));
      expect(audit.markdownImageSources).toEqual([]);
      expect(audit.nativeImgKeys).toEqual([]);
    });

    it('leaves fenced code, inline code, escaped syntax and ordinary links untouched in the process panel', () => {
      const text = [
        '围栏代码：',
        '```',
        '![fenced](img:0)',
        '```',
        '行内 `![inline](/tmp/in.png)` 代码',
        '转义 \\!\\[escaped](img:0) 文本',
        '普通[文档链接](https://example.com/docs?x=img:0)结尾',
      ].join('\n');
      const record = imageRecord('completed', false);
      record.progress = [text];
      record.tools = [];
      record.activity = [{ kind: 'progress', id: 'p0', text }];
      const audit = auditCard(buildTurnReplyCard(record, presentation));
      expect(audit.invalidMarkdownImageSources).toEqual([]);
      expect(audit.panelContent).toContain('![fenced](img:0)');
      expect(audit.panelContent).toContain('`![inline](/tmp/in.png)`');
      expect(audit.panelContent).toContain('\\!\\[escaped](img:0)');
      expect(audit.panelContent).toContain('[文档链接](https://example.com/docs?x=img:0)');
      expect(audit.panelContent).not.toContain('[Image omitted]');
    });

    it('neutralizes image syntax in pending ask questions and answered free-text summaries', () => {
      const askQuestion = (prompt: string) => ({
        askId: 'a1', nonce: 'nonce', larkAppId: key.larkAppId, chatId: input.chatId,
        rootMessageId: input.rootId, sessionId: key.sessionId, createdAt: 0, deadlineAt: 10_000, settled: false,
        questions: [{ prompt, multiSelect: false, options: [{ key: 'yes', label: '继续' }, { key: 'no', label: '停止' }] }],
      });
      // A pending question is model-authored display text rendered in the same card.
      const pending = imageRecord('waiting', false);
      pending.asks = [{ ask: askQuestion('请确认 ![q](img:0)？') }];
      const pendingAudit = auditCard(buildTurnReplyCard(pending, presentation));
      expect(pendingAudit.invalidMarkdownImageSources).toEqual([]);
      // An answered custom reply (user free text) is embedded INTO the process panel.
      const answered = imageRecord();
      answered.asks = [{ ask: askQuestion('问题'), result: {
        kind: 'answered' as const, answers: [[]], by: 'ou_user', comment: '用户原文 ![图](img:0,1)', timedOut: false as const,
      } }];
      answered.activity!.push({ kind: 'ask', id: 'a1' });
      const answeredAudit = auditCard(buildTurnReplyCard(answered, presentation));
      expect(answeredAudit.invalidMarkdownImageSources).toEqual([]);
      expect(answeredAudit.panelContent).toContain('用户原文 ');
      expect(answeredAudit.validBodyImageRefs).toEqual([bodyKey]);
    });

    it('neutralizes image syntax in the custom-input ask form question prompt', () => {
      // #ask-custom-input renders q.prompt through a dedicated form builder on
      // the same turn card; it must use the same image-safe escaper.
      const alienKey = 'img_v3_02k_form_alien_key_cccccc';
      const ask = {
        askId: 'a1', nonce: 'nonce', larkAppId: key.larkAppId, chatId: input.chatId,
        rootMessageId: input.rootId, sessionId: key.sessionId, createdAt: 0, deadlineAt: 10_000, settled: false,
        originKind: 'explicit' as const,
        questions: [{ prompt: `请填写 ![图](${alienKey})`, multiSelect: false, options: [{ key: 'ok', label: '确定' }] }],
      };
      const record = imageRecord('waiting', false);
      record.asks = [{ ask }];
      const cardJson = buildTurnReplyCard(record, presentation);
      const audit = auditCard(cardJson);
      expect(audit.markdownImageSources).toEqual([]);
      expect(cardJson).not.toContain('![');
    });

    it('publishes working PATCHes and the final PATCH without tripping the whole-card image fallback', async () => {
      const dir2 = mkdtempSync(join(tmpdir(), 'botmux-process-image-'));
      try {
        const store2 = new TurnReplyCardStore(dir2);
        const published: string[] = [];
        // Mimic Feishu's whole-card gate: any image key not uploaded by THIS
        // card rejects with 230099/200570, which drives the whole-card
        // fallback and the persistent omitImages downgrade.
        const gate = (content: string) => {
          published.push(content);
          const audit = auditCard(content);
          const illegal = [...audit.markdownImageSources, ...audit.nativeImgKeys].filter(source => source !== bodyKey);
          if (illegal.length) {
            throw Object.assign(new Error('card contains invalid image keys; ErrCode: 200570'), {
              code: 230099, msg: 'card contains invalid image keys; ErrCode: 200570',
            });
          }
        };
        const io2: TurnReplyCardTransport = {
          render: r => buildTurnReplyCard(r, presentation),
          beforeEffect: () => {}, isWithdrawn: e => e instanceof Error && e.message === 'withdrawn',
          send: vi.fn(async content => { gate(content); return 'om_card'; }),
          patch: vi.fn(async (_id, content) => { gate(content); }),
        };
        await store2.prepare(key, input);
        await store2.update(key, { kind: 'start' }, io2);
        await store2.update(key, {
          kind: 'tools',
          tools: [{ id: 't0', name: 'bash', subject: 'preview ![p](/tmp/p.png)', completed: false }],
          activity: [
            { kind: 'thinking', id: 'th0', text: '先想 ![](img:0,1)' },
            { kind: 'tool', id: 't0' },
          ],
        }, io2);
        // A single working-phase progress renders ONLY through the live body
        // branch (not yet the panel): a key-shaped hallucination here used to
        // reject the PATCH and permanently downgrade the turn's images.
        await store2.update(key, { kind: 'progress', text: `实时进度 ![](img_v3_02k_hallucinated_key_aaaaaa) 尾` }, io2);
        const finalCard = buildCanonicalFinalReplyCard({ markdown: `正文\n\n![](${bodyKey})` });
        await store2.update(key, { kind: 'final', text: '正文', card: finalCard, source: 'explicit' }, io2);
        await store2.update(key, { kind: 'terminal', phase: 'completed' }, io2);

        expect(published.length).toBeGreaterThan(0);
        for (const payload of published) {
          expect(auditCard(payload).invalidMarkdownImageSources).toEqual([]);
        }
        expect(auditCard(published.at(-1)!).validBodyImageRefs).toEqual([bodyKey]);
        // No rejected send => no fallback retry and no persistent downgrade.
        expect(io2.send).toHaveBeenCalledTimes(1);
        const stored = store2.read(key)!;
        expect(stored.omitImages).toBeUndefined();
        expect(stored.finalCard).toContain(bodyKey);
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    });
  });
});
