import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shouldQueueInitialPrompt } from '../src/codex-rpc-lifecycle.js';
import { createPiAdapter } from '../src/adapters/cli/pi.js';
import {
  PI_INITIAL_PROMPT_ARG_BYTE_LIMIT,
  preparePiInitialPromptArg,
} from '../src/adapters/cli/pi-initial-prompt.js';
import registerBotmuxInitialPromptExtension, {
  PI_INITIAL_PROMPT_COMMAND,
  PI_INITIAL_PROMPT_COMMAND_NAME,
  PI_INITIAL_PROMPT_FILE_ENV,
} from '../src/adapters/cli/pi-initial-prompt-extension.js';

function longBotmuxPrompt(): string {
  return [
    '<botmux_routing>',
    '- botmux-goal-ask: ask the user before choosing a goal',
    '- botmux-orchestrate: coordinate bounded multi-step work',
    '- botmux-ask: ask for approval through cards',
    '</botmux_routing>',
    '<botmux_builtin_skills>',
    '- botmux-goal-ask: ...',
    '- botmux-orchestrate: ...',
    '- botmux-ask: ...',
    '</botmux_builtin_skills>',
    '<identity>',
    '  <name>DW Agent (Pi)</name>',
    '  <routing_rules>hidden launch rules</routing_rules>',
    '</identity>',
    '<user_message>',
    '请修复 Pi 长首轮 prompt 被拆成多轮 user message 的问题。',
    '</user_message>',
    'x'.repeat(PI_INITIAL_PROMPT_ARG_BYTE_LIMIT + 1),
  ].join('\n');
}

describe('Pi initial prompt @file delivery', () => {
  it('keeps short first prompts as the positional message', () => {
    const result = preparePiInitialPromptArg({
      prompt: '<user_message>hello Pi</user_message>',
      sessionId: 'sess-short',
      sessionDataDir: '/tmp/botmux-data',
    });

    expect(result.initialPromptArg).toBe('<user_message>hello Pi</user_message>');
    expect(result.filePath).toBeUndefined();
    expect(result.readonlyRoot).toBeUndefined();
  });

  it('writes long first prompts to a session-lifetime UTF-8 file and passes @file', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-pi-prompt-'));
    try {
      const prompt = longBotmuxPrompt();
      const result = preparePiInitialPromptArg({
        prompt,
        sessionId: 'sess-long',
        sessionDataDir: dataDir,
      });

      expect(result.initialPromptArg).toBe(`@${result.filePath}`);
      expect(result.filePath).toMatch(/pi-initial-prompts\/sess-long\/initial\.prompt\.md$/);
      expect(result.readonlyRoot).toBe(dirname(result.filePath!));
      expect(result.cleanupDir).toBe(result.readonlyRoot);
      expect(readFileSync(result.filePath!, 'utf-8')).toBe(prompt);
      expect(result.initialPromptArg).toContain('@');
      expect(result.deferredInput?.content).toBe(PI_INITIAL_PROMPT_COMMAND);
      expect(result.deferredInput?.additionalArgs).toEqual([
        '--extension',
        expect.stringMatching(/pi-initial-prompt-extension\.(?:js|ts)$/),
      ]);
      expect(result.deferredInput?.env).toEqual({
        [PI_INITIAL_PROMPT_FILE_ENV]: result.filePath,
      });

      const adapterPrepared = createPiAdapter('pi').prepareInitialPromptArg!({
        initialPrompt: prompt,
        sessionId: 'sess-long-adapter',
        sessionDataDir: dataDir,
      });
      expect(adapterPrepared.initialPrompt).toMatch(/^@.+\.prompt\.md$/);
      expect(adapterPrepared.readonlyRoots).toEqual([dirname(adapterPrepared.cleanupPaths![0]!)]);
      expect(adapterPrepared.cleanupPaths).toHaveLength(1);
      expect(adapterPrepared.cleanupDirs).toEqual(adapterPrepared.readonlyRoots);
      expect(adapterPrepared.deferredInput?.content).toBe(PI_INITIAL_PROMPT_COMMAND);

      const args = createPiAdapter('pi').buildArgs({
        sessionId: 'sess-long-adapter',
        initialPrompt: adapterPrepared.initialPrompt,
      });
      expect(args).toEqual(['--session-id', 'sess-long-adapter', adapterPrepared.initialPrompt]);

      expect(Buffer.byteLength(prompt, 'utf8')).toBeGreaterThan(PI_INITIAL_PROMPT_ARG_BYTE_LIMIT);
      expect(Buffer.byteLength(adapterPrepared.initialPrompt, 'utf8')).toBeLessThan(prompt.length);

      // Worker wiring must treat the prepared @file path as args-baked input, so
      // the first turn is not queued for writeInput/TUI paste fallback after spawn.
      expect(shouldQueueInitialPrompt({
        hasPrompt: true,
        rpcEngineActive: false,
        queuePrompt: false,
        passesInitialPromptViaArgs: true,
        deferInitialPrompt: false,
      })).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('uses a distinct readonly directory for every session', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-pi-isolation-'));
    try {
      const first = preparePiInitialPromptArg({
        prompt: longBotmuxPrompt(),
        sessionId: 'session-a',
        sessionDataDir: dataDir,
      });
      const second = preparePiInitialPromptArg({
        prompt: longBotmuxPrompt(),
        sessionId: 'session-b',
        sessionDataDir: dataDir,
      });

      expect(first.readonlyRoot).not.toBe(second.readonlyRoot);
      expect(relative(first.readonlyRoot!, second.filePath!).startsWith('..')).toBe(true);
      expect(relative(second.readonlyRoot!, first.filePath!).startsWith('..')).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('fails closed when a long prompt has no session data directory for the prompt file', () => {
    expect(() => preparePiInitialPromptArg({
      prompt: longBotmuxPrompt(),
      sessionId: 'sess-no-dir',
    })).toThrow(/SESSION_DATA_DIR/);
  });
});

describe('Pi deferred initial prompt extension', () => {
  it('loads the worker-selected file and submits it as one native user message', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-pi-extension-'));
    const filePath = join(dataDir, 'initial.prompt.md');
    const prompt = longBotmuxPrompt();
    writeFileSync(filePath, prompt);
    const previous = process.env[PI_INITIAL_PROMPT_FILE_ENV];
    process.env[PI_INITIAL_PROMPT_FILE_ENV] = filePath;
    try {
      let commandName: string | undefined;
      let handler: ((args: string, ctx: any) => Promise<void> | void) | undefined;
      const sent: Array<{ content: string; options?: { deliverAs: 'followUp' } }> = [];
      registerBotmuxInitialPromptExtension({
        registerCommand(name, options) {
          commandName = name;
          handler = options.handler;
        },
        sendUserMessage(content, options) {
          sent.push({ content, options });
        },
      });

      expect(commandName).toBe(PI_INITIAL_PROMPT_COMMAND_NAME);
      await handler!('', {
        isIdle: () => true,
        ui: { notify: () => undefined },
      });

      expect(sent).toEqual([{ content: prompt, options: undefined }]);
      expect(process.env[PI_INITIAL_PROMPT_FILE_ENV]).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env[PI_INITIAL_PROMPT_FILE_ENV];
      else process.env[PI_INITIAL_PROMPT_FILE_ENV] = previous;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
