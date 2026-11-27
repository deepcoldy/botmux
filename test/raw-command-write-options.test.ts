import { describe, expect, it } from 'vitest';
import { createCocoAdapter } from '../src/adapters/cli/coco.js';
import { createOpenCodeAdapter } from '../src/adapters/cli/opencode.js';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { createMinimaxAdapter } from '../src/adapters/cli/minimax.js';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { rawCommandWriteOptionsFor } from '../src/core/raw-command-write-options.js';

describe('raw command write options', () => {
  it.each([
    { name: 'a single-line title', command: '/rename 项目 A', framed: true },
    { name: 'another command', command: '/help 项目 A', framed: false },
    { name: 'an empty title', command: '/rename ', framed: false },
    { name: 'a multiline title', command: '/rename first\nsecond', framed: false },
    { name: 'an escape character', command: '/rename first\x1bsecond', framed: false },
    { name: 'a C1 control character', command: '/rename first\u0085second', framed: false },
  ])('selects the TraeX input mode for $name', ({ command, framed }) => {
    const adapter = createTraexAdapter('/bin/traex');
    const options = rawCommandWriteOptionsFor(adapter, 'traex', command);

    expect(Boolean(options.bracketedPaste)).toBe(framed);
  });

  it.each([undefined, '/rename 项目 A'])('uses OpenCode paste-line delivery for %s', command => {
    const adapter = createOpenCodeAdapter('/bin/opencode');

    const options = rawCommandWriteOptionsFor(adapter, 'opencode', command);

    expect(options.bracketedPaste).toBeFalsy();
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

describe('framed stdin runners route raw passthrough through writeInput', () => {
  it('minimax declares runnerFramedInput and frames a raw objective exactly like a turn', async () => {
    const adapter = createMinimaxAdapter('/bin/true');
    expect(adapter.runnerFramedInput).toBe(true);

    const sent: string[] = [];
    const keys: string[] = [];
    const pty = {
      write: (data: string) => sent.push(data),
      sendText: (text: string) => { sent.push(text); },
      sendSpecialKeys: (...pressed: string[]) => { keys.push(...pressed); },
    };
    const objective = 'Read $BOTMUX_GOAL_PATH. Write files and manifest. Complete it.';
    await adapter.writeInput(pty as never, objective);

    // One framed line (::botmux-minimax:<base64>); the runner protocol sends a
    // pre-flush Enter (idempotent on an empty buffer) plus the submit Enter.
    expect(keys).toEqual(['Enter', 'Enter']);
    const line = sent.join('');
    expect(sent.filter((s) => s.startsWith('::botmux-minimax:'))).toHaveLength(1);
    expect(line.startsWith('::botmux-minimax:')).toBe(true);
    const decoded = JSON.parse(Buffer.from(line.slice('::botmux-minimax:'.length), 'base64').toString('utf8'));
    expect(decoded).toEqual({ type: 'message', content: objective });
  });

  it('generic adapters do not opt into framed raw routing', () => {
    expect(createClaudeCodeAdapter('/bin/claude').runnerFramedInput).toBeUndefined();
    expect(createOpenCodeAdapter('/bin/opencode').runnerFramedInput).toBeUndefined();
  });
});
