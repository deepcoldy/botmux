import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCardStreamSuccessOutput,
  CARD_STREAM_USAGE,
  cardMessageBelongsToSession,
  cardMessageRouteFromDetail,
  cardStreamArgsWantHelp,
  executeCardStreamFinish,
  executeCardStreamOpen,
  executeCardStreamReanchor,
  executeCardStreamSnapshot,
  executeCardStreamWrite,
  mapCardStreamError,
  parseCardStreamArgs,
  readCardStreamContent,
  type CardStreamDeps,
} from '../src/cli/card-stream-dispatch.js';
import type { CardStreamRecord } from '../src/services/card-stream-store.js';
import { parseCardRuntimeStatusArgs } from '../src/cli/card-runtime-status-dispatch.js';

const STREAM_ID = 'cs_0123456789abcdef0123456789abcdef';
const baseRecord: CardStreamRecord = {
  schemaVersion: 1,
  streamId: STREAM_ID,
  sessionId: 'sid_1',
  larkAppId: 'cli_app',
  chatId: 'oc_chat',
  messageId: 'om_card',
  cardId: 'card_1',
  status: 'open',
  sequence: 1,
  createdAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
};

function deps(overrides: Partial<CardStreamDeps> = {}): CardStreamDeps {
  return {
    store: {
      open: vi.fn(async (_binding, _cardId, callback) => {
        await callback({ cardId: 'card_1', sequence: 1, uuid: 'uuid_1' });
        return { record: baseRecord, alreadyOpen: false };
      }),
      write: vi.fn(async (_streamId, _authority, callback) => {
        await callback({ cardId: 'card_1', sequence: 2, uuid: 'uuid_2' });
        return { ...baseRecord, sequence: 2 };
      }),
      inspect: vi.fn(async () => baseRecord),
      reanchor: vi.fn(async (_streamId, _authority, nextBinding, _cardId, callback) => {
        await callback({ cardId: 'card_2', sequence: 1, uuid: 'uuid_new_1' });
        return {
          previous: { ...baseRecord, status: 'superseded', supersededByStreamId: 'cs_11111111111111111111111111111111' },
          current: {
            ...baseRecord,
            ...nextBinding,
            streamId: 'cs_11111111111111111111111111111111',
            cardId: 'card_2',
            sequence: 1,
          },
        };
      }),
      finish: vi.fn(async (_streamId, _authority, callback) => {
        await callback({ cardId: 'card_1', sequence: 2, uuid: 'uuid_2' });
        return { record: { ...baseRecord, status: 'finished', sequence: 2 }, alreadyFinished: false };
      }),
    },
    getMessageRoute: vi.fn(async () => ({
      messageId: 'om_card', chatId: 'oc_chat', rootMessageId: 'om_root', messageType: 'interactive',
    })),
    resolveCardId: vi.fn(async () => 'card_1'),
    updateSettings: vi.fn(async () => undefined),
    updateElementContent: vi.fn(async () => undefined),
    moveRuntimeBinding: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
    ...overrides,
  };
}

