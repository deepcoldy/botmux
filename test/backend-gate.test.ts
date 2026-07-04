import { describe, it, expect } from 'vitest';
import {
  decideBackendGate,
  backendGateUserMessage,
} from '../src/adapters/backend/session-backend-selector.js';

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

  it('gates herdr / zellij when unavailable instead of degrading to PTY', () => {
    expect(decideBackendGate({ requested: 'herdr', available: false, hasExistingSession: false }).action).toBe('gate');
    expect(decideBackendGate({ requested: 'zellij', available: false, hasExistingSession: false }).action).toBe('gate');
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
});
