import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAskPersistStore,
  askKeyFor,
  dispatchUuidForKey,
  ASK_STORE_SENTINEL,
  type PersistedAsk,
} from '../src/core/ask-persist-store.js';
import {
  registerAsk,
  tryResolveAsk,
  restorePersistedAsks,
  setCardDispatcher,
  setCanTalkChecker,
  setAskPersistStore,
  _pendingCount,
  _setHandoffRetentionForTest,
  _resetForTest,
} from '../src/core/ask-broker.js';
import type { AskCardDispatcher, AskResult, CreateAskInput, PendingAsk } from '../src/core/ask-types.js';
import { AskDispatchError } from '../src/core/ask-types.js';
import { classifyAskDispatchError } from '../src/im/lark/ask-card.js';

/**
 * FROZEN CONTRACT for restart-resume of `botmux ask` (codex round-3 freeze).
 * Each `describe` is one of the six clauses agreed before implementation; every
 * clause leads with a counter-example that FAILS on the pre-fix code and passes
 * only once the clause holds. Re-review runs this matrix instead of re-reading
 * the diff.
 *
 *   1. canonical identity is unique end-to-end (filename + transport uuid)
 *   2. same identity is idempotent across ALL states (active/terminal/dormant)
 *   3. identity mismatch on a shared key FAILS CLOSED (never a silent new ask)
 *   4. only a persistent (restart-surviving) backend is resumable
 *   5. card dispatch partial-success converges (bounded retry, same uuid)
 *   6. handoff has an absolute expiry; memory + disk are cleaned together
 *
 * Clauses 2–6 that need the broker live in ask-resume-restart.test.ts and the
 * clause-specific blocks below; this file owns the pure-identity clause 1 and
 * the seams that don't need a full broker.
 */

const OPTIONS = [
  { key: 'yes', label: '继续' },
  { key: 'no', label: '回滚' },
];

let dataDir: string;

function persistedFiles(dir: string): string[] {
  const d = join(dir, 'asks');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((n) => n.endsWith('.json'));
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-contract-'));
});

