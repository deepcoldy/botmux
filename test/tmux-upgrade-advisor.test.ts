import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TMUX_CARD_PATCH_GIVE_UP,
  TMUX_IDLE_SWITCH_MS,
  TMUX_NOTIFY_RETRY_MS,
  TMUX_REMOTE_INSTALLER_TIMEOUT_MS,
  TMUX_REMOTE_INSTALLER_TERM_GRACE_MS,
  TmuxUpgradeAdvisor,
  deriveTmuxFactPhase,
  fanOutTmuxSwitchSuspend,
  formatTmuxStatusAdvice,
  isNoTmuxServerError,
  killTmuxServer,
  retireEmptyTmuxServer,
  readTmuxUpgradeStoreFrom,
  tmuxUpgradeStorePathIn,
  writeTmuxUpgradeStoreTo,
  type TmuxFacts,
  type TmuxUpgradeAdvisorDeps,
} from '../src/core/tmux-upgrade.js';
import {
  TMUX_UPGRADE_ACTION_RUN,
  TMUX_UPGRADE_ACTION_SWITCH_IDLE,
  TMUX_UPGRADE_ACTION_SWITCH_IDLE_CANCEL,
  TMUX_UPGRADE_ACTION_SWITCH_NOW,
} from '../src/core/tmux-upgrade-card.js';
import { TMUX_RECOMMENDED_MIN, parseTmuxRelease } from '../src/setup/tmux-recommended.js';
import type { TmuxUpgradePlan } from '../src/setup/tmux-upgrade-plan.js';

const min = parseTmuxRelease(TMUX_RECOMMENDED_MIN.version)!;
const OLD = `${min.major}.${min.minor - 1}a`;
const NEW = `${min.major}.${min.minor + 1}a`;

class ExpiredError extends Error {}

const AUTO_PLAN: TmuxUpgradePlan = {
  auto: true,
  owner: { kind: 'system', pm: 'apt' },
  tmuxPath: '/usr/bin/tmux',
  display: 'apt-get update && apt-get install -y --no-install-recommends tmux',
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function harness(over: Partial<TmuxUpgradeAdvisorDeps> = {}, initial?: Partial<TmuxFacts>) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tmux-upgrade-advisor-'));
  dirs.push(dataDir);
  const state = {
    now: 1_000_000,
    facts: { client: OLD, serverRunning: true, server: OLD, serverUnknown: false, sessions: 3, ...initial } as TmuxFacts,
    sent: [] as { openId: string; card: any }[],
    patches: [] as { messageId: string; card: any }[],
    log: [] as string[],
    nonce: 0,
  };
  const deps: TmuxUpgradeAdvisorDeps = {
    dataDir,
    larkAppId: 'cli_primary',
    ownerOpenId: () => 'ou_owner',
    isAdmin: (_app, openId) => openId === 'ou_owner' || openId === 'ou_coadmin',
    locale: () => 'zh',
    now: () => state.now,
    tmuxBackendInUse: () => true,
    socketName: () => 'botmux',
    probeFacts: async () => ({ ...state.facts }),
    plan: async () => AUTO_PLAN,
    executeUpgrade: vi.fn(async (_plan, onLine) => {
      onLine('Unpacking tmux ...');
      state.facts = { ...state.facts, client: NEW };
      return { ok: true, ran: ['apt-get update', 'apt-get install'] };
    }),
    onBinaryChanged: vi.fn(),
    sendCard: vi.fn(async (openId: string, card: string) => {
      state.sent.push({ openId, card: JSON.parse(card) });
      return `om_${state.sent.length}`;
    }),
    updateCard: vi.fn(async (messageId: string, card: string) => {
      state.patches.push({ messageId, card: JSON.parse(card) });
    }),
    isUpdateExpired: err => err instanceof ExpiredError,
    fanOutSuspend: vi.fn(async () => ({ candidates: 0, affected: 0, failed: 0 })),
    killServer: vi.fn(async () => {
      state.facts = { ...state.facts, serverRunning: false, server: null, sessions: 0 };
    }),
    retireEmptyServer: vi.fn(async () => {
      if (state.facts.sessions === 0) state.facts = { ...state.facts, serverRunning: false, server: null };
    }),
    sleep: vi.fn(async (ms: number) => { state.now += ms; }),
    processStart: pid => (pid === process.pid ? 'self-start' : undefined),
    signalInstaller: vi.fn(),
    log: m => state.log.push(m),
    newNonce: () => `nonce-${++state.nonce}`,
    progressPatchMs: 0,
    serverPollMs: 1_000,
    ...over,
  };
  const advisor = new TmuxUpgradeAdvisor(deps);
  const store = () => readTmuxUpgradeStoreFrom(dataDir);
  const click = (action: string, opts: { operator?: string; nonce?: string; messageId?: string } = {}) => {
    const s = store();
    return advisor.handleAction({
      action,
      nonce: opts.nonce ?? s.card?.nonce,
      messageId: opts.messageId ?? s.card?.messageId,
      operatorOpenId: opts.operator ?? 'ou_owner',
      larkAppId: 'cli_primary',
    });
  };
  const lastCard = () => (state.patches.at(-1)?.card ?? state.sent.at(-1)?.card);
  const buttonsOf = (card: any) => (card?.elements ?? []).filter((e: any) => e.tag === 'action')
    .flatMap((e: any) => e.actions.map((a: any) => a.value.action));
  return { advisor, deps, state, store, click, lastCard, buttonsOf, dataDir };
}

describe('facts → what the host needs', () => {
  it('derives the phase from installed and running versions', () => {
    const f = (o: Partial<TmuxFacts>): TmuxFacts => ({ client: NEW, serverRunning: false, server: null, serverUnknown: false, sessions: 0, ...o });
    expect(deriveTmuxFactPhase(f({ client: OLD }))).toBe('needs_upgrade');
    expect(deriveTmuxFactPhase(f({ serverRunning: true, server: OLD, sessions: 2 }))).toBe('pending_switch');
    expect(deriveTmuxFactPhase(f({ serverRunning: true, server: NEW }))).toBe('done');
    expect(deriveTmuxFactPhase(f({}))).toBe('done');
    expect(deriveTmuxFactPhase(f({ client: null }))).toBeNull();
    expect(deriveTmuxFactPhase(f({ serverRunning: true, serverUnknown: true }))).toBeNull();
  });

  it('`botmux status` advice', () => {
    const f = (o: Partial<TmuxFacts>): TmuxFacts => ({ client: NEW, serverRunning: false, server: null, serverUnknown: false, sessions: 0, ...o });
    expect(formatTmuxStatusAdvice(f({ client: OLD }), 'zh')).toContain(OLD);
    expect(formatTmuxStatusAdvice(f({ serverRunning: true, server: OLD }), 'zh')).toContain(OLD);
    expect(formatTmuxStatusAdvice(f({}), 'zh')).toBeNull();
  });
});

