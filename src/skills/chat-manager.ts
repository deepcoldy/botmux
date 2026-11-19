export const CHAT_MANAGER_SKILL = `---
name: botmux-chat-manager
description: 用户要求在已有普通群设置或取消负责人、默认接话人，或查看负责人时使用。
---

# 当前群负责人

通过会话内 CLI 操作本机器人，不要直接编辑配置或群描述：

\`\`\`bash
botmux manager set
botmux manager clear
botmux manager status
botmux manager lead-only on
botmux manager lead-only off
\`\`\`

设置后，有对话权限的人的群顶层消息可以免 @ 接话；只点名其他成员时让路，@all 不算转交。
群名追加机器人名称，取消时仅恢复未被人工修改的群名。原有 ambient、reply-mode 独立生效。

可选的 lead-only（默认关闭）：本机器人是负责人时，可让它在本群的非执行者会话里只能执行 botmux 命令，
读写文件、搜索、联网、子 agent、MCP 以及非 botmux 的 Bash 都会被拦截，具体工作须用 botmux dispatch 派给执行 bot。
botmux 子命令也按名单放行（dispatch/send/status/manager/history/quoted/bots list/observe/capabilities/skill/whiteboard status|current|read|update/--help），
多行正文可放进单引号，或在命令末尾用带引号定界符的 heredoc（<<'EOF'）；
负责人的长期笔记（用户定的规矩、各 bot 的专长）可在白板启用时先 botmux whiteboard current --create，再不带 --id 用 botmux whiteboard read/update 写进本群白板；白板由群内所有 bot 共享，不要写密钥。
读本地文件的参数（--content-file/--file/--brief-file/--diff 等）、fleet 与配置类子命令（setup/upgrade/restart/delete/mcp 等）、
以及 botmux bots invite 这类变更群成员的操作都会被拦——拉人进群请真人或在 dashboard 操作。
由 botmux dispatch 派出的会话和 workflow 节点会话（执行者）不受限；私聊不生效；仅对 claude-code 生效，其他 CLI 忽略该开关。
守卫在文件沙箱/读隔离下也生效（守卫插件目录在沙箱内只读可见）；源码（非编译）运行时，若安装目录被删/移动，
钩子命令路径失效，工具调用会被持续拦截（fail-closed），重开话题即可恢复。
接管（adopt）的会话补不上启动期参数，不会生效。
仅当前负责人可开关，取消负责人时一并关闭；对已运行的会话不生效，下次会话（重新）启动时才生效；已运行会话内的 /restart、dashboard 重启和崩溃自动重启不会重新读取该开关，需重开话题。status 输出含 leadOnly（只反映群配置，不代表某个运行中会话已生效）。
关闭 bot 的负责人开关后，lead-only off 仍可执行（不会连带撤掉负责人）；lead-only on 需要开关开启。

set/clear/lead-only 必须来自当前轮真人管理员的明确指令，不能沿用会话 owner、其他机器人或定时任务的身份。
若指令有歧义，请用户在群里 @ 本机器人发送“执行 botmux manager set”、“执行 botmux manager clear”或“执行 botmux manager lead-only on/off”。
只操作当前会话所在的普通群，不支持指定其他群或替其他机器人设置。

切换时先由旧机器人执行 clear，确认成功后再让新机器人执行 set；不强制接管。
命令输出 JSON，仅 ok=true 才算成功。网络异常或 chat_update_unconfirmed 后先查 status，不盲目重试。
群描述超长会拒绝，不能删除或截断用户说明来绕过。缺少本地启用记录时，不能仅凭手写远端标记启用。
`;
