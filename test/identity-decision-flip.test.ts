/**
 * N1/N2/P2/P3 flip replay: when the worker's spawn decision flips the identity
 * model relative to the daemon's last ACTUAL publication, the daemon must
 *  1. purge the wrong-model material FIRST (plaintext root files for proven;
 *     proven memory for single),
 *  2. replay the opening turn exactly once — only while that turn is live.
 *
 * handleIdentityDecisionFlip lives in daemon.ts (it orchestrates daemon-only
 * publication), so it is exercised here by extracting the real function text
 * and running it with injected deps — the same technique as the
 * turn-cli-identity target harness.
 */
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { identityDecisionTurnIsLive } from '../src/core/worker-pool.js';

const source = ts.createSourceFile('daemon.ts', readFileSync('src/daemon.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const fnNode = source.statements.find(
  n => ts.isFunctionDeclaration(n) && n.name?.text === 'handleIdentityDecisionFlip',
);
if (!fnNode) throw new Error('Missing handleIdentityDecisionFlip production handler');
const fnText = ts.transpileModule(fnNode.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function runHandler(ds: any, context: { model: 'single' | 'proven'; flipped: boolean; turnId?: string }, deps: any) {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const handler = new Function('deps', 'with (deps) { ' + fnText + '; return handleIdentityDecisionFlip; }')(deps);
  return handler(ds, context);
}

function sessionFixture(extra: Record<string, unknown> = {}): any {
  return {
    session: { sessionId: 'flip-session', status: 'active', queuedActivationTurnId: undefined,
      ...('sessionExtra' in extra ? extra.sessionExtra as object : {}) },
    worker: { killed: false },
    currentTurnId: undefined,
    pendingTurnId: undefined,
    managedTurnOrigin: undefined,
    terminalIdentityTurnIds: undefined,
    lastPublishedIdentityModel: 'single',
    ...extra,
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    config: { session: { dataDir: '/tmp/flip-data' } },
    logger: { error: vi.fn(), warn: vi.fn() },
    clearSingleIdentityArtifacts: vi.fn(),
    forgetProvenIdentityContent: vi.fn(),
    identityDecisionTurnIsLive: vi.fn((d: any, turnId: string) =>
      d.session.status === 'active' && !!d.worker && !d.worker.killed
      && !d.terminalIdentityTurnIds?.has(turnId)),
    refreshTurnCliIdentity: vi.fn(async () => {}),
    ...overrides,
  };
}

async function testProductionLiveness(terminal: Set<string> | undefined, expectReplay: boolean): Promise<void> {
  const d = deps({ identityDecisionTurnIsLive });
  const ds = {
    session: { sessionId: 'flip-session', status: 'active' },
    larkAppId: 'cli_flip', chatId: 'oc_flip',
    worker: { killed: false, pid: 7 },
    terminalIdentityTurnIds: terminal,
    lastPublishedIdentityModel: 'single',
  } as any;
  await runHandler(ds, { model: 'proven', flipped: true, turnId: 'om_term' }, d);
  if (expectReplay) {
    expect(d.refreshTurnCliIdentity).toHaveBeenCalledWith(ds, 'om_term');
  } else {
    expect(d.refreshTurnCliIdentity).not.toHaveBeenCalled();
  }
}

describe('handleIdentityDecisionFlip', () => {
  it('does nothing without a flip or a turn id', async () => {
    const d = deps();
    await runHandler(sessionFixture(), { model: 'proven', flipped: false, turnId: 'om_open' }, d);
    expect(d.clearSingleIdentityArtifacts).not.toHaveBeenCalled();
    expect(d.refreshTurnCliIdentity).not.toHaveBeenCalled();

    const d2 = deps();
    await runHandler(sessionFixture(), { model: 'proven', flipped: true }, d2);
    expect(d2.refreshTurnCliIdentity).not.toHaveBeenCalled();
  });

  it('purges plaintext before replaying the opening turn even with no daemon live-turn field set (P2)', async () => {
    // The opening-turn instant: currentTurnId/pendingTurnId/queued/managedOrigin
    // are ALL unset — the worker's current-generation decision (already gated
    // upstream) naming its spawn turn is the authority.
    const d = deps();
    await runHandler(sessionFixture(), { model: 'proven', flipped: true, turnId: 'om_open' }, d);
    expect(d.clearSingleIdentityArtifacts).toHaveBeenCalledWith('/tmp/flip-data', 'flip-session');
    expect(d.refreshTurnCliIdentity).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({ sessionId: 'flip-session' }),
    }), 'om_open');
    expect(d.clearSingleIdentityArtifacts.mock.invocationCallOrder[0])
      .toBeLessThan(d.refreshTurnCliIdentity.mock.invocationCallOrder[0]);
  });

  it('purges proven memory on a flip back to single', async () => {
    const d = deps();
    const ds = sessionFixture({ lastPublishedIdentityModel: 'proven' });
    await runHandler(ds, { model: 'single', flipped: true, turnId: 'om_open' }, d);
    expect(d.forgetProvenIdentityContent).toHaveBeenCalledWith('/tmp/flip-data', 'flip-session');
    expect(d.clearSingleIdentityArtifacts).not.toHaveBeenCalled();
  });

  it('purges but never replays a terminal turn (late decision cannot resurrect it)', async () => {
    const d = deps();
    const ds = sessionFixture({ terminalIdentityTurnIds: new Set(['om_old']) });
    await runHandler(ds, { model: 'proven', flipped: true, turnId: 'om_old' }, d);
    expect(d.clearSingleIdentityArtifacts).toHaveBeenCalledOnce();
    expect(d.refreshTurnCliIdentity).not.toHaveBeenCalled();
    // No success record: a genuinely new decision for a live turn still runs.
    expect(ds.lastIdentityDecisionRepublish).toBeUndefined();
  });

  it('uses the PRODUCTION liveness function: a terminal-but-otherwise-live turn is not replayed (P3-b)', () =>
    // The default deps() injects an equivalent vi.fn. Here the production
    // identityDecisionTurnIsLive is wired in, so mutating the production
    // terminal check (deleting terminalIdentityTurnIds) turns THIS case red —
    // the flip layer must not rely solely on a mock copy of the gate.
    // Fixture design: the turn passes EVERY production liveness condition
    // (active session, live worker) EXCEPT membership in the terminal set.
    // Removing the terminal check would then wrongly classify it as live.
    testProductionLiveness(new Set(['om_term']), false));

  it('uses the PRODUCTION liveness function: a genuinely live opening turn IS replayed (P3-b control)', () =>
    testProductionLiveness(undefined, true));

  it('does not replay when the session is inactive or the worker is dead', async () => {
    const d1 = deps({ identityDecisionTurnIsLive: () => false });
    await runHandler(sessionFixture(), { model: 'proven', flipped: true, turnId: 'om_open' }, d1);
    expect(d1.refreshTurnCliIdentity).not.toHaveBeenCalled();
  });

  it('records success so an identical flipped report does not replay again (baseline moves)', async () => {
    const d = deps();
    const ds = sessionFixture();
    await runHandler(ds, { model: 'proven', flipped: true, turnId: 'om_open' }, d);
    // The successful replay publishes under proven: the caller then moves the
    // baseline. A following identical report computes flipped=false.
    expect(ds.lastIdentityDecisionRepublish).toEqual({ model: 'proven', turnId: 'om_open', ok: true });
    await runHandler(ds, { model: 'proven', flipped: false, turnId: 'om_open' }, d);
    expect(d.refreshTurnCliIdentity).toHaveBeenCalledOnce();
  });

  it('keeps a failed replay retryable: baseline never moves, the identical flip replays (P3-1)', async () => {
    const d = deps({ refreshTurnCliIdentity: vi.fn(async () => { throw new Error('BOOM'); }) });
    const ds = sessionFixture();
    await runHandler(ds, { model: 'single', flipped: true, turnId: 'om_1' }, d);
    expect(ds.lastIdentityDecisionRepublish).toMatchObject({ model: 'single', turnId: 'om_1', ok: false });
    expect(d.logger.error).toHaveBeenCalledOnce();
    // Same flip arrives again: still flipped (baseline stayed single→proven
    // baseline unchanged), so it retries instead of being silently swallowed.
    await runHandler(ds, { model: 'single', flipped: true, turnId: 'om_1' }, d);
    expect(d.refreshTurnCliIdentity).toHaveBeenCalledTimes(2);
  });

  it('heals a failed middle flip when the other model comes back (P3-2)', async () => {
    const ds = sessionFixture({ lastPublishedIdentityModel: 'single' });

    // 1. proven flip replays fine.
    const d1 = deps();
    await runHandler(ds, { model: 'proven', flipped: true, turnId: 'om_1' }, d1);
    expect(d1.refreshTurnCliIdentity).toHaveBeenCalledTimes(1);
    ds.lastPublishedIdentityModel = 'proven';

    // 2. single flip FAILS — its forgetProvenIdentityContent already purged
    //    the proven material.
    const d2 = deps({ refreshTurnCliIdentity: vi.fn(async () => { throw new Error('BOOM'); }) });
    await runHandler(ds, { model: 'single', flipped: true, turnId: 'om_1' }, d2);
    expect(ds.lastIdentityDecisionRepublish).toMatchObject({ model: 'single', ok: false });

    // 3. proven comes back: flipped=false against the proven baseline, but the
    //    failed single attempt purged proven content, so replay to heal.
    const d3 = deps();
    await runHandler(ds, { model: 'proven', flipped: false, turnId: 'om_1' }, d3);
    expect(d3.refreshTurnCliIdentity).toHaveBeenCalledWith(expect.anything(), 'om_1');
    expect(ds.lastIdentityDecisionRepublish).toMatchObject({ model: 'proven', ok: true });
  });

  it('replays all three successful model flips for the same turn (no dedupe starvation)', async () => {
    const ds = sessionFixture({ lastPublishedIdentityModel: 'single' });
    const d = deps();
    await runHandler(ds, { model: 'proven', flipped: true, turnId: 'om_1' }, d);
    ds.lastPublishedIdentityModel = 'proven';
    await runHandler(ds, { model: 'single', flipped: true, turnId: 'om_1' }, d);
    ds.lastPublishedIdentityModel = 'single';
    await runHandler(ds, { model: 'proven', flipped: true, turnId: 'om_1' }, d);
    expect(d.refreshTurnCliIdentity).toHaveBeenCalledTimes(3);
  });
});