describe('owner reminder', () => {
  it('below the recommendation: one DM to the owner, never repeated (also across restarts)', async () => {
    const h = harness();
    await h.advisor.tick();
    expect(h.state.sent).toHaveLength(1);
    expect(h.state.sent[0]!.openId).toBe('ou_owner');
    expect(h.buttonsOf(h.state.sent[0]!.card)).toEqual([TMUX_UPGRADE_ACTION_RUN]);
    await h.advisor.tick();
    // A fresh advisor over the same store (= daemon restart).
    const again = new TmuxUpgradeAdvisor(h.deps);
    await again.tick();
    expect(h.state.sent).toHaveLength(1);
    expect(h.state.patches).toHaveLength(0);
  });

  it('at or above the recommendation, or with no tmux-backed bot: no DM', async () => {
    const ok = harness({}, { client: NEW, server: NEW });
    await ok.advisor.tick();
    expect(ok.state.sent).toHaveLength(0);

    const noTmux = harness({ tmuxBackendInUse: () => false });
    await noTmux.advisor.tick();
    expect(noTmux.state.sent).toHaveLength(0);

    const unknown = harness({}, { client: null });
    await unknown.advisor.tick();
    expect(unknown.state.sent).toHaveLength(0);
  });

  it('upgraded by hand but the server still runs the old version → the switch card', async () => {
    const h = harness({}, { client: NEW, server: OLD });
    await h.advisor.tick();
    expect(h.state.sent).toHaveLength(1);
    expect(h.buttonsOf(h.state.sent[0]!.card)).toEqual([TMUX_UPGRADE_ACTION_SWITCH_IDLE, TMUX_UPGRADE_ACTION_SWITCH_NOW]);
  });

  it('an open reminder follows the host: a manual upgrade turns it into the switch card in place', async () => {
    const h = harness();
    await h.advisor.tick();
    h.state.facts = { ...h.state.facts, client: NEW };
    await h.advisor.tick();
    expect(h.state.sent).toHaveLength(1);
    expect(h.state.patches).toHaveLength(1);
    expect(h.store().card!.model.phase).toBe('pending_switch');
    h.state.facts = { ...h.state.facts, serverRunning: false, server: null, sessions: 0 };
    await h.advisor.tick();
    expect(h.store().card!.model.phase).toBe('done');
  });

  it('the watermark survives a lost card reference; a card from another bot does not count', async () => {
    const h = harness();
    await h.advisor.tick();
    const told = h.store();
    writeTmuxUpgradeStoreTo(h.dataDir, { notifiedKey: told.notifiedKey });
    await new TmuxUpgradeAdvisor(h.deps).tick();
    expect(h.state.sent).toHaveLength(1);

    // bots.json reordered: the old card belongs to a bot that is no longer primary.
    writeTmuxUpgradeStoreTo(h.dataDir, { ...told, card: { ...told.card!, larkAppId: 'cli_previous_primary' } });
    await new TmuxUpgradeAdvisor(h.deps).tick();
    expect(h.state.sent).toHaveLength(2);
    expect(h.store().card!.larkAppId).toBe('cli_primary');
  });

  it('a failed send backs off instead of retrying every tick', async () => {
    let fail = true;
    const h = harness({
      sendCard: vi.fn(async () => {
        if (fail) throw new Error('230013 bot cannot DM user');
        return 'om_ok';
      }),
    });
    await h.advisor.tick();
    await h.advisor.tick();
    expect(h.deps.sendCard).toHaveBeenCalledTimes(1);
    fail = false;
    h.state.now += TMUX_NOTIFY_RETRY_MS;
    await h.advisor.tick();
    expect(h.deps.sendCard).toHaveBeenCalledTimes(2);
    expect(h.store().card?.messageId).toBe('om_ok');
  });

  it('a card too old to patch is replaced by a fresh DM', async () => {
    const h = harness({
      updateCard: vi.fn(async () => { throw new ExpiredError('expired'); }),
    });
    await h.advisor.tick();
    h.state.facts = { ...h.state.facts, client: NEW };
    await h.advisor.tick();
    expect(h.state.sent).toHaveLength(2);
    expect(h.store().card!.messageId).toBe('om_2');
    expect(h.store().card!.model.phase).toBe('pending_switch');
  });

  it('a transient patch failure is retried on the next tick, not forgotten', async () => {
    let failPatch = true;
    const h = harness({
      updateCard: vi.fn(async () => { if (failPatch) throw new Error('5xx'); }),
    });
    await h.advisor.tick();
    h.state.facts = { ...h.state.facts, client: NEW };
    await h.advisor.tick();
    expect(h.store().card!.dirty).toBe(true);
    failPatch = false;
    await h.advisor.tick();
    expect(h.store().card!.dirty).toBeUndefined();
    // Exactly one retry of the SAME intended state, then nothing new to send.
    expect(h.deps.updateCard).toHaveBeenCalledTimes(2);
    const [, retried] = (h.deps.updateCard as any).mock.calls;
    expect(h.buttonsOf(JSON.parse(retried[1]))).toEqual([TMUX_UPGRADE_ACTION_SWITCH_IDLE, TMUX_UPGRADE_ACTION_SWITCH_NOW]);
    await h.advisor.tick();
    expect(h.deps.updateCard).toHaveBeenCalledTimes(2);
  });
});

describe('card buttons: authorization and freshness', () => {
  it('only bot admins can click; a stale or forged nonce is refused', async () => {
    const h = harness();
    await h.advisor.tick();
    const denied = await h.click(TMUX_UPGRADE_ACTION_RUN, { operator: 'ou_stranger' });
    expect(denied).toHaveProperty('toast.type', 'error');
    expect(await h.click(TMUX_UPGRADE_ACTION_RUN, { nonce: 'forged' })).toHaveProperty('toast.type', 'warning');
    expect(await h.click(TMUX_UPGRADE_ACTION_RUN, { messageId: 'om_other' })).toHaveProperty('toast.type', 'warning');
    expect(h.deps.executeUpgrade).not.toHaveBeenCalled();
    expect(h.store().job).toBeUndefined();
    // A co-admin (allowedUsers, not the DM recipient) may act.
    const ok = await h.click(TMUX_UPGRADE_ACTION_RUN, { operator: 'ou_coadmin' });
    expect(ok).toHaveProperty('card');
  });

  it('a button from another phase is refused (no upgrade from a switch card)', async () => {
    const h = harness({}, { client: NEW, server: OLD });
    await h.advisor.tick();
    expect(await h.click(TMUX_UPGRADE_ACTION_RUN)).toHaveProperty('toast');
    expect(h.deps.executeUpgrade).not.toHaveBeenCalled();
  });
});

