/**
 * fork-session.test.ts
 *
 * Tests for `forkSession()` + `isForkCapableSession()` in worker-pool.
 *
 * forkSession is the NON-destructive sibling of transferSession: it mints a
 * SECOND, independent botmux session (a fresh sessionId) that inherits the
 * source's context via the CLI-native fork primitive, and leaves the source
 * completely untouched. The most load-bearing behavior these tests lock is that
 * the child inherits the source's FROZEN LAUNCH POSTURE — sandbox decision,
 * effort override, and bot identity (larkAppId) — because the child is a
 * brand-new row (not a reused ds.session like transferSession), and a missing
 * field silently re-derives to the wrong value:
 *   • missing sandbox → forkWorker's resume=true path writes sandbox=false →
 *     a fork of a sandboxed session runs UNSANDBOXED (credential-seal escape);
 *   • missing effort → sessionAgentConfig re-freezes from the live bot
 *     config, dropping per-session overrides;
 *   • the model is not FROZEN — it resolves from the live bot config on every
 *     spawn — but the record of what the source last launched with travels so a
 *     CLI-mismatched fork does not cold-spawn on the CLI default; an EXPLICIT
 *     per-trigger override travels too, on the runtime (in-memory) session only;
 *   • missing larkAppId → restoreActiveSessions misattributes the fork to the
 *     first bot in the roster.
 *
 * The real forkWorker spawns a child process; we inject a spy via opts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/services/session-store.js', () => {
  let counter = 0;
  return {
    registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
    cleanupSessionBridgeSendMarkers: vi.fn(),
    cleanupSessionBridgeSendMarkersNow: vi.fn(),
    // createSession mints a minimal fresh row exactly like the real store:
    // a new id + the passed anchors, EVERYTHING else undefined. That "empty
    // by construction" shape is precisely what makes the field-inheritance
    // assertions meaningful — the child only carries what forkSession copies.
    createSession: vi.fn((chatId: string, rootMessageId: string, title: string, chatType?: string, scope?: string) => ({
      sessionId: `child-sess-${++counter}`,
      chatId,
      rootMessageId,
      title,
      chatType,
      scope,
      status: 'active',
      createdAt: new Date().toISOString(),
    })),
    updateSession: vi.fn(),
    updateSessionPid: vi.fn(),
    getSession: vi.fn(),
    getOwnedSession: vi.fn(),
    listSessions: vi.fn(() => []),
    closeSession: vi.fn(),
  };
});

// isForkCapableSession reaches config.codexRpcInputDefault, which reads
// readGlobalConfig().dashboard?.codexRpcInput. Mock the global-config source
// (NOT the whole config module — config.daemon.* is read at module load and a
// stubbed config would break import) so the "codex terminal is forkable" cases
// assert against a KNOWN global-off state rather than the dev machine's real
// ~/.botmux/config.json (test-hygiene: avoids environment-dependent drift).
vi.mock('../src/global-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/global-config.js')>();
  return { ...actual, readGlobalConfig: vi.fn(() => ({})) };
});
vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { cliId: 'claude-code', larkAppId: 'cli_app_test' },
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getBotBrand: vi.fn(() => 'feishu'),
}));

const sessionGroups = vi.hoisted(() => ({ groups: new Set<string>(), touch: vi.fn() }));
vi.mock('../src/services/session-groups-store.js', () => ({
  isSessionGroup: (chatId: string) => sessionGroups.groups.has(chatId),
  touchSessionGroup: (...args: unknown[]) => sessionGroups.touch(...args),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

const forkWorkerSpy = vi.fn();

import {
  forkSession,
  forkClosedSession,
  withActiveSessionKeyLock,
  isForkCapableSession,
  forkWorker,
  setActiveSessionsRegistry,
  turnStartingCardStatus,
  __testOnly_sessionAgentConfig as sessionAgentConfig,
} from '../src/core/worker-pool.js';
import { getBot } from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';

/** A realistic, forkable SOURCE session: thread-scope claude-code, idle, with a
 *  CLI-native id (so there's a transcript node to fork from). Overrides let each
 *  test tweak the frozen posture (sandbox/model/…) being asserted. */
function makeSourceDs(sessionOverrides: Partial<Session> = {}, dsOverrides: Partial<DaemonSession> = {}): DaemonSession {
  const session: Session = {
    sessionId: 'src-sess-1',
    chatId: 'oc_source',
    rootMessageId: 'om_source_root',
    title: 'ship the feature',
    status: 'active',
    createdAt: new Date().toISOString(),
    scope: 'thread',
    chatType: 'group',
    larkAppId: 'cli_app_test',
    ownerOpenId: 'ou_owner',
    workingDir: '/tmp/project',
    cliId: 'claude-code',
    cliSessionId: 'cli-native-src-abc',   // required: something to fork from
    agentFrozen: true,
    ...sessionOverrides,
  };
  return {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: 'cli_app_test',
    chatId: 'oc_source',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
    workingDir: '/tmp/project',
    ownerOpenId: 'ou_owner',
    lastScreenStatus: 'idle',
    ...dsOverrides,
  } as DaemonSession;
}

const callFork = (
  ds: DaemonSession,
  targetChatId = 'oc_child',
  targetRootMessageId = 'oc_child',
  targetChatType: 'group' | 'p2p' = 'group',
  targetScope: 'thread' | 'chat' = 'chat',
) => forkSession(ds.session.sessionId, targetChatId, targetRootMessageId, targetChatType, targetScope, {
  forkWorkerImpl: forkWorkerSpy as any,
});