afterEach(() => {
  const store = join(dataDir, 'asks');
  if (existsSync(join(store, ASK_STORE_SENTINEL)) || !existsSync(store)) {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function persistedFor(
  larkAppId: string,
  sessionId: string,
  originKind: string,
  requestId: string,
): PersistedAsk {
  return {
    v: 2,
    askKey: askKeyFor(larkAppId, sessionId, originKind, requestId),
    requestId,
    originKind,
    askId: requestId,
    nonce: 'nonce',
    larkAppId,
    chatId: 'oc_chat',
    rootMessageId: null,
    sessionId,
    questions: [{ prompt: '继续发版吗？', options: OPTIONS, multiSelect: false }],
    createdAt: 0,
    deadlineAt: 10_000_000_000_000,
    selections: [[]],
  };
}

describe('clause 1 — canonical identity is unique end-to-end (codex P1-1)', () => {
  it('production-length keys with different requestIds get DISTINCT persisted files', () => {
    // Reproduces the 80-char filename truncation collision: with a real bot id
    // (cli_ + 32 hex = 36 chars) and a uuid sessionId, the joined key pushes the
    // requestId past character 80 — the pre-fix filePath truncated the WHOLE key
    // to 80 chars, so two distinct requestIds sharing an 80-char prefix collapsed
    // to ONE file (one card silently overwrote the other's durable record).
    const store = createAskPersistStore(join(dataDir, 'asks'));
    const app = 'cli_' + 'a'.repeat(32); // 36 chars, like a real Feishu app id
    const sess = '11111111-1111-1111-1111-111111111111'; // 36-char uuid session
    store.put(persistedFor(app, sess, 'hook', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
    store.put(persistedFor(app, sess, 'hook', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'));
    expect(persistedFiles(dataDir)).toHaveLength(2); // pre-fix: 1 (collision)
  });

  it('two invocations differing ONLY in the tail of a long requestId do not collide', () => {
    const store = createAskPersistStore(join(dataDir, 'asks'));
    const app = 'cli_' + 'c'.repeat(32);
    const sess = '22222222-2222-2222-2222-222222222222';
    // Long, identical-prefix requestIds — differ only far past char 80.
    const long = 'req-' + 'x'.repeat(200);
    store.put(persistedFor(app, sess, 'hook', long + 'A'));
    store.put(persistedFor(app, sess, 'hook', long + 'B'));
    expect(persistedFiles(dataDir)).toHaveLength(2);
  });

  it('askKeyFor is injective for the full tuple (no delimiter aliasing)', () => {
    // Length-prefixed canonical form must not alias "a|bc" vs "ab|c".
    expect(askKeyFor('cli', 'a', 'hook', 'bc')).not.toBe(askKeyFor('cli', 'ab', 'hook', 'c'));
    expect(askKeyFor('cli_app', 'sess-1', 'hook', 'req-1')).toBe(
      askKeyFor('cli_app', 'sess-1', 'hook', 'req-1'),
    ); // deterministic
    expect(askKeyFor('cli_app', 'sess-2', 'hook', 'req-1')).not.toBe(
      askKeyFor('cli_app', 'sess-1', 'hook', 'req-1'),
    );
    expect(askKeyFor('cli_app', 'sess-1', 'explicit', 'req-1')).not.toBe(
      askKeyFor('cli_app', 'sess-1', 'hook', 'req-1'),
    );
  });

  it('dispatch uuid: stable per invocation, distinct across sessions, ≤50 chars', () => {
    const kA = askKeyFor('cli_app', 'sess-A', 'hook', 'shared-req');
    const kB = askKeyFor('cli_app', 'sess-B', 'hook', 'shared-req');
    // Same invocation → same uuid (a restart re-send dedupes server-side).
    expect(dispatchUuidForKey(kA)).toBe(
      dispatchUuidForKey(askKeyFor('cli_app', 'sess-A', 'hook', 'shared-req')),
    );
    // Same requestId, different session → DIFFERENT uuid (uuid is not a bearer
    // token that a second session could reuse to alias the first's card).
    expect(dispatchUuidForKey(kA)).not.toBe(dispatchUuidForKey(kB));
    // Feishu message uuid hard cap.
    expect(dispatchUuidForKey(kA).length).toBeLessThanOrEqual(50);
  });
});

// --- broker-backed clauses (2 & 3) -------------------------------------------

const BROKER_QS = [{ prompt: '继续发版吗？', options: OPTIONS, multiSelect: false }];

function brokerInput(over: Partial<CreateAskInput> = {}): CreateAskInput {
  return {
    larkAppId: 'cli_app',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    sessionId: 'sess-1',
    requestId: 'req-1',
    originKind: 'hook',
    backendSurvivesRestart: true, // tmux-backed hook: resumable
    questions: BROKER_QS,
    timeoutMs: 60_000,
    ...over,
  };
}

function mockDispatcher(): AskCardDispatcher & { sendCalls: PendingAsk[] } {
  const sendCalls: PendingAsk[] = [];
  return {
    async send(ask) { sendCalls.push(ask); return { messageId: `om_card_${ask.askId}` }; },
    onSettle() {},
    sendCalls,
  };
}

function brokerFiles(): PersistedAsk[] {
  const dir = join(dataDir, 'asks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf-8')) as PersistedAsk);
}

describe('clause 2 — same identity is idempotent across ALL states (codex P1-1)', () => {
  beforeEach(() => {
    _resetForTest();
    setAskPersistStore(createAskPersistStore(join(dataDir, 'asks')));
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
  });
  afterEach(() => { _resetForTest(); });

  it('terminal-state replay returns the SAME result (no new card, no re-ask)', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    const p1 = registerAsk(brokerInput());
    await new Promise((r) => setTimeout(r, 5));
    const rec = brokerFiles()[0]!;
    // Answer it → settles, record removed, entry retained briefly for replay.
    expect(tryResolveAsk({ askId: rec.askId, nonce: rec.nonce, selected: 'yes', by: 'ou_owner' })).toBe('accepted');
    const r1 = await p1;
    // Same-identity re-POST in the retention window → identical terminal result,
    // NOT a fresh ask, NOT a second card.
    const r2 = await registerAsk(brokerInput());
    expect(r2).toEqual(r1);
    expect(d.sendCalls).toHaveLength(1);
  });
});

describe('clause 3 — identity mismatch on a shared key FAILS CLOSED (codex P1-2)', () => {
  beforeEach(() => {
    _resetForTest();
    setAskPersistStore(createAskPersistStore(join(dataDir, 'asks')));
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
  });
  afterEach(() => { _resetForTest(); });

  it('same key + DIFFERENT questions → invalidated (never a silent fall-through new ask)', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    registerAsk(brokerInput()); // active ask with req-1
    await new Promise((r) => setTimeout(r, 5));
    expect(d.sendCalls).toHaveLength(1);

    // A second register REUSES the same (app/session/origin/request) key but the
    // question set differs — a crafted / stale-but-mutated re-POST. Pre-fix this
    // fell THROUGH to a brand-new ask (a second card, ambiguous which the click
    // resolves). It must instead fail closed: the caller gets `invalidated`, and
    // NO second card is posted.
    const conflicting = brokerInput({
      questions: [{ prompt: '完全不同的问题', options: OPTIONS, multiSelect: false }],
    });
    const result = await registerAsk(conflicting);
    expect(result.kind).toBe('invalidated');
    expect(d.sendCalls).toHaveLength(1); // no second card
  });

  it('questionsShape distinguishes a changed option LABEL (not just keys/prompt)', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    registerAsk(brokerInput());
    await new Promise((r) => setTimeout(r, 5));
    // Same prompt, same option keys, but a DIFFERENT visible label → the user
    // would see a different card, so it must not silently re-attach/replay.
    const relabelled = brokerInput({
      questions: [{ prompt: '继续发版吗？', options: [
        { key: 'yes', label: '完全不同的标签' },
        { key: 'no', label: '回滚' },
      ], multiSelect: false }],
    });
    const result = await registerAsk(relabelled);
    expect(result.kind).toBe('invalidated');
    expect(d.sendCalls).toHaveLength(1);
  });
});

describe('clause 5 — dispatch partial-success converges (codex P1-3)', () => {
  beforeEach(() => {
    _resetForTest();
    setAskPersistStore(createAskPersistStore(join(dataDir, 'asks')));
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
  });
  afterEach(() => { _resetForTest(); });

  it('a transient send failure is retried with the SAME uuid → one logical card, broker stays pending', async () => {
    // First attempt: send actually LANDS server-side but the client sees a
    // socket reset (retryable). Second attempt: Feishu dedupes on the same uuid
    // and returns the ORIGINAL message_id. Net: one card, ask still awaiting a
    // click (NOT invalidated).
    let attempts = 0;
    const uuids: (string | undefined)[] = [];
    const d: AskCardDispatcher & { sendCalls: PendingAsk[] } = {
      sendCalls: [],
      async send(ask) {
        this.sendCalls.push(ask);
        uuids.push(ask.dispatchUuid);
        attempts++;
        if (attempts === 1) throw new AskDispatchError('socket hang up', true); // transient
        return { messageId: 'om_original' }; // server-side dedupe returns original
      },
      onSettle() {},
    };
    setCardDispatcher(d);
    registerAsk(brokerInput());
    // Wait past the first backoff (500ms) so the retry runs.
    await new Promise((r) => setTimeout(r, 900));
    expect(attempts).toBe(2);                    // retried exactly once
    expect(uuids[0]).toBe(uuids[1]);             // SAME uuid on retry
    expect(uuids[0]).toBeTruthy();               // resumable → has a uuid
    expect(_pendingCount()).toBe(1);             // still awaiting a click, NOT invalidated
  });

  it('a deterministic 4xx send failure invalidates immediately (no retry)', async () => {
    let attempts = 0;
    const d: AskCardDispatcher = {
      async send() { attempts++; throw new AskDispatchError('http 403: permission denied', false); },
      onSettle() {},
    };
    setCardDispatcher(d);
    const result = await registerAsk(brokerInput());
    expect(result.kind).toBe('invalidated');
    expect(attempts).toBe(1);                    // no retry on deterministic failure
  });

  it('an UNTYPED throw fails closed (treated as not retryable)', async () => {
    let attempts = 0;
    const d: AskCardDispatcher = {
      async send() { attempts++; throw new Error('plain error'); },
      onSettle() {},
    };
    setCardDispatcher(d);
    const result = await registerAsk(brokerInput());
    expect(result.kind).toBe('invalidated');
    expect(attempts).toBe(1);                    // fail closed — no retry when idempotency unproven
  });

  // codex P1-1 (regression the retry-all change introduced): a NON-resumable ask
  // (explicit `botmux ask buttons`, or a PTY-backed hook) ALSO retries — so it
  // MUST carry a dedupe uuid, or the retry after a landed-but-reset send posts a
  // second real card. dispatchUuid is now decoupled from resumability.
  for (const variant of [
    { name: 'explicit ask', over: { originKind: 'explicit' as const, requestId: undefined, backendSurvivesRestart: false } },
    { name: 'PTY-backed hook', over: { backendSurvivesRestart: false } },
  ]) {
    it(`${variant.name}: transient retry reuses the SAME uuid → one logical card (not double-send)`, async () => {
      let attempts = 0;
      const uuids: (string | undefined)[] = [];
      const d: AskCardDispatcher & { sendCalls: PendingAsk[] } = {
        sendCalls: [],
        async send(ask) {
          this.sendCalls.push(ask);
          uuids.push(ask.dispatchUuid);
          attempts++;
          if (attempts === 1) throw new AskDispatchError('socket hang up', true);
          return { messageId: 'om_original' };
        },
        onSettle() {},
      };
      setCardDispatcher(d);
      registerAsk(brokerInput(variant.over));
      await new Promise((r) => setTimeout(r, 900));
      expect(attempts).toBe(2);
      expect(uuids[0]).toBeTruthy();      // non-resumable STILL gets a uuid now
      expect(uuids[1]).toBe(uuids[0]);    // same uuid on retry → server dedupes
      expect(brokerFiles()).toHaveLength(0); // and it is still NOT persisted (backend gate intact)
    });
  }
});

describe('clause 5 — classifier decision table (executable seam, codex P1-3)', () => {
  it('network / no-response → retryable', () => {
    expect(classifyAskDispatchError({ isAxiosError: true, message: 'ECONNRESET' }).retryable).toBe(true);
  });
  it('HTTP 429 and 5xx → retryable', () => {
    expect(classifyAskDispatchError({ isAxiosError: true, response: { status: 429 } }).retryable).toBe(true);
    expect(classifyAskDispatchError({ isAxiosError: true, response: { status: 500 } }).retryable).toBe(true);
    expect(classifyAskDispatchError({ isAxiosError: true, response: { status: 503 } }).retryable).toBe(true);
  });
  it('HTTP 4xx (except 429) → NOT retryable', () => {
    expect(classifyAskDispatchError({ isAxiosError: true, response: { status: 400 } }).retryable).toBe(false);
    expect(classifyAskDispatchError({ isAxiosError: true, response: { status: 403 } }).retryable).toBe(false);
    expect(classifyAskDispatchError({ isAxiosError: true, response: { status: 404 } }).retryable).toBe(false);
  });
  it('plain Error (2xx-body business error / withdrawn) → NOT retryable (fail closed)', () => {
    expect(classifyAskDispatchError(new Error('Failed to send message: xxx (code: 230011)')).retryable).toBe(false);
    expect(classifyAskDispatchError('nope').retryable).toBe(false);
    expect(classifyAskDispatchError(undefined).retryable).toBe(false);
  });
  it('transient Lark business codes are retryable EVEN on HTTP 400 / 2xx-body (codex P1-3)', () => {
    // 230049 "message is being sent" — official retry-later; can appear as the
    // second same-uuid partial-success request while the first is still landing.
    expect(classifyAskDispatchError({ isAxiosError: true, response: { status: 400, data: { code: 230049, msg: 'The message is being sent.' } } }).retryable).toBe(true);
    // 230020 per-chat rate limit; 99991400 generic OpenAPI freq-control (legacy 400).
    expect(classifyAskDispatchError({ isAxiosError: true, response: { status: 400, data: { code: 230020 } } }).retryable).toBe(true);
    expect(classifyAskDispatchError({ isAxiosError: true, response: { status: 400, data: { code: 99991400 } } }).retryable).toBe(true);
    // Same code surfacing via a 2xx-body plain Error (code only in the message).
    expect(classifyAskDispatchError(new Error('Failed to reply message: being sent (code: 230049)')).retryable).toBe(true);
    // A NON-whitelisted business code on 400 stays deterministic.
    expect(classifyAskDispatchError({ isAxiosError: true, response: { status: 400, data: { code: 230011 } } }).retryable).toBe(false);
  });
});

describe('clause 4 — only a restart-surviving backend is resumable (codex P1-4)', () => {
  beforeEach(() => {
    _resetForTest();
    setAskPersistStore(createAskPersistStore(join(dataDir, 'asks')));
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
  });
  afterEach(() => { _resetForTest(); });

  it('a hook on a NON-persistent (PTY) backend is NOT persisted (no orphan record)', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    // Same hook origin + requestId, but the daemon reports the backend does NOT
    // survive a restart (pty). Pre-fix, resumability keyed off originKind alone
    // → this persisted a record no reconnecting hook could ever exist to claim.
    registerAsk(brokerInput({ backendSurvivesRestart: false }));
    await new Promise((r) => setTimeout(r, 5));
    expect(brokerFiles()).toHaveLength(0);        // never persisted
    // But its card STILL carries a dedupe uuid (codex P1-1): the bounded retry
    // re-sends even a non-resumable card, so it needs server-side dedupe. uuid
    // gates dispatch idempotency; persistence is gated separately (backend).
    expect(d.sendCalls[0]!.dispatchUuid).toBeTruthy();
  });

  it('an undefined backend signal fails closed (not persisted) but still carries a uuid', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    registerAsk(brokerInput({ backendSurvivesRestart: undefined }));
    await new Promise((r) => setTimeout(r, 5));
    expect(brokerFiles()).toHaveLength(0);
    expect(d.sendCalls[0]!.dispatchUuid).toBeTruthy(); // dedupe uuid decoupled from persistence
  });

  it('a hook on a persistent (tmux) backend IS persisted and carries a uuid', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    registerAsk(brokerInput({ backendSurvivesRestart: true }));
    await new Promise((r) => setTimeout(r, 5));
    expect(brokerFiles()).toHaveLength(1);
    expect(d.sendCalls[0]!.dispatchUuid).toBeTruthy();
  });
});

