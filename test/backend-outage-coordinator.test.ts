/**
 * A lost shared tmux server is ONE backend outage, not N CLI crashes.
 *
 * 2026-11-19: the fleet's `-L botmux` server died (tmux 3.3a SIGSEGV), 104
 * sessions each ran the per-session crash loop, restarted at once into a
 * server that kept crashing (345 failed restarts) and dozens of chats each got
 * "⚠️ Codex 在 1 分钟内崩溃 4 次，已停止自动重启". These tests drive the
 * coordinator that replaces that behaviour with a deterministic clock and pin:
 * one canary while the server is down, bounded backoff, a few restarts at a
 * time once it is up, one card per topic patched in place, one owner summary.
 */
import { describe, expect, it } from 'vitest';
import {
  BackendOutageCoordinator,
  recoveryEligibility,
  type BackendOutageDeps,
  type BackendOutageTimings,
  type RecoveryEligibility,
  type OutageCardView,
  type OutageSummary,
  type RecoveryRestartStatus,
  type ServerLossReport,
} from '../src/core/backend-outage-coordinator.js';

/** Manual clock: timers fire only when the test advances it. */
class ManualClock {
  now = 0;
  private seq = 0;
  private timers = new Map<number, { due: number; fn: () => void }>();

  setTimeout = (fn: () => void, ms: number): number => {
    const id = ++this.seq;
    this.timers.set(id, { due: this.now + ms, fn });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  pending(): number {
    return this.timers.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      await settle();
      let next: [number, { due: number; fn: () => void }] | undefined;
      for (const entry of this.timers) if (entry[1].due <= target && (!next || entry[1].due < next[1].due)) next = entry;
      if (!next) break;
      this.timers.delete(next[0]);
      this.now = next[1].due;
      next[1].fn();
    }
    this.now = target;
    await settle();
  }
}