describe('isForkCapableSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBot).mockReturnValue({
      config: { cliId: 'claude-code', larkAppId: 'cli_app_test' },
      botName: 'TestBot',
    } as any);
  });

  it('accepts claude-code / seed / relay / codex / traex / grok (terminal)', () => {
    for (const cliId of ['claude-code', 'seed', 'relay', 'codex', 'traex', 'grok'] as const) {
      const ds = makeSourceDs({ cliId });
      expect(isForkCapableSession(ds)).toBe(true);
    }
  });

  it('refuses aiden because its adapter has no native fork contract', () => {
    const ds = makeSourceDs({ cliId: 'aiden' });
    expect(isForkCapableSession(ds)).toBe(false);
  });

  it('refuses codex-app (app-server live session, no local rollout)', () => {
    const ds = makeSourceDs({ cliId: 'codex-app' });
    expect(isForkCapableSession(ds)).toBe(false);
  });

  it('refuses a codex session running under Hybrid RPC input', () => {
    vi.mocked(getBot).mockReturnValue({
      config: { cliId: 'codex', larkAppId: 'cli_app_test', codexRpcInput: true },
      botName: 'TestBot',
    } as any);
    const ds = makeSourceDs({ cliId: 'codex' });
    expect(isForkCapableSession(ds)).toBe(false);
  });

  it('refuses a traex session running under Hybrid RPC input', () => {
    vi.mocked(getBot).mockReturnValue({
      config: { cliId: 'traex', larkAppId: 'cli_app_test', codexRpcInput: true },
      botName: 'TestBot',
    } as any);
    const ds = makeSourceDs({ cliId: 'traex' });
    expect(isForkCapableSession(ds)).toBe(false);
  });

  it('refuses a codex pane SPAWNED under RPC even after the live toggle was turned off (dynamic gate)', () => {
    // Live config now says terminal (codexRpcInput false, global default false),
    // but the pane was spawned with RPC=true and does NOT hot-swap its argv — its
    // thread still lives in the app-server with no forkable rollout. The frozen
    // spawn-time flag on ds.initConfig must keep it refused.
    vi.mocked(getBot).mockReturnValue({
      config: { cliId: 'codex', larkAppId: 'cli_app_test', codexRpcInput: false },
      botName: 'TestBot',
    } as any);
    const ds = makeSourceDs({ cliId: 'codex' }, {
      initConfig: { type: 'init', codexRpcInput: true } as any,
    });
    expect(isForkCapableSession(ds)).toBe(false);
  });

  it('refuses a non-forkable CLI (e.g. gemini)', () => {
    const ds = makeSourceDs({ cliId: 'gemini' });
    expect(isForkCapableSession(ds)).toBe(false);
  });
});

describe('turnStartingCardStatus', () => {
  it('starts a live Grok turn as working, not starting', () => {
    const live = makeSourceDs({ cliId: 'grok' }, { workerReady: true });
    expect(turnStartingCardStatus(live, 'grok')).toBe('working');
    expect(turnStartingCardStatus(live, 'codex')).toBe('starting');
  });

  it('keeps Grok on starting until the worker has initialized', () => {
    const cold = makeSourceDs({ cliId: 'grok' }, { workerReady: false });
    expect(turnStartingCardStatus(cold, 'grok')).toBe('starting');
  });

  it('surfaces limited when a usage-limit state is present', () => {
    const limited = makeSourceDs({ cliId: 'grok' }, {
      workerReady: true,
      usageLimit: { retryLabel: 'later' } as DaemonSession['usageLimit'],
    });
    expect(turnStartingCardStatus(limited, 'grok')).toBe('limited');
  });
});

