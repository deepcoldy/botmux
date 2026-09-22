import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nodeTsRunnerPrefix, resolveBunExecutable, spawnSyncTsEval } from './helpers/ts-runner.js';
import { shouldQueueInitialPrompt } from '../src/codex-rpc-lifecycle.js';
import { createPiAdapter } from '../src/adapters/cli/pi.js';
import {
  PI_INITIAL_PROMPT_ARG_BYTE_LIMIT,
  preparePiInitialPromptArg,
} from '../src/adapters/cli/pi-initial-prompt.js';
import {
  PI_INITIAL_PROMPT_COMMAND,
  PI_INITIAL_PROMPT_COMMAND_NAME,
  PI_INITIAL_PROMPT_FILE_ENV,
} from '../src/adapters/cli/pi-initial-prompt-extension.js';
import { PI_INITIAL_PROMPT_EXTENSION_SOURCE } from '../src/adapters/cli/pi-initial-prompt-extension-data.js';
import { EXTENSION_DATA_MODULE, EXTENSION_SOURCE_PATH, renderDataModule } from '../scripts/generate-pi-initial-prompt-extension.mjs';

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

  it('writes short multiline prompts to @file so Herdr can forward control-free argv on resume', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-pi-prompt-'));
    try {
      const prompt = '<user_message>\nresume message\n</user_message>';
      const result = preparePiInitialPromptArg({
        prompt,
        sessionId: 'sess-resume',
        sessionDataDir: dataDir,
      });

      expect(result.initialPromptArg).toBe(`@${result.filePath}`);
      expect(readFileSync(result.filePath!, 'utf-8')).toBe(prompt);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
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
        join(result.readonlyRoot!, 'pi-initial-prompt-extension.mjs'),
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
      expect(adapterPrepared.cleanupPaths).toEqual([
        join(adapterPrepared.readonlyRoots![0], 'initial.prompt.md'),
        join(adapterPrepared.readonlyRoots![0], 'pi-initial-prompt-extension.mjs'),
      ]);
      expect(adapterPrepared.cleanupDirs).toEqual(adapterPrepared.readonlyRoots);
      expect(adapterPrepared.deferredInput?.content).toBe(PI_INITIAL_PROMPT_COMMAND);

      const args = createPiAdapter('pi').buildArgs({
        sessionId: 'sess-long-adapter',
        initialPrompt: adapterPrepared.initialPrompt,
        nativeSessionTitle: '[BotMux·Lark] Long Pi prompt',
      });
      // The turn-boundary extension leads every Pi launch line (asserted in
      // `pi buildArgs`); the @file prompt still lands last.
      expect(args[0]).toBe('--extension');
      expect(args.slice(2)).toEqual([
        '--session-id', 'sess-long-adapter',
        '--name', '[BotMux·Lark] Long Pi prompt',
        adapterPrepared.initialPrompt,
      ]);

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
  it('loads and delivers from a minified standalone binary in a separate process', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux pi compiled-'));
    try {
      const entry = join(dataDir, 'entry.ts');
      const binary = join(dataDir, 'prepare-prompt');
      const modulePath = fileURLToPath(new URL('../src/adapters/cli/pi-initial-prompt.ts', import.meta.url));
      writeFileSync(entry, `
        import { preparePiInitialPromptArg } from ${JSON.stringify(modulePath)};
        console.log(JSON.stringify(preparePiInitialPromptArg({
          prompt: 'hello\\n完整首条消息', sessionId: 'compiled', sessionDataDir: process.argv[2],
        })));
      `);
      const build = spawnSync(resolveBunExecutable()!, [
        'build', '--compile', '--minify', entry, '--outfile', binary,
      ], { encoding: 'utf8' });
      expect(build.status, build.stderr).toBe(0);
      const run = spawnSync(binary, [dataDir], { cwd: dataDir, encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      const prepared = JSON.parse(run.stdout);
      const extensionPath = prepared.deferredInput.additionalArgs[1];
      const child = spawnSyncTsEval(`
        const { default: register } = await import(${JSON.stringify(pathToFileURL(extensionPath).href)});
        let handler;
        const sent = [];
        register({
          registerCommand(name, command) {
            if (name !== 'botmux-initial-prompt') throw new Error('wrong command');
            handler = command.handler;
          },
          sendUserMessage(content, options) { sent.push({ content, options }); },
        });
        await handler('', { isIdle: () => false, ui: { notify: () => {} } });
        if (process.env.BOTMUX_PI_INITIAL_PROMPT_FILE) throw new Error('not consumed');
        await handler('', { isIdle: () => true, ui: { notify: () => {} } });
        console.log(JSON.stringify(sent));
      `, { cwd: dataDir, encoding: 'utf8', env: { ...process.env, ...prepared.deferredInput.env } });
      expect(child.status, String(child.stderr)).toBe(0);
      expect(JSON.parse(String(child.stdout))).toEqual([
        { content: 'hello\n完整首条消息', options: { deliverAs: 'followUp' } },
      ]);
      expect(dirname(extensionPath)).toBe(prepared.readonlyRoot);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('loads the worker-selected file and submits it as one native user message', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-pi-extension-'));
    const filePath = join(dataDir, 'initial.prompt.md');
    const prompt = longBotmuxPrompt();
    writeFileSync(filePath, prompt);
    const previous = process.env[PI_INITIAL_PROMPT_FILE_ENV];
    process.env[PI_INITIAL_PROMPT_FILE_ENV] = filePath;
    try {
      const extensionPath = join(dataDir, 'extension.mjs');
      writeFileSync(extensionPath, PI_INITIAL_PROMPT_EXTENSION_SOURCE);
      const { default: registerBotmuxInitialPromptExtension } = await import(pathToFileURL(extensionPath).href);
      let commandName: string | undefined;
      let handler: ((args: string, ctx: any) => Promise<void> | void) | undefined;
      const sent: Array<{ content: string; options?: { deliverAs: 'followUp' } }> = [];
      registerBotmuxInitialPromptExtension({
        registerCommand(name: string, options: { handler: NonNullable<typeof handler> }) {
          commandName = name;
          handler = options.handler;
        },
        sendUserMessage(content: string, options?: { deliverAs: 'followUp' }) {
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

describe('Pi extension source embedding', () => {
  it('committed constant matches the true source bytes (no drift)', () => {
    expect(readFileSync(EXTENSION_DATA_MODULE, 'utf8')).toBe(renderDataModule());
    expect(PI_INITIAL_PROMPT_EXTENSION_SOURCE).toBe(readFileSync(EXTENSION_SOURCE_PATH, 'utf8'));
    // 真源里硬编码的字面量必须与 .ts 导出常量同步（裸子串断言，不依赖引号风格）。
    expect(PI_INITIAL_PROMPT_EXTENSION_SOURCE).toContain(PI_INITIAL_PROMPT_COMMAND_NAME);
    expect(PI_INITIAL_PROMPT_EXTENSION_SOURCE).toContain(PI_INITIAL_PROMPT_FILE_ENV);
  });

  it('embedded source references no transpiler helper identifiers', () => {
    // 先剥注释再扫描：注释里的「提及」不是引用（干净真源也会因此误报）。
    // 行尾规则要求 // 前有空白，避免吞掉字符串里的形如 https:// 的内容。
    const code = PI_INITIAL_PROMPT_EXTENSION_SOURCE
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^[ \t]*\/\/.*$/gm, ' ')
      .replace(/[ \t]\/\/.*$/gm, ' ');
    // 真源合法地不含任何双下划线标识符，一条正则覆盖全部转译器 helper 族
    // （枚举追不完 tsc/esbuild/bun 各自的降级与装饰器注入名）。
    expect(/\b__\w+\b/.test('__name(f)')).toBe(true);
    expect(code).not.toMatch(/\b__\w+\b/);
  });

  it('tsx-generated extension executes in a transpiler-less runtime (factory call included)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-pi-tsx-gen-'));
    try {
      // 生成端固定走 Node+tsx（即 bun run daemon 的源码直跑形态），补齐编译产物
      // 用例覆盖不到的文本形态；父进程是 bun 时 nodeTsRunnerPrefix 同样强制 Node+tsx。
      const entry = join(dataDir, 'gen-entry.mjs');
      const modulePath = fileURLToPath(new URL('../src/adapters/cli/pi-initial-prompt.ts', import.meta.url));
      writeFileSync(entry, `
        import { preparePiInitialPromptArg } from ${JSON.stringify(modulePath)};
        console.log(JSON.stringify(preparePiInitialPromptArg({
          prompt: 'tsx 生成端\\n完整首条消息', sessionId: 'tsx-generated', sessionDataDir: process.argv[2],
        })));
      `);
      const { command, prefixArgs } = nodeTsRunnerPrefix();
      const gen = spawnSync(command, [...prefixArgs, entry, dataDir], {
        cwd: resolve(fileURLToPath(new URL('..', import.meta.url))),
        encoding: 'utf8',
      });
      expect(gen.status, gen.stderr).toBe(0);
      const prepared = JSON.parse(gen.stdout);
      const extensionPath = prepared.deferredInput.additionalArgs[1];

      // 加载端不带任何转译器。register 的实参对象在 factory 调用时才求值：
      // 仅 import() 对坏产物不抛错，必须真正调用 default factory 才有判别力。
      const load = (isIdle: boolean, secondCall = false) => spawnSyncTsEval(`
        const { default: register } = await import(${JSON.stringify(pathToFileURL(extensionPath).href)});
        let handler; const sent = []; const notes = [];
        register({
          registerCommand(name, cmd) {
            if (name !== 'botmux-initial-prompt') throw new Error('wrong command');
            handler = cmd.handler;
          },
          sendUserMessage(content, options) { sent.push({ content, options }); },
        });
        await handler('', { isIdle: () => ${isIdle}, ui: { notify: (m) => notes.push(m) } });
        if (process.env.BOTMUX_PI_INITIAL_PROMPT_FILE) throw new Error('not consumed');
        ${secondCall ? `
        await handler('', { isIdle: () => true, ui: { notify: (m) => notes.push(m) } });
        if (sent.length !== 1) throw new Error('second call must not deliver');` : ''}
        console.log(JSON.stringify({ sent, notes }));
      `, { cwd: dataDir, encoding: 'utf8', env: { ...process.env, ...prepared.deferredInput.env } });

      const busy = load(false);
      expect(busy.status, String(busy.stderr)).toBe(0);
      expect(JSON.parse(String(busy.stdout))).toEqual({
        sent: [{ content: 'tsx 生成端\n完整首条消息', options: { deliverAs: 'followUp' } }],
        notes: [],
      });

      // 直投分支 + 一次性消费后的早退分支（env 已删，只能 notify 不再投递）。
      const idle = load(true, true);
      expect(idle.status, String(idle.stderr)).toBe(0);
      expect(JSON.parse(String(idle.stdout))).toEqual({
        sent: [{ content: 'tsx 生成端\n完整首条消息', options: undefined }],
        notes: ['Botmux initial prompt is no longer available.'],
      });

      // 正对照：喂一个引用自由 __name 的坏扩展——加载端必须让它失败，
      // 否则说明加载端混入了转译器、本守卫已失明。
      const badPath = join(dataDir, 'bad-extension.mjs');
      writeFileSync(badPath, `export default (pi) => pi.registerCommand('botmux-initial-prompt', { handler: __name(async () => {}) });\n`);
      const bad = spawnSyncTsEval(`
        const { default: register } = await import(${JSON.stringify(pathToFileURL(badPath).href)});
        register({ registerCommand() {}, sendUserMessage() {} });
      `, { cwd: dataDir, encoding: 'utf8' });
      expect(bad.status, String(bad.stderr)).not.toBe(0);
      expect(String(bad.stderr)).toContain('__name');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