describe('one-click upgrade (fake installer)', () => {
  it('streams progress, verifies `tmux -V`, then asks when to switch', async () => {
    const h = harness();
    await h.advisor.tick();
    const res: any = await h.click(TMUX_UPGRADE_ACTION_RUN);
    expect(h.buttonsOf(res.card.data)).toEqual([]); // "upgrading" card, no buttons
    expect(h.store().job?.kind).toBe('upgrade');
    // A second click while it runs is told to wait.
    expect(await h.click(TMUX_UPGRADE_ACTION_RUN)).toHaveProperty('toast.type', 'info');
    await res.afterAck();
    expect(h.deps.executeUpgrade).toHaveBeenCalledTimes(1);
    expect(h.deps.onBinaryChanged).toHaveBeenCalled();
    expect(JSON.stringify(h.state.patches.map(p => p.card))).toContain('Unpacking tmux');
    const s = h.store();
    expect(s.job).toBeUndefined();
    expect(s.card!.model.phase).toBe('pending_switch');
    expect(h.buttonsOf(h.lastCard())).toEqual([TMUX_UPGRADE_ACTION_SWITCH_IDLE, TMUX_UPGRADE_ACTION_SWITCH_NOW]);
    // Nothing was switched without the owner: no suspend, no kill.
    expect(h.deps.fanOutSuspend).not.toHaveBeenCalled();
    expect(h.deps.killServer).not.toHaveBeenCalled();
    // The next tick does not DM the owner again about the same situation.
    await h.advisor.tick();
    expect(h.state.sent).toHaveLength(1);
  });

  it('no running server → straight to done', async () => {
    const h = harness({}, { serverRunning: false, server: null, sessions: 0 });
    await h.advisor.tick();
    const res: any = await h.click(TMUX_UPGRADE_ACTION_RUN);
    await res.afterAck();
    expect(h.store().card!.model.phase).toBe('done');
  });

  it('installer failure → failed card with a retry button, job released', async () => {
    const h = harness({
      executeUpgrade: vi.fn(async (_p, onLine) => {
        onLine('E: Unable to locate package tmux');
        return { ok: false, ran: ['apt-get install'], failure: 'command_failed' as const, error: 'exit 100' };
      }),
    });
    await h.advisor.tick();
    const res: any = await h.click(TMUX_UPGRADE_ACTION_RUN);
    await res.afterAck();
    const s = h.store();
    expect(s.job).toBeUndefined();
    expect(s.card!.model.phase).toBe('upgrade_failed');
    expect(s.card!.model.error).toContain('exit 100');
    expect(h.buttonsOf(h.lastCard())).toEqual([TMUX_UPGRADE_ACTION_RUN]);
    // Retry is possible.
    expect(await h.click(TMUX_UPGRADE_ACTION_RUN)).toHaveProperty('card');
  });

  it('does not hide an installer failure just because the new binary is already visible', async () => {
    const h = harness({
      executeUpgrade: vi.fn(async () => {
        h.state.facts = { ...h.state.facts, client: NEW };
        return { ok: false, ran: ['apt-get install'], failure: 'command_failed' as const, error: 'dpkg post-install failed' };
      }),
    });
    await h.advisor.tick();
    const res: any = await h.click(TMUX_UPGRADE_ACTION_RUN);
    await res.afterAck();
    expect(h.store().card!.model).toMatchObject({ phase: 'upgrade_failed', client: NEW, error: expect.stringContaining('dpkg post-install failed') });
    expect(h.state.log.some(line => line.includes('tmux upgraded to'))).toBe(false);
    await h.advisor.tick();
    expect(h.store().card!.model).toMatchObject({ phase: 'upgrade_failed', error: expect.stringContaining('dpkg post-install failed') });
    const retry: any = await h.click(TMUX_UPGRADE_ACTION_RUN);
    await retry.afterAck();
    expect(h.store().card!.model.phase).toBe('pending_switch');
    expect(h.deps.executeUpgrade).toHaveBeenCalledTimes(1);
  });

  it('command succeeded but tmux is still old → failed, not success', async () => {
    const h = harness({
      executeUpgrade: vi.fn(async () => ({ ok: true, ran: ['dnf upgrade -y tmux'] })),
    });
    await h.advisor.tick();
    const res: any = await h.click(TMUX_UPGRADE_ACTION_RUN);
    await res.afterAck();
    expect(h.store().card!.model.phase).toBe('upgrade_failed');
    expect(h.store().card!.model.error).toContain(OLD);
  });

  it('the plan turned manual since the reminder → no install, manual card', async () => {
    let auto = true;
    const h = harness({
      plan: async () => (auto ? AUTO_PLAN : { auto: false, reason: 'needs_sudo', tmuxPath: '/usr/bin/tmux', manualCommand: 'sudo apt-get install -y tmux' }),
    });
    await h.advisor.tick();
    auto = false;
    const res: any = await h.click(TMUX_UPGRADE_ACTION_RUN);
    await res.afterAck();
    expect(h.deps.executeUpgrade).not.toHaveBeenCalled();
    expect(h.store().card!.model).toMatchObject({ phase: 'needs_upgrade', plan: { auto: false, reason: 'needs_sudo' } });
    expect(h.buttonsOf(h.lastCard())).toEqual([]);
  });

  it('an installer that throws still releases the job', async () => {
    const h = harness({ executeUpgrade: vi.fn(async () => { throw new Error('spawn EACCES'); }) });
    await h.advisor.tick();
    const res: any = await h.click(TMUX_UPGRADE_ACTION_RUN);
    await res.afterAck();
    expect(h.store().job).toBeUndefined();
    expect(h.store().card!.model).toMatchObject({ phase: 'upgrade_failed', error: 'spawn EACCES' });
  });

  it('a job left behind by a restarted daemon is cleared and the card re-rendered', async () => {
    const h = harness();
    await h.advisor.tick();
    const s = h.store();
    writeTmuxUpgradeStoreTo(h.dataDir, {
      ...s,
      card: { ...s.card!, model: { ...s.card!.model, phase: 'upgrading' } },
      job: { kind: 'upgrade', pid: 2_147_000_000, pidStart: 'gone', startedAt: 1 },
    });
    // The click path recognises the dead job too, but refuses the old phase.
    const fresh = new TmuxUpgradeAdvisor(h.deps);
    await fresh.tick();
    const after = h.store();
    expect(after.job).toBeUndefined();
    expect(after.card!.model).toMatchObject({ phase: 'needs_upgrade', interruptedByRestart: true });
    expect(h.buttonsOf(h.lastCard())).toEqual([TMUX_UPGRADE_ACTION_RUN]);
  });
});