describe('forkSession — frozen launch posture inheritance', () => {
  let registry: Map<string, DaemonSession>;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new Map();
    setActiveSessionsRegistry(registry);
    vi.mocked(getBot).mockReturnValue({
      config: { cliId: 'claude-code', larkAppId: 'cli_app_test' },
      botName: 'TestBot',
    } as any);
  });

  // ── THE P1 death-test: forking a SANDBOXED source must yield a SANDBOXED
  //    child. Without the sandbox-field inheritance in forkSession, the child
  //    row has sandbox=undefined and forkWorker(resume=true) writes it false —
  //    a silent credential-seal escape. Deleting any of these copies flips this
  //    assertion red (mutation has teeth). ──
  it('P1: a fork of a SANDBOXED source inherits the full sandbox seal', async () => {
    const src = makeSourceDs({
      sandbox: true,
      sandboxPaths: { readWrite: ['/tmp/project'], readOnly: ['/etc'], deny: ['/secret'] },
      sandboxHidePaths: ['/hide/me'],
      sandboxReadonlyPaths: ['/ro/here'],
      sandboxNetwork: false,
      sandboxNetworkPolicy: { version: 1, public: { mode: 'block' }, private: { mode: 'allowlist', rules: [{ cidr: '10.0.0.0/8' }] } },
    });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), src);

    const r = await callFork(src);
    expect(r.ok).toBe(true);

    const child = vi.mocked(sessionStore.createSession).mock.results[0].value as Session;
    expect(child.sandbox).toBe(true);
    expect(child.sandboxPaths).toEqual({ readWrite: ['/tmp/project'], readOnly: ['/etc'], deny: ['/secret'] });
    expect(child.sandboxHidePaths).toEqual(['/hide/me']);
    expect(child.sandboxReadonlyPaths).toEqual(['/ro/here']);
    expect(child.sandboxNetwork).toBe(false);
    expect(child.sandboxNetworkPolicy).toEqual(src.session.sandboxNetworkPolicy);
    expect(child.sandboxNetworkPolicy).not.toBe(src.session.sandboxNetworkPolicy);
  });

  // ── childOwnerOpenId: an admin forking someone else's session is stamped as
  //    the CHILD owner instead of inheriting the source owner. The stamp has to
  //    land on BOTH the persisted row and the runtime childDs (the latter feeds
  //    BOTMUX_OWNER_OPEN_ID into the CLI subprocess via applySessionOwnerEnv).
  //    Dropping the option on either copy must flip these red. ──
  it('childOwnerOpenId overrides owner on BOTH the persisted row and runtime childDs', async () => {
    const src = makeSourceDs();   // source owner = 'ou_owner'
    registry.set(sessionKey('om_source_root', 'cli_app_test'), src);

    const r = await forkSession(
      src.session.sessionId, 'oc_child', 'oc_child', 'group', 'chat',
      { forkWorkerImpl: forkWorkerSpy as any, childOwnerOpenId: 'ou_admin' },
    );
    expect(r.ok).toBe(true);

    // Persisted row (worker-pool.ts childSession.ownerOpenId).
    const child = vi.mocked(sessionStore.createSession).mock.results[0].value as Session;
    expect(child.ownerOpenId).toBe('ou_admin');

    // Runtime DaemonSession handed to forkWorker (feeds the worker owner env).
    const childDs = forkWorkerSpy.mock.calls[0][0] as DaemonSession;
    expect(childDs.ownerOpenId).toBe('ou_admin');
  });

  it('without childOwnerOpenId the child inherits the SOURCE owner (persisted + runtime)', async () => {
    const src = makeSourceDs();   // source owner = 'ou_owner'
    registry.set(sessionKey('om_source_root', 'cli_app_test'), src);

    const r = await forkSession(
      src.session.sessionId, 'oc_child', 'om_child_root', 'group', 'thread',
      { forkWorkerImpl: forkWorkerSpy as any },
    );
    expect(r.ok).toBe(true);

    const child = vi.mocked(sessionStore.createSession).mock.results[0].value as Session;
    expect(child.ownerOpenId).toBe('ou_owner');
    const childDs = forkWorkerSpy.mock.calls[0][0] as DaemonSession;
    expect(childDs.ownerOpenId).toBe('ou_owner');
  });

  it('P1: a fork of an explicitly UN-sandboxed source stays un-sandboxed (false travels, not just true)', async () => {
    const src = makeSourceDs({ sandbox: false, sandboxNetwork: true });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), src);

    const r = await callFork(src);
    expect(r.ok).toBe(true);
    const child = vi.mocked(sessionStore.createSession).mock.results[0].value as Session;
    expect(child.sandbox).toBe(false);
  });

  it('preserves service tier, scratch storage, denied paths and the worktree admission decision without shared objects', async () => {
    const src = makeSourceDs({ sandbox: 'scratch',
      serviceTier: 'priority',
      sandboxScratch: { storage: 'tmpfs', tmpfsSizeMb: 192, denyPaths: ['/private'], network: false },
      autoWorktreeFallbackDir: '/tmp/project' });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), src);
    expect((await callFork(src)).ok).toBe(true);
    const child = vi.mocked(sessionStore.createSession).mock.results[0].value as Session;
    expect(child.sandbox).toBe('scratch');
    expect(child.sandboxScratch).toEqual(src.session.sandboxScratch);
    expect(child.sandboxScratch).not.toBe(src.session.sandboxScratch);
    expect(child.serviceTier).toBe(src.session.serviceTier);
    expect(child.autoWorktreeFallbackDir).toBe('/tmp/project');
    child.sandboxScratch!.denyPaths!.push('/child-only');
    expect(src.session.sandboxScratch!.denyPaths).toEqual(['/private']);
  });

  // ── P2: the per-session reasoningEffort override + the agentFrozen marker
  //    must ride along, else sessionAgentConfig re-freezes from the live bot
  //    config and the clone silently drops the source's launch identity. ──
  it('P2: reasoningEffort / backend variant / cliRuntime / cliPathOverride / cliConfigDir / wrapperCli / agentFrozen inherited', async () => {
    const src = makeSourceDs({
      reasoningEffort: 'xhigh',
      modelBackendVariant: 'max',
      cliRuntime: {
        id: 'custom-claude',
        displayName: 'Custom Claude',
        executable: '/opt/custom/claude',
        source: 'configured',
        update: { provider: 'self' },
      },
      cliPathOverride: '/opt/custom/claude',
      cliConfigDir: '~/.claude-api',
      wrapperCli: 'ttadk',
      agentFrozen: true,
    });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), src);

    const r = await callFork(src);
    expect(r.ok).toBe(true);
    const child = vi.mocked(sessionStore.createSession).mock.results[0].value as Session;
    expect(child.reasoningEffort).toBe('xhigh');
    expect(child.modelBackendVariant).toBe('max');
    expect(child.cliRuntime).toEqual(src.session.cliRuntime);
    expect(child.cliRuntime).not.toBe(src.session.cliRuntime);
    expect(child.cliPathOverride).toBe('/opt/custom/claude');
    // The fork resumes the source transcript, which lives under the source profile.
    expect(child.cliConfigDir).toBe('~/.claude-api');
    expect(child.wrapperCli).toBe('ttadk');
    expect(child.agentFrozen).toBe(true);
  });

  // ── The model is not FROZEN (it resolves from the live bot config at every
  //    spawn, so a same-CLI clone matches the source automatically), but the
  //    record of what the source last launched with must still travel: a source
  //    pinned to a CLI the bot no longer runs relies on that record (rule 3), and
  //    a child without it would cold-spawn on the CLI default instead. ──
  it('copies the last-launched model record so a CLI-mismatched fork keeps its model', async () => {
    // Bot now runs claude-code; the source session is pinned to codex.
    vi.mocked(getBot).mockReturnValue({
      config: { cliId: 'claude-code', larkAppId: 'cli_app_test', model: 'opus' },
      botName: 'TestBot',
    } as any);
    const src = makeSourceDs({ cliId: 'codex', model: 'gpt-5.6' });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), src);

    const r = await callFork(src);
    expect(r.ok).toBe(true);
    const child = vi.mocked(sessionStore.createSession).mock.results[0].value as Session;
    expect(child.cliId).toBe('codex');
    expect(child.model).toBe('gpt-5.6');   // not undefined, and not the bot's `opus`
  });

  // ── An EXPLICIT per-trigger override, however, must reach the clone: it lives
  //    on the runtime session (in-memory, never persisted), so forkSession has
  //    to hand it to the child ds or the fork silently drops to the bot default. ──
  it('carries an explicit per-trigger model override onto the child runtime session', async () => {
    const src = makeSourceDs({}, { spawnModelOverride: 'gpt-5.6-terra' });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), src);

    const r = await callFork(src);
    expect(r.ok).toBe(true);
    const [childDs] = forkWorkerSpy.mock.calls[0] as [DaemonSession];
    expect(childDs.spawnModelOverride).toBe('gpt-5.6-terra');
    // …and it stays out of the persisted row.
    const child = vi.mocked(sessionStore.createSession).mock.results[0].value as Session;
    expect(child.model).toBeUndefined();
  });

  // ── The larkAppId gap codex caught: the persisted child row must carry the
  //    bot identity so a restart before the child's first spawn doesn't
  //    misattribute it to getAllBots()[0]. ──
  it('sets larkAppId on the persisted child row (bot identity survives restart)', async () => {
    const src = makeSourceDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), src);

    const r = await callFork(src);
    expect(r.ok).toBe(true);
    const child = vi.mocked(sessionStore.createSession).mock.results[0].value as Session;
    expect(child.larkAppId).toBe('cli_app_test');
  });

  it('records provenance (forkedFrom) + one-shot pendingForkSession + source CLI id', async () => {
    const src = makeSourceDs({ cliSessionId: 'cli-native-src-abc' });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), src);

    const r = await callFork(src);
    expect(r.ok).toBe(true);
    const child = vi.mocked(sessionStore.createSession).mock.results[0].value as Session;
    expect(child.forkedFrom).toBe('src-sess-1');
    expect(child.pendingForkSession).toBe(true);
    // Child's cliSessionId points at the SOURCE's CLI id for the first fork spawn.
    expect(child.cliSessionId).toBe('cli-native-src-abc');
  });

  it('seeds a topic fork with its task metadata, effective cwd, and first turn', async () => {
    const src = makeSourceDs(
      { workingDir: '/persisted/project' },
      { workingDir: '/effective/project' },
    );
    registry.set(sessionKey('om_source_root', 'cli_app_test'), src);
    const buildInitialPrompt = vi.fn((childSessionId: string) => ({
      content: `wrapped task for ${childSessionId}`,
    }));

    const result = await forkSession(
      src.session.sessionId,
      'oc_child',
      'om_child_root',
      'group',
      'thread',
      {
        forkWorkerImpl: forkWorkerSpy as any,
        childTitle: '🔱 investigate cleanup',
        forkTaskText: 'investigate cleanup',
        larkThreadId: 'omt_child',
        buildInitialPrompt,
        turnId: 'om_fork_command',
        senderOpenId: 'ou_trigger',
        senderIsBot: false,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const childSessionId = result.childSessionId;
    const child = vi.mocked(sessionStore.createSession).mock.results[0].value as Session;
    expect(child).toMatchObject({
      title: '🔱 investigate cleanup',
      forkTaskText: 'investigate cleanup',
      larkThreadId: 'omt_child',
      workingDir: '/effective/project',
      lastUserPrompt: 'investigate cleanup',
      lastCliInput: `wrapped task for ${childSessionId}`,
      lastCallerOpenId: 'ou_trigger',
      quoteTargetId: 'om_fork_command',
      quoteTargetSenderOpenId: 'ou_trigger',
      quoteTargetSenderIsBot: false,
    });
    expect(buildInitialPrompt).toHaveBeenCalledWith(childSessionId);
    expect(forkWorkerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workingDir: '/effective/project' }),
      { content: `wrapped task for ${childSessionId}` },
      { resume: true, turnId: 'om_fork_command' },
    );
  });

  it('cold-spawns the child worker with resume=true and never touches the source', async () => {
    const src = makeSourceDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), src);
    const sourceSnapshot = JSON.stringify(src.session);

    const r = await callFork(src);
    expect(r.ok).toBe(true);

    // forkWorker called with (childDs, '', resume=true)
    expect(forkWorkerSpy).toHaveBeenCalledTimes(1);
    const [childDs, prompt, resume] = forkWorkerSpy.mock.calls[0];
    expect(prompt).toBe('');
    expect(resume).toBe(true);
    expect(childDs.session.forkedFrom).toBe('src-sess-1');
    // Child runtime row carries bot identity + a FRESH card (never the source's).
    expect(childDs.larkAppId).toBe('cli_app_test');
    expect(childDs.streamCardId).toBeUndefined();

    // Source session object is byte-for-byte unchanged.
    expect(JSON.stringify(src.session)).toBe(sourceSnapshot);
    expect(src.worker).toBeNull();
    // Source still registered at its own anchor.
    expect(registry.get(sessionKey('om_source_root', 'cli_app_test'))).toBe(src);
  });
});

