/**
 * statusline-entry.ts — `botmux statusline` 的轻量入口。
 *
 * Claude Code 的 statusLine.command 指向这里（见 adapters/hook-command.ts
 * statuslineHookCommand），而不是 cli.js：cli.js 的静态 import 会把整张 CLI 模块图
 * 加载一遍，对一条每条 assistant 消息都会被调用的命令来说太重。本文件只 import
 * statusline-command（叶子模块），行为与 `botmux statusline` 完全一致；
 * `cli.js statusline` 仍保留，供已经在跑、命令里写死了 cli.js 的老会话使用。
 */
import { runStatusline } from './services/statusline-command.js';

void runStatusline();
