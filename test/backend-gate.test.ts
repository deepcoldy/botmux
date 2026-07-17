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

  it('reattaches a live zmx session despite a transient probe failure', () => {
    expect(
      decideBackendGate({ requested: 'zmx', available: false, hasExistingSession: true }),
    ).toEqual({ action: 'spawn' });
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

  it('includes the supported ZMX version and install path', () => {
    const msg = backendGateUserMessage('zmx', 'zmx 二进制不在 PATH 上');
    expect(msg).toContain('zmx >= 0.6.0');
    expect(msg).toContain('neurosnap/tap/zmx');
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