describe('forkSession — refusals', () => {
  let registry: Map<string, DaemonSession>;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new Map();
    setActiveSessionsRegistry(registry);
    vi.mocked(getBot).mockReturnValue({
      config: { cliId: 'claude-code', larkAppId: 'cli_app_test' },
      botName: 'TestBot',
    } as any);
  });

  it('session_not_active when the source id is not registered', async () => {
    const r = await forkSession('nope', 'oc_child', 'oc_child', 'group', 'chat', { forkWorkerImpl: forkWorkerSpy as any });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('session_not_active');
    expect(forkWorkerSpy).not.toHaveBeenCalled();
  });

  it('fork_unsupported_backend for a codex-app source', async () => {
    const src = makeSourceDs({ cliId: 'codex-app' });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), src);
    const r = await callFork(src);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('fork_unsupported_backend');
    expect(sessionStore.createSession).not.toHaveBeenCalled();
    expect(forkWorkerSpy).not.toHaveBeenCalled();
  });

  it('adopt_not_forkable for an adopted source', async () => {
    const src = makeSourceDs();
    src.session.adoptedFrom = { tmuxTarget: '0:1.0', originalCliPid: 999, cwd: '/tmp/project' } as any;
    registry.set(sessionKey('om_source_root', 'cli_app_test'), src);
    const r = await callFork(src);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('adopt_not_forkable');
    expect(forkWorkerSpy).not.toHaveBeenCalled();
  });

  it('not_started_yet when the source has no CLI-native id to fork from', async () => {
    const src = makeSourceDs({ cliSessionId: undefined });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), src);
    const r = await callFork(src);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('not_started_yet');
    expect(forkWorkerSpy).not.toHaveBeenCalled();
  });

  it('worker_busy when the source is mid-turn', async () => {
    const src = makeSourceDs({}, { lastScreenStatus: 'running', worker: { killed: false } as any });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), src);
    const r = await callFork(src);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('worker_busy');
    expect(forkWorkerSpy).not.toHaveBeenCalled();
  });
});

