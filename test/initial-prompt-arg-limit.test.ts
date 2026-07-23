import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPiAdapter } from '../src/adapters/cli/pi.js';
import { shouldQueueInitialPrompt } from '../src/codex-rpc-lifecycle.js';
import {
  resolveInitialPromptDelivery,
  shouldDeferInitialPromptForArgLimit,
} from '../src/utils/pending-input-queue.js';
import { PI_INITIAL_PROMPT_COMMAND } from '../src/adapters/cli/pi-initial-prompt-extension.js';

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

  it('routes long Pi first prompts through @file argv instead of the worker queue', () => {
    const adapter = createPiAdapter('/bin/pi');
    const prompt = '长卡片'.repeat(2500); // > 10KB UTF-8, above Pi's old tmux-safe argv budget.
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-pi-limit-'));
    try {
      const prepared = adapter.prepareInitialPromptArg!({
        initialPrompt: prompt,
        sessionId: 'sess-pi-long',
        sessionDataDir: dataDir,
      });
      const deferInitialPrompt = shouldDeferInitialPromptForArgLimit({
        passesInitialPromptViaArgs: adapter.passesInitialPromptViaArgs === true,
        prompt: prepared.initialPrompt,
        maxInitialPromptArgBytes: adapter.maxInitialPromptArgBytes,
      });
      const args = adapter.buildArgs({
        sessionId: 'sess-pi-long',
        resume: false,
        initialPrompt: deferInitialPrompt ? undefined : prepared.initialPrompt,
      });
      const shouldQueue = shouldQueueInitialPrompt({
        hasPrompt: true,
        rpcEngineActive: false,
        queuePrompt: false,
        passesInitialPromptViaArgs: adapter.passesInitialPromptViaArgs === true,
        deferInitialPrompt,
      });

      expect(adapter.maxInitialPromptArgBytes).toBeUndefined();
      expect(Buffer.byteLength(prompt, 'utf8')).toBeGreaterThan(10_000);
      expect(prepared.initialPrompt).toMatch(/^@.+\.prompt\.md$/);
      expect(readFileSync(prepared.cleanupPaths![0]!, 'utf-8')).toBe(prompt);
      expect(deferInitialPrompt).toBe(false);
      expect(args).toEqual(['--session-id', 'sess-pi-long', prepared.initialPrompt]);
      expect(args).not.toContain(prompt);
      expect(shouldQueue).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('uses Pi native message delivery instead of TUI-pasting a transformed long prompt when deferred', () => {
    const original = 'x'.repeat(10_000);
    const preparedArg = '@/data/pi-initial-prompts/session/initial.prompt.md';
    expect(resolveInitialPromptDelivery({
      originalPrompt: original,
      preparedArg,
      preparedDeferredContent: PI_INITIAL_PROMPT_COMMAND,
      defer: true,
    })).toEqual({
      queuedContent: PI_INITIAL_PROMPT_COMMAND,
      logicalContent: original,
    });
  });

  it('preserves legacy argv and deferred queue behavior without an adapter command', () => {
    expect(resolveInitialPromptDelivery({
      originalPrompt: 'hello',
      preparedArg: 'prepared',
      defer: false,
    })).toEqual({ argvPrompt: 'prepared' });
    expect(resolveInitialPromptDelivery({
      originalPrompt: 'hello',
      preparedArg: 'prepared',
      defer: true,
    })).toEqual({ queuedContent: 'hello' });
  });
});