describe('switching the tmux server', () => {
  async function pendingSwitch(over: Partial<TmuxUpgradeAdvisorDeps> = {}, facts: Partial<TmuxFacts> = {}) {
    const h = harness(over, { client: NEW, server: OLD, sessions: 3, ...facts });
    await h.advisor.tick();
    expect(h.store().card!.model.phase).toBe('pending_switch');
    return h;
  }

  it('refreshes an open switch card when only the server session count changes', async () => {
    const h = await pendingSwitch({}, { sessions: 1 });
    h.state.facts = { ...h.state.facts, sessions: 5 };
    await h.advisor.tick();
    expect(h.state.patches).toHaveLength(1);
    expect(h.store().card!.model).toMatchObject({ phase: 'pending_switch', serverSessions: 5 });
  });

  it('"now" revalidates the confirmation at click time instead of trusting a stale card', async () => {
    const h = await pendingSwitch({}, { sessions: 1 });
    h.state.facts = { ...h.state.facts, sessions: 5 };
    const res: any = await h.click(TMUX_UPGRADE_ACTION_SWITCH_NOW);
    expect(res.afterAck).toBeUndefined();
    expect(h.store().job).toBeUndefined();
    expect(h.store().card!.model).toMatchObject({ phase: 'pending_switch', serverSessions: 5 });
    expect(h.deps.fanOutSuspend).not.toHaveBeenCalled();
    expect(h.deps.killServer).not.toHaveBeenCalled();
    const nowButton = res.card.data.elements
      .filter((element: any) => element.tag === 'action')
      .flatMap((element: any) => element.actions)
      .find((action: any) => action.value.action === TMUX_UPGRADE_ACTION_SWITCH_NOW);
    expect(nowButton.confirm.text.content).toContain('5');
  });

  it('an older in-flight tick cannot overwrite a fresher click confirmation', async () => {
    const h = await pendingSwitch({}, { sessions: 1 });
    let releaseStale: (() => void) | undefined;
    h.deps.probeFacts = vi.fn(() => {
      if (!releaseStale) {
        return new Promise<TmuxFacts>(resolve => {
          releaseStale = () => resolve({ ...h.state.facts, sessions: 1 });
        });
      }
      return Promise.resolve({ ...h.state.facts });
    });
    h.state.facts = { ...h.state.facts, sessions: 5 };
    const ticking = h.advisor.tick();
    await vi.waitFor(() => expect(releaseStale).toBeDefined());
    const res: any = await h.click(TMUX_UPGRADE_ACTION_SWITCH_NOW);
    expect(res.afterAck).toBeUndefined();
    expect(h.store().card!.model.serverSessions).toBe(5);
    releaseStale!();
    await ticking;
    expect(h.store().card!.model.serverSessions).toBe(5);
    expect(h.store().job).toBeUndefined();
  });

  it('"now": suspends idle sessions first, then stops the old server for the rest', async () => {
    const h = await pendingSwitch({
      fanOutSuspend: vi.fn(async () => ({ candidates: 2, affected: 2, failed: 0 })),
    });
    // After the suspend one busy session keeps the old server alive.
    (h.deps.fanOutSuspend as any).mockImplementation(async () => {
      h.state.facts = { ...h.state.facts, sessions: 1 };
      return { candidates: 2, affected: 2, failed: 0 };
    });
    const res: any = await h.click(TMUX_UPGRADE_ACTION_SWITCH_NOW);
    expect(h.store().job?.kind).toBe('switch');
    await res.afterAck();
    expect(h.deps.fanOutSuspend).toHaveBeenCalledWith({ socketName: 'botmux', olderThanMs: 1, dryRun: false });
    expect(h.deps.killServer).toHaveBeenCalledWith('botmux');
    expect(h.store().card!.model).toMatchObject({ phase: 'done', suspended: 2, interrupted: 1 });
    expect(h.store().job).toBeUndefined();
  });

  it('"now" with every session idle: the emptied server exits by itself, nothing is killed', async () => {
    const h = await pendingSwitch({
      fanOutSuspend: vi.fn(async () => {
        h.state.facts = { ...h.state.facts, serverRunning: false, server: null, sessions: 0 };
        return { candidates: 3, affected: 3, failed: 0 };
      }),
    });
    const res: any = await h.click(TMUX_UPGRADE_ACTION_SWITCH_NOW);
    await res.afterAck();
    expect(h.deps.killServer).not.toHaveBeenCalled();
    expect(h.store().card!.model).toMatchObject({ phase: 'done', suspended: 3, interrupted: 0 });
  });

  it('kill-server that does not take → switch_failed with the server still on the old version', async () => {
    const h = await pendingSwitch({ killServer: vi.fn(async () => {}) });
    const res: any = await h.click(TMUX_UPGRADE_ACTION_SWITCH_NOW);
    await res.afterAck();
    expect(h.store().card!.model.phase).toBe('switch_failed');
    expect(h.buttonsOf(h.lastCard())).toEqual([TMUX_UPGRADE_ACTION_SWITCH_IDLE, TMUX_UPGRADE_ACTION_SWITCH_NOW]);
  });

  it('"when idle" waits while any session is not idle long enough, and never suspends or kills meanwhile', async () => {
    const h = await pendingSwitch({
      fanOutSuspend: vi.fn(async req => ({ candidates: req.dryRun ? 2 : 0, affected: 0, failed: 0 })),
    });
    const res: any = await h.click(TMUX_UPGRADE_ACTION_SWITCH_IDLE);
    expect(h.store().idleSwitch?.requestedBy).toBe('ou_owner');
    await res.afterAck(); // immediate evaluation
    await h.advisor.tick();
    const calls = (h.deps.fanOutSuspend as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((r: any) => r.dryRun === true && r.olderThanMs === TMUX_IDLE_SWITCH_MS)).toBe(true);
    expect(h.deps.killServer).not.toHaveBeenCalled();
    expect(h.store().card!.model).toMatchObject({ phase: 'awaiting_idle', idleReady: 2, serverSessions: 3 });
  });

  it('"when idle" switches once every session is idle-ready', async () => {
    const h = await pendingSwitch({
      fanOutSuspend: vi.fn(async req => {
        if (req.dryRun) return { candidates: 3, affected: 0, failed: 0 };
        h.state.facts = { ...h.state.facts, serverRunning: false, server: null, sessions: 0 };
        return { candidates: 3, affected: 3, failed: 0 };
      }),
    });
    const res: any = await h.click(TMUX_UPGRADE_ACTION_SWITCH_IDLE);
    await res.afterAck();
    await vi.waitFor(() => expect(h.store().card!.model.phase).toBe('done'));
    expect(h.deps.killServer).not.toHaveBeenCalled();
    expect(h.store().idleSwitch).toBeUndefined();
  });

  it('"when idle" never kills: if a session wakes up mid-switch it goes back to waiting', async () => {
    const h = await pendingSwitch({
      fanOutSuspend: vi.fn(async req => {
        if (req.dryRun) return { candidates: 3, affected: 0, failed: 0 };
        h.state.facts = { ...h.state.facts, sessions: 1 }; // one became busy
        return { candidates: 2, affected: 2, failed: 0 };
      }),
    });
    const res: any = await h.click(TMUX_UPGRADE_ACTION_SWITCH_IDLE);
    await res.afterAck();
    await vi.waitFor(() => expect(h.store().job).toBeUndefined());
    expect(h.deps.killServer).not.toHaveBeenCalled();
    expect(h.store().card!.model.phase).toBe('awaiting_idle');
    expect(h.store().idleSwitch).toBeDefined();
  });

  it('"when idle" with an unreachable daemon waits instead of switching blind', async () => {
    const h = await pendingSwitch({
      fanOutSuspend: vi.fn(async () => ({ candidates: 3, affected: 0, failed: 1 })),
    });
    const res: any = await h.click(TMUX_UPGRADE_ACTION_SWITCH_IDLE);
    await res.afterAck();
    expect((h.deps.fanOutSuspend as any).mock.calls.every((c: any[]) => c[0].dryRun)).toBe(true);
    expect(h.store().card!.model.phase).toBe('awaiting_idle');
  });

  it('cancel disarms the idle switch', async () => {
    const h = await pendingSwitch({
      fanOutSuspend: vi.fn(async () => ({ candidates: 3, affected: 0, failed: 0 })),
    });
    await h.click(TMUX_UPGRADE_ACTION_SWITCH_IDLE);
    const res: any = await h.click(TMUX_UPGRADE_ACTION_SWITCH_IDLE_CANCEL);
    expect(h.buttonsOf(res.card.data)).toEqual([TMUX_UPGRADE_ACTION_SWITCH_IDLE, TMUX_UPGRADE_ACTION_SWITCH_NOW]);
    expect(h.store().idleSwitch).toBeUndefined();
    await h.advisor.tick();
    expect(h.deps.fanOutSuspend).not.toHaveBeenCalled();
    expect(h.store().card!.model.phase).toBe('pending_switch');
  });

  it('the shared default server is never switched', async () => {
    const h = await pendingSwitch({ socketName: () => undefined });
    expect(h.buttonsOf(h.lastCard())).toEqual([]);
    expect(await h.click(TMUX_UPGRADE_ACTION_SWITCH_NOW)).toHaveProperty('toast');
    expect(await h.click(TMUX_UPGRADE_ACTION_SWITCH_IDLE)).toHaveProperty('toast');
    expect(h.deps.killServer).not.toHaveBeenCalled();
    expect(h.deps.fanOutSuspend).not.toHaveBeenCalled();
  });

  it('an idle switch and its card are invalidated when the dedicated socket changes', async () => {
    let socket = 'sock-a';
    const h = await pendingSwitch({ socketName: () => socket });
    await h.click(TMUX_UPGRADE_ACTION_SWITCH_IDLE); // armed, but do not run afterAck
    socket = 'sock-b';
    expect(await h.click(TMUX_UPGRADE_ACTION_SWITCH_NOW)).toHaveProperty('toast.type', 'warning');
    await new TmuxUpgradeAdvisor(h.deps).tick();
    expect(h.store().idleSwitch).toBeUndefined();
    expect(h.store().job).toBeUndefined();
    expect(h.store().card).toMatchObject({ recipientOpenId: 'ou_owner', messageId: 'om_2', model: { socketName: 'sock-b' } });
    expect(h.state.sent.map(s => s.openId)).toEqual(['ou_owner', 'ou_owner']);
    expect(h.deps.fanOutSuspend).not.toHaveBeenCalled();
    expect(h.deps.killServer).not.toHaveBeenCalled();
  });

  it('legacy cards and idle switches without scope fields fail closed', async () => {
    const h = await pendingSwitch();
    const s: any = h.store();
    delete s.card.recipientOpenId;
    delete s.card.model.socketName;
    s.card.model.sharedServer = true;
    s.notifiedKey = 'legacy-unscoped-watermark';
    s.idleSwitch = { requestedAt: 1, requestedBy: 'ou_owner' };
    writeTmuxUpgradeStoreTo(h.dataDir, s);
    await new TmuxUpgradeAdvisor(h.deps).tick();
    expect(h.store().idleSwitch).toBeUndefined();
    expect(h.store().card).toMatchObject({ recipientOpenId: 'ou_owner', messageId: 'om_2', model: { socketName: 'botmux' } });
    expect(h.deps.fanOutSuspend).not.toHaveBeenCalled();
  });

  it('owner replacement invalidates the old card and sends the new owner an actionable one', async () => {
    let owner = 'ou_owner';
    const h = harness({ ownerOpenId: () => owner, isAdmin: (_app, openId) => openId === owner });
    await h.advisor.tick();
    const old = h.store().card!;
    owner = 'ou_new_owner';
    expect(await h.click(TMUX_UPGRADE_ACTION_RUN, {
      operator: owner, messageId: old.messageId, nonce: old.nonce,
    })).toHaveProperty('toast.type', 'warning');
    await new TmuxUpgradeAdvisor(h.deps).tick();
    expect(h.state.sent.map(s => s.openId)).toEqual(['ou_owner', 'ou_new_owner']);
    expect(h.store().card).toMatchObject({ recipientOpenId: 'ou_new_owner', messageId: 'om_2' });
    expect(h.state.patches).toHaveLength(0);
  });

  it('a new owner does not inherit the previous owner\'s failed-DM backoff', async () => {
    let owner = 'ou_owner';
    const h = harness({
      ownerOpenId: () => owner,
      sendCard: vi.fn(async (openId: string, card: string) => {
        if (openId === 'ou_owner') throw new Error('old owner cannot be DMd');
        h.state.sent.push({ openId, card: JSON.parse(card) });
        return 'om_new_owner';
      }),
    });
    await h.advisor.tick();
    expect(h.store().notifyFailedAt).toBeDefined();
    owner = 'ou_new_owner';
    await new TmuxUpgradeAdvisor(h.deps).tick();
    expect(h.state.sent.map(s => s.openId)).toEqual(['ou_new_owner']);
    expect(h.store().card).toMatchObject({ recipientOpenId: 'ou_new_owner', messageId: 'om_new_owner' });
    expect(h.store().notifyFailedAt).toBeUndefined();
  });

  it('a different primary app does not inherit the previous app\'s failed-DM backoff', async () => {
    const h = harness({ sendCard: vi.fn(async () => { throw new Error('app A DM failed'); }) });
    await h.advisor.tick();
    expect(h.store().notifyFailedAt).toBeDefined();
    const sendB = vi.fn(async () => 'om_app_b');
    const appB = new TmuxUpgradeAdvisor({ ...h.deps, larkAppId: 'cli_b', sendCard: sendB });
    await appB.tick();
    expect(sendB).toHaveBeenCalledTimes(1);
    expect(h.store().card).toMatchObject({ larkAppId: 'cli_b', recipientOpenId: 'ou_owner', messageId: 'om_app_b' });
  });

  it('owner replacement also drops an idle switch armed by the previous owner', async () => {
    let owner = 'ou_owner';
    const h = await pendingSwitch({ ownerOpenId: () => owner, isAdmin: (_app, openId) => openId === owner });
    await h.click(TMUX_UPGRADE_ACTION_SWITCH_IDLE);
    owner = 'ou_new_owner';
    await new TmuxUpgradeAdvisor(h.deps).tick();
    expect(h.store().idleSwitch).toBeUndefined();
    expect(h.store().card).toMatchObject({ recipientOpenId: 'ou_new_owner', messageId: 'om_2' });
    expect(h.deps.fanOutSuspend).not.toHaveBeenCalled();
  });

  it('"now" re-checks the binary: a downgraded tmux is not switched to', async () => {
    const h = await pendingSwitch();
    h.state.facts = { ...h.state.facts, client: OLD };
    const res: any = await h.click(TMUX_UPGRADE_ACTION_SWITCH_NOW);
    await res.afterAck();
    expect(h.deps.fanOutSuspend).not.toHaveBeenCalled();
    expect(h.deps.killServer).not.toHaveBeenCalled();
    expect(h.store().card!.model.phase).toBe('switch_failed');
  });
});

