import { describe, it, expect } from 'vitest';
import { CODEX_RPC_TERMINAL_HYDRATION_DELAYS_MS, RpcEngagementFence, codexRpcEligible, paneRunsRemoteTui, orchestrateCodexRpcInit, shouldQueueInitialPrompt, rolloutUserTurnMatches, decideStartupDialogAction, killAndVerifyPersistentPane, RPC_CAPABLE_CLIS, type PaneProbes, type RpcInitEffects } from '../src/codex-rpc-lifecycle.js';
import type { DaemonToWorker } from '../src/types.js';

type InitCfg = Extract<DaemonToWorker, { type: 'init' }>;

/** Minimal eligible init config; tests override single fields to prove each
 *  fail-closed gate independently. */
function baseCfg(over: Partial<InitCfg> = {}): InitCfg {
  return {
    type: 'init',
    sessionId: 's1', chatId: 'c1', rootMessageId: 'r1', workingDir: '/tmp/x',
    cliId: 'codex', backendType: 'tmux', prompt: 'hello',
    codexRpcInput: true,
    larkAppId: 'app', larkAppSecret: 'sec',
    ...over,
  } as InitCfg;
}

describe('codexRpcEligible — the eligible base case', () => {
  it('a fresh codex/tmux bot with a prompt + codexRpcInput is eligible', () => {
    expect(codexRpcEligible(baseCfg())).toBe(true);
  });
  it('traex is also RPC-capable', () => {
    expect(codexRpcEligible(baseCfg({ cliId: 'traex' }))).toBe(true);
    expect(RPC_CAPABLE_CLIS.has('traex')).toBe(true);
  });
  it('a resume (no prompt but resume + cliSessionId) is eligible', () => {
    expect(codexRpcEligible(baseCfg({ prompt: '', resume: true, cliSessionId: 'thread-1' }))).toBe(true);
  });
});

describe('RPC terminal rollout hydration window', () => {
  it('keeps polling through delayed 9s visibility and remains bounded near the 12s first-turn probe', () => {
    const totalMs = CODEX_RPC_TERMINAL_HYDRATION_DELAYS_MS
      .reduce((sum, delayMs) => sum + delayMs, 0);
    expect(totalMs).toBeGreaterThanOrEqual(10_000);
    expect(totalMs).toBeLessThanOrEqual(12_000);

    // Model a rollout that becomes visible nine seconds after the native
    // terminal. The retry sequence must still have a scheduled observation at
    // or after visibility, rather than retiring the bridge mark early.
    let elapsedMs = 0;
    let observed = false;
    for (const delayMs of CODEX_RPC_TERMINAL_HYDRATION_DELAYS_MS) {
      elapsedMs += delayMs;
      if (elapsedMs >= 9_000) {
        observed = true;
        break;
      }
    }
    expect(observed).toBe(true);
  });
});

describe('RpcEngagementFence', () => {
  it('rejects a delayed first-turn result after restart invalidates its lease', async () => {
    const fence = new RpcEngagementFence();
    const lease = fence.begin();
    let resolveProbe!: (value: 'accepted') => void;
    const probe = new Promise<'accepted'>(resolve => { resolveProbe = resolve; });
    let published = false;
    let requeued = false;
    const engage = (async () => {
      const outcome = await probe;
      if (!fence.isCurrent(lease)) return 'superseded';
      published = true;
      if (outcome !== 'accepted') requeued = true;
      return outcome;
    })();

    fence.invalidate();
    resolveProbe('accepted');

    await expect(engage).resolves.toBe('superseded');
    expect(published).toBe(false);
    expect(requeued).toBe(false);
  });
});

describe('codexRpcEligible — every fail-closed gate degrades to paste', () => {
  const cases: Array<[string, Partial<InitCfg>]> = [
    ['codexRpcInput not set', { codexRpcInput: false }],
    ['non-RPC cli (claude)', { cliId: 'claude-code' as any }],
    ['non-tmux backend (pty)', { backendType: 'pty' as any }],
    ['non-tmux backend (herdr)', { backendType: 'herdr' as any }],
    ['adopt mode', { adoptMode: true }],
    ['read isolation', { readIsolation: true }],
    ['sandbox', { sandbox: true }],
    ['disableCliBypass (approval-gated — must not become dangerFullAccess)', { disableCliBypass: true }],
    ['has startupCommands (/effort ordering)', { startupCommands: ['/effort high'] }],
    ['wrapperCli launcher', { wrapperCli: 'aiden x codex' }],
    ['cliPathOverride launcher', { cliPathOverride: '/opt/wrap/codex' }],
    ['no prompt and not a resume', { prompt: '' }],
    ['resume flag but no cliSessionId', { prompt: '', resume: true }],
  ];
  for (const [name, over] of cases) {
    it(`fails closed: ${name}`, () => {
      expect(codexRpcEligible(baseCfg(over))).toBe(false);
    });
  }
  it('fails closed when BOTMUX_SANDBOX=1 forces sandbox outside InitCfg', () => {
    expect(codexRpcEligible(baseCfg(), { sandboxForced: true })).toBe(false);
  });
});

