/**
 * Structured turn-idle channel: decision logic, auth wiring and the opt-in
 * surface that keeps every other CLI / backend on its previous path.
 *
 * The worker's own end-to-end behaviour (IPC → fireIdle → prompt_ready, and the
 * rejections) lives in worker-turn-idle.test.ts; the CLI boundary lives in
 * turn-idle-cli.test.ts. This file pins the pure fence, the daemon route's
 * authorization, and the "only dsh-tui opts in" invariants.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideTurnIdleReport } from '../src/utils/turn-idle-report.js';
import { authorizeSessionScopedIpc } from '../src/core/daemon-ipc-session-auth.js';
import { turnIdleHookCommand } from '../src/adapters/hook-command.js';
import { BOTMUX_INJECTED_ENV_KEYS, SESSION_TURN_MARKER_ENV_KEYS } from '../src/utils/child-env.js';

const REPO_ROOT = join(__dirname, '..');
const TURN_IDLE_ENV_KEY = 'BOTMUX_TURN_IDLE_COMMAND';

function source(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

describe('decideTurnIdleReport — turn fence', () => {
  const base = {
    reportedTurnId: 'turn-a',
    reportedDispatchAttempt: 3,
    activeTurnId: 'turn-a',
    activeDispatchAttempt: 3,
    promptReady: false,
  };

  it('accepts a report that names exactly the turn in flight', () => {
    expect(decideTurnIdleReport(base)).toEqual({ accept: true });
  });

  it('rejects a report with no turn identity', () => {
    expect(decideTurnIdleReport({ ...base, reportedTurnId: undefined, reportedDispatchAttempt: undefined }))
      .toEqual({ accept: false, reason: 'missing-turn' });
  });

  it('rejects a report while this worker has no active turn', () => {
    expect(decideTurnIdleReport({ ...base, activeTurnId: undefined, activeDispatchAttempt: undefined }))
      .toEqual({ accept: false, reason: 'no-active-turn' });
  });

  it('rejects a report for a different turn (the expensive direction)', () => {
    expect(decideTurnIdleReport({ ...base, reportedTurnId: 'turn-b' }))
      .toEqual({ accept: false, reason: 'turn-mismatch' });
  });

  it('rejects a replay of the same turn id under another dispatch attempt', () => {
    expect(decideTurnIdleReport({ ...base, reportedDispatchAttempt: 2 }))
      .toEqual({ accept: false, reason: 'attempt-mismatch' });
  });

  it('rejects a report while the worker is not waiting for a turn', () => {
    expect(decideTurnIdleReport({ ...base, promptReady: true }))
      .toEqual({ accept: false, reason: 'already-ready' });
  });

  it('fails closed when the active attempt is known but the report omits one', () => {
    // A report that cannot name the dispatch generation cannot be bound to the
    // turn the worker is waiting on: an earlier retry/replay of the same turn id
    // would otherwise settle the newer generation.
    expect(decideTurnIdleReport({ ...base, reportedDispatchAttempt: undefined }))
      .toEqual({ accept: false, reason: 'missing-attempt' });
  });

  it('fails closed when the report names an attempt this worker does not have', () => {
    expect(decideTurnIdleReport({ ...base, activeDispatchAttempt: undefined }))
      .toEqual({ accept: false, reason: 'attempt-mismatch' });
  });

  it('accepts only when neither side has an attempt (non-durable turn)', () => {
    expect(decideTurnIdleReport({
      ...base,
      reportedDispatchAttempt: undefined,
      activeDispatchAttempt: undefined,
    })).toEqual({ accept: true });
  });

  it('fences a worker restart/retry of the same turn id by generation', () => {
    // Same turn id, next dispatch generation: the older generation's report must
    // not settle the newer one (and vice versa).
    expect(decideTurnIdleReport({ ...base, reportedDispatchAttempt: 2, activeDispatchAttempt: 3 }))
      .toEqual({ accept: false, reason: 'attempt-mismatch' });
    expect(decideTurnIdleReport({ ...base, reportedDispatchAttempt: 4, activeDispatchAttempt: 3 }))
      .toEqual({ accept: false, reason: 'attempt-mismatch' });
  });
});

describe('/api/turn-idle claim ↔ capability binding', () => {
  // The route reuses the same fence against the daemon's live origin (the
  // publication the presented capability was minted for), so a caller holding a
  // live token cannot name somebody else's turn.
  const liveOrigin = { turnId: 'turn-a', dispatchAttempt: 1 };

  function bind(claim: { turnId?: string; dispatchAttempt?: number }) {
    return decideTurnIdleReport({
      reportedTurnId: claim.turnId,
      reportedDispatchAttempt: claim.dispatchAttempt,
      activeTurnId: liveOrigin.turnId,
      activeDispatchAttempt: liveOrigin.dispatchAttempt,
      promptReady: false,
    });
  }

  it('accepts a claim that names exactly the origin the token was minted for', () => {
    expect(bind({ turnId: 'turn-a', dispatchAttempt: 1 })).toEqual({ accept: true });
  });

  it('refuses a live token presented with a different turn or generation', () => {
    expect(bind({ turnId: 'turn-b', dispatchAttempt: 1 }))
      .toEqual({ accept: false, reason: 'turn-mismatch' });
    expect(bind({ turnId: 'turn-a', dispatchAttempt: 9 }))
      .toEqual({ accept: false, reason: 'attempt-mismatch' });
    expect(bind({ turnId: 'turn-a' })).toEqual({ accept: false, reason: 'missing-attempt' });
    expect(bind({})).toEqual({ accept: false, reason: 'missing-turn' });
  });
});

describe('/api/turn-idle authorization', () => {
  const liveOrigin = { capability: 'live-capability', turnId: 'turn-a', dispatchAttempt: 1 };

  it('rejects an unproven caller that presents no capability', () => {
    expect(authorizeSessionScopedIpc({
      trustedHost: false,
      sessionExists: true,
      receiverSession: false,
      allowReceiver: true,
      sessionId: 'sess-a',
      liveOrigin,
      claimedCapability: undefined,
      claimedTurnId: 'turn-a',
      claimedDispatchAttempt: 1,
    })).toEqual({ ok: false, error: 'origin_unproven' });
  });

  it('rejects a stale capability and accepts the live one', () => {
    const claim = {
      trustedHost: false,
      sessionExists: true,
      receiverSession: false,
      allowReceiver: true,
      sessionId: 'sess-a',
      liveOrigin,
      claimedTurnId: 'turn-a',
      claimedDispatchAttempt: 1,
    } as const;
    expect(authorizeSessionScopedIpc({ ...claim, claimedCapability: 'stale' }))
      .toEqual({ ok: false, error: 'origin_unproven' });
    expect(authorizeSessionScopedIpc({ ...claim, claimedCapability: 'live-capability' }))
      .toEqual({ ok: true });
  });

  it('rejects a caller for a session the daemon does not know', () => {
    expect(authorizeSessionScopedIpc({
      trustedHost: false,
      sessionExists: false,
      receiverSession: false,
      allowReceiver: true,
      sessionId: 'sess-a',
      claimedCapability: 'live-capability',
    })).toEqual({ ok: false, error: 'origin_unproven' });
  });

  it('denies a VC-meeting receiver session because this route has observable effects', () => {
    expect(authorizeSessionScopedIpc({
      trustedHost: false,
      sessionExists: true,
      receiverSession: true,
      allowReceiver: false,
      sessionId: 'sess-a',
      liveOrigin,
      claimedCapability: 'live-capability',
    })).toEqual({ ok: false, error: 'managed_action_required' });
  });
});

describe('turn-idle protocol wiring', () => {
  it('registers the daemon route with session-scoped authorization before forwarding', () => {
    const daemon = source('src/daemon.ts');
    const route = daemon.indexOf("ipcRoute('POST', '/api/turn-idle'");
    expect(route).toBeGreaterThan(-1);
    const routeBody = daemon.slice(route, daemon.indexOf("ipcRoute(", route + 10));
    expect(routeBody).toContain('authorizeSessionScopedIpc({');
    expect(routeBody).toContain("jsonRes(res, 403");
    expect(routeBody).toContain("type: 'turn_idle'");
    // Observable route: receiver sessions are denied (unlike session-ready).
    expect(routeBody).toContain('allowReceiver: false');
    // Never forward before the capability check.
    expect(routeBody.indexOf('authorizeSessionScopedIpc({'))
      .toBeLessThan(routeBody.indexOf("type: 'turn_idle'"));
  });

  it('carries the report in the daemon→worker protocol', () => {
    const types = source('src/types.ts');
    expect(types).toMatch(/type: 'turn_idle'; turnId\?: string; dispatchAttempt\?: number/);
  });

  it('binds the claimed turn/attempt to the live origin before forwarding', () => {
    const daemon = source('src/daemon.ts');
    const route = daemon.indexOf("ipcRoute('POST', '/api/turn-idle'");
    const routeBody = daemon.slice(route, daemon.indexOf("ipcRoute(", route + 10));
    // The capability only proves "holds this session's current token"; the claim
    // is bound to the origin that token was minted for, and a mismatch is
    // refused instead of forwarded.
    expect(routeBody).toContain('decideTurnIdleReport({');
    expect(routeBody).toContain("error: 'origin_identity_mismatch'");
    expect(routeBody.indexOf('authorizeSessionScopedIpc({'))
      .toBeLessThan(routeBody.indexOf('decideTurnIdleReport({'));
    expect(routeBody.indexOf('decideTurnIdleReport({'))
      .toBeLessThan(routeBody.indexOf("type: 'turn_idle'"));
  });

  it('transports the frozen (event-time) identity instead of re-resolving the marker', () => {
    const cli = source('src/cli.ts');
    expect(cli).toContain('parsed.v === TURN_IDLE_PROTOCOL_VERSION');
    expect(cli).toContain('frozenOrigin');
    // The frozen path must not fall back to the live marker or its env fallback.
    const frozen = cli.slice(cli.indexOf('const frozenOrigin = opts?.frozenOrigin'));
    const originAssignment = frozen.slice(0, frozen.indexOf('satisfies RequestInit'));
    expect(originAssignment).toContain('frozenOrigin');
    expect(originAssignment).toContain('liveOrigin?.turnId');
    expect(originAssignment).toContain('process.env.BOTMUX_TURN_ID');
    // …and when a frozen origin is present the marker walk is skipped entirely.
    expect(cli).toContain('const liveOrigin = frozenOrigin ? undefined : resolveSessionContext(');
  });

  it('registers `botmux turn-idle-v2` and allowlists it inside workflow subagents', () => {
    const cli = source('src/cli.ts');
    expect(cli).toContain("case 'turn-idle-v2':");
    expect(cli).toContain('await cmdTurnIdle();');
    expect(cli).toContain("'turn-idle-v2',");
  });

  it('builds the shell command from the same launcher resolution as session-ready', () => {
    expect(turnIdleHookCommand()).toMatch(/turn-idle-v2$/);
    expect(source('src/adapters/hook-command.ts')).toContain("renderShellCommand(undefined, 'turn-idle-v2')");
  });
});

describe('turn-idle opt-in surface', () => {
  it('is opted into by dsh-tui alone', () => {
    const adapterDir = join(REPO_ROOT, 'src', 'adapters', 'cli');
    const optingIn = readdirSync(adapterDir)
      .filter(name => name.endsWith('.ts'))
      .filter(name => source(join('src', 'adapters', 'cli', name)).includes('injectsTurnIdleHook: true'))
      .sort();
    expect(optingIn).toEqual(['dsh-tui.ts']);
  });

  it('injects the env only for adapters that declare the flag', () => {
    const worker = source('src/worker.ts');
    expect(worker).toContain('if (cliAdapter.injectsTurnIdleHook) childEnv.BOTMUX_TURN_IDLE_COMMAND = turnIdleHookCommand();');
    expect(worker).toContain('else delete childEnv.BOTMUX_TURN_IDLE_COMMAND;');
  });

  it('transports and scrubs the env key at every session boundary', () => {
    expect(BOTMUX_INJECTED_ENV_KEYS).toContain(TURN_IDLE_ENV_KEY);
    expect(SESSION_TURN_MARKER_ENV_KEYS).toContain(TURN_IDLE_ENV_KEY);
  });

  it('keeps BOTMUX_READY_COMMAND opt-in as before (no other adapter gained the gate)', () => {
    const adapterDir = join(REPO_ROOT, 'src', 'adapters', 'cli');
    const readyOptIn = readdirSync(adapterDir)
      .filter(name => name.endsWith('.ts'))
      .filter(name => source(join('src', 'adapters', 'cli', name)).includes('injectsReadyHook: true'))
      .sort();
    // claude-code + grok already shipped it; this change added dsh-tui only.
    expect(readyOptIn).toEqual(['claude-code.ts', 'dsh-tui.ts', 'grok.ts']);
  });
});
