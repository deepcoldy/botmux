import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decideBackendGate,
  backendGateUserMessage,
  backendSandboxCompatibilityUserMessage,
} from '../src/adapters/backend/session-backend-selector.js';

const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

describe('decideBackendGate (PTY 退役 hard gate)', () => {
  it('always spawns when PTY is explicitly requested (escape hatch), even if "unavailable"', () => {
    expect(
      decideBackendGate({ requested: 'pty', available: false, hasExistingSession: false }),
    ).toEqual({ action: 'spawn' });
  });

  it('spawns tmux when the functional probe passes', () => {
    expect(
      decideBackendGate({ requested: 'tmux', available: true, hasExistingSession: false }),
    ).toEqual({ action: 'spawn' });
  });

  it('GATES tmux when probe fails and no live session exists (no silent PTY fallback)', () => {
    const d = decideBackendGate({ requested: 'tmux', available: false, hasExistingSession: false });
    expect(d.action).toBe('gate');
  });

  it('reattaches a live tmux session despite a transient probe failure (PR#249 exemption)', () => {
    expect(
      decideBackendGate({ requested: 'tmux', available: false, hasExistingSession: true }),
    ).toEqual({ action: 'spawn' });
  });

  it('gates herdr / zellij / zmx when unavailable instead of degrading to PTY', () => {
    expect(decideBackendGate({ requested: 'herdr', available: false, hasExistingSession: false }).action).toBe('gate');
    expect(decideBackendGate({ requested: 'zellij', available: false, hasExistingSession: false }).action).toBe('gate');
    expect(decideBackendGate({ requested: 'zmx', available: false, hasExistingSession: false }).action).toBe('gate');
  });

  it('keeps the generic existing-session exemption available for transient probes', () => {
    expect(
      decideBackendGate({ requested: 'zmx', available: false, hasExistingSession: true }),
    ).toEqual({ action: 'spawn' });
  });

  it('requires the ZMX protocol version before considering a managed live session', () => {
    const start = workerSource.indexOf("} else if (effectiveBackend === 'zmx') {");
    const end = workerSource.indexOf("} else if (effectiveBackend === 'herdr')", start);
    const gate = workerSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(gate.indexOf('probeZmxVersion()')).toBeLessThan(gate.indexOf('probeOwnedZmxSession('));
    expect(gate).toContain("resolvedZmxSessionProbe = 'unknown'");
    expect(gate).toContain('hasExistingSession = false');
  });
});

describe('backendGateUserMessage', () => {
  it('includes the reason, an install hint, and the explicit PTY escape hatch', () => {
    const msg = backendGateUserMessage('tmux', 'tmux 二进制不在 PATH 上');
    expect(msg).toContain('tmux 不可用');
    expect(msg).toContain('tmux 二进制不在 PATH 上');
    expect(msg).toContain('brew install tmux');
    expect(msg).toContain('BACKEND_TYPE=pty');
  });

  it('includes the supported ZMX version and unreleased upstream prerequisite', () => {
    const msg = backendGateUserMessage('zmx', 'zmx 二进制不在 PATH 上');
    expect(msg).toContain('zmx >= 0.7.1');
    expect(msg).toContain('PR #202');
    expect(msg).toContain('官方 0.6.0 尚不满足');
  });
});

describe('ZMX filesystem-isolation gate', () => {
  it('posts an actionable user notification before failing closed', () => {
    const msg = backendSandboxCompatibilityUserMessage(
      'backend "zmx" does not support file/read isolation',
    );
    expect(msg).toContain('ZMX');
    expect(msg).toContain('拒绝启动');
    expect(msg).toContain('tmux');
    expect(msg).toContain('pty');
    expect(msg).toContain('sandbox');
    expect(msg).toContain('readIsolation');
  });

  it('gates on effective isolation and sends user_notify before throwing', () => {
    const start = workerSource.indexOf('const explicitLegacyReadIso =');
    const end = workerSource.indexOf('const readIsolationGate =', start);
    const gate = workerSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // A bare legacy readIsolation flag is a no-op on Linux. Passing the raw
    // cfg value here would reject ZMX even though no boundary is enforced.
    expect(gate).toContain('effectiveReadIsolationRequested: explicitLegacyReadIso');
    expect(gate).not.toContain('effectiveReadIsolationRequested: cfg.readIsolation');

    const notify = gate.indexOf("type: 'user_notify'");
    const failure = gate.indexOf('throw new Error');
    expect(notify).toBeGreaterThan(-1);
    expect(failure).toBeGreaterThan(notify);
  });
});

