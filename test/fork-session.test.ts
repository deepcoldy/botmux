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
 * model/effort override, and bot identity (larkAppId) — because the child is a
 * brand-new row (not a reused ds.session like transferSession), and a missing
 * field silently re-derives to the wrong value:
 *   • missing sandbox → forkWorker's resume=true path writes sandbox=false →
 *     a fork of a sandboxed session runs UNSANDBOXED (credential-seal escape);
 *   • missing model/effort → sessionAgentConfig re-freezes from the live bot
 *     config, dropping per-session overrides;
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

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

const forkWorkerSpy = vi.fn();

import {
  forkSession,
  isForkCapableSession,
  forkWorker,
  setActiveSessionsRegistry,
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

  it('accepts claude-code / seed / relay / codex (terminal)', () => {
    for (const cliId of ['claude-code', 'seed', 'relay', 'codex'] as const) {
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
  });

  it('P1: a fork of an explicitly UN-sandboxed source stays un-sandboxed (false travels, not just true)', async () => {
    const src = makeSourceDs({ sandbox: false, sandboxNetwork: true });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), src);

    const r = await callFork(src);
    expect(r.ok).toBe(true);
    const child = vi.mocked(sessionStore.createSession).mock.results[0].value as Session;
    expect(child.sandbox).toBe(false);
  });

  // ── P2: per-session model / reasoningEffort overrides + the agentFrozen
  //    marker must ride along, else sessionAgentConfig re-freezes from the live
  //    bot config and the clone silently drops the source's launch identity. ──
  it('P2: model / reasoningEffort / cliRuntime / cliPathOverride / wrapperCli / agentFrozen inherited', async () => {
    const src = makeSourceDs({
      model: 'opus-custom',
      reasoningEffort: 'xhigh',
      cliRuntime: {
        id: 'custom-claude',
        displayName: 'Custom Claude',
        executable: '/opt/custom/claude',
        source: 'configured',
        update: { provider: 'self' },
      },
      cliPathOverride: '/opt/custom/claude',
      wrapperCli: 'ttadk',
      agentFrozen: true,
    });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), src);

    const r = await callFork(src);
    expect(r.ok).toBe(true);
    const child = vi.mocked(sessionStore.createSession).mock.results[0].value as Session;
    expect(child.model).toBe('opus-custom');
    expect(child.reasoningEffort).toBe('xhigh');
    expect(child.cliRuntime).toEqual(src.session.cliRuntime);
    expect(child.cliRuntime).not.toBe(src.session.cliRuntime);
    expect(child.cliPathOverride).toBe('/opt/custom/claude');
    expect(child.wrapperCli).toBe('ttadk');
    expect(child.agentFrozen).toBe(true);
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