/**
 * sessionAgentConfig — /cli cliLaunchSnapshot model resolution WIRING.
 *
 * The unit-level model contract lives in session-launch-model.test.ts (it tests
 * resolveSessionLaunchModel directly). These tests guard the CALL SITE: that the
 * snapshot branch actually routes model through that live resolution AFTER it
 * stamps ds.session.cliId = selected.cliId, rather than freezing the (null)
 * snapshot model. Reverting the fix to `model = selected.model ?? undefined`
 * reddens the "same-CLI keeps bot model" and "override wins" cases here — which
 * the function-level tests cannot catch.
 */
describe('sessionAgentConfig — /cli snapshot model wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBot).mockReturnValue({
      config: { cliId: 'claude-code', larkAppId: 'cli_app_test' },
      botName: 'TestBot',
    } as any);
  });

  const pendingSnapshot = (cliId: any) => ({
    version: 1 as const,
    state: 'pending' as const,
    entryId: cliId,
    cliId,
    cliRuntime: null,
    cliPathOverride: null,
    wrapperCli: null,
    model: null,
    reasoningEffort: null,
    launchShell: null,
    startupCommands: [] as string[],
  });

  // A fresh /cli-selected session: no history, no model of its own, pending snapshot.
  const selectedDs = (cliId: any, dsOverrides: Partial<DaemonSession> = {}) =>
    makeSourceDs(
      { cliId: undefined, cliSessionId: undefined, agentFrozen: false, model: undefined, cliLaunchSnapshot: pendingSnapshot(cliId) as any },
      dsOverrides,
    );

  it('leaks no bot model across a cross-CLI selection (/cli codex on a claude bot)', () => {
    const ds = selectedDs('codex');
    const cfg = sessionAgentConfig(ds, { cliId: 'claude-code', model: 'opus' });
    expect(cfg.cliId).toBe('codex');
    expect(cfg.model).toBeUndefined();          // opus must NOT reach codex
    expect(ds.session.cliId).toBe('codex');     // snapshot resolved onto the session
    expect(ds.session.agentFrozen).toBe(true);
  });

  it('keeps the bot model for a same-CLI selection (/cli codex on a codex bot)', () => {
    const ds = selectedDs('codex');
    const cfg = sessionAgentConfig(ds, { cliId: 'codex', model: 'gpt-5.6' });
    expect(cfg.model).toBe('gpt-5.6');          // same CLI → live bot model applies (== /restart)
  });

  it('clears a Codex service tier only when a cross-CLI selection resolves', () => {
    const ds = selectedDs('claude-code', {});
    ds.session.serviceTier = 'priority';
    const cfg = sessionAgentConfig(ds, { cliId: 'codex' });
    expect(cfg.cliId).toBe('claude-code');
    expect(cfg.serviceTier).toBeUndefined();
    expect(ds.session.serviceTier).toBe('inherit');
    expect(ds.session.agentFrozen).toBe(true);
  });

  it('keeps a Codex service tier for a same-CLI selection', () => {
    const ds = selectedDs('codex', {});
    ds.session.serviceTier = 'priority';
    const cfg = sessionAgentConfig(ds, { cliId: 'codex' });
    expect(cfg.serviceTier).toBe('priority');
    expect(ds.session.serviceTier).toBe('priority');
  });

  it('honors a per-trigger spawnModelOverride on a /cli session', () => {
    const ds = selectedDs('codex', { spawnModelOverride: 'gpt-5.6-terra' } as any);
    const cfg = sessionAgentConfig(ds, { cliId: 'claude-code', model: 'opus' });
    expect(cfg.model).toBe('gpt-5.6-terra');    // override wins even on cross-CLI
  });

  it('freezes a TraeX backend variant for the session launch identity', () => {
    const ds = makeSourceDs({ cliId: 'traex', agentFrozen: false });
    const first = sessionAgentConfig(ds, { cliId: 'traex', modelBackendVariant: 'max' });
    expect(first.modelBackendVariant).toBe('max');
    expect(ds.session.modelBackendVariant).toBe('max');

    const resumed = sessionAgentConfig(ds, { cliId: 'traex', modelBackendVariant: 'standard' });
    expect(resumed.modelBackendVariant).toBe('max');
  });

  it('keeps old frozen sessions without a variant in inherit mode', () => {
    const ds = makeSourceDs({ cliId: 'traex', agentFrozen: true });
    const cfg = sessionAgentConfig(ds, { cliId: 'traex', modelBackendVariant: 'max' });
    expect(cfg.modelBackendVariant).toBeUndefined();
  });

  it('freezes Forge x TraeX launch mode from bot config', () => {
    const ds = makeSourceDs({ cliId: 'traex', agentFrozen: false });
    const cfg = sessionAgentConfig(ds, { cliId: 'traex', cliLaunchMode: 'forge-traex' });
    expect(cfg.cliLaunchMode).toBe('forge-traex');
    expect(ds.session.cliLaunchMode).toBe('forge-traex');
    expect(ds.session.agentFrozen).toBe(true);
  });

  it('repairs a stale backend variant from a frozen non-TraeX session', () => {
    const ds = makeSourceDs({
      cliId: 'codex',
      agentFrozen: true,
      modelBackendVariant: 'max',
    });

    const cfg = sessionAgentConfig(ds, { cliId: 'codex' });

    expect(cfg.modelBackendVariant).toBeUndefined();
    expect(ds.session.modelBackendVariant).toBeUndefined();
  });
});


