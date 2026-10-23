import { describe, expect, it } from 'vitest';
import { createCocoAdapter } from '../src/adapters/cli/coco.js';
import { createOpenCodeAdapter } from '../src/adapters/cli/opencode.js';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { createMinimaxAdapter } from '../src/adapters/cli/minimax.js';
import { rawCommandWriteOptionsFor } from '../src/core/raw-command-write-options.js';
import { writeRawCommandLine, type RawCommandWriter } from '../src/core/raw-command-writer.js';

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

  it('minimax raw 通道按 runner 帧协议编码（v3 goal 注入不能被 runner 丢成 non-frame input）', () => {
    const adapter = createMinimaxAdapter('/bin/true');
    const options = rawCommandWriteOptionsFor(adapter, 'minimax');

    expect(typeof options.frameLine).toBe('function');
    const objective = 'Read $BOTMUX_GOAL_PATH. Complete it.';
    const framed = options.frameLine!(objective);
    expect(framed.startsWith('::botmux-minimax:')).toBe(true);
    expect(framed).not.toContain('\n');
    expect(framed).not.toContain('\r');
    const decoded = JSON.parse(Buffer.from(framed.slice('::botmux-minimax:'.length), 'base64').toString('utf8'));
    expect(decoded).toEqual({ type: 'message', content: objective });
  });

  it('writeRawCommandLine writes the framed line verbatim and submits with Enter', async () => {
    const sent: string[] = [];
    const keys: string[] = [];
    const backend: RawCommandWriter = {
      sendText: (text) => { sent.push(text); },
      sendSpecialKeys: (...pressed) => { keys.push(...pressed); },
    };
    const frameLine = (content: string) => `frame:${Buffer.from(content).toString('base64')}`;
    const ok = await writeRawCommandLine(backend, '/goal hi', {
      frameLine,
      submitBeatMs: 0,
      delay: async () => {},
    });
    expect(ok).not.toBe(false);
    expect(sent).toEqual([frameLine('/goal hi')]);
    expect(keys).toEqual(['Enter']);
  });
});
