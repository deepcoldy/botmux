/**
 * Codex adapter × read-isolation: isolation is enforced by the worker's
 * whole-process Seatbelt wrapper, NOT by codex's own permission profile
 * (codex 0.137 can't express a read blocklist). So the adapter declares the
 * capability and keeps its normal spawn args (bypass on → codex's own nested
 * sandbox off, outer Seatbelt is the enforcer).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execSync: vi.fn(() => '') }));

import { createCodexAdapter } from '../src/adapters/cli/codex.js';

describe('codex adapter × read isolation', () => {
  const adapter = createCodexAdapter('/usr/bin/codex');

  it('declares read-isolation capability', () => {
    expect(adapter.supportsReadIsolation).toBe(true);
  });

  it('keeps normal bypass spawn args (outer Seatbelt is the enforcer)', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false });
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('forwards its env to shell subprocesses under read isolation (send-cred lookup needs BOTMUX_LARK_APP_ID)', () => {
    const iso = adapter.buildArgs({ sessionId: 's', resume: false, readIsolation: true }).join(' ');
    expect(iso).toContain('shell_environment_policy.inherit="all"');
    expect(iso).toContain('shell_environment_policy.ignore_default_excludes=true');
    const plain = adapter.buildArgs({ sessionId: 's', resume: false }).join(' ');
    expect(plain).not.toContain('shell_environment_policy.inherit');
  });
});
