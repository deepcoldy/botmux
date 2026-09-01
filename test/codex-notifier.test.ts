import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodexNotifierEventStore,
  CodexNotifierEventValidationError,
  buildCodexCompletionCard,
  buildCodexNotifierResultCard,
  codexNotifierEventId,
  codexNotifierMessageUuid,
  parseCodexNotifierEvent,
  parseCodexNotifierPluginEvent,
} from '../src/features/codex-notifier/index.js';
import type { CodexTaskCompletedEvent } from '../src/features/codex-notifier/index.js';

const tempDirs: string[] = [];
const APP_THREAD_ID = '019f8d92-df7c-7572-83ca-b1e99f20204c';

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function validEvent(seed = '1'): CodexTaskCompletedEvent {
  const identity = {
    source: 'codex-desktop' as const,
    threadId: APP_THREAD_ID,
    nativeTurnId: `turn-${seed}`,
    status: 'completed' as const,
  };
  return {
    schemaVersion: 1,
    eventId: codexNotifierEventId(identity),
    type: 'task.completed',
    ...identity,
    clientSurface: 'codex-app',
    title: '修复通知链路',
    cwd: '/workspace/project',
    completedAt: '2026-07-22T08:00:00.000Z',
    finalPreview: '任务已经完成。',
  };
}

function newStore(
  maxEntries = 1000,
  maxReceipts = 10_000,
): { store: CodexNotifierEventStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-notifier-'));
  tempDirs.push(dir);
  const file = join(dir, 'codex-notifier-events.json');
  return { store: new CodexNotifierEventStore(file, maxEntries, maxReceipts), file };
}