describe('sessionAgentConfig — service tier without /cli selection', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['default', 'priority', 'ultrafast'] as const)(
    'clears %s when the Bot switches CLI before the first fork', (serviceTier) => {
      const ds = makeSourceDs({ cliId: undefined, agentFrozen: false, serviceTier });
      const cfg = sessionAgentConfig(ds, { cliId: 'claude-code' });
      expect(cfg.cliId).toBe('claude-code');
      expect(cfg.serviceTier).toBeUndefined();
      expect(ds.session.serviceTier).toBe('inherit');
      expect(sessionStore.updateSession).toHaveBeenLastCalledWith(expect.objectContaining({
        cliId: 'claude-code', agentFrozen: true, serviceTier: 'inherit',
      }));
      expect(sessionAgentConfig(ds, { cliId: 'codex' }).serviceTier).toBeUndefined();
    },
  );

  it('preserves the tier when the session already froze a Codex CLI', () => {
    const ds = makeSourceDs({ cliId: 'codex', agentFrozen: true, serviceTier: 'priority' });
    const cfg = sessionAgentConfig(ds, { cliId: 'claude-code' });
    expect(cfg.cliId).toBe('codex');
    expect(cfg.serviceTier).toBe('priority');
    expect(ds.session.serviceTier).toBe('priority');
  });

  it.each(['codex', 'claude-code'] as const)('resolves the tier after the store restores a stale %s row', (cliId) => {
    const ds = makeSourceDs({ cliId: undefined, agentFrozen: false, serviceTier: undefined });
    vi.mocked(sessionStore.updateSession).mockImplementationOnce(session => {
      session.serviceTier = 'priority';
    });
    const cfg = sessionAgentConfig(ds, { cliId });
    expect(cfg.serviceTier).toBe(cliId === 'codex' ? 'priority' : undefined);
    expect(ds.session.serviceTier).toBe(cliId === 'codex' ? 'priority' : 'inherit');
  });
});


describe('sessionAgentConfig — group defaults', () => {
  const topic = (overrides: Partial<Session> = {}) => makeSourceDs({
    cliId: 'codex', cliSessionId: undefined, agentFrozen: false,
    groupDefaultModels: { codex: { model: 'gpt-5.6-sol', reasoningEffort: 'ultra' } },
    ...overrides,
  });
  const bot = { cliId: 'codex', model: 'gpt-5.5', reasoningEffort: 'medium' } as const;

  it.each([false, true])('applies group effort with agentFrozen=%s without changing CLI', (agentFrozen) => {
    const ds = topic({ agentFrozen });
    const cfg = sessionAgentConfig(ds, bot);
    expect(cfg.cliId).toBe('codex');
    expect(cfg.model).toBe('gpt-5.6-sol');
    expect(cfg.reasoningEffort).toBe('ultra');
  });

  it('preserves explicit session effort', () => {
    expect(sessionAgentConfig(topic({ reasoningEffort: 'high' }), bot).reasoningEffort).toBe('high');
  });

  it('ignores captured group settings when session becomes chat scope', () => {
    const ds = topic();
    ds.session.scope = 'chat';
    const cfg = sessionAgentConfig(ds, bot);
    expect(cfg.model).toBe('gpt-5.5');
    expect(cfg.reasoningEffort).toBe('medium');
  });
});

