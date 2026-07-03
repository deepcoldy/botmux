/**
 * Claude adapter × read-isolation. Isolation is enforced by the worker's
 * whole-process Seatbelt wrapper, NOT by injecting a sandbox block into
 * --settings. So the only adapter-level contract left to assert is that it
 * declares the capability and never smuggles a sandbox block into --settings.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execSync: vi.fn(() => '') }));

import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';

function settingsOf(args: string[]): any {
  const idx = args.indexOf('--settings');
  expect(idx).toBeGreaterThanOrEqual(0);
  return JSON.parse(args[idx + 1]);
}

describe('claude-code adapter × read isolation', () => {
  const adapter = createClaudeCodeAdapter('/usr/bin/claude');

  it('declares read-isolation capability', () => {
    expect(adapter.supportsReadIsolation).toBe(true);
  });

  it('does NOT inject a sandbox block into --settings even when readIsolation is on (the external wrapper enforces it)', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false, readIsolation: true });
    const s = settingsOf(args);
    expect(s.sandbox).toBeUndefined();
    // --settings still carries the bypassPermissions default (unrelated to isolation)
    expect(s.permissions?.defaultMode).toBe('bypassPermissions');
  });

  it('does not add sandbox block when readIsolation is absent', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false });
    const s = settingsOf(args);
    expect(s.sandbox).toBeUndefined();
  });
});