describe('parseCodexNotifierEvent', () => {
  it('accepts the strict built-in event schema', () => {
    expect(parseCodexNotifierEvent(JSON.stringify(validEvent()))).toEqual(validEvent());
  });

  it('accepts legacy events without client surface metadata', () => {
    const { clientSurface: _clientSurface, ...legacy } = validEvent('legacy-surface');
    expect(parseCodexNotifierEvent(legacy)).toEqual(legacy);
  });

  it('keeps the old plugin parser as a narrow compatibility boundary', () => {
    expect(parseCodexNotifierPluginEvent('codex-watch', validEvent())).toEqual(validEvent());
    expect(() => parseCodexNotifierPluginEvent('other-plugin', validEvent())).toThrowError(
      expect.objectContaining({ code: 'invalid_plugin' }),
    );
  });

  it.each([
    [{ ...validEvent(), schemaVersion: 2 }],
    [{ ...validEvent(), type: 'task.started' }],
    [{ ...validEvent(), status: 'running' }],
    [{ ...validEvent(), completedAt: 'yesterday' }],
    [{ ...validEvent(), surprise: true }],
    [{ ...validEvent(), eventId: 'forged-event-id' }],
    [{ ...validEvent(), nativeTurnId: undefined }],
    [{ ...validEvent(), clientSurface: 'browser' }],
    [{ ...validEvent(), conversationKind: 'subagent' }],
  ])('rejects malformed or expanded events', (input) => {
    expect(() => parseCodexNotifierEvent(input)).toThrowError(
      expect.objectContaining({ code: 'invalid_event' }),
    );
  });

  it('rejects non-plain and prototype-shaped input', () => {
    const inherited = Object.create(validEvent());
    expect(() => parseCodexNotifierEvent(inherited)).toThrowError(
      expect.objectContaining({ code: 'invalid_event' }),
    );
    const poisoned = JSON.parse(`{"__proto__":{},${JSON.stringify(validEvent()).slice(1)}`);
    expect(() => parseCodexNotifierEvent(poisoned)).toThrowError(
      expect.objectContaining({ code: 'invalid_event' }),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects oversized input before JSON parsing', () => {
    const payload = `{${'x'.repeat(128)}}`;
    expect(() => parseCodexNotifierEvent(payload, 64)).toThrowError(
      expect.objectContaining({ code: 'payload_too_large' }),
    );
  });

  it('classifies invalid JSON separately', () => {
    try {
      parseCodexNotifierEvent('{');
      throw new Error('expected parser to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CodexNotifierEventValidationError);
      expect((error as CodexNotifierEventValidationError).code).toBe('invalid_json');
    }
  });
});

describe('codexNotifierMessageUuid', () => {
  it('uses the full event id while keeping the Feishu UUID short', () => {
    const prefix = 'x'.repeat(100);
    const first = codexNotifierMessageUuid(`${prefix}-first`);
    const second = codexNotifierMessageUuid(`${prefix}-second`);
    expect(first).toHaveLength(50);
    expect(first).toMatch(/^cw_[a-f0-9]{47}$/);
    expect(second).not.toBe(first);
    expect(codexNotifierMessageUuid(`${prefix}-first`)).toBe(first);
  });
});

describe('CodexNotifierEventStore', () => {
  it('records, deduplicates, updates delivery and survives reload', () => {
    const { store, file } = newStore();
    const event = validEvent();
    const first = store.record(event, Date.parse('2026-07-22T08:01:00.000Z'));
    expect(first.inserted).toBe(true);
    expect(store.isDuplicate(event.eventId)).toBe(true);
    expect(store.record({ ...validEvent(), title: '不应覆盖' }).inserted).toBe(false);

    const delivered = store.updateDelivery(event.eventId, {
      status: 'delivered',
      messageId: 'om_card',
    }, Date.parse('2026-07-22T08:02:00.000Z'));
    expect(delivered?.delivery).toMatchObject({
      status: 'delivered',
      attempts: 1,
      messageId: 'om_card',
    });
    expect(new CodexNotifierEventStore(file).get(event.eventId)).toEqual(delivered);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      schemaVersion: 2,
      receipts: [],
    });
  });

  it('is bounded and evicts the least recently active event', () => {
    const { store } = newStore(2);
    const first = validEvent('1');
    const second = validEvent('2');
    const third = validEvent('3');
    store.record(first);
    store.record(second);
    store.updateDelivery(first.eventId, { status: 'failed', lastError: 'offline' });
    store.record(third);
    expect(store.get(first.eventId)).toBeDefined();
    expect(store.get(second.eventId)).toBeUndefined();
    expect(store.get(third.eventId)).toBeDefined();
  });

  it('keeps a slim delivered receipt after active eviction and reload', () => {
    const { store, file } = newStore(1, 2);
    const first = validEvent('receipt-1');
    const second = validEvent('receipt-2');
    store.record(first);
    store.updateDelivery(first.eventId, {
      status: 'delivered',
      messageId: 'om_receipt',
    });
    store.record(second);

    const receipt = store.get(first.eventId);
    expect(receipt).toMatchObject({
      event: {
        eventId: first.eventId,
        threadId: first.threadId,
        nativeTurnId: first.nativeTurnId,
      },
      delivery: {
        status: 'delivered',
        messageId: 'om_receipt',
      },
    });
    expect(receipt?.event.finalPreview).toBeUndefined();
    expect(receipt?.event.title).toBeUndefined();
    expect(store.record({ ...first, title: '不应重新发送' }).inserted).toBe(false);

    const persisted = JSON.parse(readFileSync(file, 'utf8'));
    expect(persisted.records).toHaveLength(1);
    expect(persisted.receipts).toHaveLength(1);
    expect(persisted.receipts[0].event.finalPreview).toBeUndefined();
    expect(persisted.receipts[0].event.title).toBeUndefined();

    const reloaded = new CodexNotifierEventStore(file, 1, 2);
    expect(reloaded.isDuplicate(first.eventId)).toBe(true);
    expect(reloaded.get(first.eventId)).toEqual(receipt);
  });

  it('bounds delivery receipts independently', () => {
    const { store, file } = newStore(1, 1);
    const first = validEvent('bounded-receipt-1');
    const second = validEvent('bounded-receipt-2');
    const third = validEvent('bounded-receipt-3');
    store.record(first);
    store.updateDelivery(first.eventId, { status: 'delivered', messageId: 'om_first' });
    store.record(second);
    store.updateDelivery(second.eventId, { status: 'delivered', messageId: 'om_second' });
    store.record(third);

    expect(store.get(first.eventId)).toBeUndefined();
    expect(store.get(second.eventId)?.delivery.messageId).toBe('om_second');
    expect(JSON.parse(readFileSync(file, 'utf8')).receipts).toHaveLength(1);
  });

  it('strips titles from development-era v2 receipts on the next write', () => {
    const { store, file } = newStore();
    const event = validEvent('legacy-title-receipt');
    store.record(event);
    const delivered = store.updateDelivery(event.eventId, {
      status: 'delivered',
      messageId: 'om_legacy_title',
    });
    if (!delivered) throw new Error('expected delivered record');
    delete delivered.event.finalPreview;
    writeFileSync(file, JSON.stringify({
      schemaVersion: 2,
      records: [],
      receipts: [delivered],
    }));

    const migrated = new CodexNotifierEventStore(file);
    expect(migrated.get(event.eventId)?.event.title).toBeUndefined();
    migrated.record(validEvent('after-title-migration'));

    const persisted = JSON.parse(readFileSync(file, 'utf8'));
    expect(persisted.receipts[0].event.title).toBeUndefined();
  });

  it('loads a schema v1 ledger and upgrades it on the next write', () => {
    const { store, file } = newStore();
    const first = validEvent('legacy');
    store.record(first);
    const current = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, `${JSON.stringify({
      schemaVersion: 1,
      records: current.records,
    }, null, 2)}\n`);

    const migrated = new CodexNotifierEventStore(file);
    expect(migrated.get(first.eventId)?.event).toEqual(first);
    migrated.record(validEvent('after-migration'));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      schemaVersion: 2,
      receipts: [],
    });
  });

  it('rejects invalid or duplicate delivery receipts', () => {
    const { store, file } = newStore();
    const event = validEvent('invalid-receipt');
    store.record(event);
    const current = JSON.parse(readFileSync(file, 'utf8'));
    current.schemaVersion = 2;
    current.receipts = [current.records[0]];
    writeFileSync(file, JSON.stringify(current));
    expect(() => new CodexNotifierEventStore(file)).toThrow(/delivery receipt/);

    const delivered = store.updateDelivery(event.eventId, {
      status: 'delivered',
      messageId: 'om_duplicate',
    });
    if (!delivered) throw new Error('expected delivered record');
    delete delivered.event.finalPreview;
    delete delivered.event.title;
    writeFileSync(file, JSON.stringify({
      schemaVersion: 2,
      records: [delivered],
      receipts: [delivered],
    }));
    expect(() => new CodexNotifierEventStore(file)).toThrow(/duplicate event/);
  });

  it('fails closed on a corrupted persisted ledger', () => {
    const { file } = newStore();
    writeFileSync(file, '{broken');
    expect(() => new CodexNotifierEventStore(file)).toThrow(/unreadable/);
  });

  it('returns undefined when updating an unknown event', () => {
    const { store } = newStore();
    expect(store.updateDelivery('missing', { status: 'failed' })).toBeUndefined();
  });

  it('keeps pending attempts in memory without rewriting the whole ledger', () => {
    const { store, file } = newStore();
    const event = validEvent('pending-write');
    store.record(event);
    const persistedBefore = readFileSync(file, 'utf8');

    expect(store.updateDelivery(event.eventId, { status: 'pending' })?.delivery).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
    expect(readFileSync(file, 'utf8')).toBe(persistedBefore);

    store.updateDelivery(event.eventId, {
      status: 'delivered',
      messageId: 'om_pending_write',
      incrementAttempts: false,
    });
    expect(new CodexNotifierEventStore(file).get(event.eventId)?.delivery).toMatchObject({
      status: 'delivered',
      attempts: 1,
      messageId: 'om_pending_write',
    });
  });
});

