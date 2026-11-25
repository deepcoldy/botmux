import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/adapters/backend/pty-backend.js', () => ({
  PtyBackend: class MockPtyBackend {},
}));

vi.mock('../src/adapters/backend/tmux-pipe-backend.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/adapters/backend/tmux-pipe-backend.js')>()),
  TmuxPipeBackend: class MockTmuxPipeBackend {
    constructor() { throw new Error('hc must never be routed to TmuxPipeBackend'); }
  },
}));

vi.mock('../src/adapters/backend/hc-backend.js', () => ({
  HcBackend: class MockHcBackend {
    constructor(public target: unknown, public opts: unknown) {}
  },
}));

vi.mock('../src/adapters/backend/hc/cli-ops.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/adapters/backend/hc/cli-ops.js')>()),
  probeHcTerminal: vi.fn(() => 'missing'),
}));

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeHcTerminal, type HcTarget } from '../src/adapters/backend/hc/cli-ops.js';
import { HC_MIN_VERSION } from '../src/setup/ensure-hc.js';
import type { SessionProbe } from '../src/adapters/backend/types.js';
import {
  backendGateUserMessage,
  decideBackendGate,
  resolveHcBackendGate,
  selectSessionBackend,
} from '../src/adapters/backend/session-backend-selector.js';

const SID = '9cfa0024-197d-4781-845b-c541dceb8980';

function target(socket: string, sessionName = 'bmx-9cfa0024', hcSession = 'botmux'): HcTarget {
  return { backendType: 'hc', sessionName, hcSession, socket };
}