describe('persistent backend cold-restart ordering', () => {
  it('selects the backend only after stale persistent panes have been removed', () => {
    const coldRestartGate = workerSource.indexOf(
      'if (cliAdapter.mcpGateway && mcpRuntimeManifest?.entries.length',
    );
    const backendSelection = workerSource.indexOf(
      'const selectedBackend = selectSessionBackend({',
    );

    expect(coldRestartGate).toBeGreaterThan(-1);
    expect(backendSelection).toBeGreaterThan(coldRestartGate);
  });

  it('fails closed on an uncertain MCP pane and refreshes the cached ZMX probe after killing it', () => {
    const start = workerSource.indexOf(
      'if (cliAdapter.mcpGateway && mcpRuntimeManifest?.entries.length',
    );
    const end = workerSource.indexOf('const willReattachPersistent =', start);
    const gate = workerSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(gate).toContain('probePersistentSession(');
    expect(gate).toContain("paneProbe === 'unknown'");
    expect(gate).toContain("postKillProbe !== 'missing'");
    expect(gate).toContain("effectiveBackendType === 'zmx'");
    expect(gate).toContain('resolvedZmxSessionProbe = postKillProbe');
  });
});

describe('ZMX observer crash cleanup', () => {
  it('detaches zmx tail from the synchronous worker exit hook without destroying the session', () => {
    const start = workerSource.indexOf("process.on('exit'");
    const end = workerSource.indexOf("process.on('uncaughtException'", start);
    const exitHook = workerSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(exitHook).toContain('backend instanceof ZmxBackend');
    expect(exitHook).toContain('backend.kill()');
    expect(exitHook).not.toContain('destroySession');
  });
});

describe('live-only observer screen rebase', () => {
  it('registers the authoritative snapshot callback and refreshes idle/card state', () => {
    const handlerStart = workerSource.indexOf('function onBackendScreenResync(');
    const handlerEnd = workerSource.indexOf('function releaseRawInputRestartGate', handlerStart);
    const handler = workerSource.slice(handlerStart, handlerEnd);
    const registration = workerSource.indexOf('backend.onScreenResync?.(');

    expect(handlerStart).toBeGreaterThan(-1);
    expect(registration).toBeGreaterThan(handlerStart);
    expect(handler).toContain('lastPtyActivityAtMs = now');
    expect(handler).toContain('lastAnalyzerSnapshot = snapshot');
    expect(handler).toContain('idleDetector.reset()');
    expect(handler).toContain('idleDetector.feed(idleTail)');
    expect(handler).toContain('workflowTranscript = snapshot.slice');
    expect(handler).toContain('handleVisibleStartupInteraction(snapshot)');
  });

  it('shares update and trust dialog handling with incremental PTY output', () => {
    const helperStart = workerSource.indexOf('function handleVisibleStartupInteraction(');
    const helperEnd = workerSource.indexOf('// Codex App runner sends', helperStart);
    const helper = workerSource.slice(helperStart, helperEnd);
    const ptyStart = workerSource.indexOf('function onPtyData(');
    const ptyEnd = workerSource.indexOf('function onBackendScreenResync(', ptyStart);
    const ptyHandler = workerSource.slice(ptyStart, ptyEnd);

    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(helper).toContain('dismissAidenCodexUpdateDialog(data)');
    expect(helper).toContain('TRUST_DIALOG_PATTERN.test(stripped)');
    expect(helper).toContain("sendSpecialKeys('Enter')");
    expect(ptyHandler).toContain('handleVisibleStartupInteraction(data)');
  });
});
