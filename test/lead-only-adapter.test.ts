import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''),
  spawnSync: vi.fn(() => ({ stdout: '', status: 0 })),
  execFile: vi.fn((_bin, _args, _opts, cb) => { cb(null, '{}'); }),
}));

import { createCliAdapterSync } from '../src/adapters/cli/registry.js';

function build(opts: Record<string, unknown>) {
  const args = createCliAdapterSync('claude-code').buildArgs({ sessionId: 's', resume: false, locale: 'zh', botName: 'B', ...opts } as any);
  const disallowed = args[args.indexOf('--disallowed-tools') + 1].split(',');
  const sys = args[args.indexOf('--append-system-prompt') + 1] ?? '';
  return { args, disallowed, sys };
}

describe('claude-code buildArgs: lead-only', () => {
  it('lead-only session: edit tools disallowed and role prompt appended', () => {
    const { disallowed, sys } = build({ leadOnly: true });
    expect(disallowed).toEqual(expect.arrayContaining(['EnterPlanMode', 'ExitPlanMode', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Read', 'Grep', 'Glob', 'Agent', 'Task', 'WebFetch', 'WebSearch']));
    expect(sys).toContain('<lead_only_manager>');
    expect(sys).toContain('botmux dispatch');
    expect(sys).toContain('不适用');
  });

  it('english locale prompt', () => {
    expect(build({ leadOnly: true, locale: 'en' }).sys).toContain('does NOT apply');
  });

  it('normal and executor sessions are unchanged (no leadOnly flag)', () => {
    for (const opts of [{}, { leadOnly: false }]) {
      const { disallowed, sys } = build(opts);
      expect(disallowed).toEqual(['EnterPlanMode', 'ExitPlanMode']);
      expect(sys).not.toContain('lead_only_manager');
    }
  });

  it('promptInjection=none: enforcement stays (tools disallowed + guard plugin dir), no prompt', () => {
    const { args, disallowed } = build({ leadOnly: true, promptInjection: 'none' });
    expect(disallowed).toContain('Edit');
    expect(args).not.toContain('--append-system-prompt');
    const dirs = args.flatMap((a, i) => (a === '--plugin-dir' ? [args[i + 1]] : []));
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/claude-plugin-lead-only$/);
  });

  it('lead-only mounts the guard dir; ordinary sessions never do', () => {
    const lead = build({ leadOnly: true }).args;
    expect(lead.filter(a => a.endsWith('claude-plugin-lead-only'))).toHaveLength(1);
    expect(build({}).args.some(a => a.endsWith('-lead-only'))).toBe(false);
  });

  it('fail closed: when the guard plugin dir cannot be materialised, Bash is disallowed and no guard dir is mounted', async () => {
    const guard = await import('../src/skills/lead-only-guard.js');
    const spy = vi.spyOn(guard, 'ensureLeadOnlyPluginDir').mockReturnValue(undefined);
    try {
      const { args, disallowed } = build({ leadOnly: true });
      expect(disallowed).toContain('Bash');
      expect(args.some(a => a.endsWith('claude-plugin-lead-only'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
