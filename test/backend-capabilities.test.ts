import { describe, expect, it } from 'vitest';
import {
  backendCliCompatibilityError,
  backendSupportsWebTerminal,
} from '../src/adapters/backend/capabilities.js';
import type { BackendType } from '../src/adapters/backend/types.js';

describe('backendSupportsWebTerminal', () => {
  it('keeps the plain-history zmx backend disabled while Orca uses text snapshots', () => {
    expect(backendSupportsWebTerminal('zmx')).toBe(false);

    for (const backend of ['pty', 'tmux', 'hc', 'herdr', 'zellij', 'riff', 'mojo', 'orca'] satisfies BackendType[]) {
      expect(backendSupportsWebTerminal(backend)).toBe(true);
    }
  });
});

describe('backendCliCompatibilityError', () => {
  it('fails closed for runner CLIs whose final/thread events require hidden OSC on zmx', () => {
    for (const cliId of ['codex-app', 'mira', 'mir', 'dsh'] as const) {
      expect(backendCliCompatibilityError('zmx', cliId)).toContain('hidden OSC');
      expect(backendCliCompatibilityError('tmux', cliId)).toBeUndefined();
    }
    expect(backendCliCompatibilityError('zmx', 'codex')).toBeUndefined();
  });

  it('fails closed on hc only for the runner CLIs whose events travel in the terminal output', () => {
    for (const cliId of ['mira', 'mir', 'dsh', 'minimax'] as const) {
      expect(backendCliCompatibilityError('hc', cliId)).toContain(cliId);
      expect(backendCliCompatibilityError('tmux', cliId)).toBeUndefined();
    }
    // codex-app's events go over a signed socket, not the terminal.
    expect(backendCliCompatibilityError('hc', 'codex-app')).toBeUndefined();
    expect(backendCliCompatibilityError('hc', 'codex')).toBeUndefined();
  });

  it('fails closed on hc for Antigravity only when it runs as the framed ACP runner', () => {
    expect(backendCliCompatibilityError('hc', 'antigravity', { runnerFramedInput: true })).toContain('antigravity');
    expect(backendCliCompatibilityError('tmux', 'antigravity', { runnerFramedInput: true })).toBeUndefined();
    expect(backendCliCompatibilityError('hc', 'antigravity', { runnerFramedInput: false })).toBeUndefined();
    expect(backendCliCompatibilityError('hc', 'antigravity')).toBeUndefined();
  });
});