/** Let every queued promise continuation run (real macrotask turns). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

interface Session { id: string; eligibility: RecoveryEligibility }

function harness(opts: {
  serverUp?: boolean;
  timings?: Partial<BackendOutageTimings>;
  app?: string;
  clock?: ManualClock;
  server?: { serverUp: boolean };
  /** Called as a restart starts (e.g. its new-session brings the server up). */
  onRestart?: (id: string) => void;
  serverUpFn?: () => Promise<boolean>;
  externalRecoveryInFlight?: (id: string) => boolean;
} = {}) {
  const clock = opts.clock ?? new ManualClock();
  const state = opts.server ?? { serverUp: opts.serverUp ?? false };
  const restarts: Array<{ sessionId: string; serverWasUp: boolean; settle: (status: RecoveryRestartStatus) => void }> = [];
  const posts: Array<{ sessionId: string; view: OutageCardView; uuid: string }> = [];
  const patches: Array<{ sessionId: string; messageId: string; view: OutageCardView }> = [];
  /** Inject delivery failures: a post that throws AFTER creating the message
   *  (an ambiguous timeout), or patches that fail transiently. */
  const faults = { postCreatesThenThrows: 0, patchFailures: 0 };
  const created = new Map<string, string>(); // uuid → message id (Lark dedupes by uuid)
  const giveUps: Array<{ sessionId: string; keepTerminal: boolean }> = [];
  const summaries: OutageSummary[] = [];
  const probes: number[] = [];
  const sessions = new Map<string, Session>();
  let lastView = new Map<string, OutageCardView>();
  const deps: BackendOutageDeps<Session> = {
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    restart: (ref, onSettled) => {
      restarts.push({ sessionId: ref.id, serverWasUp: state.serverUp, settle: onSettled });
      opts.onRestart?.(ref.id);
      return true;
    },
    serverUp: async () => {
      probes.push(clock.now);
      return opts.serverUpFn ? opts.serverUpFn() : state.serverUp;
    },
    eligible: ref => ref.eligibility,
    externalRecoveryInFlight: ref => opts.externalRecoveryInFlight?.(ref.id) ?? true,
    giveUp: (ref, o) => { giveUps.push({ sessionId: ref.id, keepTerminal: o.keepTerminal }); },
    render: (ref, view) => {
      lastView.set(ref.id, view);
      return JSON.stringify({ id: ref.id, view });
    },
    post: async (ref, json, uuid) => {
      const existing = uuid ? created.get(uuid) : undefined;
      if (!existing) posts.push({ sessionId: ref.id, view: JSON.parse(json).view, uuid });
      const id = existing ?? `om_${ref.id}_${posts.length}`;
      if (uuid) created.set(uuid, id);
      if (faults.postCreatesThenThrows > 0) {
        faults.postCreatesThenThrows -= 1;
        throw new Error('request timed out');
      }
      return id;
    },
    patch: async (ref, messageId, json) => {
      if (faults.patchFailures > 0) {
        faults.patchFailures -= 1;
        throw new Error('gateway 503');
      }
      patches.push({ sessionId: ref.id, messageId, view: JSON.parse(json).view });
    },
    summarize: summary => { summaries.push(summary); },
    log: () => {},
  };
  const coordinator = new BackendOutageCoordinator<Session>(deps, { gatherJitterMs: 0, ...opts.timings });
  const session = (id: string): Session => {
    let s = sessions.get(id);
    if (!s) {
      s = { id, eligibility: 'now' };
      sessions.set(id, s);
    }
    return s;
  };
  const report = (over: Partial<ServerLossReport> = {}): ServerLossReport => ({
    larkAppId: opts.app ?? 'cli_app',
    socketName: 'botmux',
    kind: 'gone',
    cliName: 'Codex',
    title: 'topic',
    turnInFlight: false,
    canPark: true,
    silent: false,
    ...over,
  });
  const lose = (id: string, over: Partial<ServerLossReport> = {}) =>
    coordinator.onServerLost(session(id), id, report({ title: `topic ${id}`, ...over }));
  /** Settle the restart most recently started for `id`. */
  const settleRestart = (id: string, status: RecoveryRestartStatus) => {
    const r = [...restarts].reverse().find(x => x.sessionId === id);
    if (!r) throw new Error(`no restart for ${id}`);
    r.settle(status);
  };
  const cardsPerSession = () => {
    const counts = new Map<string, number>();
    for (const p of posts) counts.set(p.sessionId, (counts.get(p.sessionId) ?? 0) + 1);
    return counts;
  };
  const view = (id: string) => lastView.get(id)!;
  /** What the chat shows: the last delivered post/patch per topic. */
  const shown = (id: string) => {
    const delivered = [...posts.filter(p => p.sessionId === id), ...patches.filter(p => p.sessionId === id)];
    return patches.filter(p => p.sessionId === id).at(-1)?.view ?? delivered.at(-1)?.view;
  };
  return {
    clock, state, coordinator, restarts, posts, patches, giveUps, summaries, probes, faults,
    lose, settleRestart, cardsPerSession, view, session, shown,
    resetViews: () => { lastView = new Map(); },
  };
}

const IDS = ['s1', 's2', 's3', 's4', 's5', 's6'];

