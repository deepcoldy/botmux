import { describe, expect, it } from 'vitest';
import { createOpenCodeAdapter } from '../src/adapters/cli/opencode.js';
import { createOpenCode2Adapter } from '../src/adapters/cli/opencode2.js';

describe('OpenCode first-prompt extended quiescence', () => {
  it('v1 adapter waits 4s of silence before the first paste', () => {
    const cli = createOpenCodeAdapter('/bin/true');
    expect(cli.readyPattern).toBeUndefined();
    expect(cli.firstPromptQuiescenceMs).toBe(4_000);
  });

  it('v2 adapter waits 4s of silence before the first paste', () => {
    const cli = createOpenCode2Adapter('/bin/true');
    expect(cli.readyPattern).toBeUndefined();
    expect(cli.firstPromptQuiescenceMs).toBe(4_000);
  });
});
