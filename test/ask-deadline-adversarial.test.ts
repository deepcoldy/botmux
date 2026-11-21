import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as realBroker from '../src/core/ask-broker.js';
import * as form from '../src/core/ask-form.js';
import * as decisions from '../src/core/human-decision-store.js';
import * as persist from '../src/core/ask-persist-store.js';
import * as types from '../src/core/ask-types.js';
import * as custom from '../src/core/ask-custom-input.js';
import * as hooks from '../src/core/ask-hook/types.js';
import { logger } from '../src/utils/logger.js';
import type { CreateAskInput, PendingAsk, AskResult } from '../src/core/ask-types.js';

// 非文本断言：变异仅在内存中执行真实 broker，断言返回值及持久化结果。
function mutatedBroker(): typeof realBroker {
  const source = ts.createSourceFile('ask-broker.ts', readFileSync(new URL('../src/core/ask-broker.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  let code = source.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(source)).join('\n');
  const guards: Record<string, [string, string]> = {
    deadline: ['Date.now() >= ask.deadlineAt', 'false'],
    boundary: ['Date.now() >= ask.deadlineAt', 'Date.now() > ask.deadlineAt'],
    delivery: ['(!ask.timeoutStartsAfterDelivery || ask.timeoutStartedAt !== undefined)', 'true'],
    // An indefinite ask also lacks a started delivery clock; disable both exemptions together.
    indefinite: ['ask.timeoutMs !== 0\n    && (!ask.timeoutStartsAfterDelivery || ask.timeoutStartedAt !== undefined)', 'true'],
    desktop: ['expireAskAtDeadline(ask);\n  if (!ask)', 'if (!ask)'],
  };
  const name = process.env.ASK_DEADLINE_REVIEW_MUTATION!;
  const guard = guards[name];
  if (!guard || !code.includes(guard[0])) throw Error(`Missing guard ${name}`);
  code = code.replace(guard[0], guard[1]);
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const scope = { ...form, ...decisions, ...persist, ...types, ...custom, ...hooks, randomUUID, logger, exports: {} };
  return new Function('scope', `with(scope) { ${compiled}; return exports; }`)(scope);
}
const broker = process.env.ASK_DEADLINE_REVIEW_MUTATION ? mutatedBroker() : realBroker;
const input = (over: Partial<CreateAskInput> = {}): CreateAskInput => ({
  larkAppId: 'cli_test', sessionId: 'session', chatId: 'oc_test', rootMessageId: 'om_thread', timeoutMs: 5000,
  questions: [{ prompt: 'Continue?', multiSelect: false, allowCustom: false, options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }] }], ...over,
});
let cards: PendingAsk[], results: AskResult[];
const temporaryDirs: string[] = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-20T00:00:00Z')); broker._resetForTest();
  cards = []; results = [];
  broker.setCanTalkChecker(() => true);
  broker.setCardDispatcher({ send: async ask => { cards.push(ask); return { messageId: 'om_card' }; },
    onSettle: (_ask, result) => { results.push(result); } });
});
afterEach(() => {
  broker._resetForTest(); vi.useRealTimers();
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const flush = async () => { for (let n = 0; n < 6; n++) await Promise.resolve(); };
const args = () => ({ askId: cards[0].askId, nonce: cards[0].nonce, by: 'ou_operator' });

describe('deadline arbitration under delayed timer delivery', () => {
  for (const path of ['button', 'submit', 'toggle', 'form', 'text', 'draft', 'desktop']) {
    it.each([-1, 0, 1])(`${path} arbitrates at deadline offset %i`, async offset => {
      const spec = input(path === 'form' ? { questions: [{ prompt: 'Text', multiSelect: false, options: [], input: { type: 'text' } }] }
        : path === 'draft' ? { questions: [{ ...input().questions[0], allowCustom: true }] } : {});
      const waiting = broker.registerAsk(spec); await flush();
      vi.setSystemTime(cards[0].deadlineAt + offset);
      const a = args();
      const outcome = path === 'button' ? broker.tryResolveAsk({ ...a, selected: 'yes' })
        : path === 'submit' ? broker.submitAsk({ ...a, selections: [['yes']] })
        : path === 'toggle' ? broker.toggleAsk({ ...a, questionIndex: 0, key: 'yes' })
        : path === 'form' ? broker.submitAskForm({ ...a, values: { q0: 'answer' } })
        : path === 'text' ? broker.submitCustomReply({ ...a, text: 'answer' })
        : path === 'draft' ? broker.applyAskForm({ ...a, revision: 0, fields: {}, toggle: { questionIndex: 0, key: 'yes' } })
        : broker.submitAskFromDesktop({ ...a, selections: [['yes']] });
      expect(outcome).toBe(offset >= 0 ? 'already_settled' : ['toggle', 'draft'].includes(path) ? 'toggled' : 'accepted');
      if (offset < 0 && ['toggle', 'draft'].includes(path)) broker.invalidateAll('test cleanup');
      expect((await waiting).kind).toBe(offset >= 0 ? 'timedOut' : ['toggle', 'draft'].includes(path) ? 'invalidated' : 'answered');
      await vi.runAllTimersAsync(); expect(results).toHaveLength(1);
    });
  }

  it('does not start a host decision window during delayed delivery', async () => {
    let delivered!: (value: { messageId: string }) => void;
    broker.setCardDispatcher({ send: ask => { cards.push(ask); return new Promise(r => { delivered = r; }); } });
    const waiting = broker.registerHostAsk(input({ originKind: 'host_explicit', requestId: 'delivery' }));
    vi.setSystemTime(cards[0].deadlineAt + 20000);
    expect(broker.toggleAsk({ ...args(), questionIndex: 0, key: 'yes' })).toBe('toggled');
    delivered({ messageId: 'om_late' }); await flush();
    const current = broker.getAskSnapshot(cards[0].askId)!;
    expect(current.deadlineAt).toBeGreaterThan(Date.now());
    vi.setSystemTime(current.deadlineAt);
    expect(broker.submitAsk({ ...args(), selections: [['yes']] })).toBe('already_settled');
    expect((await waiting).kind).toBe('timedOut');
  });

  it('keeps an indefinite host ask answerable after wall-clock movement', async () => {
    const waiting = broker.registerHostAsk(input({ originKind: 'host_explicit', requestId: 'unlimited', timeoutMs: 0 }));
    await flush(); vi.setSystemTime(Date.now() + 30 * 86400000);
    expect(broker.submitAsk({ ...args(), selections: [['yes']] })).toBe('accepted');
    expect((await waiting).kind).toBe('answered');
  });

  it('does not turn manual revocation into timeout or a late answer', async () => {
    const waiting = broker.registerAsk(input()); await flush();
    broker.invalidateAll('operator cancelled'); vi.setSystemTime(cards[0].deadlineAt + 1);
    expect(broker.submitAsk({ ...args(), selections: [['yes']] })).toBe('already_settled');
    expect(await waiting).toMatchObject({ kind: 'invalidated', reason: 'operator cancelled' });
    await vi.runAllTimersAsync(); expect(results).toHaveLength(1);
  });

  it('persists the timeout before an interrupted card patch and replays it after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-deadline-review-')); temporaryDirs.push(dir);
    const store = persist.createAskPersistStore(dir);
    broker.setAskPersistStore(store);
    broker.setCardDispatcher({ send: async ask => { cards.push(ask); return { messageId: 'om_card' }; },
      onSettle: () => { throw Error('injected card patch failure'); } });
    const spec = input({ originKind: 'host_explicit', requestId: 'durable' });
    const waiting = broker.registerHostAsk(spec); await flush();
    vi.setSystemTime(broker.getAskSnapshot(cards[0].askId)!.deadlineAt);
    expect(broker.submitAsk({ ...args(), selections: [['yes']] })).toBe('already_settled');
    expect((await waiting).kind).toBe('timedOut');
    expect(store.list()[0].answeredResult?.kind).toBe('timedOut');
    broker._resetForTest(); broker.setAskPersistStore(store);
    broker.setCardDispatcher({ send: async () => { throw Error('must not redeliver terminal card'); } });
    expect(broker.restorePersistedAsks()).toBe(1);
    expect((await broker.registerHostAsk(spec)).kind).toBe('timedOut');
  });
});