describe('BackendOutageCoordinator', () => {
  it('brings a dead server back through ONE canary, then restarts the rest a few at a time', async () => {
    const h = harness({ serverUp: false });
    for (const id of IDS) h.lose(id);
    await h.clock.advance(0);

    // Nothing restarts inside the gather window: no restart herd into a
    // server that may still be crashing.
    expect(h.restarts).toHaveLength(0);
    await h.clock.advance(2_999);
    expect(h.restarts).toHaveLength(0);

    // Server still down → exactly one session is restarted to bring it back.
    await h.clock.advance(1);
    expect(h.restarts.map(r => r.sessionId)).toEqual(['s1']);
    expect(h.view('s1').state).toBe('recovering');
    expect(h.view('s2').state).toBe('interrupted');

    // The canary came up (it started the server): the rest follow, at most
    // four in flight.
    h.state.serverUp = true;
    h.settleRestart('s1', 'succeeded');
    await h.clock.advance(0);
    expect(h.restarts.map(r => r.sessionId)).toEqual(['s1', 's2', 's3', 's4', 's5']);

    h.settleRestart('s2', 'succeeded');
    await h.clock.advance(0);
    expect(h.restarts.map(r => r.sessionId)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
    for (const id of ['s3', 's4', 's5', 's6']) h.settleRestart(id, 'succeeded');
    await h.clock.advance(0);
    await h.coordinator.cardsSettled();

    for (const id of IDS) expect(h.view(id).state).toBe('recovered');
    // One card per topic, every later state patched into it.
    expect([...h.cardsPerSession().values()]).toEqual(IDS.map(() => 1));
    expect(h.patches.length).toBeGreaterThan(0);
    expect(new Set(h.patches.map(p => p.messageId)).size).toBe(IDS.length);
    expect(h.giveUps).toEqual([]);

    // One owner summary once the outage has been quiet for the settle window.
    expect(h.summaries).toHaveLength(0);
    await h.clock.advance(60_000);
    expect(h.summaries).toHaveLength(1);
    expect(h.summaries[0].members.map(m => m.state)).toEqual(IDS.map(() => 'recovered'));
    expect(h.summaries[0].serverRetries).toBe(0);
    await h.clock.advance(10 * 60_000);
    expect(h.summaries).toHaveLength(1);
  });

  it('skips the canary when the server is already back (another bot restarted it)', async () => {
    const h = harness({ serverUp: true });
    for (const id of IDS.slice(0, 3)) h.lose(id);
    await h.clock.advance(3_000);
    expect(h.restarts.map(r => r.sessionId)).toEqual(['s1', 's2', 's3']);
  });

  it('backs off while the server stays down and gives every topic one failure card after the budget', async () => {
    const h = harness({ serverUp: false });
    for (const id of ['s1', 's2', 's3']) h.lose(id);
    await h.clock.advance(3_000);
    expect(h.restarts).toHaveLength(1);

    // Each canary fails while the server is still down: retried after 5s,
    // 15s, 30s, 60s — and only ever one session at a time.
    const backoff = [5_000, 15_000, 30_000, 60_000];
    for (const [i, delay] of backoff.entries()) {
      h.restarts.at(-1)!.settle('failed');
      await h.clock.advance(0);
      expect(h.view(h.restarts.at(-1)!.sessionId).state).toBe('interrupted');
      expect(h.view('s1').serverRetries).toBe(i + 1);
      await h.clock.advance(delay - 1);
      expect(h.restarts).toHaveLength(i + 1);
      await h.clock.advance(1);
      expect(h.restarts).toHaveLength(i + 2);
    }
    // The canary rotates: a session that cannot start never blocks the
    // others, and one that only failed because the server was down did not
    // spend its own attempts.
    expect(h.restarts.map(r => r.sessionId)).toEqual(['s1', 's2', 's3', 's1', 's2']);

    h.restarts.at(-1)!.settle('failed');
    await h.clock.advance(0);
    await h.coordinator.cardsSettled();
    for (const id of ['s1', 's2', 's3']) {
      expect(h.view(id)).toMatchObject({ state: 'failed', failure: 'server_unavailable' });
    }
    // Stopped like the crash loop (next message retries), without parking a
    // diagnostic shell on the server that failed.
    expect(h.giveUps).toEqual(['s1', 's2', 's3'].map(sessionId => ({ sessionId, keepTerminal: false })));
    expect([...h.cardsPerSession().values()]).toEqual([1, 1, 1]);

    await h.clock.advance(60_000);
    expect(h.summaries).toHaveLength(1);
    expect(h.summaries[0].serverRetries).toBe(5);
    expect(h.summaries[0].members.every(m => m.failure === 'server_unavailable')).toBe(true);
  });

  it('a server that dies again during recovery goes back to one canary, without double counting', async () => {
    const h = harness({ serverUp: false });
    for (const id of IDS) h.lose(id);
    await h.clock.advance(3_000);
    h.state.serverUp = true;
    h.settleRestart('s1', 'succeeded');
    await h.clock.advance(0);
    expect(h.restarts).toHaveLength(5);

    // The fresh server dies again: the recovered canary and the in-flight
    // members report losses, and the in-flight restarts fail.
    h.state.serverUp = false;
    h.lose('s1', { kind: 'gone' });
    h.lose('s2', { kind: 'gone' });
    for (const id of ['s3', 's4', 's5']) h.settleRestart(id, 'failed');
    await h.clock.advance(0);
    for (const id of IDS) expect(h.view(id).state).toBe('interrupted');
    // One down period, one retry counted.
    expect(h.view('s1').serverRetries).toBe(1);
    expect(h.restarts).toHaveLength(5);

    await h.clock.advance(5_000);
    expect(h.restarts).toHaveLength(6);
    h.state.serverUp = true;
    h.settleRestart(h.restarts.at(-1)!.sessionId, 'succeeded');
    await h.clock.advance(0);
    for (const r of h.restarts.slice(6)) r.settle('succeeded');
    await h.clock.advance(0);
    for (const r of h.restarts.slice(6)) r.settle('succeeded');
    await h.clock.advance(0);
    for (const id of IDS) expect(h.view(id).state).toBe('recovered');
    expect([...h.cardsPerSession().values()]).toEqual(IDS.map(() => 1));
  });

  it('retries a CLI that fails on a healthy server once, then stops it with its last error', async () => {
    const h = harness({ serverUp: true });
    h.lose('s1', { turnInFlight: true });
    await h.clock.advance(3_000);
    expect(h.restarts).toHaveLength(1);

    // The resumed CLI exits on its own (server fine): absorbed, not a crash.
    expect(h.coordinator.onCliExit('s1', { code: 1, logTail: 'no rollout found for thread id' })).toBe(true);
    h.settleRestart('s1', 'failed');
    await h.clock.advance(0);
    expect(h.restarts).toHaveLength(2);

    expect(h.coordinator.onCliExit('s1', { code: 1, logTail: 'no rollout found for thread id' })).toBe(true);
    h.settleRestart('s1', 'failed');
    await h.clock.advance(0);
    await h.coordinator.cardsSettled();
    expect(h.restarts).toHaveLength(2);
    expect(h.view('s1')).toMatchObject({ state: 'failed', failure: 'cli_failed', turnInFlight: true });
    expect(h.view('s1').failureDetail).toContain('no rollout found');
    expect(h.giveUps).toEqual([{ sessionId: 's1', keepTerminal: true }]);

    // Once settled, later exits are ordinary again (crash loop applies).
    expect(h.coordinator.onCliExit('s1', { code: 1 })).toBe(false);
  });

  it('stops a session that keeps losing its server (bounded like the crash loop)', async () => {
    const h = harness({ serverUp: true });
    for (let i = 0; i < 3; i++) {
      h.lose('s1', { kind: 'replaced' });
      await h.clock.advance(3_000);
      h.settleRestart('s1', 'succeeded');
      await h.clock.advance(0);
      expect(h.view('s1').state).toBe('recovered');
    }
    h.lose('s1', { kind: 'replaced' });
    await h.clock.advance(3_000);
    await h.coordinator.cardsSettled();
    expect(h.restarts).toHaveLength(3);
    expect(h.view('s1')).toMatchObject({ state: 'failed', failure: 'repeated' });
    expect(h.giveUps).toEqual([{ sessionId: 's1', keepTerminal: false }]);
    expect(h.cardsPerSession().get('s1')).toBe(1);
  });

  it('folds notices into the card and absorbs start failures of members still recovering', async () => {
    const h = harness({ serverUp: true });
    h.lose('s1', { turnInFlight: true });
    expect(h.coordinator.onStartupFailure('s1', 'tmux new-session failed: no server running')).toBe(true);
    await h.clock.advance(3_000);
    expect(h.coordinator.absorbNotice('s1', '⚠️ 会话刚刚重启，重启前的工作被中断：上一轮还没做完。已提醒 Codex 检查后继续。')).toBe(true);
    h.settleRestart('s1', 'succeeded');
    await h.clock.advance(0);
    await h.coordinator.cardsSettled();
    expect(h.view('s1').state).toBe('recovered');
    expect(h.view('s1').notices).toEqual(['⚠️ 会话刚刚重启，重启前的工作被中断：上一轮还没做完。已提醒 Codex 检查后继续。']);
    expect(h.cardsPerSession().get('s1')).toBe(1);
    // Not a member: nothing absorbed.
    expect(h.coordinator.absorbNotice('s9', 'x')).toBe(false);
    expect(h.coordinator.onStartupFailure('s9', 'x')).toBe(false);
  });

  it('never kills a CLI whose restart only timed out, and flips the card when it gets ready', async () => {
    const h = harness({ serverUp: true });
    h.lose('s1');
    await h.clock.advance(3_000);
    h.settleRestart('s1', 'timed_out');
    await h.clock.advance(0);
    expect(h.view('s1')).toMatchObject({ state: 'failed', failure: 'timed_out' });
    expect(h.giveUps).toEqual([]);
    h.coordinator.onPromptReady('s1');
    await h.coordinator.cardsSettled();
    expect(h.view('s1').state).toBe('recovered');
  });

  it('a member that is no longer eligible is dropped without a restart', async () => {
    const h = harness({ serverUp: false });
    h.lose('s1');
    h.lose('s2');
    h.session('s1').eligibility = 'never';
    await h.clock.advance(3_000);
    expect(h.restarts.map(r => r.sessionId)).toEqual(['s2']);
    expect(h.view('s1').state).toBe('stopped');
  });

  it('posts nothing for a silent session but still recovers it', async () => {
    const h = harness({ serverUp: true });
    h.lose('s1', { silent: true });
    await h.clock.advance(3_000);
    h.settleRestart('s1', 'succeeded');
    await h.clock.advance(0);
    await h.coordinator.cardsSettled();
    expect(h.posts).toEqual([]);
    expect(h.patches).toEqual([]);
    expect(h.restarts).toHaveLength(1);
  });

  // ─── adversarial review regressions ────────────────────────────────────

  it('a canary that hits its own loss budget does not strand the other sessions', async () => {
    const h = harness({ serverUp: false, timings: { maxLossesPerWindow: 1 } });
    for (const id of ['s1', 's2', 's3']) h.lose(id);
    await h.clock.advance(3_000);
    expect(h.restarts.map(r => r.sessionId)).toEqual(['s1']);
    // The canary's fresh pane dies with the server again: its 2nd loss is over
    // budget, so s1 stops — but the outage must go on for s2 and s3.
    h.lose('s1', { kind: 'gone' });
    await h.clock.advance(0);
    expect(h.view('s1')).toMatchObject({ state: 'failed', failure: 'repeated' });
    h.state.serverUp = true;
    await h.clock.advance(5_000);
    expect(h.restarts.map(r => r.sessionId)).toEqual(['s1', 's2', 's3']);
    h.settleRestart('s2', 'succeeded');
    h.settleRestart('s3', 'succeeded');
    await h.clock.advance(60_000);
    expect(h.view('s2').state).toBe('recovered');
    expect(h.view('s3').state).toBe('recovered');
    expect(h.summaries).toHaveLength(1);
  });

  it('a canary that hits its loss budget on a `replaced` report still lets the rest restart', async () => {
    const h = harness({ serverUp: false, timings: { maxLossesPerWindow: 1 } });
    for (const id of ['s1', 's2']) h.lose(id);
    await h.clock.advance(3_000);
    h.state.serverUp = true;
    h.lose('s1', { kind: 'replaced' });
    await h.clock.advance(0);
    expect(h.restarts.map(r => r.sessionId)).toEqual(['s1', 's2']);
  });

  it('when the budget runs out with restarts still in flight, the late settlers fail too (nobody waits forever)', async () => {
    const h = harness({ serverUp: false, timings: { serverBackoffMs: [5_000] } });
    for (const id of ['s1', 's2', 's3', 's4']) h.lose(id);
    await h.clock.advance(3_000);
    h.state.serverUp = true;
    h.settleRestart('s1', 'succeeded');
    await h.clock.advance(0);
    expect(h.restarts.map(r => r.sessionId)).toEqual(['s1', 's2', 's3', 's4']);
    // The server dies again under the in-flight restarts.
    h.state.serverUp = false;
    h.lose('s1', { kind: 'gone' });
    h.settleRestart('s2', 'failed');
    await h.clock.advance(5_000);
    h.restarts.at(-1)!.settle('failed'); // the new canary fails: budget spent
    await h.clock.advance(0);
    h.settleRestart('s3', 'failed');
    h.settleRestart('s4', 'failed');
    await h.clock.advance(0);
    for (const id of ['s1', 's2', 's3', 's4']) expect(h.view(id)).toMatchObject({ state: 'failed', failure: 'server_unavailable' });
    await h.clock.advance(60_000);
    expect(h.summaries).toHaveLength(1);
    expect(h.clock.pending()).toBe(0);
  });

  it('a session someone else brought back (a /restart, a new message) is not restarted again', async () => {
    const h = harness({ serverUp: false });
    for (const id of ['s1', 's2']) h.lose(id);
    // The user restarted s1 during the gather window; its CLI is at its prompt.
    h.coordinator.onPromptReady('s1');
    await h.clock.advance(3_000);
    expect(h.restarts.map(r => r.sessionId)).toEqual(['s2']);
    h.state.serverUp = true;
    h.settleRestart('s2', 'succeeded');
    await h.clock.advance(60_000);
    expect(h.restarts.map(r => r.sessionId)).toEqual(['s2']);
    expect(h.view('s1').state).toBe('recovered');
  });

  it('a session in the middle of a relay is asked again later instead of being dropped', async () => {
    const h = harness({ serverUp: true });
    h.lose('s1');
    h.session('s1').eligibility = 'later';
    await h.clock.advance(3_000);
    expect(h.restarts).toEqual([]);
    expect(h.view('s1').state).toBe('interrupted');
    // The relay failed; the session stayed where it was.
    h.session('s1').eligibility = 'now';
    await h.clock.advance(5_000);
    expect(h.restarts.map(r => r.sessionId)).toEqual(['s1']);
    h.settleRestart('s1', 'succeeded');
    await h.clock.advance(0);
    expect(h.view('s1').state).toBe('recovered');
  });

  it('the others start as soon as the server answers, not when the canary CLI is ready', async () => {
    const h = harness({ serverUp: false });
    for (const id of ['s1', 's2', 's3']) h.lose(id);
    await h.clock.advance(3_000);
    expect(h.restarts.map(r => r.sessionId)).toEqual(['s1']);
    h.state.serverUp = true; // the canary's new-session brought the server back
    await h.clock.advance(2_000);
    expect(h.restarts.map(r => r.sessionId)).toEqual(['s1', 's2', 's3']);
  });

  it('a restart that only timed out turns into "recovered" when the CLI gets ready, and the summary waits for it', async () => {
    const h = harness({ serverUp: true });
    h.lose('s1');
    await h.clock.advance(3_000);
    h.settleRestart('s1', 'timed_out');
    await h.clock.advance(61_000);
    expect(h.summaries).toHaveLength(0);
    h.coordinator.onPromptReady('s1');
    await h.clock.advance(120_000);
    await h.coordinator.cardsSettled();
    expect(h.view('s1').state).toBe('recovered');
    expect(h.summaries).toHaveLength(1);
    expect(h.summaries[0].members[0]!.state).toBe('recovered');
  });

  it('the card still ends on its last state after a transient patch failure', async () => {
    const h = harness({ serverUp: true });
    h.lose('s1');
    await h.clock.advance(3_000);
    await h.coordinator.cardsSettled();
    h.faults.patchFailures = 1;
    h.settleRestart('s1', 'succeeded');
    await h.clock.advance(0);
    await h.coordinator.cardsSettled();
    await h.clock.advance(2_000);
    await h.coordinator.cardsSettled();
    expect(h.shown('s1')?.state).toBe('recovered');
  });

  it('a post that failed after the message was created does not produce a second card', async () => {
    const h = harness({ serverUp: true });
    h.faults.postCreatesThenThrows = 1;
    h.lose('s1');
    await h.clock.advance(0);
    await h.coordinator.cardsSettled();
    await h.clock.advance(3_000);
    await h.coordinator.cardsSettled();
    h.settleRestart('s1', 'succeeded');
    await h.clock.advance(0);
    await h.coordinator.cardsSettled();
    expect(h.cardsPerSession().get('s1')).toBe(1);
    expect(h.shown('s1')?.state).toBe('recovered');
  });

  it('two bot daemons on one server: the later one finds it back and sends no canary of its own', async () => {
    const clock = new ManualClock();
    const server = { serverUp: false };
    const timings = { gatherJitterMs: 7_000 };
    // Whichever bot goes first: its canary's new-session starts the server.
    const a = harness({ clock, server, timings, app: 'bot-a', onRestart: () => { server.serverUp = true; } });
    const b = harness({ clock, server, timings, app: 'bot-b', onRestart: () => { server.serverUp = true; } });
    a.lose('a1'); a.lose('a2');
    b.lose('b1'); b.lose('b2');
    await clock.advance(10_000);
    const all = [...a.restarts, ...b.restarts];
    expect(all).toHaveLength(4);
    expect(all.filter(r => !r.serverWasUp)).toHaveLength(1);
  });

  it('re-probes late down reports instead of spending recovery budget on a healthy server', async () => {
    const h = harness({ serverUp: true, timings: { gatherMs: 0, serverBackoffMs: [1, 1, 1, 1] } });
    h.lose('s1');
    await h.clock.advance(0);
    h.settleRestart('s1', 'succeeded');
    await h.clock.advance(0);

    // Each verdict was latched before the preceding restoration but arrives
    // only after it. The member still needs its own restart; the server does
    // not need another down/backoff period.
    for (const [index, id] of ['s2', 's3', 's4', 's5', 's6'].entries()) {
      h.lose(id, { kind: index % 2 === 0 ? 'gone' : 'unreachable' });
      await h.clock.advance(1);
      expect(h.restarts).toHaveLength(index + 2);
      h.settleRestart(id, 'succeeded');
      await h.clock.advance(0);
    }
    for (const id of IDS) expect(h.view(id)).toMatchObject({ state: 'recovered', serverRetries: 0 });
    expect(h.giveUps).toEqual([]);
  });

  it('holds canary progress while its restart settlement probe is in flight', async () => {
    const probes: Array<{ promise: Promise<boolean>; resolve: (up: boolean) => void }> = [];
    const h = harness({
      timings: { gatherMs: 0 },
      serverUpFn: () => {
        let resolve!: (up: boolean) => void;
        const promise = new Promise<boolean>(r => { resolve = r; });
        probes.push({ promise, resolve });
        return promise;
      },
    });
    h.lose('s1');
    h.lose('s2');
    await h.clock.advance(0);
    probes[0]!.resolve(false);
    await h.clock.advance(0);
    expect(h.restarts.map(r => r.sessionId)).toEqual(['s1']);

    h.settleRestart('s1', 'failed');
    await h.clock.advance(2_000);
    probes[2]!.resolve(false); // poll returns before the settlement probe
    await h.clock.advance(0);
    expect(h.restarts.map(r => r.sessionId)).toEqual(['s1']);

    probes[1]!.resolve(true);
    await h.clock.advance(0);
    // The old settlement may retry ITS OWN failed CLI on the healthy server;
    // it must not create a second canary or apply a stale phase transition.
    expect(h.restarts.map(r => r.sessionId)).toEqual(['s1', 's1', 's2']);
    expect(h.view('s2').state).toBe('recovering');
  });

  it('a newer poll-up decision invalidates a stale settlement-down result', async () => {
    const probes: Array<{ promise: Promise<boolean>; resolve: (up: boolean) => void }> = [];
    const h = harness({
      timings: { gatherMs: 0 },
      serverUpFn: () => {
        let resolve!: (up: boolean) => void;
        const promise = new Promise<boolean>(r => { resolve = r; });
        probes.push({ promise, resolve });
        return promise;
      },
    });
    h.lose('s1');
    await h.clock.advance(0);
    probes[0]!.resolve(false);
    await h.clock.advance(0);
    h.settleRestart('s1', 'failed');
    await h.clock.advance(2_000);
    probes[2]!.resolve(true); // newer observation: the server is back
    await h.clock.advance(0);
    probes[1]!.resolve(false); // stale settlement must not pull it down again
    await h.clock.advance(0);
    expect(h.view('s1').serverRetries).toBe(0);
    expect(h.restarts.map(r => r.sessionId)).toEqual(['s1', 's1']);
  });

  it('a stale settlement still preserves timed_out semantics after a newer poll-up', async () => {
    const probes: Array<{ promise: Promise<boolean>; resolve: (up: boolean) => void }> = [];
    const h = harness({
      timings: { gatherMs: 0 },
      serverUpFn: () => {
        let resolve!: (up: boolean) => void;
        const promise = new Promise<boolean>(r => { resolve = r; });
        probes.push({ promise, resolve });
        return promise;
      },
    });
    h.lose('s1');
    await h.clock.advance(0);
    probes[0]!.resolve(false);
    await h.clock.advance(0);
    h.settleRestart('s1', 'timed_out');
    await h.clock.advance(2_000);
    probes[2]!.resolve(true);
    await h.clock.advance(0);
    probes[1]!.resolve(false);
    await h.clock.advance(0);
    expect(h.restarts).toHaveLength(1);
    expect(h.view('s1')).toMatchObject({ state: 'failed', failure: 'timed_out' });
    expect(h.giveUps).toEqual([]);
    h.coordinator.onPromptReady('s1');
    await h.clock.advance(0);
    expect(h.view('s1').state).toBe('recovered');
  });

  it('a stale settlement cannot bypass the member attempt budget after a newer poll-up', async () => {
    const probes: Array<{ promise: Promise<boolean>; resolve: (up: boolean) => void }> = [];
    const h = harness({
      timings: { gatherMs: 0, memberMaxAttempts: 1 },
      serverUpFn: () => {
        let resolve!: (up: boolean) => void;
        const promise = new Promise<boolean>(r => { resolve = r; });
        probes.push({ promise, resolve });
        return promise;
      },
    });
    h.lose('s1');
    await h.clock.advance(0);
    probes[0]!.resolve(false);
    await h.clock.advance(0);
    h.settleRestart('s1', 'failed');
    await h.clock.advance(2_000);
    probes[2]!.resolve(true);
    await h.clock.advance(0);
    probes[1]!.resolve(false);
    await h.clock.advance(0);
    expect(h.restarts).toHaveLength(1);
    expect(h.view('s1')).toMatchObject({ state: 'failed', failure: 'cli_failed' });
    expect(h.giveUps).toEqual([{ sessionId: 's1', keepTerminal: true }]);
  });

  it('a cancelled restart defers to the replacement generation, then recovers without another restart', async () => {
    const h = harness({ serverUp: true, timings: { gatherMs: 0, deferRecheckMs: 100, externalRecoveryGraceMs: 1_000 } });
    h.lose('s1');
    await h.clock.advance(0);
    h.settleRestart('s1', 'cancelled');
    await h.clock.advance(0);
    expect(h.restarts).toHaveLength(1);

    h.coordinator.onPromptReady('s1');
    await h.clock.advance(1_100);
    expect(h.view('s1').state).toBe('recovered');
    expect(h.restarts).toHaveLength(1);
  });

  it('a cancelled restart has a bounded fallback when no replacement becomes ready', async () => {
    const h = harness({ serverUp: true, timings: { gatherMs: 0, deferRecheckMs: 100, externalRecoveryGraceMs: 1_000 } });
    h.lose('s1');
    await h.clock.advance(0);
    h.settleRestart('s1', 'cancelled');
    await h.clock.advance(999);
    expect(h.restarts).toHaveLength(1);
    await h.clock.advance(101);
    expect(h.restarts).toHaveLength(2);
  });

  it('maps the daemon facts about a session to whether it may be restarted', () => {
    expect(recoveryEligibility({ active: true, current: true, transferring: false })).toBe('now');
    // A relay may still fail and leave the session where it was: ask again.
    expect(recoveryEligibility({ active: true, current: true, transferring: true })).toBe('later');
    expect(recoveryEligibility({ active: false, current: true, transferring: false })).toBe('never');
    expect(recoveryEligibility({ active: true, current: false, transferring: true })).toBe('never');
  });
});
