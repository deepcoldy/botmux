import { describe, it, expect } from 'vitest';
import { childLarkEnvOverride } from '../src/utils/child-lark-env.js';

describe('childLarkEnvOverride()', () => {
  // The override is spread onto the child CLI's env. `undefined` values remove
  // the variable inherited from the worker (node-pty drops undefined keys; the
  // tmux backend's buildBotmuxEnvAssignments skips them).

  it('redacts bare LARK_APP_* by default (exposeLarkEnvToChild unset)', () => {
    const o = childLarkEnvOverride(undefined);
    expect(o).toEqual({ LARK_APP_ID: undefined, LARK_APP_SECRET: undefined });
    // Spreading it onto an inherited env removes both keys.
    const childEnv = { ...{ LARK_APP_ID: 'cli_bot', LARK_APP_SECRET: 's' }, ...o };
    expect(childEnv.LARK_APP_ID).toBeUndefined();
    expect(childEnv.LARK_APP_SECRET).toBeUndefined();
  });

  it('redacts when explicitly false (same as default)', () => {
    expect(childLarkEnvOverride(false)).toEqual({
      LARK_APP_ID: undefined,
      LARK_APP_SECRET: undefined,
    });
  });

  it('exposes bare LARK_APP_* only when explicitly true (legacy opt-in)', () => {
    const o = childLarkEnvOverride(true);
    expect(o).toEqual({});
    // No override → the child keeps whatever the worker inherited.
    const childEnv = { ...{ LARK_APP_ID: 'cli_bot', LARK_APP_SECRET: 's' }, ...o };
    expect(childEnv.LARK_APP_ID).toBe('cli_bot');
    expect(childEnv.LARK_APP_SECRET).toBe('s');
  });
});
