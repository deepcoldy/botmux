import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPiAdapter } from '../src/adapters/cli/pi.js';
import { createGrokAdapter } from '../src/adapters/cli/grok.js';
import { createRiffAdapter } from '../src/adapters/cli/riff.js';
import { createGeminiAdapter } from '../src/adapters/cli/gemini.js';
import { createOpenCodeAdapter } from '../src/adapters/cli/opencode.js';
import { shouldQueueInitialPrompt } from '../src/codex-rpc-lifecycle.js';
import {
  resolveInitialPromptDelivery,
  shouldArmSpawnArgvInitialPromptBusy,
  shouldTrackArgvBakedFirstPrompt,
  shouldDeferInitialPromptForArgLimit,
} from '../src/utils/pending-input-queue.js';
import { PI_INITIAL_PROMPT_COMMAND } from '../src/adapters/cli/pi-initial-prompt-extension.js';

process.env.BOTMUX_TIME_SCALE ??= '0.01';

describe('shouldArmSpawnArgvInitialPromptBusy (PR #633 CR)', () => {
  it('arms only for Grok-class argv + SessionStart + reliable terminal', () => {
    const grok = createGrokAdapter('/bin/grok');
    expect(shouldArmSpawnArgvInitialPromptBusy({
      passesInitialPromptViaArgs: grok.passesInitialPromptViaArgs === true,
      preparedInitialPrompt: 'review this MR',
      queuedInitialPrompt: undefined,
      injectsReadyHook: grok.injectsReadyHook === true,
      reliableTurnTerminal: grok.reliableTurnTerminal === true,
    })).toBe(true);
  });

  it('does not arm for Riff (prompt is queue-after-spawn, not argv)', () => {
    const riff = createRiffAdapter();
    // Reviewer regression: preparedInitialPrompt non-empty alone must NOT arm —
    // Riff ignores prompt in buildArgs and queues after spawnCli returns.
    expect(riff.passesInitialPromptViaArgs).toBeFalsy();
    expect(shouldArmSpawnArgvInitialPromptBusy({
      passesInitialPromptViaArgs: riff.passesInitialPromptViaArgs === true,
      preparedInitialPrompt: 'hello from feishu',
      queuedInitialPrompt: undefined,
      injectsReadyHook: riff.injectsReadyHook === true,
      reliableTurnTerminal: riff.reliableTurnTerminal === true,
    })).toBe(false);
  });

  it('does not arm for quiescence-only argv adapters (Pi / Gemini) but still tracks argv seed', () => {
    for (const adapter of [createPiAdapter('/bin/pi'), createGeminiAdapter('/bin/gemini')]) {
      expect(adapter.passesInitialPromptViaArgs).toBe(true);
      expect(adapter.injectsReadyHook).toBeFalsy();
      const base = {
        passesInitialPromptViaArgs: adapter.passesInitialPromptViaArgs === true,
        preparedInitialPrompt: 'do something',
        queuedInitialPrompt: undefined as string | undefined,
      };
      // Track seed so markPromptReady can publish working→idle for card-off.
      expect(shouldTrackArgvBakedFirstPrompt(base)).toBe(true);
      // Must NOT hold busy across first ready (first ready IS turn end).
      expect(shouldArmSpawnArgvInitialPromptBusy({
        ...base,
        injectsReadyHook: adapter.injectsReadyHook === true,
        reliableTurnTerminal: adapter.reliableTurnTerminal === true,
      })).toBe(false);
    }
  });

  it('does not arm when the first prompt was deferred to the write queue', () => {
    expect(shouldArmSpawnArgvInitialPromptBusy({
      passesInitialPromptViaArgs: true,
      preparedInitialPrompt: 'argv-form',
      queuedInitialPrompt: 'queued command',
      injectsReadyHook: true,
      reliableTurnTerminal: true,
    })).toBe(false);
  });

  it('Riff post-spawn queue path: shouldQueueInitialPrompt is true when prompt exists', () => {
    // Behavioral pin: riff does not bake prompt into argv, so the worker must
    // queue + flush once after spawn (isPromptReady stays true for that flush).
    const riff = createRiffAdapter();
    expect(shouldQueueInitialPrompt({
      hasPrompt: true,
      rpcEngineActive: false,
      queuePrompt: false,
      passesInitialPromptViaArgs: riff.passesInitialPromptViaArgs === true,
      deferInitialPrompt: false,
    })).toBe(true);
  });
});

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
      // The turn-boundary extension leads every Pi launch line (see
      // `pi buildArgs` in cli-adapters.test.ts); this case is about the @file
      // prompt, so assert the rest exactly.
      expect(args.slice(0, 1)).toEqual(['--extension']);
      expect(args.slice(2)).toEqual(['--session-id', 'sess-pi-long', prepared.initialPrompt]);
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