describe('selectSessionBackend: hc', () => {
  let runtimeDir: string;

  beforeEach(() => {
    vi.mocked(probeHcTerminal).mockReset().mockReturnValue('missing');
    runtimeDir = mkdtempSync(join(tmpdir(), 'bm-hcsel-'));
    vi.stubEnv('XDG_RUNTIME_DIR', runtimeDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('drives the recorded terminal in pipe mode, never as a tmux attach', () => {
    const recorded = target('/run/recorded/herdr-core/botmux.sock');
    const selected = selectSessionBackend({
      sessionId: SID, backendType: 'hc', persistentBackendTarget: recorded, hasExistingSession: true,
    });

    expect(selected.backend.constructor.name).toBe('MockHcBackend');
    expect((selected.backend as any).target).toEqual(recorded);
    expect((selected.backend as any).opts).toEqual({ sessionId: SID, isReattach: true });
    expect(selected).toMatchObject({
      isPipeMode: true, isTmuxMode: false, isZellijMode: false, isReattach: true,
      persistentSessionName: 'bmx-9cfa0024', persistentBackendTarget: recorded,
    });
    expect(probeHcTerminal).not.toHaveBeenCalled();
  });

  it('freezes a session with no recorded core to this env\'s botmux core', () => {
    vi.mocked(probeHcTerminal).mockReturnValue('exists');
    const selected = selectSessionBackend({ sessionId: SID, backendType: 'hc' });

    const expected = target(join(runtimeDir, 'herdr-core', 'botmux.sock'));
    expect(selected.persistentBackendTarget).toEqual(expected);
    expect(probeHcTerminal).toHaveBeenCalledWith(expected);
    expect(selected.isReattach).toBe(true);
    expect((selected.backend as any).opts).toEqual({ sessionId: SID, isReattach: true });
  });

  it('creates when the frozen decision says the terminal is gone, without probing again', () => {
    vi.mocked(probeHcTerminal).mockReturnValue('exists');
    const selected = selectSessionBackend({
      sessionId: SID, backendType: 'hc', persistentBackendTarget: target('/r/herdr-core/botmux.sock'), hasExistingSession: false,
    });

    expect(selected.isReattach).toBe(false);
    expect(probeHcTerminal).not.toHaveBeenCalled();
  });

  it('ignores a recorded hc target that names no core', () => {
    const selected = selectSessionBackend({
      sessionId: SID, backendType: 'hc', persistentBackendTarget: target(''), hasExistingSession: false,
    });

    expect(selected.persistentBackendTarget).toEqual(target(join(runtimeDir, 'herdr-core', 'botmux.sock')));
  });
});

describe('resolveHcBackendGate', () => {
  const recorded = target('/run/old/herdr-core/botmux.sock');
  const fresh = target('/run/new/herdr-core/botmux.sock');

  function resolve(opts: {
    recorded?: HcTarget;
    available?: boolean;
    probes?: Record<string, SessionProbe>;
    unreachable?: Record<string, string>;
    defaultCore?: () => { hcSession: string; socket: string };
  }) {
    const probe = vi.fn((t: HcTarget) => opts.probes?.[t.socket] ?? 'missing');
    const resolution = resolveHcBackendGate({
      sessionId: SID,
      recorded: opts.recorded,
      availability: () => (opts.available === false ? { ok: false, reason: 'no herdr-core here' } : { ok: true }),
      defaultCore: opts.defaultCore ?? (() => ({ hcSession: fresh.hcSession, socket: fresh.socket })),
      coreUnreachable: core => opts.unreachable?.[core.socket] ?? null,
      probe,
    });
    const gate = decideBackendGate({
      requested: 'hc',
      available: resolution.available,
      hasExistingSession: resolution.hasExistingSession,
      existingSessionUnknown: resolution.existingSessionUnknown,
    });
    return { resolution, gate, probe };
  }

  it('gates with the discovery reason and an hc install hint when no usable binary exists', () => {
    const { resolution, gate, probe } = resolve({ recorded, available: false });

    expect(gate.action).toBe('gate');
    expect(resolution.target).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
    const card = backendGateUserMessage('hc', resolution.reason);
    expect(card).toContain('no herdr-core here');
    expect(card).toContain(HC_MIN_VERSION.join('.'));
  });

  it('reattaches a live recorded terminal without looking at the default core', () => {
    const { resolution, gate, probe } = resolve({ recorded, probes: { [recorded.socket]: 'exists' } });

    expect(gate.action).toBe('spawn');
    expect(resolution).toMatchObject({ target: recorded, probe: 'exists', hasExistingSession: true });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('keeps the reattach bias pinned to a recorded core that gave no answer', () => {
    const { resolution, gate, probe } = resolve({ recorded, probes: { [recorded.socket]: 'unknown', [fresh.socket]: 'missing' } });

    expect(gate.action).toBe('spawn');
    expect(resolution).toMatchObject({ target: recorded, probe: 'unknown', existingSessionUnknown: true, hasExistingSession: false });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('creates on the default core once the recorded terminal is authoritatively gone', () => {
    const { resolution, gate } = resolve({ recorded, probes: { [recorded.socket]: 'missing' } });

    expect(gate.action).toBe('spawn');
    expect(resolution).toMatchObject({ target: fresh, probe: 'missing', hasExistingSession: false, existingSessionUnknown: false });
  });

  it('reattaches a live terminal on the default core whose target report was lost', () => {
    const { resolution } = resolve({ probes: { [fresh.socket]: 'exists' } });

    expect(resolution).toMatchObject({ target: fresh, probe: 'exists', hasExistingSession: true });
  });

  it('does not probe the same core twice', () => {
    const sameCore = target(fresh.socket);
    const { resolution, probe } = resolve({ recorded: sameCore, probes: { [fresh.socket]: 'missing' } });

    expect(resolution).toMatchObject({ target: fresh, probe: 'missing' });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('treats a recorded core whose runtime dir is gone as missing', () => {
    const { resolution, probe } = resolve({
      recorded, unreachable: { [recorded.socket]: 'runtime directory missing' }, probes: { [recorded.socket]: 'exists' },
    });

    expect(resolution).toMatchObject({ target: fresh, probe: 'missing' });
    expect(probe).toHaveBeenCalledWith(fresh);
    expect(probe).not.toHaveBeenCalledWith(recorded);
  });

  it.each([
    { entry: 'botmux.sock', reason: 'socket path is occupied' },
    { entry: 'botmux.holder.1.sock', reason: 'runtime path is inaccessible' },
  ])('refuses to migrate an unreachable recorded core with $entry still present', ({ entry, reason }) => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'bm-hcgate-'));
    try {
      const blocked = target(join(runtimeDir, 'botmux.sock'));
      writeFileSync(join(runtimeDir, entry), '');
      const { resolution, gate, probe } = resolve({ recorded: blocked, unreachable: { [blocked.socket]: reason } });

      expect(resolution).toMatchObject({ available: false, reason });
      expect(resolution.target).toBeUndefined();
      expect(gate.action).toBe('gate');
      expect(probe).not.toHaveBeenCalled();
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it('gates when this env names no usable default core', () => {
    const tooLong = resolve({ recorded, defaultCore: () => { throw new Error('socket path too long'); } });
    expect(tooLong.gate.action).toBe('gate');
    expect(tooLong.resolution.reason).toBe('socket path too long');

    const gone = resolve({ unreachable: { [fresh.socket]: `${fresh.socket} is gone` } });
    expect(gone.gate.action).toBe('gate');
    expect(gone.resolution.reason).toBe(`${fresh.socket} is gone`);
    expect(gone.probe).not.toHaveBeenCalled();
  });
});
