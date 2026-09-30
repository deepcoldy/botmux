import { describe, expect, it } from 'vitest';
import { adoptedFromForTarget } from '../src/core/adopt-target.js';

describe('adoptedFromForTarget', () => {
  it('preserves every restart identity field for an Orca target', () => {
    expect(adoptedFromForTarget({
      source: 'orca',
      orcaTerminalHandle: 'term_1',
      orcaPtyId: 'ssh:h@@pty:1',
      orcaIncarnationId: 'inc_1',
      orcaExecutionHostId: 'ssh:h',
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
      orcaTerminalHandle: 'term_1',
      orcaPtyId: 'ssh:h@@pty:1',
      orcaIncarnationId: 'inc_1',
      orcaExecutionHostId: 'ssh:h',
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
});