describe('clause 6 — handoff has absolute expiry; memory + disk cleaned together (codex P1-4)', () => {
  beforeEach(() => {
    _resetForTest();
    setAskPersistStore(createAskPersistStore(join(dataDir, 'asks')));
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
  });
  afterEach(() => { _resetForTest(); });

  it('an UNCLAIMED stash is reaped from memory AND disk at answeredAt + retention', async () => {
    _setHandoffRetentionForTest(120); // 120ms window instead of 24h
    setCardDispatcher(mockDispatcher());
    registerAsk(brokerInput());
    await new Promise((r) => setTimeout(r, 5));
    const rec = brokerFiles()[0]!;

    // Simulate a restart → restore dormant → user answers the dormant card
    // BEFORE the hook reconnects (stash). Nobody ever claims it.
    _resetForTest();
    _setHandoffRetentionForTest(120);
    setAskPersistStore(createAskPersistStore(join(dataDir, 'asks')));
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    setCardDispatcher(mockDispatcher());
    restorePersistedAsks(Date.now(), 'cli_app');
    expect(tryResolveAsk({ askId: rec.askId, nonce: rec.nonce, selected: 'yes', by: 'ou_owner' })).toBe('accepted');
    expect(brokerFiles()).toHaveLength(1);   // stashed, awaiting claim
    expect(_pendingCount()).toBe(0);         // settled (terminal), not awaiting a click

    // Wait past the shrunk retention → the absolute-expiry reaper fires and
    // clears BOTH memory and disk (not just a boot list() sweep).
    await new Promise((r) => setTimeout(r, 220));
    expect(brokerFiles()).toHaveLength(0);   // disk reaped
    // memory: the entry is gone (no dormant handoff lingering).
    // (indirect: a fresh restore finds nothing.)
    restorePersistedAsks(Date.now(), 'cli_app');
    expect(_pendingCount()).toBe(0);
  });

  it('a CLAIMED stash cancels the reaper (no double-free, answer delivered once)', async () => {
    _setHandoffRetentionForTest(120);
    setCardDispatcher(mockDispatcher());
    registerAsk(brokerInput());
    await new Promise((r) => setTimeout(r, 5));
    const rec = brokerFiles()[0]!;

    _resetForTest();
    _setHandoffRetentionForTest(120);
    setAskPersistStore(createAskPersistStore(join(dataDir, 'asks')));
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    setCardDispatcher(mockDispatcher());
    restorePersistedAsks(Date.now(), 'cli_app');
    tryResolveAsk({ askId: rec.askId, nonce: rec.nonce, selected: 'yes', by: 'ou_owner' });
    // Hook reconnects and CLAIMS the stash before the reaper fires.
    const result = await registerAsk(brokerInput());
    expect(result.kind).toBe('answered');
    expect(brokerFiles()).toHaveLength(0);   // claimed → removed

    // Let the (now-cancelled) reaper's original deadline pass; nothing crashes,
    // no resurrection.
    await new Promise((r) => setTimeout(r, 220));
    expect(brokerFiles()).toHaveLength(0);
    expect(_pendingCount()).toBe(0);
  });
});