describe('forkClosedSession（/resume <别处的 id>：从已关闭记录复制）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBot).mockReturnValue({
      config: { cliId: 'claude-code', larkAppId: 'cli_app_test' },
      botName: 'TestBot',
    } as any);
    setActiveSessionsRegistry(new Map());
  });

  const closedRow = (overrides: Partial<Session> = {}): Session => ({
    ...makeSourceDs({ status: 'closed', closedAt: new Date().toISOString(), sandbox: true, reasoningEffort: 'high', ...overrides }).session,
  });
  const callClosedFork = (row: Session) => {
    vi.mocked(sessionStore.getOwnedSession).mockReturnValue(row);
    return forkClosedSession(row.sessionId, 'oc_here', 'om_here_root', 'group', 'thread', {
      forkWorkerImpl: forkWorkerSpy as any,
      childOwnerOpenId: 'ou_resumer',
    });
  };

  it('在目标锚点铸出带完整上下文的子会话，原关闭记录不动', async () => {
    const row = closedRow();
    const before = structuredClone(row);
    const registry = new Map<string, DaemonSession>();
    setActiveSessionsRegistry(registry);
    const res = await callClosedFork(row);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const child = vi.mocked(sessionStore.updateSession).mock.calls.map(c => c[0]).find(s => s.sessionId === res.childSessionId)!;
    expect(child).toMatchObject({
      chatId: 'oc_here', rootMessageId: 'om_here_root', scope: 'thread',
      forkedFrom: row.sessionId, pendingForkSession: true, cliSessionId: 'cli-native-src-abc',
      sandbox: true, reasoningEffort: 'high', larkAppId: 'cli_app_test', ownerOpenId: 'ou_resumer',
    });
    expect(registry.get(sessionKey('om_here_root', 'cli_app_test'))?.session.sessionId).toBe(res.childSessionId);
    expect(forkWorkerSpy).toHaveBeenCalledTimes(1);
    expect(row).toEqual(before);
  });

  it('两个复制请求并发打到同一个空锚点：先注册者胜出，后到者不会把它替换/关掉', async () => {
    const row = closedRow();
    vi.mocked(sessionStore.getOwnedSession).mockReturnValue(row);
    const registry = new Map<string, DaemonSession>();
    setActiveSessionsRegistry(registry);
    const go = () => forkClosedSession(row.sessionId, 'oc_here', 'om_here_root', 'group', 'thread', {
      forkWorkerImpl: forkWorkerSpy as any,
    });
    const [a, b] = await Promise.all([go(), go()]);
    const oks = [a, b].filter(r => r.ok);
    expect(oks).toHaveLength(1);
    expect([a, b].find(r => !r.ok)).toEqual({ ok: false, error: 'target_chat_has_session' });
    const winner = registry.get(sessionKey('om_here_root', 'cli_app_test'));
    expect(winner?.session.sessionId).toBe((oks[0] as { childSessionId: string }).childSessionId);
    expect(winner?.session.status).toBe('active');
    expect(forkWorkerSpy).toHaveBeenCalledTimes(1);
  });

  it('排队等目标锁期间源会话被回收：进锁后复查源，拒绝 workspace_retired 且不铸子会话', async () => {
    const row = closedRow();
    const retired = { ...row, workspaceRetirement: { operationId: 'op', workspacePath: '/tmp/project' } as any };
    vi.mocked(sessionStore.getOwnedSession).mockReturnValueOnce(row).mockReturnValue(retired);
    vi.mocked(sessionStore.createSession).mockClear();
    const res = await forkClosedSession(row.sessionId, 'oc_here', 'om_here_root', 'group', 'thread', {
      forkWorkerImpl: forkWorkerSpy as any,
    });
    expect(res).toEqual({ ok: false, error: 'workspace_retired' });
    expect(sessionStore.createSession).not.toHaveBeenCalled();
    expect(forkWorkerSpy).not.toHaveBeenCalled();
  });

  it('已关闭的 Codex/TraeX 会话无法确认是否以 RPC 启动：fail closed', async () => {
    for (const cliId of ['codex', 'traex'] as const) {
      expect(await callClosedFork(closedRow({ cliId }))).toEqual({ ok: false, error: 'fork_unsupported_backend' });
    }
    expect(forkWorkerSpy).not.toHaveBeenCalled();
  });

  it('会话群顶层（chat-scope）复制成功后把子会话登记为常驻；子话题与非会话群不登记', async () => {
    const row = closedRow();
    vi.mocked(sessionStore.getOwnedSession).mockReturnValue(row);
    sessionGroups.groups = new Set(['oc_group']);
    sessionGroups.touch.mockClear();
    setActiveSessionsRegistry(new Map());
    const chat = await forkClosedSession(row.sessionId, 'oc_group', 'oc_group', 'group', 'chat', { forkWorkerImpl: forkWorkerSpy as any });
    expect(chat.ok).toBe(true);
    expect(sessionGroups.touch).toHaveBeenCalledWith('oc_group', (chat as { childSessionId: string }).childSessionId);
    sessionGroups.touch.mockClear();
    setActiveSessionsRegistry(new Map());
    expect((await forkClosedSession(row.sessionId, 'oc_group', 'om_sub_root', 'group', 'thread', { forkWorkerImpl: forkWorkerSpy as any })).ok).toBe(true);
    setActiveSessionsRegistry(new Map());
    expect((await forkClosedSession(row.sessionId, 'oc_plain', 'oc_plain', 'group', 'chat', { forkWorkerImpl: forkWorkerSpy as any })).ok).toBe(true);
    expect(sessionGroups.touch).not.toHaveBeenCalled();
    sessionGroups.groups = new Set();
  });

  it('关闭行缺少 larkAppId：拒绝而不是回退到其它 bot 的身份', async () => {
    expect(await callClosedFork(closedRow({ larkAppId: undefined }))).toEqual({ ok: false, error: 'not_found' });
    expect(forkWorkerSpy).not.toHaveBeenCalled();
  });

  it('只接受已关闭、未回收、可 fork 的记录', async () => {
    expect(await callClosedFork(closedRow({ status: 'active' }))).toEqual({ ok: false, error: 'not_closed' });
    expect(await callClosedFork(closedRow({ workspaceRetirement: { operationId: 'op', workspacePath: '/tmp/p' } as any })))
      .toEqual({ ok: false, error: 'workspace_retired' });
    expect(await callClosedFork(closedRow({ cliId: 'codex-app' }))).toEqual({ ok: false, error: 'fork_unsupported_backend' });
    expect(await callClosedFork(closedRow({ cliSessionId: undefined }))).toEqual({ ok: false, error: 'not_started_yet' });
    vi.mocked(sessionStore.getOwnedSession).mockReturnValue(undefined);
    expect(await forkClosedSession('missing', 'oc_here', 'om_here_root', 'group', 'thread')).toEqual({ ok: false, error: 'not_found' });
    expect(forkWorkerSpy).not.toHaveBeenCalled();
  });
});

