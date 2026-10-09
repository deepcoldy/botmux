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

  it('does not treat a side that could not read an attempt as a mismatch', () => {
    expect(decideTurnIdleReport({ ...base, reportedDispatchAttempt: undefined })).toEqual({ accept: true });
    expect(decideTurnIdleReport({ ...base, activeDispatchAttempt: undefined })).toEqual({ accept: true });
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

  it('registers `botmux turn-idle` and allowlists it inside workflow subagents', () => {
    const cli = source('src/cli.ts');
    expect(cli).toContain("case 'turn-idle':");
    expect(cli).toContain('await cmdTurnIdle();');
    expect(cli).toContain("'turn-idle',");
  });

  it('builds the shell command from the same launcher resolution as session-ready', () => {
    expect(turnIdleHookCommand()).toMatch(/turn-idle$/);
    expect(source('src/adapters/hook-command.ts')).toContain("renderShellCommand(undefined, 'turn-idle')");
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
