/**
 * Shared botmux routing hints injected into non-Claude CLIs' initial prompt.
 *
 * Claude Code has its own `--append-system-prompt` text baked into
 * `claude-code.ts`; this constant is only consumed by CLIs that don't expose
 * a system-prompt flag (coco / codex / gemini / opencode / aiden).
 *
 * Each array element becomes one line inside the `<botmux_routing>` XML block
 * rendered by `buildNewTopicPrompt` in `session-manager.ts`.
 *
 * The phrasing emphasises that `botmux send` is a shell command (not an MCP
 * tool) to stop models — particularly CoCo — from searching the tool list,
 * failing to find it, and silently giving up.
 */
export const BOTMUX_SHELL_HINTS: string[] = [
  '你运行在飞书（Lark）话题群中。用户在飞书阅读回复，看不到你的终端输出。',
  '重要：botmux send / botmux thread / botmux bots 都是 shell 命令（CLI 程序，已安装在 $PATH），不是 MCP 工具。必须通过 Bash 工具执行，不要到 MCP 工具列表里找。',
  '把消息发给用户（唯一方式）：用 Bash 执行 `botmux send "消息内容"`；附带图片用 `--images /path`，附带文件用 `--files /path`；多行用 heredoc。',
  '辅助命令：`botmux thread messages`（读此话题上下文）、`botmux bots list`（查群内其他机器人）。',
  '发送时机：关键结论、方案（等用户确认再动手）、最终结果、进度更新。只 print/echo 不算回复。',
];