describe('paneRunsRemoteTui — RPC-owned detection via leaf argv (not pane_current_command)', () => {
  const probes = (tree: Record<number, { argv: string[]; comm?: string; children?: number[] }>, panePid = 100): PaneProbes => ({
    panePidOf: () => panePid,
    argvOf: (pid) => tree[pid]?.argv ?? [],
    commOf: (pid) => tree[pid]?.comm,
    childrenOf: (pid) => tree[pid]?.children ?? [],
  });

  it('direct codex --remote pane → RPC-owned', () => {
    expect(paneRunsRemoteTui('bmx-1', probes({
      100: { comm: 'codex', argv: ['codex', '--remote', 'ws://127.0.0.1:9', 'resume', '--no-alt-screen', 'tid'] },
    }))).toBe(true);
  });

  it('nested: shell → codex --remote leaf → RPC-owned', () => {
    expect(paneRunsRemoteTui('bmx-1', probes({
      100: { comm: 'zsh', argv: ['-zsh'], children: [200] },
      200: { comm: 'codex', argv: ['/usr/bin/codex', '--remote', 'ws://x', 'resume', 'tid'] },
    }))).toBe(true);
  });

  it('node launcher wrapping codex --remote (comm=node, argv basename=codex) → RPC-owned', () => {
    expect(paneRunsRemoteTui('bmx-1', probes({
      100: { comm: 'node', argv: ['node', '/n/bin/codex', '--remote', 'ws://x', 'resume', 'tid'] },
    }))).toBe(true);
  });

  it('native paste codex (resume, NO --remote) → not RPC-owned (fail-closed, boundary #3)', () => {
    expect(paneRunsRemoteTui('bmx-1', probes({
      100: { comm: 'codex', argv: ['codex', 'resume', '--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen', 'tid'] },
    }))).toBe(false);
  });

  it('bare shell pane → not RPC-owned', () => {
    expect(paneRunsRemoteTui('bmx-1', probes({
      100: { comm: 'zsh', argv: ['-zsh'] },
    }))).toBe(false);
  });

  it('--remote present but NOT codex-family (e.g. ssh) → not RPC-owned', () => {
    expect(paneRunsRemoteTui('bmx-1', probes({
      100: { comm: 'ssh', argv: ['ssh', '--remote', 'host'] },
    }))).toBe(false);
  });

  it('unreadable pane pid → not RPC-owned', () => {
    expect(paneRunsRemoteTui('bmx-1', { panePidOf: () => undefined })).toBe(false);
  });

  it('does not loop forever on a cyclic/self-referential tree', () => {
    // pid 100's child is itself — seen-set must prevent an infinite walk.
    expect(paneRunsRemoteTui('bmx-1', probes({
      100: { comm: 'zsh', argv: ['-zsh'], children: [100] },
    }))).toBe(false);
  });
});

