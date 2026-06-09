import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

import { delay } from '../../utils/timing.js';

export function createOpenCodeAdapter(pathOverride?: string): CliAdapter {
  // resolvedBin is lazy: setup constructs adapters only to read static
  // modelChoices and must not shell out (see resolveCommand); the binary path
  // is a spawn-time concern.
  const rawBin = pathOverride ?? 'opencode';
  let cachedBin: string | undefined;
  return {
    id: 'opencode',
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ initialPrompt, model }) {
      // OpenCode manages sessions internally (SQLite store).
      // Resume not supported — always start fresh.  --continue exits
      // immediately (code 0) when there is no prior session, causing a
      // crash-loop in the daemon auto-restart path.
      const args: string[] = [];
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      // Use --prompt for the initial prompt.  OpenCode's Bubble Tea TUI
      // has an async startup phase; writing to stdin during this window
      // may be lost.  --prompt injects it once the TUI is ready.
      if (initialPrompt) {
        args.push('--prompt', initialPrompt);
      }
      return args;
    },

    passesInitialPromptViaArgs: true,

    async writeInput(pty: PtyHandle, content: string) {
      if (pty.sendText && pty.sendSpecialKeys) {
        pty.sendText(content);
        await delay(200);
        pty.sendSpecialKeys('Enter');
      } else {
        pty.write(content);
        await delay(1000);
        pty.write('\r');
      }
    },

    completionPattern: undefined,   // quiescence only — no explicit completion marker
    readyPattern: undefined,        // Bubble Tea TUI — no reliable prompt indicator; rely on quiescence + spinner guard
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,                // Bubble Tea renders in alternate screen buffer
    skillsDir: '~/.config/opencode/skills',
    // botmux hook 安装：spawn 时写入 OpenCode 插件文件，
    // 使 question.asked 事件自动转发到 `botmux hook opencode`。
    hookInstall: {
      configPath: '~/.config/opencode/plugin/botmux-ask.js',
      format: 'opencode-plugin',
    },
    asksViaHook: true,
    // OpenCode model 通常 provider/name 形式（anthropic/claude-sonnet-4、openai/gpt-5），
    // 自由度高，候选只做引导，setup 时选 Other 自定义最常见。
    modelChoices: [
      'anthropic/claude-sonnet-4',
      'anthropic/claude-opus-4',
      'openai/gpt-5',
      'google/gemini-2.5-pro',
    ],
  };
}

export const create = createOpenCodeAdapter;
