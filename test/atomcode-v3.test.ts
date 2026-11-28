import { describe, expect, it } from 'vitest';
import {
  GOAL_COMMAND_OBJECTIVE,
  V3_NATIVE_GOAL_COMMAND_CLIS,
  V3_SUPPORTED_CLIS,
  cliTakesNativeGoalCommand,
  isBotmuxGoalObjective,
  isV3SupportedCli,
} from '../src/workflows/v3/contract.js';
import { buildGoalCommand } from '../src/workflows/v3/ephemeral-pool.js';

describe('AtomCode workflows/v3 support', () => {
  it('admits atomcode in V3_SUPPORTED_CLIS as a programmatic ACP node', () => {
    expect(V3_SUPPORTED_CLIS).toContain('atomcode');
    expect(isV3SupportedCli('atomcode')).toBe(true);
    expect(V3_NATIVE_GOAL_COMMAND_CLIS).not.toContain('atomcode');
    expect(cliTakesNativeGoalCommand('atomcode')).toBe(false);
  });

  it('builds bare objective prompt without /goal prefix for atomcode', () => {
    const cmd = buildGoalCommand({ botSnapshot: { cliId: 'atomcode' } } as never);
    expect(cmd).toBe(GOAL_COMMAND_OBJECTIVE);
    expect(cmd.startsWith('/goal ')).toBe(false);
    expect(isBotmuxGoalObjective(cmd)).toBe(true);
  });
});
