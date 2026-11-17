import { describe, expect, it, vi } from 'vitest';
import { createDashboardExecutableResolver, resolveDashboardRuntimeUpdateTargets } from '../src/dashboard/cli-executable-resolver.js';

describe('Dashboard asynchronous executable discovery', () => {
  it('coalesces identical pending lookups and passes the effective environment to the async probe', async () => {
    let complete!: (value: { resolved: string; inconclusive: boolean }) => void;
    const probe = vi.fn(() => new Promise<{ resolved: string; inconclusive: boolean }>(resolve => { complete = resolve; }));
    const env = { PATH: '/test/bin' };
    const resolve = createDashboardExecutableResolver(env, probe);
    const first = resolve('codex');
    const second = resolve('codex');
    expect(first).toBe(second);
    expect(probe).toHaveBeenCalledWith('codex', { env });
    expect(await resolve('/custom/codex')).toBe('/custom/codex');
    expect(probe).toHaveBeenCalledOnce();
    complete({ resolved: '/test/bin/codex', inconclusive: false });
    expect(await first).toBe('/test/bin/codex');
  });

  it('rejects unresolved bare names instead of falling back to a synchronous adapter lookup', async () => {
    const resolve = createDashboardExecutableResolver({}, async command => ({ resolved: command, inconclusive: true }));
    await expect(resolve('missing-cli')).rejects.toThrow('cli_executable_unresolved');
  });

  it('resolves a shared default only once and keeps unavailable targets isolated', async () => {
    const resolve = vi.fn(async command => {
      if (command === 'broken') throw new Error('not found');
      return command === 'codex' ? '/test/bin/codex' : command;
    });
    const targets = await resolveDashboardRuntimeUpdateTargets([
      { cliId: 'codex' }, { cliId: 'codex-app' },
      { cliId: 'codex', cliPathOverride: 'broken' },
      { cliId: 'claude-code' },
    ], resolve);
    expect(resolve.mock.calls.map(([command]) => command).sort()).toEqual(['broken', 'codex']);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ runtimeId: 'codex', binPath: '/test/bin/codex' });
  });
});