// P3-a: the daemon registers onIdentityDecision as fire-and-forget but MUST
// not let a rejected flip promise escape as unhandledRejection (the inner
// try/catch only covers refreshTurnCliIdentity; a purge throw still rejects
// handleIdentityDecisionFlip). Exercise the REAL registered callback text.
function extractOnIdentityDecision(): (deps: any) => any {
  let text: string | undefined;
  function walk(node: ts.Node) {
    // The callback is a shorthand method inside the worker-handlers object.
    if (ts.isMethodDeclaration(node)
      && node.name && ts.isIdentifier(node.name)
      && node.name.text === 'onIdentityDecision') {
      text = node.getText(source);
    }
    ts.forEachChild(node, walk);
  }
  walk(source);
  if (!text) throw new Error('Missing onIdentityDecision callback');
  // text: "onIdentityDecision(ds, context) { void ... .catch(...) }" → fn
  const fnText = 'function ' + text;
  return (injectedDeps: any) => {
    const body = 'with (deps) { ' + fnText + '; return onIdentityDecision; }';
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function('deps', body)(injectedDeps);
  };
}

describe('onIdentityDecision registration (P3-a)', () => {
  it('captures a rejected flip (purge throws) via .catch and never throws itself', async () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const flip = vi.fn(async () => { throw new Error('PURGE-BOOM'); });
    const callback = extractOnIdentityDecision();
    const ds = { session: { sessionId: 's' } };
    // Synchronous return must be undefined and must not throw.
    let unhandled: unknown;
    const onUnhandled = (reason: unknown) => { unhandled = reason; };
    process.once('unhandledRejection', onUnhandled);
    expect(() => callback({ logger, handleIdentityDecisionFlip: flip })(
      ds, { model: 'proven', flipped: true, turnId: 'om_1' },
    )).not.toThrow();
    // Give the rejected promise's microtask + .catch a tick.
    await new Promise(r => setTimeout(r, 10));
    process.removeListener('unhandledRejection', onUnhandled);
    expect(unhandled).toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(String(logger.error.mock.calls[0])).toContain('PURGE-BOOM');
  });
});