describe('OpenCode v1 initial-prompt argv byte-limit (tmux command-too-long)', () => {
  const adapter = createOpenCodeAdapter('/usr/bin/opencode');

  it('declares a conservative maxInitialPromptArgBytes budget', () => {
    expect(adapter.passesInitialPromptViaArgs).toBe(true);
    expect(adapter.maxInitialPromptArgBytes).toBe(4096);
  });

  it('keeps short first prompts on --prompt argv (cold-start reliability)', () => {
    const prompt = '请帮我审查这个 PR';
    const defer = shouldDeferInitialPromptForArgLimit({
      passesInitialPromptViaArgs: adapter.passesInitialPromptViaArgs === true,
      prompt,
      maxInitialPromptArgBytes: adapter.maxInitialPromptArgBytes,
    });
    expect(defer).toBe(false);

    const args = adapter.buildArgs({
      sessionId: 'sess-oc-short',
      resume: false,
      initialPrompt: defer ? undefined : prompt,
    });
    const idx = args.indexOf('--prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(prompt);
    expect(args).toContain(prompt);

    // Short prompt → not queued, stays on argv.
    expect(shouldQueueInitialPrompt({
      hasPrompt: true,
      rpcEngineActive: false,
      queuePrompt: false,
      passesInitialPromptViaArgs: adapter.passesInitialPromptViaArgs === true,
      deferInitialPrompt: defer,
    })).toBe(false);
  });

  it('routes long Chinese/multi-line routing prompts to the post-start queue, not argv', () => {
    // Simulates a long routing/role/user prompt that would blow tmux's
    // command-string limit (~12–16 KB on Linux + tmux 3.3a).
    const prompt = '你是一个资深的代码审查专家。\n'.repeat(500); // ~20 KB UTF-8
    expect(Buffer.byteLength(prompt, 'utf8')).toBeGreaterThan(4096);

    const defer = shouldDeferInitialPromptForArgLimit({
      passesInitialPromptViaArgs: adapter.passesInitialPromptViaArgs === true,
      prompt,
      maxInitialPromptArgBytes: adapter.maxInitialPromptArgBytes,
    });
    expect(defer).toBe(true);

    // When deferred, the worker passes undefined to buildArgs so --prompt
    // is never added → the long text does NOT appear in tmux new-session argv.
    const args = adapter.buildArgs({
      sessionId: 'sess-oc-long',
      resume: false,
      initialPrompt: defer ? undefined : prompt,
    });
    expect(args).not.toContain('--prompt');
    expect(args).not.toContain(prompt);

    // Deferred → worker queues the prompt for post-start delivery.
    expect(shouldQueueInitialPrompt({
      hasPrompt: true,
      rpcEngineActive: false,
      queuePrompt: false,
      passesInitialPromptViaArgs: adapter.passesInitialPromptViaArgs === true,
      deferInitialPrompt: defer,
    })).toBe(true);
  });

  it('resume path defers via initialPromptArgsIgnoredOnResume regardless of prompt length', () => {
    // On resume, OpenCode silently ignores --prompt with -s <id>. The worker
    // routes the initial prompt through the input queue via
    // initialPromptArgsIgnoredOnResume — this is independent of the
    // maxInitialPromptArgBytes byte limit.
    expect(adapter.initialPromptArgsIgnoredOnResume).toBe(true);

    const shortPrompt = '继续上次的任务';
    const longPrompt = '长'.repeat(6000);

    // Even a short prompt on resume must be deferred (via the resume flag,
    // not the byte limit). The byte-limit check is an additional fresh-only guard.
    const shortDeferByLimit = shouldDeferInitialPromptForArgLimit({
      passesInitialPromptViaArgs: adapter.passesInitialPromptViaArgs === true,
      prompt: shortPrompt,
      maxInitialPromptArgBytes: adapter.maxInitialPromptArgBytes,
    });
    expect(shortDeferByLimit).toBe(false); // short enough for argv

    const longDeferByLimit = shouldDeferInitialPromptForArgLimit({
      passesInitialPromptViaArgs: adapter.passesInitialPromptViaArgs === true,
      prompt: longPrompt,
      maxInitialPromptArgBytes: adapter.maxInitialPromptArgBytes,
    });
    expect(longDeferByLimit).toBe(true); // over-limit even on fresh

    // But buildArgs on resume never receives initialPrompt (worker strips it),
    // so the resume args never include --prompt regardless.
    const resumeArgs = adapter.buildArgs({
      sessionId: 'sess-oc-resume',
      resume: true,
      resumeSessionId: 'ses_abc123',
      initialPrompt: undefined,
    });
    expect(resumeArgs).not.toContain('--prompt');
    expect(resumeArgs).toContain('--session');
  });

  it('prompt exactly at the byte budget stays on argv (boundary is inclusive)', () => {
    // shouldDeferInitialPromptForArgLimit uses strict `>`, so a prompt whose
    // UTF-8 byte length equals the limit keeps legacy --prompt behavior.
    const exactBytes = 4096;
    // ASCII chars are 1 byte each → length === byte length.
    const prompt = 'a'.repeat(exactBytes);
    expect(Buffer.byteLength(prompt, 'utf8')).toBe(exactBytes);

    const defer = shouldDeferInitialPromptForArgLimit({
      passesInitialPromptViaArgs: adapter.passesInitialPromptViaArgs === true,
      prompt,
      maxInitialPromptArgBytes: adapter.maxInitialPromptArgBytes,
    });
    expect(defer).toBe(false);

    const oneMore = 'a'.repeat(exactBytes + 1);
    const deferOver = shouldDeferInitialPromptForArgLimit({
      passesInitialPromptViaArgs: adapter.passesInitialPromptViaArgs === true,
      prompt: oneMore,
      maxInitialPromptArgBytes: adapter.maxInitialPromptArgBytes,
    });
    expect(deferOver).toBe(true);
  });
});