describe('adversarial-review regressions', () => {
  async function pending(over: Partial<TmuxUpgradeAdvisorDeps> = {}, facts: Partial<TmuxFacts> = {}) {
    const h = harness(over, { client: NEW, server: OLD, sessions: 3, ...facts });
    await h.advisor.tick();
    expect(h.store().card!.model.phase).toBe('pending_switch');
    return h;
  }

  it('"now": an unreadable probe after the sweep is not "switched" — it keeps polling and kills', async () => {
    let glitches = 2;
    const h = await pending();
    (h.deps.fanOutSuspend as any).mockImplementation(async () => {
      h.state.facts = { ...h.state.facts, sessions: 1 };
      return { candidates: 2, affected: 2, failed: 0 };
    });
    h.deps.probeFacts = vi.fn(async () => {
      if ((h.deps.fanOutSuspend as any).mock.calls.length && glitches > 0) {
        glitches--;
        return { ...h.state.facts, server: null, serverUnknown: true };
      }
      return { ...h.state.facts };
    });
    const res: any = await h.click(TMUX_UPGRADE_ACTION_SWITCH_NOW);
    await res.afterAck();
    expect(h.deps.killServer).toHaveBeenCalledTimes(1);
    expect(h.store().card!.model).toMatchObject({ phase: 'done', interrupted: 1 });
  });

  it('"now": a server that stays unreadable ends as switch_failed, never done', async () => {
    const h = await pending({ killServer: vi.fn(async () => {}) });
    (h.deps.fanOutSuspend as any).mockImplementation(async () => {
      h.state.facts = { ...h.state.facts, server: null, serverUnknown: true };
      return { candidates: 0, affected: 0, failed: 0 };
    });
    const res: any = await h.click(TMUX_UPGRADE_ACTION_SWITCH_NOW);
    await res.afterAck();
    expect(h.store().card!.model.phase).toBe('switch_failed');
  });

  it('"when idle": an unreadable probe after the sweep goes back to waiting, never kills', async () => {
    const h = await pending();
    (h.deps.fanOutSuspend as any).mockImplementation(async (req: any) => {
      if (req.dryRun) return { candidates: 3, affected: 0, failed: 0 };
      h.state.facts = { ...h.state.facts, server: null, serverUnknown: true };
      return { candidates: 3, affected: 3, failed: 0 };
    });
    const res: any = await h.click(TMUX_UPGRADE_ACTION_SWITCH_IDLE);
    await res.afterAck();
    await vi.waitFor(() => expect(h.store().job).toBeUndefined());
    expect(h.deps.killServer).not.toHaveBeenCalled();
    expect(h.deps.retireEmptyServer).not.toHaveBeenCalled();
    expect(h.store().card!.model.phase).toBe('awaiting_idle');
    expect(h.store().idleSwitch).toBeDefined();
  });

  it('"when idle": the real sweep uses the same idle age as the dry run', async () => {
    const h = await pending();
    (h.deps.fanOutSuspend as any).mockImplementation(async (req: any) => {
      if (!req.dryRun) h.state.facts = { ...h.state.facts, serverRunning: false, server: null, sessions: 0 };
      return { candidates: 3, affected: req.dryRun ? 0 : 3, failed: 0 };
    });
    const res: any = await h.click(TMUX_UPGRADE_ACTION_SWITCH_IDLE);
    await res.afterAck();
    await vi.waitFor(() => expect(h.store().card!.model.phase).toBe('done'));
    const real = (h.deps.fanOutSuspend as any).mock.calls.map((c: any[]) => c[0]).filter((r: any) => !r.dryRun);
    expect(real).toEqual([{ socketName: 'botmux', olderThanMs: TMUX_IDLE_SWITCH_MS, dryRun: false }]);
  });

  it('"when idle": a failure disarms the idle switch — no automatic retries, no repeated kills', async () => {
    const h = await pending();
    (h.deps.fanOutSuspend as any).mockImplementation(async (req: any) => {
      if (req.dryRun) return { candidates: 3, affected: 0, failed: 0 };
      throw new Error('ipc exploded');
    });
    const res: any = await h.click(TMUX_UPGRADE_ACTION_SWITCH_IDLE);
    await res.afterAck();
    await vi.waitFor(() => expect(h.store().job).toBeUndefined());
    expect(h.store().card!.model.phase).toBe('switch_failed');
    expect(h.store().idleSwitch).toBeUndefined();
    const calls = (h.deps.fanOutSuspend as any).mock.calls.length;
    await h.advisor.tick();
    await h.advisor.tick();
    expect((h.deps.fanOutSuspend as any).mock.calls.length).toBe(calls);
    expect(h.deps.killServer).not.toHaveBeenCalled();
  });

  it('"when idle" on an empty lingering server lets it exit instead of killing it', async () => {
    const h = await pending({}, { sessions: 0 });
    const res: any = await h.click(TMUX_UPGRADE_ACTION_SWITCH_IDLE);
    await res.afterAck();
    await vi.waitFor(() => expect(h.store().card!.model.phase).toBe('done'));
    expect(h.deps.retireEmptyServer).toHaveBeenCalledWith('botmux');
    expect(h.deps.killServer).not.toHaveBeenCalled();
  });

  it('a fan-out that never answers cannot wedge the job (hard deadline)', async () => {
    const h = await pending({
      fanOutSuspend: vi.fn(() => new Promise<never>(() => {})),
      fanOutTimeoutMs: { dry: 30, run: 30 },
    });
    const res: any = await h.click(TMUX_UPGRADE_ACTION_SWITCH_NOW);
    await res.afterAck();
    expect(h.store().job).toBeUndefined();
    expect(h.store().card!.model.phase).toBe('switch_failed');
    expect(h.deps.killServer).not.toHaveBeenCalled();
  });

  it('arming idle during an active tick gets a fresh evaluation in the same tick loop', async () => {
    const h = await pending({}, { sessions: 1 });
    let releaseProbe: (() => void) | undefined;
    h.deps.probeFacts = vi.fn(() => {
      if (!releaseProbe) {
        return new Promise<TmuxFacts>(resolve => {
          releaseProbe = () => resolve({ ...h.state.facts });
        });
      }
      return Promise.resolve({ ...h.state.facts });
    });
    h.deps.fanOutSuspend = vi.fn(async request => {
      if (!request.dryRun) h.state.facts = { ...h.state.facts, serverRunning: false, server: null, sessions: 0 };
      return { candidates: 1, affected: request.dryRun ? 0 : 1, failed: 0 };
    });
    const ticking = h.advisor.tick();
    await vi.waitFor(() => expect(releaseProbe).toBeDefined());
    const armed: any = await h.click(TMUX_UPGRADE_ACTION_SWITCH_IDLE);
    const evaluated = armed.afterAck();
    releaseProbe!();
    await Promise.all([ticking, evaluated]);
    expect((h.deps.fanOutSuspend as any).mock.calls.map((c: any[]) => c[0].dryRun)).toEqual([true, false]);
    await vi.waitFor(() => expect(h.store().card!.model.phase).toBe('done'));
  });

  it('cancel during a slow dry run is answered at once and the switch does not happen', async () => {
    let releaseDry: (v: any) => void = () => {};
    const h = await pending();
    (h.deps.fanOutSuspend as any).mockImplementation((req: any) => (req.dryRun
      ? new Promise(r => { releaseDry = r; })
      : Promise.resolve({ candidates: 3, affected: 3, failed: 0 })));
    const armed: any = await h.click(TMUX_UPGRADE_ACTION_SWITCH_IDLE);
    const ticking = armed.afterAck();
    await vi.waitFor(() => expect(h.deps.fanOutSuspend).toHaveBeenCalled());
    const cancel: any = await h.click(TMUX_UPGRADE_ACTION_SWITCH_IDLE_CANCEL);
    expect(cancel).toHaveProperty('card');
    releaseDry({ candidates: 3, affected: 0, failed: 0 });
    await ticking;
    expect((h.deps.fanOutSuspend as any).mock.calls.every((c: any[]) => c[0].dryRun)).toBe(true);
    expect(h.store().idleSwitch).toBeUndefined();
    expect(h.store().job).toBeUndefined();
  });

  it('an idle switch armed on another bot\'s card is dropped, not executed', async () => {
    const h = await pending({ fanOutSuspend: vi.fn(async () => ({ candidates: 3, affected: 3, failed: 0 })) });
    const s = h.store();
    writeTmuxUpgradeStoreTo(h.dataDir, {
      ...s,
      card: { ...s.card!, larkAppId: 'cli_previous_primary', model: { ...s.card!.model, phase: 'awaiting_idle' } },
      idleSwitch: { requestedAt: 1, requestedBy: 'ou_previous_owner', socketName: 'botmux' },
    });
    await new TmuxUpgradeAdvisor(h.deps).tick();
    expect(h.deps.fanOutSuspend).not.toHaveBeenCalled();
    expect(h.store().idleSwitch).toBeUndefined();
  });

  it('an idle switch is dropped when the managed server becomes the shared default one', async () => {
    let socket: string | undefined = 'botmux';
    const h = await pending({
      socketName: () => socket,
      fanOutSuspend: vi.fn(async () => ({ candidates: 0, affected: 0, failed: 0 })),
    });
    await h.click(TMUX_UPGRADE_ACTION_SWITCH_IDLE);
    socket = undefined;
    await h.advisor.tick();
    expect(h.deps.fanOutSuspend).not.toHaveBeenCalled();
    expect(h.store().idleSwitch).toBeUndefined();
  });

  it('while a failed DM is backing off, the card is not even built (no package-tool spawns)', async () => {
    const plan = vi.fn(async () => AUTO_PLAN);
    const h = harness({ plan, sendCard: vi.fn(async () => { throw new Error('230013'); }) });
    for (let i = 0; i < 5; i++) await h.advisor.tick();
    expect(h.deps.sendCard).toHaveBeenCalledTimes(1);
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it('re-sending an expired card backs off after a failed send, like a new DM', async () => {
    let sendOk = true;
    const h = harness({
      updateCard: vi.fn(async () => { throw new ExpiredError('expired'); }),
      sendCard: vi.fn(async (_o: string, card: string) => {
        if (!sendOk) throw new Error('230013');
        h.state.sent.push({ openId: 'ou_owner', card: JSON.parse(card) });
        return `om_${h.state.sent.length}`;
      }),
    });
    await h.advisor.tick();
    sendOk = false;
    h.state.facts = { ...h.state.facts, client: NEW };
    await h.advisor.tick();
    await h.advisor.tick();
    await h.advisor.tick();
    expect(h.deps.sendCard).toHaveBeenCalledTimes(2);
  });

  it('a click during a tick\'s card patch is not lost to the tick\'s write', async () => {
    let releasePatch: () => void = () => {};
    let holdPatches = false;
    const h = harness({
      updateCard: vi.fn((messageId: string, card: string) => {
        h.state.patches.push({ messageId, card: JSON.parse(card) });
        return holdPatches ? new Promise<void>(r => { releasePatch = r; }) : Promise.resolve();
      }),
    });
    await h.advisor.tick();
    holdPatches = true;
    h.state.facts = { ...h.state.facts, client: `${min.major}.${min.minor - 1}b` }; // a change → reconcile patch
    const ticking = h.advisor.tick();
    await vi.waitFor(() => expect(h.state.patches.length).toBe(1));
    const click = h.click(TMUX_UPGRADE_ACTION_RUN);
    holdPatches = false;
    releasePatch();
    await ticking;
    const res: any = await click;
    expect(res).toHaveProperty('card');
    expect(h.store().job?.kind).toBe('upgrade');
    await res.afterAck();
  });

  it('a card whose patches keep failing is eventually replaced by a fresh DM', async () => {
    const h = harness({ updateCard: vi.fn(async () => { throw new Error('230002'); }) });
    await h.advisor.tick();
    h.state.facts = { ...h.state.facts, client: NEW };
    for (let i = 0; i < TMUX_CARD_PATCH_GIVE_UP + 2; i++) await h.advisor.tick();
    expect(h.state.sent).toHaveLength(2);
    expect(h.store().card).toMatchObject({ messageId: 'om_2', model: { phase: 'pending_switch' } });
    expect(h.store().card!.dirty).toBeUndefined();
  });

  it('a job that could not be recorded is not left half-claimed', async () => {
    const h = harness();
    await h.advisor.tick();
    const blocker = `${tmuxUpgradeStorePathIn(h.dataDir)}.${process.pid}.tmp`;
    mkdirSync(blocker);
    expect(await h.click(TMUX_UPGRADE_ACTION_RUN)).toHaveProperty('toast.type', 'warning');
    rmSync(blocker, { recursive: true });
    const res: any = await h.click(TMUX_UPGRADE_ACTION_RUN);
    expect(res).toHaveProperty('card');
    await res.afterAck();
    expect(h.deps.executeUpgrade).toHaveBeenCalledTimes(1);
  });

  it('a recycled pid is not mistaken for the job owner', async () => {
    const h = harness({ processStart: pid => (pid === process.pid ? 'self-start' : pid === 4242 ? 'a-different-process' : undefined) });
    await h.advisor.tick();
    const s = h.store();
    writeTmuxUpgradeStoreTo(h.dataDir, {
      ...s,
      card: { ...s.card!, model: { ...s.card!.model, phase: 'upgrading' } },
      job: { kind: 'upgrade', pid: 4242, pidStart: 'the-old-daemon', startedAt: 1 },
    });
    await new TmuxUpgradeAdvisor(h.deps).tick();
    expect(h.store().job).toBeUndefined();
    expect(h.store().card!.model.interruptedByRestart).toBe(true);
  });

  it('an installer still running after a daemon restart keeps the job alive until it ends', async () => {
    let installerAlive = true;
    const h = harness({
      processStart: pid => (pid === process.pid ? 'self-start' : pid === 777 && installerAlive ? 'apt-start' : undefined),
    });
    await h.advisor.tick();
    const s = h.store();
    writeTmuxUpgradeStoreTo(h.dataDir, {
      ...s,
      card: { ...s.card!, model: { ...s.card!.model, phase: 'upgrading' } },
      job: { kind: 'upgrade', pid: 2_147_000_001, startedAt: h.state.now, installerPid: 777, installerStart: 'apt-start' },
    });
    const restarted = new TmuxUpgradeAdvisor(h.deps);
    await restarted.tick();
    expect(h.store().job).toBeDefined();
    expect(await h.click(TMUX_UPGRADE_ACTION_RUN, {})).toHaveProperty('toast.type', 'info');
    // apt finished meanwhile and delivered the new binary.
    installerAlive = false;
    h.state.facts = { ...h.state.facts, client: NEW };
    await restarted.tick();
    expect(h.store().job).toBeUndefined();
    expect(h.store().card!.model.phase).toBe('pending_switch');
    expect(h.state.sent).toHaveLength(1);
  });

  it('re-arms a bounded TERM/KILL recovery for an installer that outlives its daemon deadline', async () => {
    let installerAlive = true;
    const signalInstaller = vi.fn();
    const h = harness({
      processStart: pid => (pid === process.pid ? 'self-start' : pid === 777 && installerAlive ? 'apt-start' : undefined),
      signalInstaller,
    });
    await h.advisor.tick();
    const s = h.store();
    writeTmuxUpgradeStoreTo(h.dataDir, {
      ...s,
      card: { ...s.card!, model: { ...s.card!.model, phase: 'upgrading' } },
      job: {
        kind: 'upgrade', pid: 2_147_000_001,
        startedAt: h.state.now - TMUX_REMOTE_INSTALLER_TIMEOUT_MS,
        installerPid: 777, installerStart: 'apt-start',
      },
    });
    const restarted = new TmuxUpgradeAdvisor(h.deps);
    await restarted.tick();
    expect(signalInstaller).toHaveBeenCalledWith(777, 'SIGTERM');
    expect(h.store().job).toMatchObject({ installerPid: 777, timeoutRequestedAt: h.state.now });

    await restarted.tick();
    expect(signalInstaller).toHaveBeenCalledTimes(1); // still inside the TERM grace
    h.state.now += TMUX_REMOTE_INSTALLER_TERM_GRACE_MS;
    await restarted.tick();
    expect(signalInstaller).toHaveBeenCalledWith(777, 'SIGKILL');
    expect(h.store().job).toBeDefined(); // never released while the installer is alive

    installerAlive = false;
    h.state.facts = { ...h.state.facts, client: NEW };
    await restarted.tick();
    expect(h.store().job).toBeUndefined();
    expect(h.store().card!.model.phase).toBe('pending_switch');
  });

  it('never signals a recycled installer PID just because the old daemon is still alive', async () => {
    const signalInstaller = vi.fn();
    const h = harness({
      processStart: pid => pid === process.pid ? 'self-start'
        : pid === 4242 ? 'daemon-start'
          : pid === 777 ? 'recycled-unrelated-process' : undefined,
      signalInstaller,
    });
    await h.advisor.tick();
    const s = h.store();
    writeTmuxUpgradeStoreTo(h.dataDir, {
      ...s,
      card: { ...s.card!, model: { ...s.card!.model, phase: 'upgrading' } },
      job: {
        kind: 'upgrade', pid: 4242, pidStart: 'daemon-start',
        startedAt: h.state.now - TMUX_REMOTE_INSTALLER_TIMEOUT_MS,
        installerPid: 777, installerStart: 'original-installer-start',
      },
    });
    await new TmuxUpgradeAdvisor(h.deps).tick();
    expect(signalInstaller).not.toHaveBeenCalled();
    expect(h.store().job?.installerPid).toBe(777);
    expect(h.store().job?.timeoutRequestedAt).toBeUndefined();
  });

  it('sends KILL once, then surfaces manual recovery without releasing the live job', async () => {
    const signalInstaller = vi.fn();
    const h = harness({
      processStart: pid => pid === process.pid ? 'self-start' : pid === 777 ? 'apt-start' : undefined,
      signalInstaller,
    });
    await h.advisor.tick();
    const s = h.store();
    writeTmuxUpgradeStoreTo(h.dataDir, {
      ...s,
      card: { ...s.card!, model: { ...s.card!.model, phase: 'upgrading' } },
      job: {
        kind: 'upgrade', pid: 2_147_000_001,
        startedAt: h.state.now - TMUX_REMOTE_INSTALLER_TIMEOUT_MS,
        installerPid: 777, installerStart: 'apt-start',
      },
    });
    const restarted = new TmuxUpgradeAdvisor(h.deps);
    await restarted.tick(); // TERM
    h.state.now += TMUX_REMOTE_INSTALLER_TERM_GRACE_MS;
    await restarted.tick(); // one KILL
    h.state.now += TMUX_REMOTE_INSTALLER_TERM_GRACE_MS;
    await restarted.tick(); // terminal/manual state
    h.state.now += 2 * TMUX_REMOTE_INSTALLER_TERM_GRACE_MS;
    await restarted.tick();
    expect(signalInstaller.mock.calls.map(call => call[1])).toEqual(['SIGTERM', 'SIGKILL']);
    expect(h.store().job).toMatchObject({ installerPid: 777, recoveryFailedAt: expect.any(Number) });
    expect(h.store().card!.model).toMatchObject({ phase: 'upgrade_failed', error: expect.stringContaining('777') });
    const click: any = await h.click(TMUX_UPGRADE_ACTION_RUN);
    expect(click.toast.content).toContain('777');
    expect(h.store().job).toBeDefined();
  });

  it('treats a zombie installer as gone instead of signaling or blocking forever', async () => {
    const signalInstaller = vi.fn();
    const h = harness({
      processStart: pid => pid === process.pid ? 'self-start' : pid === 777 ? 'apt-start' : undefined,
      processZombie: pid => pid === 777,
      signalInstaller,
    });
    await h.advisor.tick();
    const s = h.store();
    writeTmuxUpgradeStoreTo(h.dataDir, {
      ...s,
      card: { ...s.card!, model: { ...s.card!.model, phase: 'upgrading' } },
      job: {
        kind: 'upgrade', pid: 2_147_000_001,
        startedAt: h.state.now - TMUX_REMOTE_INSTALLER_TIMEOUT_MS,
        installerPid: 777, installerStart: 'apt-start',
      },
    });
    await new TmuxUpgradeAdvisor(h.deps).tick();
    expect(signalInstaller).not.toHaveBeenCalled();
    expect(h.store().job).toBeUndefined();
  });

  it('the installer pid is recorded on the job while it runs', async () => {
    let seenJob: any;
    const h = harness({
      executeUpgrade: vi.fn(async (_p, _onLine, onSpawn) => {
        onSpawn(4321);
        await new Promise(r => setTimeout(r, 5));
        seenJob = readTmuxUpgradeStoreFrom(h.dataDir).job;
        h.state.facts = { ...h.state.facts, client: NEW };
        return { ok: true, ran: [] };
      }),
      processStart: pid => (pid === process.pid ? 'self-start' : pid === 4321 ? 'installer-start' : undefined),
    });
    await h.advisor.tick();
    const res: any = await h.click(TMUX_UPGRADE_ACTION_RUN);
    await res.afterAck();
    expect(seenJob).toMatchObject({ installerPid: 4321, installerStart: 'installer-start' });
  });

  it('upgraded but the server could not be read: card stays on the switch, no second DM', async () => {
    const h = harness({
      executeUpgrade: vi.fn(async () => {
        h.state.facts = { ...h.state.facts, client: NEW, server: null, serverUnknown: true };
        return { ok: true, ran: [] };
      }),
    });
    await h.advisor.tick();
    const res: any = await h.click(TMUX_UPGRADE_ACTION_RUN);
    await res.afterAck();
    expect(h.store().card!.model.phase).toBe('pending_switch');
    h.state.facts = { ...h.state.facts, server: OLD, serverUnknown: false };
    await h.advisor.tick();
    expect(h.state.sent).toHaveLength(1);
  });

  it('the final card waits out the click\'s own card response before patching', async () => {
    const h = harness({ minFinalPatchDelayMs: 1_500 }, { client: NEW, server: NEW });
    // Force an open card in needs_upgrade even though tmux is already new:
    // the job finishes instantly ("someone upgraded it meanwhile").
    h.state.facts = { ...h.state.facts, client: OLD, server: OLD };
    await h.advisor.tick();
    h.state.facts = { ...h.state.facts, client: NEW, server: NEW };
    const res: any = await h.click(TMUX_UPGRADE_ACTION_RUN);
    const sleepsBefore = (h.deps.sleep as any).mock.calls.length;
    await res.afterAck();
    const sleeps = (h.deps.sleep as any).mock.calls.slice(sleepsBefore).map((c: any[]) => c[0]);
    expect(sleeps.reduce((a: number, b: number) => a + b, 0)).toBeGreaterThanOrEqual(1_500);
    expect(h.store().card!.model.phase).toBe('done');
  });

  it('no progress patch can land after the final card (even from late installer output)', async () => {
    const h = harness({
      progressPatchMs: 0,
      updateCard: vi.fn(async (messageId: string, card: string) => {
        h.state.patches.push({ messageId, card: JSON.parse(card) });
      }),
      executeUpgrade: vi.fn(async (_p, onLine) => {
        for (let i = 0; i < 5; i++) onLine(`line ${i}`);
        // A runner that delivers its last line after it already resolved.
        setTimeout(() => onLine('late line'), 30);
        h.state.facts = { ...h.state.facts, client: NEW };
        return { ok: true, ran: [] };
      }),
    });
    await h.advisor.tick();
    const res: any = await h.click(TMUX_UPGRADE_ACTION_RUN);
    await res.afterAck();
    await new Promise(r => setTimeout(r, 120));
    expect(h.state.patches.at(-1)!.card.header.template).toBe('turquoise'); // pending_switch
  });
});

describe('production fan-out and probes', () => {
  it('zero discovered daemons is a failed fan-out, never an empty success', async () => {
    const fetchIpc = vi.fn();
    const result = await fanOutTmuxSwitchSuspend({ socketName: 'botmux', olderThanMs: 1, dryRun: true }, {
      listDaemons: () => [], fetchIpc,
    });
    expect(result).toEqual({ candidates: 0, affected: 0, failed: 1 });
    expect(fetchIpc).not.toHaveBeenCalled();
  });

  it('empty socket names are refused before any tmux server mutation', async () => {
    await expect(killTmuxServer('')).rejects.toThrow();
    await expect(retireEmptyTmuxServer('')).rejects.toThrow();
  });

  it('a daemon that never answers counts as failed within the deadline; answers are summed', async () => {
    const started = Date.now();
    const result = await fanOutTmuxSwitchSuspend({ socketName: 'botmux', olderThanMs: 1, dryRun: true }, {
      listDaemons: () => [{ ipcPort: 1 }, { ipcPort: 2 }, { ipcPort: 3 }],
      fetchIpc: (async (port: number) => {
        if (port === 1) return new Response(JSON.stringify({ ok: true, candidates: 2, affected: 0 }));
        if (port === 2) return new Response(JSON.stringify({ ok: false, error: 'mutation_gate_busy' }), { status: 409 });
        return new Promise<never>(() => {});
      }) as any,
      timeoutMs: 50,
    });
    expect(result).toEqual({ candidates: 2, affected: 0, failed: 2 });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('only tmux\'s own "nothing listening" answers mean the server is gone', () => {
    expect(isNoTmuxServerError('no server running on /tmp/tmux-0/botmux\n')).toBe(true);
    expect(isNoTmuxServerError('error connecting to /tmp/tmux-0/botmux (No such file or directory)')).toBe(true);
    expect(isNoTmuxServerError('error connecting to /tmp/tmux-0/botmux (Connection refused)')).toBe(true);
    expect(isNoTmuxServerError('error connecting to /tmp/tmux-0/botmux (Permission denied)')).toBe(false);
    expect(isNoTmuxServerError('server exited unexpectedly')).toBe(false);
    expect(isNoTmuxServerError('lost server')).toBe(false);
    expect(isNoTmuxServerError('')).toBe(false);
  });
});

describe('one-click upgrade through botmux\'s own prebuilt tmux', () => {
  const PREBUILT_PLAN: TmuxUpgradePlan = {
    auto: true,
    owner: { kind: 'botmux', root: '/home/u/.botmux/tools/tmux' },
    tmuxPath: '/home/u/.local/bin/tmux',
    display: 'tmux_3.5a-2~bpo12+1_amd64.deb',
    prebuilt: { release: NEW, root: '/home/u/.botmux/tools/tmux', keepPath: '/home/u/.local/bin/tmux' },
  };

  it('the reminder offers it; the click installs, re-reads tmux -V, then asks when to switch', async () => {
    const h = harness({
      plan: async () => PREBUILT_PLAN,
      executeUpgrade: vi.fn(async (plan, onLine) => {
        expect(plan.owner.kind).toBe('botmux');
        onLine('download https://deb.debian.org/debian/pool/main/t/tmux/tmux_3.5a-2~bpo12+1_amd64.deb');
        onLine('  sha256 ok (8aedf15af88f47dd…)');
        h.state.facts = { ...h.state.facts, client: NEW }; // tmuxEnv now resolves botmux's copy
        return { ok: true, ran: ['https://deb.debian.org/…'], selected: NEW };
      }),
    });
    await h.advisor.tick();
    const reminder = JSON.stringify(h.state.sent[0]!.card);
    expect(reminder).toContain('/home/u/.botmux/tools/tmux/current/bin/tmux');
    expect(reminder).toContain('/home/u/.local/bin/tmux');
    expect(h.buttonsOf(h.state.sent[0]!.card)).toEqual([TMUX_UPGRADE_ACTION_RUN]);
    const res: any = await h.click(TMUX_UPGRADE_ACTION_RUN);
    await res.afterAck();
    expect(JSON.stringify(h.state.patches.map(p => p.card))).toContain('sha256 ok');
    expect(h.store().card!.model.phase).toBe('pending_switch');
    // Switching is still the owner's choice: nothing was suspended or killed.
    expect(h.deps.fanOutSuspend).not.toHaveBeenCalled();
    expect(h.deps.killServer).not.toHaveBeenCalled();
  });

  it('a host lacking the libraries gets a plain explanation, and can retry later', async () => {
    const h = harness({
      plan: async () => PREBUILT_PLAN,
      executeUpgrade: vi.fn(async () => ({
        ok: false, ran: [], failure: 'libs_missing' as const, error: 'missing', missingLibraries: ['libjemalloc.so.2', 'libutempter.so.0'],
      })),
    });
    await h.advisor.tick();
    const res: any = await h.click(TMUX_UPGRADE_ACTION_RUN);
    await res.afterAck();
    expect(h.store().card!.model).toMatchObject({ phase: 'upgrade_failed' });
    expect(h.store().card!.model.error).toContain('libjemalloc.so.2');
    expect(h.buttonsOf(h.lastCard())).toEqual([TMUX_UPGRADE_ACTION_RUN]);
  });

  it('checksum / download / verification / foreign failures are each worded for the owner', async () => {
    for (const failure of ['checksum_mismatch', 'download_failed', 'verify_failed', 'foreign'] as const) {
      const h = harness({
        plan: async () => PREBUILT_PLAN,
        executeUpgrade: vi.fn(async () => ({ ok: false, ran: [], failure, error: `DETAIL-${failure}` })),
      });
      await h.advisor.tick();
      const res: any = await h.click(TMUX_UPGRADE_ACTION_RUN);
      await res.afterAck();
      const error = h.store().card!.model.error!;
      expect(error).toContain(`DETAIL-${failure}`);
      expect(error).not.toMatch(/tmux_upgrade\./);
    }
  });
});
