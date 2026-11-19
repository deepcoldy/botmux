/**
 * Daemon-owned first-message claim for a silent fresh-topic schedule run,
 * used when the CLI cannot write `<dataDir>/deferred-topics` (sandbox / read
 * isolation). Pins: only the capability's own scheduled turn may claim; one
 * publisher at a time; the daemon records a root only after proving it is a
 * top-level message this bot sent into the session's chat; and the CLI-side
 * store keeps the exact dispatch semantics of the file-backed store.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFERRED_TOPIC_LEASE_TTL_MS,
  DeferredTopicClaimRegistry,
  deferredTopicRootFactsFromDetail,
  parseDeferredTopicClaimRequest,
  type DeferredTopicRootFacts,
} from '../src/core/deferred-topic-claim.js';
import {
  probeDeferredTopicBindingWritable,
  readDeferredTopicBinding,
  writeDeferredTopicBinding,
} from '../src/core/deferred-topic-binding.js';
import { dispatchDeferredTopicSend } from '../src/cli/deferred-topic-send.js';
import {
  peekRemoteDeferredTopicBinding,
  remoteDeferredTopicBindingStore,
  resolveDeferredTopicIpcPort,
} from '../src/cli/deferred-topic-remote-store.js';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const TURN_ID = 'schedule:task-9:run-3';
const ANCHOR = 'schedule-run:task-9:run-3';

function liveSession(turnId: string | null = TURN_ID, extra: Record<string, unknown> = {}): any {
  return {
    session: {
      sessionId: SESSION_ID,
      status: 'active',
      deferredScheduleRun: { taskId: 'task-9', turnId: TURN_ID, routingAnchor: ANCHOR, createdAt: '2026-10-20T00:00:00.000Z' },
      ...extra,
    },
    larkAppId: 'cli_app',
    chatId: 'oc_target',
    managedTurnOrigin: { capability: 'cap', ...(turnId ? { turnId } : {}) },
  };
}

function cliSession(ds: any) {
  return {
    sessionId: ds.session.sessionId,
    chatId: ds.chatId,
    larkAppId: ds.larkAppId,
    deferredScheduleRun: ds.session.deferredScheduleRun,
  };
}

const RUN_STARTED = Date.parse('2026-10-20T00:00:00.000Z');
const GOOD_ROOT: DeferredTopicRootFacts = { chatId: 'oc_target', senderAppId: 'cli_app', isReply: false, createdAtMs: RUN_STARTED + 60_000 };

describe('DeferredTopicClaimRegistry', () => {
  let dataDir: string;
  let now: number;
  let lookupRoot: ReturnType<typeof vi.fn>;
  let registry: DeferredTopicClaimRegistry;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-deferred-claim-'));
    now = 1_000_000;
    lookupRoot = vi.fn(async () => GOOD_ROOT);
    registry = new DeferredTopicClaimRegistry({
      readBinding: id => readDeferredTopicBinding(dataDir, id),
      writeBinding: b => writeDeferredTopicBinding(dataDir, b),
      lookupRoot: lookupRoot as any,
      now: () => now,
    });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('grants a lease only to the capability turn of the scheduled run', async () => {
    expect(await registry.handle(liveSession('some-later-turn'), { action: 'claim' }))
      .toEqual({ ok: true, state: 'not_claimable', reason: 'turn_mismatch' });
    expect(await registry.handle(liveSession(null), { action: 'claim' }))
      .toEqual({ ok: true, state: 'not_claimable', reason: 'turn_mismatch' });
    expect(await registry.handle(liveSession(), { action: 'claim' }))
      .toMatchObject({ ok: true, state: 'claimed' });
  });

  it('refuses sessions that are gone or not a deferred run', async () => {
    expect(await registry.handle(undefined, { action: 'claim' })).toMatchObject({ ok: false, status: 404 });
    expect(await registry.handle(liveSession(TURN_ID, { status: 'closed' }), { action: 'claim' }))
      .toMatchObject({ ok: false, status: 404 });
    expect(await registry.handle(liveSession(TURN_ID, { deferredScheduleRun: undefined }), { action: 'claim' }))
      .toMatchObject({ ok: false, status: 409, error: 'not_deferred_run' });
  });

  it('serializes publishers and lets an expired lease be taken over', async () => {
    const ds = liveSession();
    const first = await registry.handle(ds, { action: 'claim' }) as any;
    expect(first.state).toBe('claimed');
    expect(await registry.handle(ds, { action: 'claim' })).toEqual({ ok: true, state: 'busy' });

    now += DEFERRED_TOPIC_LEASE_TTL_MS + 1;
    const second = await registry.handle(ds, { action: 'claim' }) as any;
    expect(second.state).toBe('claimed');
    expect(second.leaseId).not.toBe(first.leaseId);
    // The superseded holder can no longer record a root.
    expect(await registry.handle(ds, { action: 'commit', leaseId: first.leaseId, rootMessageId: 'om_late' }))
      .toMatchObject({ ok: false, error: 'lease_lost' });
    expect(readDeferredTopicBinding(dataDir, SESSION_ID)).toBeUndefined();
  });

  it('records a verified root, then answers every caller with it', async () => {
    const ds = liveSession();
    const { leaseId } = await registry.handle(ds, { action: 'claim' }) as any;
    const committed = await registry.handle(ds, { action: 'commit', leaseId, rootMessageId: 'om_root_1' });
    expect(committed).toMatchObject({ ok: true, state: 'bound', rootMessageId: 'om_root_1' });
    expect(lookupRoot).toHaveBeenCalledWith('cli_app', 'om_root_1');
    expect(readDeferredTopicBinding(dataDir, SESSION_ID)).toMatchObject({
      sessionId: SESSION_ID, turnId: TURN_ID, chatId: 'oc_target', larkAppId: 'cli_app',
      routingAnchor: ANCHOR, rootMessageId: 'om_root_1',
    });
    expect(await registry.handle(ds, { action: 'claim' })).toMatchObject({ state: 'bound', rootMessageId: 'om_root_1' });
    expect(await registry.handle(ds, { action: 'peek' })).toMatchObject({ state: 'bound', rootMessageId: 'om_root_1' });
    // A retried commit converges on the same root only.
    expect(await registry.handle(ds, { action: 'commit', leaseId, rootMessageId: 'om_root_1' }))
      .toMatchObject({ ok: true, state: 'bound' });
    expect(await registry.handle(ds, { action: 'commit', leaseId, rootMessageId: 'om_other' }))
      .toMatchObject({ ok: false, error: 'already_bound' });
  });

  it.each([
    ['another chat', { ...GOOD_ROOT, chatId: 'oc_elsewhere' }, 'root_outside_target_chat'],
    ['another sender', { ...GOOD_ROOT, senderAppId: 'cli_other' }, 'root_not_sent_by_bot'],
    ['a human sender', { ...GOOD_ROOT, senderAppId: undefined }, 'root_not_sent_by_bot'],
    ['a reply in a thread', { ...GOOD_ROOT, isReply: true }, 'root_not_top_level'],
    ['before the run fired (an older bot topic)', { ...GOOD_ROOT, createdAtMs: RUN_STARTED - 11_000 }, 'root_predates_run'],
    ['a message with no creation time', { ...GOOD_ROOT, createdAtMs: undefined }, 'root_predates_run'],
  ])('refuses a root from %s', async (_label, facts, error) => {
    lookupRoot.mockResolvedValueOnce(facts);
    const ds = liveSession();
    const { leaseId } = await registry.handle(ds, { action: 'claim' }) as any;
    expect(await registry.handle(ds, { action: 'commit', leaseId, rootMessageId: 'om_forged' }))
      .toMatchObject({ ok: false, status: 409, error });
    expect(readDeferredTopicBinding(dataDir, SESSION_ID)).toBeUndefined();
  });

  it('fails closed when the provider cannot resolve the root', async () => {
    const ds = liveSession();
    lookupRoot.mockRejectedValueOnce(new Error('timeout'));
    const { leaseId } = await registry.handle(ds, { action: 'claim' }) as any;
    expect(await registry.handle(ds, { action: 'commit', leaseId, rootMessageId: 'om_root_1' }))
      .toMatchObject({ ok: false, status: 502, error: 'root_lookup_failed' });
    lookupRoot.mockResolvedValueOnce(null);
    expect(await registry.handle(ds, { action: 'commit', leaseId, rootMessageId: 'om_root_1' }))
      .toMatchObject({ ok: false, status: 502, error: 'root_lookup_failed' });
    expect(readDeferredTopicBinding(dataDir, SESSION_ID)).toBeUndefined();
    // The lease survives a failed lookup, so a retry by the holder can finish.
    expect(await registry.handle(ds, { action: 'commit', leaseId, rootMessageId: 'om_root_1' }))
      .toMatchObject({ ok: true, state: 'bound' });
  });

  it('refuses the commit of a holder whose lease was taken over during the root lookup', async () => {
    const ds = liveSession();
    const { leaseId } = await registry.handle(ds, { action: 'claim' }) as any;
    let second: any;
    lookupRoot.mockImplementationOnce(async () => {
      // The provider is slow: the lease expires and another send takes over.
      now += DEFERRED_TOPIC_LEASE_TTL_MS + 1;
      second = await registry.handle(ds, { action: 'claim' });
      return GOOD_ROOT;
    });
    expect(await registry.handle(ds, { action: 'commit', leaseId, rootMessageId: 'om_root_1' }))
      .toMatchObject({ ok: false, status: 409, error: 'lease_lost' });
    expect(second).toMatchObject({ ok: true, state: 'claimed' });
    expect(readDeferredTopicBinding(dataDir, SESSION_ID)).toBeUndefined();
  });

  it('refuses a commit once the capability moved to another turn', async () => {
    const ds = liveSession();
    const { leaseId } = await registry.handle(ds, { action: 'claim' }) as any;
    ds.managedTurnOrigin = { capability: 'cap2', turnId: 'next-turn' };
    expect(await registry.handle(ds, { action: 'commit', leaseId, rootMessageId: 'om_root_1' }))
      .toMatchObject({ ok: false, error: 'turn_mismatch' });
    expect(lookupRoot).not.toHaveBeenCalled();
  });

  it('renewal keeps a live holder from being taken over', async () => {
    const ds = liveSession();
    const { leaseId } = await registry.handle(ds, { action: 'claim' }) as any;
    now += DEFERRED_TOPIC_LEASE_TTL_MS - 1;
    expect(await registry.handle(ds, { action: 'renew', leaseId })).toEqual({ ok: true, state: 'renewed' });
    now += DEFERRED_TOPIC_LEASE_TTL_MS - 1;
    expect(await registry.handle(ds, { action: 'claim' })).toEqual({ ok: true, state: 'busy' });
    now += 2;
    const taken = await registry.handle(ds, { action: 'claim' }) as any;
    expect(taken.state).toBe('claimed');
    // The superseded holder cannot resurrect its lease.
    expect(await registry.handle(ds, { action: 'renew', leaseId })).toMatchObject({ ok: false, error: 'lease_lost' });
  });

  it('accepts a root within the clock-skew allowance of the run start', async () => {
    lookupRoot.mockResolvedValueOnce({ ...GOOD_ROOT, createdAtMs: RUN_STARTED - 9_000 });
    const ds = liveSession();
    const { leaseId } = await registry.handle(ds, { action: 'claim' }) as any;
    expect(await registry.handle(ds, { action: 'commit', leaseId, rootMessageId: 'om_root_1' }))
      .toMatchObject({ ok: true, state: 'bound' });
  });

  it('release frees the lease for the next publisher', async () => {
    const ds = liveSession();
    const { leaseId } = await registry.handle(ds, { action: 'claim' }) as any;
    expect(await registry.handle(ds, { action: 'release', leaseId: '00000000-0000-4000-8000-000000000000' }))
      .toEqual({ ok: true, state: 'released' });
    expect(await registry.handle(ds, { action: 'claim' })).toEqual({ ok: true, state: 'busy' });
    await registry.handle(ds, { action: 'release', leaseId });
    expect(await registry.handle(ds, { action: 'claim' })).toMatchObject({ state: 'claimed' });
  });

  it('refuses a binding that belongs to another run identity', async () => {
    writeDeferredTopicBinding(dataDir, {
      sessionId: SESSION_ID, turnId: 'old-turn', chatId: 'oc_target', larkAppId: 'cli_app',
      routingAnchor: ANCHOR, rootMessageId: 'om_old', createdAt: '2026-10-19T00:00:00.000Z',
    });
    expect(await registry.handle(liveSession(), { action: 'claim' }))
      .toMatchObject({ ok: false, status: 409, error: 'binding_identity_mismatch' });
  });
});

describe('parseDeferredTopicClaimRequest', () => {
  it('accepts only well-formed actions', () => {
    const lease = '0f0e0d0c-0b0a-4908-8706-050403020100';
    expect(parseDeferredTopicClaimRequest({ action: 'claim' })).toEqual({ action: 'claim' });
    expect(parseDeferredTopicClaimRequest({ action: 'commit', leaseId: lease, rootMessageId: 'om_x' }))
      .toEqual({ action: 'commit', leaseId: lease, rootMessageId: 'om_x' });
    expect(parseDeferredTopicClaimRequest({ action: 'commit', leaseId: lease, rootMessageId: 'oc_x' })).toBeUndefined();
    expect(parseDeferredTopicClaimRequest({ action: 'commit', leaseId: '../x', rootMessageId: 'om_x' })).toBeUndefined();
    expect(parseDeferredTopicClaimRequest({ action: 'write' })).toBeUndefined();
  });
});

describe('deferredTopicRootFactsFromDetail', () => {
  it('reads chat, bot sender and reply position from a message GET payload', () => {
    const top = { items: [{ message_id: 'om_a', chat_id: 'oc_1', create_time: '1792464586033', sender: { id: 'cli_app', id_type: 'app_id', sender_type: 'app' } }] };
    expect(deferredTopicRootFactsFromDetail(top)).toEqual({ chatId: 'oc_1', senderAppId: 'cli_app', isReply: false, createdAtMs: 1792464586033 });
    const reply = { items: [{ message_id: 'om_b', chat_id: 'oc_1', parent_id: 'om_a', root_id: 'om_a', sender: { id: 'cli_app', sender_type: 'app' } }] };
    expect(deferredTopicRootFactsFromDetail(reply)?.isReply).toBe(true);
    const human = { items: [{ message_id: 'om_c', chat_id: 'oc_1', sender: { id: 'ou_x', id_type: 'open_id', sender_type: 'user' } }] };
    expect(deferredTopicRootFactsFromDetail(human)?.senderAppId).toBeUndefined();
    // Lark has been seen labelling bot senders `bot` instead of `app`.
    const botLabel = { items: [{ message_id: 'om_d', chat_id: 'oc_1', sender: { id: 'cli_app', id_type: 'app_id', sender_type: 'bot' } }] };
    expect(deferredTopicRootFactsFromDetail(botLabel)?.senderAppId).toBe('cli_app');
    const untyped = { items: [{ message_id: 'om_e', chat_id: 'oc_1', sender: { id: 'cli_app', id_type: 'app_id' } }] };
    expect(deferredTopicRootFactsFromDetail(untyped)?.senderAppId).toBe('cli_app');
    const untypedUser = { items: [{ message_id: 'om_f', chat_id: 'oc_1', sender: { id: 'ou_x', id_type: 'open_id' } }] };
    expect(deferredTopicRootFactsFromDetail(untypedUser)?.senderAppId).toBeUndefined();
  });
});

describe('remote deferred-topic store through dispatchDeferredTopicSend', () => {
  let dataDir: string;
  let registry: DeferredTopicClaimRegistry;
  let ds: any;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-deferred-remote-'));
    registry = new DeferredTopicClaimRegistry({
      readBinding: id => readDeferredTopicBinding(dataDir, id),
      writeBinding: b => writeDeferredTopicBinding(dataDir, b),
      lookupRoot: async () => GOOD_ROOT,
    });
    ds = liveSession();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const post = (req: any) => registry.handle(ds, req);
  const noSleep = async () => { await new Promise(r => setImmediate(r)); };

  function options(overrides: Record<string, unknown> = {}) {
    return {
      // Deliberately a directory nobody writes: the remote store must not touch it.
      dataDir: join(dataDir, 'unused'),
      store: () => remoteDeferredTopicBindingStore(cliSession(ds), post, { sleep: noSleep }),
      session: cliSession(ds),
      currentTurnId: TURN_ID,
      explicitTopLevel: false,
      content: 'refresh ok',
      msgType: 'text',
      sendRoot: vi.fn(async () => 'om_root_1'),
      sendTitleSeed: vi.fn(async () => 'om_title_1'),
      replyRoot: vi.fn(async () => 'om_reply_1'),
      ...overrides,
    };
  }

  it('materializes once and replies into the topic on the next send', async () => {
    const first = options();
    expect(await dispatchDeferredTopicSend(first)).toEqual({
      handled: true, messageId: 'om_root_1', rootMessageId: 'om_root_1', materializedNow: true,
    });
    expect(first.sendRoot).toHaveBeenCalledWith('refresh ok', 'text', SESSION_ID);
    expect(readDeferredTopicBinding(dataDir, SESSION_ID)?.rootMessageId).toBe('om_root_1');

    const second = options({ content: 'detail' });
    expect(await dispatchDeferredTopicSend(second)).toEqual({
      handled: true, messageId: 'om_reply_1', rootMessageId: 'om_root_1', materializedNow: false,
    });
    expect(second.sendRoot).not.toHaveBeenCalled();
    expect(second.replyRoot).toHaveBeenCalledWith('om_root_1', 'detail', 'text', undefined);
  });

  it('lets exactly one of two concurrent sends publish the root', async () => {
    let releaseRoot!: () => void;
    const gate = new Promise<void>(r => { releaseRoot = r; });
    const a = options({ sendRoot: vi.fn(async () => { await gate; return 'om_root_1'; }) });
    const b = options({ content: 'second' });
    const pa = dispatchDeferredTopicSend(a);
    await noSleep();
    const pb = dispatchDeferredTopicSend(b);
    await noSleep();
    releaseRoot();
    const [ra, rb] = await Promise.all([pa, pb]);
    expect(ra).toMatchObject({ messageId: 'om_root_1', materializedNow: true });
    expect(rb).toMatchObject({ messageId: 'om_reply_1', rootMessageId: 'om_root_1', materializedNow: false });
    expect(b.sendRoot).not.toHaveBeenCalled();
  });

  it('uses the title seed as root and records it before the first reply', async () => {
    ds.session.deferredScheduleRun = { ...ds.session.deferredScheduleRun, topicTitle: '元数据刷新' };
    const opts = options({
      replyRoot: vi.fn(async () => {
        expect(readDeferredTopicBinding(dataDir, SESSION_ID)?.rootMessageId).toBe('om_title_1');
        return 'om_reply_1';
      }),
    });
    expect(await dispatchDeferredTopicSend(opts)).toMatchObject({
      messageId: 'om_reply_1', rootMessageId: 'om_title_1', materializedNow: true,
    });
    expect(opts.sendTitleSeed).toHaveBeenCalledWith('元数据刷新', SESSION_ID);
  });

  it('never publishes when the daemon refuses the claim', async () => {
    ds.managedTurnOrigin = { capability: 'cap', turnId: 'a-later-turn' };
    const opts = options();
    await expect(dispatchDeferredTopicSend(opts)).rejects.toThrow(/not claimable: turn_mismatch/);
    expect(opts.sendRoot).not.toHaveBeenCalled();
    expect(opts.sendTitleSeed).not.toHaveBeenCalled();
  });

  it('keeps the fail-closed rule for a non-scheduled turn without a binding', async () => {
    const opts = options({ currentTurnId: 'other-turn' });
    await expect(dispatchDeferredTopicSend(opts)).rejects.toThrow('deferred topic is not materialized for this turn');
    expect(await dispatchDeferredTopicSend(options({ currentTurnId: 'other-turn', explicitTopLevel: true })))
      .toEqual({ handled: false });
    expect(opts.sendRoot).not.toHaveBeenCalled();
  });

  it('retries a commit whose root lookup missed, then binds', async () => {
    let lookups = 0;
    registry = new DeferredTopicClaimRegistry({
      readBinding: id => readDeferredTopicBinding(dataDir, id),
      writeBinding: b => writeDeferredTopicBinding(dataDir, b),
      lookupRoot: async () => (++lookups < 3 ? null : GOOD_ROOT),
    });
    expect(await dispatchDeferredTopicSend(options())).toMatchObject({ messageId: 'om_root_1', materializedNow: true });
    expect(lookups).toBe(3);
    expect(readDeferredTopicBinding(dataDir, SESSION_ID)?.rootMessageId).toBe('om_root_1');
  });

  it('renews the lease while a slow publish is in flight', async () => {
    const posts: string[] = [];
    const spy = (req: any) => { posts.push(req.action); return registry.handle(ds, req); };
    const opts = options({
      store: () => remoteDeferredTopicBindingStore(cliSession(ds), spy, { sleep: noSleep, renewMs: 5 }),
      sendRoot: vi.fn(async () => { await new Promise(r => setTimeout(r, 40)); return 'om_root_1'; }),
    });
    await dispatchDeferredTopicSend(opts);
    expect(posts.filter(a => a === 'renew').length).toBeGreaterThan(0);
    const settled = posts.length;
    await new Promise(r => setTimeout(r, 30));
    expect(posts.length).toBe(settled);
  });

  it('releases the lease when the provider request fails', async () => {
    const failing = options({ sendRoot: vi.fn(async () => { throw new Error('lark 500'); }) });
    await expect(dispatchDeferredTopicSend(failing)).rejects.toThrow('lark 500');
    // Without the release the retry would see `busy` for the whole lease TTL.
    expect(await registry.handle(ds, { action: 'claim' })).toMatchObject({ state: 'claimed' });
  });

  it('peek reports the daemon binding for advisory callers and never claims', async () => {
    const session = cliSession(ds);
    expect(await peekRemoteDeferredTopicBinding(session, post)).toBeUndefined();
    // Peeking took no lease: a publisher can still claim immediately.
    await dispatchDeferredTopicSend(options());
    expect((await peekRemoteDeferredTopicBinding(session, post))?.rootMessageId).toBe('om_root_1');
    expect(await peekRemoteDeferredTopicBinding(session, async () => { throw new Error('down'); })).toBeUndefined();
  });
});

describe('resolveDeferredTopicIpcPort', () => {
  it('prefers the port from the rotating capability claim over a stale spawn-time env', () => {
    expect(resolveDeferredTopicIpcPort(7962, '7951')).toBe(7962);
    expect(resolveDeferredTopicIpcPort(undefined, '7951')).toBe(7951);
    expect(resolveDeferredTopicIpcPort(undefined, undefined)).toBeUndefined();
    expect(resolveDeferredTopicIpcPort(undefined, 'nope')).toBeUndefined();
    expect(resolveDeferredTopicIpcPort(undefined, '70000')).toBeUndefined();
  });
});

describe('probeDeferredTopicBindingWritable', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-deferred-probe-')); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it('is true for a writable data dir and leaves no probe behind', () => {
    expect(probeDeferredTopicBindingWritable(dataDir)).toBe(true);
    expect(readDeferredTopicBinding(dataDir, SESSION_ID)).toBeUndefined();
    expect(readdirSync(join(dataDir, 'deferred-topics'))).toEqual([]);
  });

  it('is false when the sidecar directory cannot be created', () => {
    writeFileSync(join(dataDir, 'deferred-topics'), 'not a dir');
    expect(probeDeferredTopicBindingWritable(dataDir)).toBe(false);
  });
});

