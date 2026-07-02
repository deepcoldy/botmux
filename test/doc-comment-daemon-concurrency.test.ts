/**
 * Regression coverage for document-comment session routing races.
 *
 * Most of the delivery pipeline intentionally remains private to daemon.ts, so
 * the tests combine behavioural coverage of the small routing primitives with
 * source-order guards at the private integration points. This mirrors the
 * established daemon closure coverage in initial-passthrough-ownership.test.ts.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  class FakeWSClient { start() {} }
  class FakeEventDispatcher { register() {} }
  return {
    Client: FakeClient,
    WSClient: FakeWSClient,
    EventDispatcher: FakeEventDispatcher,
    LoggerLevel: { info: 2 },
  };
});

const src = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf-8');

function asyncFnRegion(name: string, nextName: string): string {
  const start = src.indexOf(`async function ${name}(`);
  const end = src.indexOf(`async function ${nextName}(`, start + 1);
  expect(start, `${name} not found in daemon.ts`).toBeGreaterThanOrEqual(0);
  expect(end, `${nextName} not found after ${name}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

function makeDs(sessionId: string, rootMessageId = 'om_doc_root'): DaemonSession {
  return {
    session: {
      sessionId,
      chatId: 'oc_doc_chat',
      rootMessageId,
      scope: 'thread',
      title: sessionId,
      status: 'active',
      createdAt: new Date(0).toISOString(),
      larkAppId: 'app-doc',
    },
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: 'app-doc',
    chatId: 'oc_doc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 0,
    cliVersion: 'test',
    lastMessageAt: 0,
    hasHistory: false,
  } as DaemonSession;
}

function makeDocDs(sessionId: string, fileToken = 'doccnFILE'): DaemonSession {
  const anchor = `doc:${fileToken}`;
  return {
    session: {
      sessionId,
      chatId: anchor,
      rootMessageId: anchor,
      scope: 'chat',
      title: sessionId,
      status: 'active',
      createdAt: new Date(0).toISOString(),
      larkAppId: 'app-doc',
    },
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: 'app-doc',
    chatId: anchor,
    chatType: 'group',
    scope: 'chat',
    spawnedAt: 0,
    cliVersion: 'test',
    lastMessageAt: 0,
    hasHistory: false,
  } as DaemonSession;
}

describe('document-comment routing generation primitives', () => {
  beforeEach(async () => {
    const daemon = await import('../src/daemon.js');
    daemon.__testOnly_activeSessions.clear();
    daemon.__testOnly_resetDocCommentClaims();
  });

  it('accepts only the exact map occupant, Session object, route, and active status', async () => {
    const daemon = await import('../src/daemon.js');
    const ds = makeDs('candidate');
    const key = 'om_doc_root::app-doc';
    daemon.__testOnly_activeSessions.set(key, ds);
    const generation = daemon.__testOnly_captureRoutingGeneration(ds);

    expect(daemon.__testOnly_isCurrentRoutingGeneration(generation)).toBe(true);

    daemon.__testOnly_activeSessions.set(key, makeDs('replacement'));
    expect(daemon.__testOnly_isCurrentRoutingGeneration(generation)).toBe(false);

    daemon.__testOnly_activeSessions.set(key, ds);
    ds.session.status = 'closed';
    expect(daemon.__testOnly_isCurrentRoutingGeneration(generation)).toBe(false);

    ds.session.status = 'active';
    const originalSession = ds.session;
    ds.session = { ...originalSession };
    expect(daemon.__testOnly_isCurrentRoutingGeneration(generation)).toBe(false);

    ds.session = originalSession;
    ds.session.rootMessageId = 'om_moved';
    expect(daemon.__testOnly_isCurrentRoutingGeneration(generation)).toBe(false);
  });

  it('keeps a concurrent winner and returns it after rolling back the rejected candidate', async () => {
    const daemon = await import('../src/daemon.js');
    const winner = makeDs('winner');
    const candidate = makeDs('candidate');
    const key = 'om_doc_root::app-doc';
    daemon.__testOnly_activeSessions.set(key, winner);
    const rollback = vi.fn(async (
      _map: Map<string, DaemonSession>,
      rollbackKey: string,
      rejected: DaemonSession,
    ) => {
      expect(rollbackKey).toBe(key);
      expect(rejected).toBe(candidate);
      rejected.session.status = 'closed';
      return winner;
    });

    const selected = await daemon.__testOnly_registerDocSessionCandidate(key, candidate, rollback);

    expect(selected).toBe(winner);
    expect(daemon.__testOnly_activeSessions.get(key)).toBe(winner);
    expect(candidate.session.status).toBe('closed');
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('registers the candidate without rollback when the route is free', async () => {
    const daemon = await import('../src/daemon.js');
    const candidate = makeDs('candidate');
    const key = 'om_doc_root::app-doc';
    const rollback = vi.fn();

    const selected = await daemon.__testOnly_registerDocSessionCandidate(key, candidate, rollback);

    expect(selected).toBe(candidate);
    expect(daemon.__testOnly_activeSessions.get(key)).toBe(candidate);
    expect(rollback).not.toHaveBeenCalled();
  });

  it('persists and mutates an auto-created binding to the selected doc-native route', async () => {
    const daemon = await import('../src/daemon.js');
    const selected = makeDocDs('winner');
    const sub = {
      fileToken: 'doccnFILE',
      fileType: 'docx',
      sessionAnchor: 'om_old_root',
      sessionId: 'old-session',
      scope: 'thread' as const,
      chatId: 'oc_old_chat',
      commentTriggerMode: 'all' as const,
      pollCursorAt: 42,
      createdAt: 1,
    };
    const current = { ...sub, pollCursorReplyId: 'reply-newer' };
    const read = vi.fn(() => current);
    const write = vi.fn(() => ({}));

    daemon.__testOnly_persistDocBindingToSession(sub, 'app-doc', selected, {
      dataDir: '/tmp/doc-routing-test',
      read,
      write,
    });

    const canonical = expect.objectContaining({
      sessionAnchor: 'doc:doccnFILE',
      sessionId: 'winner',
      scope: 'chat',
      chatId: 'doc:doccnFILE',
      pollCursorAt: 42,
      pollCursorReplyId: 'reply-newer',
    });
    expect(write).toHaveBeenCalledWith('/tmp/doc-routing-test', 'app-doc', canonical);
    expect(sub).toEqual(canonical);
  });

  it('accepts the CAS winner binding without clobbering newer subscription fields', async () => {
    const daemon = await import('../src/daemon.js');
    const selected = makeDocDs('winner');
    const sub = {
      fileToken: 'doccnFILE',
      fileType: 'docx',
      sessionAnchor: 'om_old_root',
      sessionId: 'old-session',
      scope: 'thread' as const,
      chatId: 'oc_old_chat',
      commentTriggerMode: 'all' as const,
      createdAt: 1,
    };
    const current = {
      ...sub,
      sessionAnchor: 'doc:doccnFILE',
      sessionId: 'winner',
      scope: 'chat' as const,
      chatId: 'doc:doccnFILE',
      pollCursorAt: 99,
    };
    const write = vi.fn(() => ({}));

    expect(() => daemon.__testOnly_persistDocBindingToSession(sub, 'app-doc', selected, {
      dataDir: '/tmp/doc-routing-test',
      read: () => current,
      write,
    })).not.toThrow();

    expect(write).toHaveBeenCalledWith(
      '/tmp/doc-routing-test',
      'app-doc',
      expect.objectContaining({ sessionId: 'winner', pollCursorAt: 99 }),
    );
    expect(sub).toMatchObject({ sessionAnchor: 'doc:doccnFILE', sessionId: 'winner', pollCursorAt: 99 });
  });

  it('refuses to overwrite a newer explicit subscription rebind', async () => {
    const daemon = await import('../src/daemon.js');
    const selected = makeDocDs('auto-created');
    const sub = {
      fileToken: 'doccnFILE',
      fileType: 'docx',
      sessionAnchor: 'om_old_root',
      sessionId: 'old-session',
      scope: 'thread' as const,
      chatId: 'oc_old_chat',
      commentTriggerMode: 'all' as const,
      createdAt: 1,
    };
    const current = {
      ...sub,
      sessionAnchor: 'om_new_root',
      sessionId: 'explicit-new-session',
      chatId: 'oc_new_chat',
      createdAt: 2,
    };
    const write = vi.fn(() => ({}));

    expect(() => daemon.__testOnly_persistDocBindingToSession(sub, 'app-doc', selected, {
      dataDir: '/tmp/doc-routing-test',
      read: () => current,
      write,
    })).toThrow(/rebound during routing/);

    expect(write).not.toHaveBeenCalled();
    expect(sub).toMatchObject({ sessionAnchor: 'om_old_root', sessionId: 'old-session' });
  });

  it('follows a relayed subscribed session by sessionId instead of a replacement at the stale anchor', async () => {
    const daemon = await import('../src/daemon.js');
    const replacement = makeDs('replacement-at-old-anchor');
    const relayed = makeDs('subscribed-session', 'om_new_root');
    daemon.__testOnly_activeSessions.set('om_doc_root::app-doc', replacement);
    daemon.__testOnly_activeSessions.set('om_new_root::app-doc', relayed);
    const sub = {
      fileToken: 'doccnFILE',
      fileType: 'docx',
      sessionAnchor: 'om_doc_root',
      sessionId: 'subscribed-session',
      scope: 'thread' as const,
      chatId: 'oc_doc_chat',
      commentTriggerMode: 'all' as const,
      createdAt: 1,
    };
    const persist = vi.fn();

    const selected = daemon.__testOnly_resolveBoundDocSession(sub, 'app-doc', persist);

    expect(selected).toBe(relayed);
    expect(persist).toHaveBeenCalledWith(sub, 'app-doc', relayed);
    expect(selected).not.toBe(replacement);
  });

  it('rejects a different session that reused a stale subscription anchor', async () => {
    const daemon = await import('../src/daemon.js');
    const replacement = makeDs('replacement-at-old-anchor');
    daemon.__testOnly_activeSessions.set('om_doc_root::app-doc', replacement);
    const sub = {
      fileToken: 'doccnFILE',
      fileType: 'docx',
      sessionAnchor: 'om_doc_root',
      sessionId: 'subscribed-session',
      scope: 'thread' as const,
      chatId: 'oc_doc_chat',
      commentTriggerMode: 'all' as const,
      createdAt: 1,
    };
    const persist = vi.fn();

    expect(daemon.__testOnly_resolveBoundDocSession(sub, 'app-doc', persist)).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
  });

  it('rolls back only its own newly-registered candidate when binding persistence fails', async () => {
    const daemon = await import('../src/daemon.js');
    const candidate = makeDocDs('candidate');
    const key = 'doc:doccnFILE::app-doc';
    daemon.__testOnly_activeSessions.set(key, candidate);
    const persistError = new Error('disk write failed');
    const rollback = vi.fn(async () => {
      if (daemon.__testOnly_activeSessions.get(key) === candidate) {
        daemon.__testOnly_activeSessions.delete(key);
        candidate.session.status = 'closed';
      }
    });

    await expect(daemon.__testOnly_persistSelectedDocBinding(
      key,
      {} as never,
      'app-doc',
      candidate,
      candidate,
      () => { throw persistError; },
      rollback,
    )).rejects.toBe(persistError);

    expect(rollback).toHaveBeenCalledWith('candidate');
    expect(candidate.session.status).toBe('closed');
    expect(daemon.__testOnly_activeSessions.has(key)).toBe(false);
  });

  it('does not close another CAS winner when binding persistence fails', async () => {
    const daemon = await import('../src/daemon.js');
    const winner = makeDocDs('winner');
    const rejected = makeDocDs('rejected');
    const key = 'doc:doccnFILE::app-doc';
    daemon.__testOnly_activeSessions.set(key, winner);
    const persistError = new Error('disk write failed');
    const rollback = vi.fn(async () => {});

    await expect(daemon.__testOnly_persistSelectedDocBinding(
      key,
      {} as never,
      'app-doc',
      winner,
      rejected,
      () => { throw persistError; },
      rollback,
    )).rejects.toBe(persistError);

    expect(rollback).not.toHaveBeenCalled();
    expect(daemon.__testOnly_activeSessions.get(key)).toBe(winner);
    expect(winner.session.status).toBe('active');
  });

  it('makes a concurrent follower await the owner failure instead of reporting success', async () => {
    const daemon = await import('../src/daemon.js');
    let failOwner!: () => void;
    const ownerGate = new Promise<void>((_resolve, reject) => {
      failOwner = () => reject(new Error('delivery failed'));
    });
    const ownerCleanup = vi.fn(async () => {});
    const owner = daemon.__testOnly_runClaimedDocCommentTurn(
      'app-doc:file:reply-1',
      async () => { await ownerGate; },
      ownerCleanup,
    );
    const ownerSettled = owner.catch((err: unknown) => err);
    const followerWork = vi.fn(async () => {});
    const follower = daemon.__testOnly_runClaimedDocCommentTurn(
      'app-doc:file:reply-1',
      followerWork,
    );

    failOwner();

    expect(await ownerSettled).toEqual(expect.objectContaining({ message: 'delivery failed' }));
    expect(await follower).toBe(false);
    expect(followerWork).not.toHaveBeenCalled();
    expect(ownerCleanup).toHaveBeenCalledOnce();

    const retryWork = vi.fn(async () => {});
    await expect(daemon.__testOnly_runClaimedDocCommentTurn('app-doc:file:reply-1', retryWork)).resolves.toBe(true);
    expect(retryWork).toHaveBeenCalledOnce();
  });
});

describe('document-comment routing integration', () => {
  it('registers auto-created sessions through CAS and hands loser comments to the winner', () => {
    const fullRegion = asyncFnRegion('autoCreateDocSession', 'handleDocComment');
    const region = fullRegion.slice(0, fullRegion.indexOf('const handledDocCommentTurns'));
    expect(region).not.toContain('activeSessions.set(');
    expect(region).not.toContain('resolveSender(');
    expect(region).not.toContain('docCommentTurns');
    expect(region).not.toContain('docCommentTargets');
    expect(region).toContain('const virtualAnchor = virtualChatId;');
    expect(region).toContain('registerDocSessionCandidate(routingKey, ds)');
    expect(region).toContain('persistSelectedDocBinding(routingKey, sub, larkAppId, selected, ds)');
    expect(region).toContain('return selected;');
  });

  it('revalidates prewarm after sender resolution before mutating or dispatching', () => {
    const region = asyncFnRegion('prewarmDocCommentSession', 'autoCreateDocSession');
    expect(region).toMatch(/const generation = captureRoutingGeneration\(ds\);[\s\S]*await resolveSender[\s\S]*ensureCurrentRoutingGeneration\(generation, 'prewarm:sender'\)/);
    const guard = region.indexOf("ensureCurrentRoutingGeneration(generation, 'prewarm:sender')");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(region.indexOf('beginNewTurn(ds, title)')).toBeGreaterThan(guard);
    expect(region.indexOf('sendWorkerInput(ds, cliInput', guard)).toBeGreaterThan(guard);
    expect(region.indexOf('forkWorker(ds, wrappedInput', guard)).toBeGreaterThan(guard);
  });

  it('revalidates comment delivery after every key await and before send/fork', () => {
    const region = asyncFnRegion('handleDocComment', 'pollWatchedDocComments');
    expect(region).toContain('resolveBoundDocSession(sub, larkAppId)');
    expect(region).toMatch(/await addCommentReaction[\s\S]*ensureCurrentRoutingGeneration\(generation, 'comment:reaction'\)/);
    expect(region).toMatch(/await resolveSender[\s\S]*ensureCurrentRoutingGeneration\(generation, 'comment:sender'\)/);
    expect(region).toMatch(/await noteTurnReceived[\s\S]*ensureCurrentRoutingGeneration\(generation, 'comment:live-note'\)[\s\S]*sendWorkerInput/);
    expect(region).toMatch(/await noteTurnReceived[\s\S]*ensureCurrentRoutingGeneration\(generation, 'comment:refork-note'\)[\s\S]*forkWorker/);
  });

  it('rolls back only this turn target and an already-landed Typing reaction before releasing the claim', () => {
    const region = asyncFnRegion('handleDocComment', 'pollWatchedDocComments');
    expect(region).toContain('targetMatchesThisTurn(runtimeTarget)');
    expect(region).toContain('deliveryDs.docCommentTurns?.delete(turnId)');
    expect(region).toContain('targetMatchesThisTurn(persistedTarget)');
    expect(region).toContain('delete deliverySession.docCommentTargets?.[turnId]');
    expect(region).toContain('sessionStore.getOwnedSession(deliverySession.sessionId) === deliverySession');
    expect(region).toMatch(/if \(reactionId && userReplyId\)[\s\S]*await removeCommentReaction/);
    expect(region).toMatch(/\(ds\.session\.docCommentTargets \?\?= \{\}\)\[turnId\] = docTarget/);
    expect(region).toContain('}, cleanupFailedDelivery)');
  });

  it('shares an in-flight Promise result and deletes a failed claim only after cleanup', () => {
    const region = asyncFnRegion('runClaimedDocCommentTurn', 'handleDocComment');
    expect(src).toContain('new BoundedMap<string, Promise<boolean>>');
    expect(region).toContain('if (existing) return await existing;');
    const cleanup = region.indexOf('await onOwnerFailure?.(err)');
    const deletion = region.indexOf('handledDocCommentTurns.delete(claimKey)', cleanup);
    const settle = region.indexOf('resolveClaim(false)', deletion);
    expect(cleanup).toBeGreaterThanOrEqual(0);
    expect(deletion).toBeGreaterThan(cleanup);
    expect(settle).toBeGreaterThan(deletion);
  });

  it('uses only the current bot-owned session store during subscription restore', () => {
    const region = asyncFnRegion('restoreDocSubscriptions', 'startDaemon');
    expect(region).toContain('sessionStore.getOwnedSession(sub.sessionId)');
    expect(region).not.toContain('sessionStore.getSession(sub.sessionId)');
  });
});