describe('buildCodexCompletionCard', () => {
  it('builds a v2 app completion card with callback-only owner-safe actions', () => {
    const event = validEvent();
    const card = JSON.parse(buildCodexCompletionCard(event, { platform: 'darwin' }));
    expect(card.schema).toBe('2.0');
    const buttonRow = card.body.elements.find((element: any) => element.tag === 'column_set');
    const continueAction = buttonRow.columns[0].elements[0];
    const openAction = buttonRow.columns[1].elements[0];
    expect(continueAction.behaviors[0].value).toEqual({
      action: 'codex_notifier_continue',
      event_id: event.eventId,
    });
    expect(openAction).toMatchObject({
      type: 'default',
      text: { content: '打开 Codex App ↗' },
      behaviors: [{
        type: 'callback',
        value: {
          action: 'codex_notifier_open_app',
          event_id: event.eventId,
        },
      }],
    });
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('project · 修复通知链路');
    expect(serialized).not.toContain('project · project');
    expect(serialized).toContain('任务已经完成。');
    expect(serialized).toContain('会请求运行 BotMux 的 Mac 打开原 Codex App 会话');
    expect(serialized).not.toContain('移动端也可触发');
    expect(serialized).not.toContain('直接回复当前卡片');
    expect(serialized).not.toContain('codex://');
    expect(serialized).not.toContain(APP_THREAD_ID);
    expect(serialized).not.toContain('open_url');
    expect(serialized).not.toContain('turn-1');
    expect(serialized).not.toContain('/workspace/project');
    expect(serialized).not.toMatch(/terminal[_-]?(token|url)/i);
  });

  it.each([
    ['codex-cli', APP_THREAD_ID, 'Codex CLI'],
    [undefined, APP_THREAD_ID, 'Codex App/CLI'],
    ['codex-app', 'not-a-uuid', 'Codex App'],
  ] as const)('omits the app link for surface %s and thread %s', (clientSurface, threadId, label) => {
    const base = validEvent(`without-link-${clientSurface ?? 'legacy'}`);
    const identity = {
      source: base.source,
      threadId,
      nativeTurnId: base.nativeTurnId,
      status: base.status,
    };
    const event: CodexTaskCompletedEvent = {
      ...base,
      eventId: codexNotifierEventId(identity),
      threadId,
      ...(clientSurface ? { clientSurface } : {}),
    };
    if (!clientSurface) delete event.clientSurface;

    const card = JSON.parse(buildCodexCompletionCard(event, { platform: 'darwin' }));
    const buttonRow = card.body.elements.find((element: any) => element.tag === 'column_set');
    expect(buttonRow.columns).toHaveLength(1);
    expect(JSON.stringify(card)).toContain(`载体: \`${label}\``);
    expect(JSON.stringify(card)).not.toContain('codex://threads/');
  });

  it('omits the App-open callback outside macOS', () => {
    const card = JSON.parse(buildCodexCompletionCard(validEvent(), { platform: 'linux' }));
    const buttonRow = card.body.elements.find((element: any) => element.tag === 'column_set');

    expect(buttonRow.columns).toHaveLength(1);
    expect(JSON.stringify(card)).not.toContain('codex_notifier_open_app');
  });

  it('renders Side Chat as result-only because the ephemeral thread cannot be adopted', () => {
    const card = JSON.parse(buildCodexCompletionCard({
      ...validEvent('side'),
      conversationKind: 'side',
    }, { platform: 'darwin' }));
    const serialized = JSON.stringify(card);

    expect(card.body.elements.find((element: any) => element.tag === 'column_set')).toBeUndefined();
    expect(serialized).toContain('Codex App Side Chat');
    expect(serialized).toContain('Side Chat 是临时会话');
    expect(serialized).not.toContain('codex_notifier_continue');
    expect(serialized).not.toContain('codex_notifier_open_app');
  });

  it('does not prepend the project twice for a legacy plugin title', () => {
    const serialized = buildCodexCompletionCard({
      ...validEvent(),
      title: 'project · 修复通知链路',
    });

    expect(serialized).toContain('project · 修复通知链路');
    expect(serialized).not.toContain('project · project');
  });

  it.each([
    ['completed', 'green'],
    ['failed', 'red'],
    ['cancelled', 'orange'],
  ] as const)('maps %s to the %s header', (status, template) => {
    const card = JSON.parse(buildCodexCompletionCard({ ...validEvent(), status }));
    expect(card.header.template).toBe(template);
  });

  it('uses plain text and strips control characters from displayed fields', () => {
    const card = JSON.parse(buildCodexCompletionCard({
      ...validEvent(),
      title: '<at id=all></at>\n伪造通知',
      cwd: '/tmp\u0000/project',
      finalPreview: '第一行\u0000\n第二行',
    }));
    const serialized = JSON.stringify(card);
    const body = card.body.elements.find((element: any) => element.element_id === 'main_content').text;
    expect(body.tag).toBe('plain_text');
    expect(body.lines).toBe(30);
    expect(body.content).toBe('第一行 \n第二行');
    expect(serialized).not.toContain('\u0000');
    expect(serialized).not.toContain('<at id=all>');
  });
});

describe('buildCodexNotifierResultCard', () => {
  it.each([
    ['已接管 Codex App 任务', '可以继续处理', 'green'],
    ['Codex App 任务接管失败', '请稍后重试', 'red'],
  ] as const)('builds a V2 terminal card without stale callback actions', (title, content, template) => {
    const card = buildCodexNotifierResultCard(title, content, template) as any;
    const serialized = JSON.stringify(card);

    expect(card).toMatchObject({
      schema: '2.0',
      config: { update_multi: true },
      header: {
        template,
        title: { tag: 'plain_text', content: title },
      },
      body: {
        direction: 'vertical',
        elements: [{ tag: 'markdown', content }],
      },
    });
    expect(card.elements).toBeUndefined();
    expect(serialized).not.toContain('"tag":"button"');
    expect(serialized).not.toContain('"behaviors"');
  });

  it('escapes callback result content before rendering markdown', () => {
    const card = buildCodexNotifierResultCard(
      '接管失败',
      '<at id=all></at> `伪造内容`',
      'red',
    ) as any;

    expect(card.body.elements[0].content).toBe(
      '\\<at id=all\\>\\</at\\> \\`伪造内容\\`',
    );
  });
});