describe('orchestrateCodexRpcInit — three-state fresh / resume / kill-failure (Codex P0-1/P0-2/P1-1)', () => {
  function fx(over: Partial<RpcInitEffects> & { pane?: { name: string; live: boolean } | null; isRemote?: boolean; outcome?: 'accepted' | 'ambiguous' | 'resumed' | 'not-engaged'; killGone?: boolean } = {}) {
    const calls: string[] = [];
    const effects: RpcInitEffects = {
      paneInfo: () => { calls.push('paneInfo'); return over.pane ?? null; },
      paneIsRemote: () => { calls.push('paneIsRemote'); return over.isRemote ?? false; },
      prepare: async () => { calls.push('prepare'); },
      engage: async () => { calls.push('engage'); return over.outcome ?? 'accepted'; },
      killVerify: async () => { calls.push('killVerify'); return over.killGone ?? true; },
      teardownEngine: () => { calls.push('teardownEngine'); },
      log: () => {},
      notify: () => { calls.push('notify'); },
    };
    return { effects, calls };
  }

  it('not eligible → no-op, engine never engaged', async () => {
    const { effects, calls } = fx();
    const d = await orchestrateCodexRpcInit(baseCfg({ codexRpcInput: false }), effects);
    expect(d).toEqual({ engaged: false, queuePrompt: false, abortSpawn: false });
    expect(calls).not.toContain('engage');
  });

  it('FRESH accepted (ack/rollout) → engaged, do NOT queue (turn pre-sent)', async () => {
    const { effects, calls } = fx({ pane: null, outcome: 'accepted' });
    const d = await orchestrateCodexRpcInit(baseCfg(), effects);
    expect(d).toEqual({ engaged: true, queuePrompt: false, abortSpawn: false });
    expect(calls).toContain('engage');
    expect(calls.indexOf('prepare')).toBeLessThan(calls.indexOf('engage'));
    expect(calls).not.toContain('notify');
  });

  it('FRESH ambiguous (dispatched, unconfirmed) → engaged, 0 queue, 1 notify — NEVER resend (P1-1)', async () => {
    const { effects, calls } = fx({ pane: null, outcome: 'ambiguous' });
    const d = await orchestrateCodexRpcInit(baseCfg(), effects);
    expect(d).toEqual({ engaged: true, queuePrompt: false, abortSpawn: false }); // queuePrompt:false ⇒ prompt never queued
    expect(calls.filter(c => c === 'notify')).toHaveLength(1);
  });

  it('FRESH not-sent (frame never dispatched) → paste fallback exactly once', async () => {
    const { effects } = fx({ pane: null, outcome: 'not-engaged' });
    const d = await orchestrateCodexRpcInit(baseCfg(), effects);
    expect(d).toEqual({ engaged: false, queuePrompt: false, abortSpawn: false }); // → paste path queues once
  });

  it('RESUME whose pane did NOT survive → engaged(resumed), MUST queue the waking prompt (P0-1)', async () => {
    const { effects } = fx({ pane: null, outcome: 'resumed' });
    const d = await orchestrateCodexRpcInit(baseCfg({ prompt: 'wake up', resume: true, cliSessionId: 't1' }), effects);
    expect(d).toEqual({ engaged: true, queuePrompt: true, abortSpawn: false });
  });

  it('live RPC-owned pane + kill succeeds → engage, replace, queue the prompt', async () => {
    const { effects, calls } = fx({ pane: { name: 'bmx-1', live: true }, isRemote: true, outcome: 'resumed', killGone: true });
    const d = await orchestrateCodexRpcInit(baseCfg({ prompt: 'hi', resume: true, cliSessionId: 't1' }), effects);
    expect(d).toEqual({ engaged: true, queuePrompt: true, abortSpawn: false });
    expect(calls).toEqual(['paneInfo', 'paneIsRemote', 'prepare', 'engage', 'killVerify']);
  });

  it('live RPC-owned pane + kill FAILS → tear engine down + ABORT spawn, notify (P0-2)', async () => {
    const { effects, calls } = fx({ pane: { name: 'bmx-1', live: true }, isRemote: true, outcome: 'resumed', killGone: false });
    const d = await orchestrateCodexRpcInit(baseCfg({ prompt: 'hi', resume: true, cliSessionId: 't1' }), effects);
    expect(d).toEqual({ engaged: false, queuePrompt: false, abortSpawn: true });
    expect(calls).toContain('teardownEngine');
    expect(calls).toContain('notify');
  });

  it('live RPC-owned pane but engage FAILS → kill stale viewer, then fall back to native paste', async () => {
    const { effects, calls } = fx({ pane: { name: 'bmx-1', live: true }, isRemote: true, outcome: 'not-engaged' });
    const d = await orchestrateCodexRpcInit(baseCfg({ resume: true, cliSessionId: 't1' }), effects);
    expect(d).toEqual({ engaged: false, queuePrompt: false, abortSpawn: false });
    expect(calls).toEqual(['paneInfo', 'paneIsRemote', 'prepare', 'engage', 'killVerify']);
  });

  it('live RPC-owned pane + engage failure + kill failure → abort instead of reattaching stale viewer', async () => {
    const { effects, calls } = fx({ pane: { name: 'bmx-1', live: true }, isRemote: true, outcome: 'not-engaged', killGone: false });
    const d = await orchestrateCodexRpcInit(baseCfg({ resume: true, cliSessionId: 't1' }), effects);
    expect(d).toEqual({ engaged: false, queuePrompt: false, abortSpawn: true });
    expect(calls).toContain('notify');
  });

  it('live NATIVE paste pane (possibly mid-turn) → left untouched, no engage (boundary #3)', async () => {
    const { effects, calls } = fx({ pane: { name: 'bmx-1', live: true }, isRemote: false });
    const d = await orchestrateCodexRpcInit(baseCfg({ resume: true, cliSessionId: 't1' }), effects);
    expect(d).toEqual({ engaged: false, queuePrompt: false, abortSpawn: false });
    expect(calls).not.toContain('prepare');
    expect(calls).not.toContain('engage');
    expect(calls).not.toContain('killVerify');
  });
});

