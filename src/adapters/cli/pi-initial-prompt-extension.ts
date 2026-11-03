export const PI_INITIAL_PROMPT_COMMAND_NAME = 'botmux-initial-prompt';
export const PI_INITIAL_PROMPT_COMMAND = `/${PI_INITIAL_PROMPT_COMMAND_NAME}`;
export const PI_INITIAL_PROMPT_FILE_ENV = 'BOTMUX_PI_INITIAL_PROMPT_FILE';

/**
 * Pi expands @file only for launch argv, not for text entered into its TUI.
 * Deferred first prompts therefore use this short, one-shot command: the
 * extension reads the worker-selected file (never a user-supplied path) and
 * submits its full contents through Pi's native user-message API as one turn.
 *
 * 可加载的扩展本体是纯 JS 真源 pi-initial-prompt-extension.mjs，构建期被
 * scripts/generate-pi-initial-prompt-extension.mjs 原样嵌入字符串常量
 * PI_INITIAL_PROMPT_EXTENSION_SOURCE（见 pi-initial-prompt-extension-data.ts）。
 */
