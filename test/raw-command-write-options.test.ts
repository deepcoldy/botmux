import { describe, expect, it } from 'bun:test';
import { createCocoAdapter } from '../src/adapters/cli/coco.js';
import { createOpenCodeAdapter } from '../src/adapters/cli/opencode.js';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { rawCommandWriteOptionsFor } from '../src/core/raw-command-write-options.js';

describe('raw command write options', () => {
  it('maps OpenCode raw command capability to paste-line delivery', () => {
    const adapter = createOpenCodeAdapter('/bin/opencode');

    const options = rawCommandWriteOptionsFor(adapter, 'opencode');

    expect(options.pasteLine).toBe(true);
    expect(options.pasteSettleMs).toEqual(expect.any(Number));
    expect(Number.isFinite(options.pasteSettleMs)).toBe(true);
    expect(options.pasteSettleMs).toBeGreaterThan(0);
    expect(options.coco).toBe(false);
  });

  it('keeps CoCo raw command typing dominant when adapter has paste-line capability', () => {
    const adapter = {
      ...createCocoAdapter('/bin/coco'),
      rawCommandInputMode: 'paste-line',
      rawCommandSettleMs: 300,
    } satisfies ReturnType<typeof createCocoAdapter>;

    const options = rawCommandWriteOptionsFor(adapter, 'coco');

    expect(options.coco).toBe(true);
    expect(options.cocoThrottleMs).toBeGreaterThan(0);
    expect(options.pasteLine).toBeUndefined();
    expect(options.pasteSettleMs).toBeUndefined();
  });

  it('omits paste-line delivery for generic adapters', () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');

    const options = rawCommandWriteOptionsFor(adapter, 'claude-code');

    expect(options.coco).toBe(false);
    expect(options.pasteLine).toBeUndefined();
    expect(options.pasteSettleMs).toBeUndefined();
  });
});
