import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnReplyCardStore, type TurnReplyCardTransport } from '../src/services/turn-reply-card.js';
import { buildTurnReplyCard, publicReplyCardTools } from '../src/im/lark/turn-reply-card.js';
import { buildCanonicalFinalReplyCard } from '../src/im/lark/md-card.js';
import { shouldSuppressBridgeEmit } from '../src/services/bridge-fallback-gate.js';
import { extractCardContent } from '../src/im/lark/message-parser.js';

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
    io.sendOverflow = vi.fn(async () => 'om_full_answer');
    await store.update(key, finalEvent(text), io);
    await store.update(key, finalEvent(text), io);
    expect(io.sendOverflow).toHaveBeenCalledTimes(1);
    expect(io.sendOverflow).toHaveBeenCalledWith(text, expect.any(String));
    const card = [...cards.values()][0];
    expect(Buffer.byteLength(card)).toBeLessThan(24 * 1024);
    expect(card).toContain('完整答复较长');
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
    expect(card.body.elements[0].content).toBe('🧠 **处理中**');
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