describe('killAndVerifyPersistentPane — verifies the resolved name without re-prefixing', () => {
  it('passes the exact bmx-* name to every kill and liveness probe', async () => {
    const killed: string[] = [];
    const probed: string[] = [];
    const gone = await killAndVerifyPersistentPane('bmx-12345678', {
      kill: (name) => { killed.push(name); },
      isLive: (name) => { probed.push(name); return true; },
      wait: async () => {},
    }, 2, 0);
    expect(gone).toBe(false);
    expect(killed).toEqual(['bmx-12345678', 'bmx-12345678']);
    expect(probed.every(name => name === 'bmx-12345678')).toBe(true);
  });

  it('returns true only after the exact session is observed gone', async () => {
    let live = true;
    let kills = 0;
    const gone = await killAndVerifyPersistentPane('bmx-abcdef12', {
      kill: () => { kills += 1; if (kills === 2) live = false; },
      isLive: () => live,
      wait: async () => {},
    }, 4, 0);
    expect(gone).toBe(true);
    expect(kills).toBe(2);
  });
});

describe('shouldQueueInitialPrompt — the worker queuing wiring (exactly-once, P1-1)', () => {
  const base = { hasPrompt: true, rpcEngineActive: false, queuePrompt: false, passesInitialPromptViaArgs: false, deferInitialPrompt: false };
  it('paste (no engine) → queues', () => { expect(shouldQueueInitialPrompt(base)).toBe(true); });
  it('RPC FRESH accepted (engine set, queuePrompt=false) → NOT queued (turn pre-sent)', () => {
    expect(shouldQueueInitialPrompt({ ...base, rpcEngineActive: true, queuePrompt: false })).toBe(false);
  });
  it('RPC FRESH ambiguous (engine set, queuePrompt=false) → NOT queued (never resend)', () => {
    // ambiguous keeps the engine active with queuePrompt=false → prompt must NOT
    // reach pendingMessages/inflightInputs (Codex P1-1 wiring assertion).
    expect(shouldQueueInitialPrompt({ ...base, rpcEngineActive: true, queuePrompt: false })).toBe(false);
  });
  it('RPC RESUME (engine set, queuePrompt=true) → queued for post-ready flush', () => {
    expect(shouldQueueInitialPrompt({ ...base, rpcEngineActive: true, queuePrompt: true })).toBe(true);
  });
  it('no prompt → never queued', () => { expect(shouldQueueInitialPrompt({ ...base, hasPrompt: false })).toBe(false); });
  it('args-baked prompt (not deferred) → not queued even in paste', () => {
    expect(shouldQueueInitialPrompt({ ...base, passesInitialPromptViaArgs: true })).toBe(false);
  });
  it('args-baked prompt deferred (startup commands / arg limit / resume ignore) → queued', () => {
    expect(shouldQueueInitialPrompt({ ...base, passesInitialPromptViaArgs: true, deferInitialPrompt: true })).toBe(true);
  });
});

describe('rolloutUserTurnMatches — positive rollout evidence (P1-1)', () => {
  it('matches a user turn whose text equals the prompt', () => {
    expect(rolloutUserTurnMatches([{ kind: 'user', text: 'ALPHA' }], 'ALPHA')).toBe(true);
  });
  it('matches when codex prepended AGENTS.md context (contains)', () => {
    expect(rolloutUserTurnMatches([{ kind: 'user', text: '# AGENTS.md ...\n\nALPHA run please' }], 'ALPHA run please')).toBe(true);
  });
  it('empty thread (only session_meta / assistant, no user turn) → false', () => {
    expect(rolloutUserTurnMatches([{ kind: 'assistant_final', text: 'ALPHA' }], 'ALPHA')).toBe(false);
    expect(rolloutUserTurnMatches([], 'ALPHA')).toBe(false);
  });
  it('empty prompt → false (no evidence to match)', () => {
    expect(rolloutUserTurnMatches([{ kind: 'user', text: '' }], '')).toBe(false);
  });
});

describe('decideStartupDialogAction — RPC pane startup dialogs (P1-3/P2)', () => {
  const ready = /›/;
  it('update menu → warn-update (NEVER auto-press)', () => {
    expect(decideStartupDialogAction('✨ Update available! 0.144.1 -> 0.144.3\n1. Update now (runs npm ...)', ready)).toBe('warn-update');
  });
  it('update menu + a "press enter" line → still warn (precedence, never press)', () => {
    expect(decideStartupDialogAction('Update available\nPress enter to continue', ready)).toBe('warn-update');
  });
  it('plain "press enter to continue" (no menu) → dismiss-safe', () => {
    expect(decideStartupDialogAction('Some notice\nPress enter to continue', ready)).toBe('dismiss-safe');
  });
  it('composer up, no dialog → ready', () => {
    expect(decideStartupDialogAction('› ', ready)).toBe('ready');
  });
  it('nothing actionable → wait', () => {
    expect(decideStartupDialogAction('booting...', ready)).toBe('wait');
  });
});
