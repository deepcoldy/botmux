import { describe, expect, it, vi } from 'vitest';
import { createPiAdapter } from '../src/adapters/cli/pi.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';
import { shouldQueueInitialPrompt } from '../src/codex-rpc-lifecycle.js';
import { shouldDeferInitialPromptForArgLimit } from '../src/utils/pending-input-queue.js';

process.env.BOTMUX_TIME_SCALE ??= '0.01';

describe('initial prompt argv byte-limit fallback', () => {
  it('does not defer when the adapter does not pass initial prompts via args', () => {
    expect(shouldDeferInitialPromptForArgLimit({
      passesInitialPromptViaArgs: false,
      prompt: 'x'.repeat(10_000),
      maxInitialPromptArgBytes: 4096,
    })).toBe(false);
  });

  it('keeps short Pi first prompts on argv for legacy startup behavior', () => {
    const adapter = createPiAdapter('/bin/pi');
    const prompt = 'short prompt';

    const deferInitialPrompt = shouldDeferInitialPromptForArgLimit({
      passesInitialPromptViaArgs: adapter.passesInitialPromptViaArgs === true,
      prompt,
      maxInitialPromptArgBytes: adapter.maxInitialPromptArgBytes,
    });
    const args = adapter.buildArgs({
      sessionId: 'sess-pi',
      resume: false,
      initialPrompt: deferInitialPrompt ? undefined : prompt,
    });

    expect(deferInitialPrompt).toBe(false);
    expect(args.at(-1)).toBe(prompt);
    expect(shouldQueueInitialPrompt({
      hasPrompt: true,
      rpcEngineActive: false,
      queuePrompt: false,
      passesInitialPromptViaArgs: adapter.passesInitialPromptViaArgs === true,
      deferInitialPrompt,
    })).toBe(false);
  });

  it('routes over-limit Pi first prompts out of spawn args and into the worker queue exactly once', async () => {
    const adapter = createPiAdapter('/bin/pi');
    const prompt = '长卡片'.repeat(2500); // > 10KB UTF-8, above Pi's tmux-safe argv budget.

    const deferInitialPrompt = shouldDeferInitialPromptForArgLimit({
      passesInitialPromptViaArgs: adapter.passesInitialPromptViaArgs === true,
      prompt,
      maxInitialPromptArgBytes: adapter.maxInitialPromptArgBytes,
    });
    const args = adapter.buildArgs({
      sessionId: 'sess-pi-long',
      resume: false,
      initialPrompt: deferInitialPrompt ? undefined : prompt,
    });
    const shouldQueue = shouldQueueInitialPrompt({
      hasPrompt: true,
      rpcEngineActive: false,
      queuePrompt: false,
      passesInitialPromptViaArgs: adapter.passesInitialPromptViaArgs === true,
      deferInitialPrompt,
    });

    expect(adapter.maxInitialPromptArgBytes).toBe(4096);
    expect(Buffer.byteLength(prompt, 'utf8')).toBeGreaterThan(10_000);
    expect(deferInitialPrompt).toBe(true);
    expect(args).toEqual(['--session-id', 'sess-pi-long']);
    expect(args).not.toContain(prompt);
    expect(shouldQueue).toBe(true);

    const pty = {
      write: vi.fn(),
      pasteText: vi.fn(),
      sendSpecialKeys: vi.fn(),
    } satisfies PtyHandle;
    if (shouldQueue) await adapter.writeInput(pty, prompt);

    expect(pty.pasteText).toHaveBeenCalledTimes(1);
    expect(pty.pasteText).toHaveBeenCalledWith(prompt);
    expect(pty.sendSpecialKeys).toHaveBeenCalledTimes(1);
    expect(pty.sendSpecialKeys).toHaveBeenCalledWith('Enter');
  });
});
