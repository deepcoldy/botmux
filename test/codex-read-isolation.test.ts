/**
 * Codex adapter × read-isolation: buildArgs must emit the default_permissions
 * filesystem-deny profile and NOT the bypass flag (bypass disables the profile).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execSync: vi.fn(() => '') }));

import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import type { ReadIsolationContext } from '../src/adapters/cli/read-isolation.js';

const ctx: ReadIsolationContext = {
  currentAppId: 'cli_self',
  otherAppIds: ['cli_other'],
  sessionDataDir: '/Users/bot/.botmux/data',
  homeDir: '/Users/bot',
};

describe('codex adapter × read isolation', () => {
  const adapter = createCodexAdapter('/usr/bin/codex');

  it('reports read-isolation UNsupported (fail-closed pending Codex 0.137 fix)', () => {
    // codex 0.137 filesystem profile can't do blocklist read-isolation (see codex.ts).
    expect(adapter.supportsReadIsolation).toBe(false);
  });

  it('buildArgs still wires the profile+base when a context is passed (kept for future)', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false, readIsolation: ctx });
    const joined = args.join(' ');
    expect(joined).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(joined).toContain('default_permissions="botmux_read_isolation"');
    expect(joined).toContain('--sandbox workspace-write');
    expect(joined).toContain('--ask-for-approval never');
    expect(joined).toContain('"/Users/bot/.botmux/bots.json"="deny"');
  });

  it('keeps the bypass flag when isolation is off (unchanged behavior)', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false });
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});