describe('parseCardStreamArgs', () => {
  it('parses open, write, snapshot, and finish', () => {
    expect(parseCardStreamArgs(['open', '--message-id', 'om_1', '--summary', '进行中']))
      .toEqual({ ok: true, operation: 'open', messageId: 'om_1', summary: '进行中' });
    expect(parseCardStreamArgs([
      'write', '--stream-id', STREAM_ID, '--element-id', 'work_log', '--content-file', '-', '--session-id', 'sid_1',
    ])).toEqual({
      ok: true,
      operation: 'write',
      streamId: STREAM_ID,
      elementId: 'work_log',
      contentFile: '-',
      sessionId: 'sid_1',
    });
    expect(parseCardStreamArgs(['finish', '--stream-id', STREAM_ID, '--summary=完成']))
      .toEqual({ ok: true, operation: 'finish', streamId: STREAM_ID, summary: '完成' });
    expect(parseCardStreamArgs(['snapshot', '--stream-id', STREAM_ID, '--session-id', 'sid_1']))
      .toEqual({ ok: true, operation: 'snapshot', streamId: STREAM_ID, sessionId: 'sid_1' });
    expect(parseCardStreamArgs([
      'reanchor', '--stream-id', STREAM_ID, '--message-id', 'om_2', '--summary', '继续执行',
    ])).toEqual({
      ok: true,
      operation: 'reanchor',
      streamId: STREAM_ID,
      messageId: 'om_2',
      summary: '继续执行',
    });
  });

  it('rejects malformed ids, an invalid element id, and ambiguous content input', () => {
    expect(parseCardStreamArgs(['open', '--message-id', 'bad']).ok).toBe(false);
    expect(parseCardStreamArgs(['write', '--stream-id', '../x', '--element-id', 'main', '--content', 'x']).ok).toBe(false);
    expect(parseCardStreamArgs([
      'write', '--stream-id', STREAM_ID, '--element-id', '1bad', '--content', 'x',
    ]).ok).toBe(false);
    expect(parseCardStreamArgs([
      'write', '--stream-id', STREAM_ID, '--element-id', 'main', '--content', 'x', '--content-file', '/x',
    ]).ok).toBe(false);
  });

  it('rejects content-free writes and overlong summaries', () => {
    expect(parseCardStreamArgs(['write', '--stream-id', STREAM_ID, '--element-id', 'main']).ok).toBe(false);
    const result = parseCardStreamArgs(['finish', '--stream-id', STREAM_ID, '--summary', 'x'.repeat(51)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('50');
  });
});

describe('parseCardRuntimeStatusArgs', () => {
  it('parses bind/unbind runtime status commands', () => {
    expect(parseCardRuntimeStatusArgs([
      'bind-runtime',
      '--stream-id', STREAM_ID,
      '--status-element-id', 'status_badge',
      '--image-element-id', 'loader_img',
      '--active-image-key', 'img_active_12345678',
      '--inactive-image-key', 'img_inactive_12345678',
      '--labels-json', '{"working":"执行中"}',
      '--session-id', 'sid_1',
    ])).toEqual({
      ok: true,
      operation: 'bind-runtime',
      streamId: STREAM_ID,
      statusElementId: 'status_badge',
      imageElementId: 'loader_img',
      activeImageKey: 'img_active_12345678',
      inactiveImageKey: 'img_inactive_12345678',
      labels: { working: '执行中' },
      sessionId: 'sid_1',
    });
    expect(parseCardRuntimeStatusArgs([
      'unbind-runtime', '--stream-id', STREAM_ID,
    ])).toEqual({ ok: true, operation: 'unbind-runtime', streamId: STREAM_ID });
  });

  it('rejects unsafe element/image ids and malformed labels', () => {
    expect(parseCardRuntimeStatusArgs([
      'bind-runtime', '--stream-id', STREAM_ID,
      '--status-element-id', '../bad', '--image-element-id', 'loader_img',
      '--active-image-key', 'img_active_12345678', '--inactive-image-key', 'img_inactive_12345678',
    ]).ok).toBe(false);
    expect(parseCardRuntimeStatusArgs([
      'bind-runtime', '--stream-id', STREAM_ID,
      '--status-element-id', 'status_badge', '--image-element-id', 'loader_img',
      '--active-image-key', 'bad', '--inactive-image-key', 'img_inactive_12345678',
    ]).ok).toBe(false);
    expect(parseCardRuntimeStatusArgs([
      'bind-runtime', '--stream-id', STREAM_ID,
      '--status-element-id', 'status_badge', '--image-element-id', 'loader_img',
      '--active-image-key', 'img_active_12345678', '--inactive-image-key', 'img_inactive_12345678',
      '--labels-json', '{"unknown":"x"}',
    ]).ok).toBe(false);
  });
});

describe('readCardStreamContent', () => {
  it('passes inline content and reads a file', () => {
    expect(readCardStreamContent('hello', undefined)).toEqual({ ok: true, content: 'hello' });
    const dir = mkdtempSync(join(tmpdir(), 'botmux-stream-content-'));
    try {
      const file = join(dir, 'content.md');
      writeFileSync(file, 'line 1\nline 2', 'utf-8');
      expect(readCardStreamContent(undefined, file)).toEqual({ ok: true, content: 'line 1\nline 2' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps a missing file and oversized content clearly', () => {
    expect(readCardStreamContent(undefined, '/missing/card-stream.md'))
      .toEqual({ ok: false, exitCode: 1, error: expect.stringContaining('文件不存在') });
    expect(readCardStreamContent('x'.repeat(30_001), undefined))
      .toEqual({ ok: false, exitCode: 2, error: expect.stringContaining('30000') });
  });
});

describe('card message ownership', () => {
  it('normalizes the Lark detail response', () => {
    expect(cardMessageRouteFromDetail({ items: [{
      message_id: 'om_1', chat_id: 'oc_1', root_id: 'om_root', msg_type: 'interactive',
    }] }, 'om_fallback')).toEqual({
      messageId: 'om_1', chatId: 'oc_1', rootMessageId: 'om_root', messageType: 'interactive',
    });
  });

  it('requires same chat and same thread for thread sessions', () => {
    const session = { chatId: 'oc_1', rootMessageId: 'om_root', scope: 'thread' as const };
    expect(cardMessageBelongsToSession({
      messageId: 'om_card', chatId: 'oc_1', rootMessageId: 'om_root', messageType: 'interactive',
    }, session)).toEqual({ ok: true });
    expect(cardMessageBelongsToSession({
      messageId: 'om_card', chatId: 'oc_other', rootMessageId: 'om_root', messageType: 'interactive',
    }, session).ok).toBe(false);
    expect(cardMessageBelongsToSession({
      messageId: 'om_card', chatId: 'oc_1', rootMessageId: 'om_other', messageType: 'interactive',
    }, session).ok).toBe(false);
    expect(cardMessageBelongsToSession({
      messageId: 'om_card', chatId: 'oc_1', rootMessageId: 'om_root', messageType: 'text',
    }, session).ok).toBe(false);
  });

  it('allows any interactive card in the same chat for chat-scope sessions', () => {
    expect(cardMessageBelongsToSession({
      messageId: 'om_card', chatId: 'oc_1', rootMessageId: 'om_other', messageType: 'interactive',
    }, { chatId: 'oc_1', rootMessageId: 'om_root', scope: 'chat' })).toEqual({ ok: true });
  });
});

describe('CardKit stream execution', () => {
  const binding = { sessionId: 'sid_1', larkAppId: 'cli_app', chatId: 'oc_chat', messageId: 'om_card' };
  const sessionRoute = { chatId: 'oc_chat', rootMessageId: 'om_root', scope: 'thread' as const };
  const authority = { sessionId: 'sid_1', larkAppId: 'cli_app', chatId: 'oc_chat' };

  it('opens with native typewriter settings after route validation', async () => {
    const d = deps();
    const outcome = await executeCardStreamOpen(d, { binding, sessionRoute, summary: '进行中' });
    expect(outcome).toEqual({
      ok: true,
      operation: 'open',
      streamId: STREAM_ID,
      messageId: 'om_card',
      sequence: 1,
      alreadyOpen: false,
    });
    expect(d.resolveCardId).toHaveBeenCalledWith('cli_app', 'om_card');
    expect(d.updateSettings).toHaveBeenCalledWith({
      larkAppId: 'cli_app',
      cardId: 'card_1',
      sequence: 1,
      uuid: 'uuid_1',
      streamingMode: true,
      summary: '进行中',
      print: { frequencyMs: 70, step: 1, strategy: 'fast' },
    });
  });

  it('fails closed before CardKit conversion when the message is outside the session', async () => {
    const d = deps({
      getMessageRoute: vi.fn(async () => ({ messageId: 'om_card', chatId: 'oc_other', messageType: 'interactive' })),
    });
    const outcome = await executeCardStreamOpen(d, { binding, sessionRoute });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.exitCode).toBe(2);
    expect(d.resolveCardId).not.toHaveBeenCalled();
  });

  it('writes the full element snapshot with the store-issued sequence', async () => {
    const d = deps();
    const outcome = await executeCardStreamWrite(d, {
      streamId: STREAM_ID,
      authority,
      elementId: 'work_log',
      content: '正在读取代码…',
    });
    expect(outcome).toEqual({
      ok: true, operation: 'write', streamId: STREAM_ID, elementId: 'work_log', sequence: 2,
    });
    expect(d.updateElementContent).toHaveBeenCalledWith({
      larkAppId: 'cli_app',
      cardId: 'card_1',
      sequence: 2,
      uuid: 'uuid_2',
      elementId: 'work_log',
      content: '正在读取代码…',
    });
  });

  it('finishes the stream and updates the preview summary', async () => {
    const d = deps();
    const outcome = await executeCardStreamFinish(d, { streamId: STREAM_ID, authority, summary: '已完成' });
    expect(outcome).toEqual({
      ok: true, operation: 'finish', streamId: STREAM_ID, sequence: 2, alreadyFinished: false,
    });
    expect(d.updateSettings).toHaveBeenCalledWith({
      larkAppId: 'cli_app',
      cardId: 'card_1',
      sequence: 2,
      uuid: 'uuid_2',
      streamingMode: false,
      summary: '已完成',
    });
  });

  it('reads a session-authorized native usage snapshot without estimating missing data', async () => {
    const d = deps();
    const usage = {
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 50,
      cacheCreateTokens: 10,
      totalTokens: 210,
    };
    const outcome = await executeCardStreamSnapshot(d, {
      streamId: STREAM_ID,
      authority,
      readUsage: () => usage,
      currentTurnId: 'turn_2',
      now: () => new Date('2026-08-31T01:02:03.000Z'),
    });
    expect(outcome).toEqual({
      ok: true,
      operation: 'snapshot',
      streamId: STREAM_ID,
      capturedAt: '2026-08-31T01:02:03.000Z',
      usage,
      currentTurnId: 'turn_2',
    });
    expect(d.store.inspect).toHaveBeenCalledWith(STREAM_ID, authority);

    const unavailable = await executeCardStreamSnapshot(d, {
      streamId: STREAM_ID,
      authority,
      readUsage: () => null,
    });
    expect(unavailable.ok).toBe(true);
    if (unavailable.ok && unavailable.operation === 'snapshot') {
      expect(unavailable.usage).toBeNull();
    }
  });

  it('reanchors only after the replacement card is validated and fences the old stream', async () => {
    const order: string[] = [];
    const d = deps({
      getMessageRoute: vi.fn(async () => ({
        messageId: 'om_card_2', chatId: 'oc_chat', rootMessageId: 'om_root', messageType: 'interactive',
      })),
      resolveCardId: vi.fn(async () => 'card_2'),
    });
    vi.mocked(d.store.reanchor).mockImplementation(async (_streamId, _authority, nextBinding, _cardId, callback) => {
      await callback({ cardId: 'card_2', sequence: 1, uuid: 'uuid_new_1' });
      order.push('fence');
      return {
        previous: { ...baseRecord, status: 'superseded', supersededByStreamId: 'cs_11111111111111111111111111111111' },
        current: {
          ...baseRecord,
          ...nextBinding,
          streamId: 'cs_11111111111111111111111111111111',
          cardId: 'card_2',
          sequence: 1,
        },
      };
    });
    vi.mocked(d.moveRuntimeBinding).mockImplementation(async () => {
      order.push('runtime');
      return true;
    });
    vi.mocked(d.deleteMessage).mockImplementation(async () => {
      order.push('recall');
      return true;
    });
    const outcome = await executeCardStreamReanchor(d, {
      streamId: STREAM_ID,
      authority,
      nextBinding: {
        ...authority,
        messageId: 'om_card_2',
        anchorTurnId: 'turn_2',
      },
      sessionRoute,
      summary: '继续执行',
    });
    expect(outcome).toEqual({
      ok: true,
      operation: 'reanchor',
      previousStreamId: STREAM_ID,
      streamId: 'cs_11111111111111111111111111111111',
      previousMessageId: 'om_card',
      messageId: 'om_card_2',
      sequence: 1,
      runtimeRebound: true,
      previousMessageRecalled: true,
      anchorTurnId: 'turn_2',
    });
    expect(d.store.reanchor).toHaveBeenCalled();
    expect(d.moveRuntimeBinding).toHaveBeenCalledWith(
      STREAM_ID,
      'cs_11111111111111111111111111111111',
      authority,
    );
    expect(d.deleteMessage).toHaveBeenCalledWith('cli_app', 'om_card');
    expect(order).toEqual(['fence', 'runtime', 'recall']);
  });

  it('maps provider business errors without hiding the Feishu code', async () => {
    const d = deps({
      updateElementContent: vi.fn(async () => {
        throw { response: { data: { code: 300100, msg: 'sequence invalid' } } };
      }),
    });
    const outcome = await executeCardStreamWrite(d, {
      streamId: STREAM_ID, authority, elementId: 'work_log', content: 'x',
    });
    expect(outcome).toEqual({
      ok: false,
      exitCode: 1,
      error: 'CardKit 更新失败: sequence invalid (code: 300100)',
    });
  });
});

describe('help and output', () => {
  it('documents the three-step lifecycle and stdin', () => {
    expect(cardStreamArgsWantHelp(['--help'])).toBe(true);
    expect(CARD_STREAM_USAGE).toContain('stream open');
    expect(CARD_STREAM_USAGE).toContain('stream write');
    expect(CARD_STREAM_USAGE).toContain('stream snapshot');
    expect(CARD_STREAM_USAGE).toContain('stream reanchor');
    expect(CARD_STREAM_USAGE).toContain('bind-runtime');
    expect(CARD_STREAM_USAGE).toContain('unbind-runtime');
    expect(CARD_STREAM_USAGE).toContain('stream finish');
    expect(CARD_STREAM_USAGE).toContain('--content-file -');
  });

  it('emits machine-readable JSON without the internal ok field', () => {
    expect(buildCardStreamSuccessOutput({
      ok: true,
      operation: 'write',
      streamId: STREAM_ID,
      elementId: 'work_log',
      sequence: 2,
    }, 'sid_1')).toBe(JSON.stringify({
      success: true,
      operation: 'write',
      streamId: STREAM_ID,
      elementId: 'work_log',
      sequence: 2,
      sessionId: 'sid_1',
    }));
  });
});

describe('runtime error mapping', () => {
  it('maps runtime binding errors without leaking stacks or local lock paths', () => {
    const runtime = Object.assign(new Error('runtime status binding 与 streamId 不匹配'), {
      name: 'CardRuntimeStatusBridgeError',
    });
    expect(mapCardStreamError(runtime)).toEqual({
      exitCode: 2,
      error: 'runtime status binding 与 streamId 不匹配',
    });

    const lock = Object.assign(new Error('file-lock timeout waiting for /private/path/card.json.lock'), {
      code: 'FILE_LOCK_TIMEOUT',
    });
    expect(mapCardStreamError(lock)).toEqual({
      exitCode: 1,
      error: '卡片流暂时忙，请稍后重试',
    });
  });
});
