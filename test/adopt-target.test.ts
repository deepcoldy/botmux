import { describe, expect, it } from 'vitest';
import { adoptedFromForTarget } from '../src/core/adopt-target.js';
import { adoptTargetLabel } from '../src/core/session-discovery.js';

describe('adoptedFromForTarget', () => {
  it.each(['server', 'relay-local'] as const)('preserves every restart identity field for an Orca %s target', instance => {
    expect(adoptedFromForTarget({
      source: 'orca',
      orcaInstance: instance,
      orcaTerminalHandle: 'term_1',
      orcaTerminalTitle: 'Fix login',
      orcaPtyId: 'serve-1',
      orcaIncarnationId: 'inc_1',
      orcaExecutionHostId: 'local',
      orcaWorktreeId: 'repo::/work',
      orcaAgentIdentity: 'trae',
      cliPid: 123,
      sessionId: 'rollout_1',
      cliId: 'traex',
      cwd: '/work',
      paneCols: 104,
      paneRows: 50,
      paneSizeVerified: true,
    })).toEqual({
      source: 'orca',
      orcaInstance: instance,
      orcaTerminalHandle: 'term_1',
      orcaTerminalTitle: 'Fix login',
      orcaPtyId: 'serve-1',
      orcaIncarnationId: 'inc_1',
      orcaExecutionHostId: 'local',
      orcaWorktreeId: 'repo::/work',
      orcaAgentIdentity: 'trae',
      originalCliPid: 123,
      sessionId: 'rollout_1',
      cliId: 'traex',
      cwd: '/work',
      paneCols: 104,
      paneRows: 50,
      orcaPaneSizeVerified: true,
    });
  });

  it('uses the persisted Orca title for display without changing its handle identity', () => {
    const adopted = adoptedFromForTarget({
      source: 'orca',
      orcaInstance: 'relay',
      orcaTerminalHandle: 'term_1',
      orcaTerminalTitle: 'Fix login',
      orcaPtyId: 'ssh:h@@pty:1',
      orcaWorktreeId: 'repo::/work',
      orcaAgentIdentity: 'trae',
      cliId: 'traex',
      cwd: '/work',
      paneCols: 104,
      paneRows: 50,
      paneSizeVerified: true,
    });
    expect(adoptTargetLabel(adopted)).toBe('orca:Fix login');
    expect(adopted.orcaTerminalHandle).toBe('term_1');
  });
});
