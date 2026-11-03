/**
 * Pi 首条消息扩展的运行时真源：纯 JS、自包含，由外部 pi 进程直接加载。
 *
 * registerCommand 的实参对象在 default factory 被调用时才求值，因此本文件
 * 引用的每个标识符都必须由本文件自身定义——不得 import 仓库模块，也不得
 * 依赖任何转译器注入的模块作用域 helper（tsx 会注入 __name，pi 无转译器，
 * 加载即 ReferenceError）。构建期由 scripts/generate-pi-initial-prompt-extension.mjs
 * 把本文件字节原样嵌入 pi-initial-prompt-extension-data.ts；改动后需运行
 * `bun run build` 重新生成。
 */
import { readFile } from 'node:fs/promises';
export default function registerBotmuxInitialPromptExtension(pi) {
  const fileEnv = 'BOTMUX_PI_INITIAL_PROMPT_FILE';
  pi.registerCommand('botmux-initial-prompt', {
    description: 'Deliver the Botmux initial prompt',
    handler: async (_args, ctx) => {
      const filePath = process.env[fileEnv];
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
        delete process.env[fileEnv];
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        ctx.ui.notify('Failed to load Botmux initial prompt: ' + detail, 'error');
      }
    },
  });
}
