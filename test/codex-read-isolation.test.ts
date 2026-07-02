/**
 * Codex adapter × read-isolation: isolation is enforced by the worker's external
 * Seatbelt wrapper (readIsolationMechanism='external-wrapper'), NOT by codex's
 * own permission profile (codex 0.137 can't express a read blocklist). So the
 * adapter declares the capability + mechanism and keeps its normal spawn args
 * (bypass on → codex's own nested sandbox off, outer Seatbelt is the enforcer).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execSync: vi.fn(() => '') }));

import { createCodexAdapter } from '../src/adapters/cli/codex.js';

describe('codex adapter × read isolation', () => {
  const adapter = createCodexAdapter('/usr/bin/codex');

  it('declares read-isolation capability via the external-wrapper mechanism', () => {
    expect(adapter.supportsReadIsolation).toBe(true);
    expect(adapter.readIsolationMechanism).toBe('external-wrapper');
  });

  it('keeps normal bypass spawn args (outer Seatbelt is the enforcer)', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false });
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});
