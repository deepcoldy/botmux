import { readFile } from 'node:fs/promises';

export const PI_INITIAL_PROMPT_COMMAND_NAME = 'botmux-initial-prompt';
export const PI_INITIAL_PROMPT_COMMAND = `/${PI_INITIAL_PROMPT_COMMAND_NAME}`;
export const PI_INITIAL_PROMPT_FILE_ENV = 'BOTMUX_PI_INITIAL_PROMPT_FILE';

interface PiExtensionCommandContext {
  isIdle(): boolean;
  ui: {
    notify(message: string, level: 'info' | 'warning' | 'error'): void;
  };
}

interface PiExtensionApi {
  registerCommand(name: string, options: {
    description: string;
    handler(args: string, ctx: PiExtensionCommandContext): Promise<void> | void;
  }): void;
  sendUserMessage(content: string, options?: { deliverAs: 'followUp' }): void;
}

/**
 * Pi expands @file only for launch argv, not for text entered into its TUI.
 * Deferred first prompts therefore use this short, one-shot command: the
 * extension reads the worker-selected file (never a user-supplied path) and
 * submits its full contents through Pi's native user-message API as one turn.
 */
export default function registerBotmuxInitialPromptExtension(pi: PiExtensionApi): void {
  pi.registerCommand(PI_INITIAL_PROMPT_COMMAND_NAME, {
    description: 'Deliver the Botmux initial prompt',
    handler: async (_args, ctx) => {
      const filePath = process.env[PI_INITIAL_PROMPT_FILE_ENV];
      if (!filePath) {
        ctx.ui.notify('Botmux initial prompt is no longer available.', 'error');
        return;
      }

      try {
        const prompt = await readFile(filePath, 'utf8');
        if (ctx.isIdle()) pi.sendUserMessage(prompt);
        else pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
        // One-shot within this Pi process. Keep the file itself until the worker
        // ends the session so an owned process restart can safely replay a
        // command that was written but not yet consumed.
        delete process.env[PI_INITIAL_PROMPT_FILE_ENV];
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to load Botmux initial prompt: ${detail}`, 'error');
      }
    },
  });
}