describe('forkSession：等目标锁期间源会话变化', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBot).mockReturnValue({
      config: { cliId: 'claude-code', larkAppId: 'cli_app_test' },
      botName: 'TestBot',
    } as any);
  });

  const forkWhileTargetLocked = async (mutate: (src: DaemonSession, registry: Map<string, DaemonSession>) => void) => {
    const registry = new Map<string, DaemonSession>();
    setActiveSessionsRegistry(registry);
    const src = makeSourceDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), src);
    vi.mocked(sessionStore.createSession).mockClear();
    let release: (() => void) | undefined;
    const held = withActiveSessionKeyLock(registry, sessionKey('oc_child', 'cli_app_test'), () => new Promise<void>(r => { release = r; }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    // Source guards pass now; the fork then queues behind the held target lock.
    const pending = callFork(src);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    mutate(src, registry);
    release!();
    await held;
    return pending;
  };

  it('源会话开始新一轮：拒绝 worker_busy，不铸子会话', async () => {
    const res = await forkWhileTargetLocked(src => {
      src.worker = { killed: false } as any;
      src.lastScreenStatus = 'working' as any;
    });
    expect(res).toEqual({ ok: false, error: 'worker_busy' });
    expect(sessionStore.createSession).not.toHaveBeenCalled();
    expect(forkWorkerSpy).not.toHaveBeenCalled();
  });

  it('源会话被关闭：拒绝 session_not_active，不铸子会话', async () => {
    const res = await forkWhileTargetLocked((src, registry) => {
      src.session.status = 'closed';
      registry.clear();
    });
    expect(res).toEqual({ ok: false, error: 'session_not_active' });
    expect(sessionStore.createSession).not.toHaveBeenCalled();
  });
});

describe('sessionAgentConfig — cliConfigDir (Claude config profile) is frozen per session', () => {
  it('freezes the bot profile on first fork and ignores later bot edits', () => {
    const ds = makeSourceDs({ agentFrozen: false, cliConfigDir: undefined });
    const first = sessionAgentConfig(ds, { cliId: 'claude-code', cliConfigDir: '~/.claude-api' });
    expect(first.cliConfigDir).toBe('~/.claude-api');
    expect(ds.session.cliConfigDir).toBe('~/.claude-api');
    // The transcript lives in the frozen profile: a resume must not follow the bot.
    const again = sessionAgentConfig(ds, { cliId: 'claude-code', cliConfigDir: '~/.claude-other' });
    expect(again.cliConfigDir).toBe('~/.claude-api');
  });

  it('never back-fills a profile into a session frozen by an older build', () => {
    const ds = makeSourceDs({ agentFrozen: true, cliConfigDir: undefined });
    const cfg = sessionAgentConfig(ds, { cliId: 'claude-code', cliConfigDir: '~/.claude-api' });
    expect(cfg.cliConfigDir).toBeUndefined();
    expect(ds.session.cliConfigDir).toBeUndefined();
  });

  it('never hands a profile to an adopted session (it wraps an external CLI on the default root)', () => {
    const adoptedFrom = { source: 'tmux' as const, tmuxTarget: 'ext-pane', cwd: '/repo' };
    const fresh = makeSourceDs({ agentFrozen: false, cliConfigDir: undefined, adoptedFrom });
    expect(sessionAgentConfig(fresh, { cliId: 'claude-code', cliConfigDir: '~/.claude-api' }).cliConfigDir).toBeUndefined();
    expect(fresh.session.cliConfigDir).toBeUndefined();
    // a row an older build froze with the bot profile must not reach the spawn either
    const legacy = makeSourceDs({ agentFrozen: true, cliConfigDir: '~/.claude-api', adoptedFrom });
    expect(sessionAgentConfig(legacy, { cliId: 'claude-code' }).cliConfigDir).toBeUndefined();
  });

  it('drops the profile for a CLI that does not support it', () => {
    const ds = makeSourceDs({ cliId: 'codex', agentFrozen: false, cliConfigDir: undefined });
    const cfg = sessionAgentConfig(ds, { cliId: 'codex', cliConfigDir: '~/.claude-api' });
    expect(cfg.cliConfigDir).toBeUndefined();
  });

  it('does not hand the bot profile to a per-session /cli selection', () => {
    const ds = makeSourceDs({
      cliId: undefined,
      cliSessionId: undefined,
      agentFrozen: false,
      model: undefined,
      cliLaunchSnapshot: {
        version: 1, state: 'pending', entryId: 'claude-code', cliId: 'claude-code', cliRuntime: null,
        cliPathOverride: null, wrapperCli: null, model: null, reasoningEffort: null, launchShell: null, startupCommands: [],
      } as any,
    });
    const cfg = sessionAgentConfig(ds, { cliId: 'claude-code', cliConfigDir: '~/.claude-api' });
    expect(cfg.cliConfigDir).toBeUndefined();
    expect(ds.session.cliConfigDir).toBeUndefined();
  });
});
