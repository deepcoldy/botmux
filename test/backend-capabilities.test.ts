import { describe, expect, it } from 'vitest';
import {
  backendCliCompatibilityError,
  backendSupportsWebTerminal,
} from '../src/adapters/backend/capabilities.js';
import type { BackendType } from '../src/adapters/backend/types.js';

describe('backendSupportsWebTerminal', () => {
  it('disables the Web TUI only for the plain-text zmx tail backend', () => {
    expect(backendSupportsWebTerminal('zmx')).toBe(false);

    for (const backend of ['pty', 'tmux', 'herdr', 'zellij', 'riff'] satisfies BackendType[]) {
      expect(backendSupportsWebTerminal(backend)).toBe(true);
    }
  });
});

describe('backendCliCompatibilityError', () => {
  it('fails closed for runner CLIs whose final/thread events require hidden OSC on zmx', () => {
    for (const cliId of ['codex-app', 'mira', 'mir'] as const) {
      expect(backendCliCompatibilityError('zmx', cliId)).toContain('hidden OSC');
      expect(backendCliCompatibilityError('tmux', cliId)).toBeUndefined();
    }
    expect(backendCliCompatibilityError('zmx', 'codex')).toBeUndefined();
  });
});
