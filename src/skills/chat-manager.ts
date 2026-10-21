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
\`\`\`

设置后，有对话权限的人的群顶层消息可以免 @ 接话；只点名其他成员时让路，@all 不算转交。
群名追加机器人名称，取消时仅恢复未被人工修改的群名。原有 ambient、reply-mode 独立生效。

set/clear 必须来自当前轮真人管理员的明确指令，不能沿用会话 owner、其他机器人或定时任务的身份。
若指令有歧义，请用户在群里 @ 本机器人发送“执行 botmux manager set”或“执行 botmux manager clear”。
只操作当前会话所在的普通群，不支持指定其他群或替其他机器人设置。

切换时先由旧机器人执行 clear，确认成功后再让新机器人执行 set；不强制接管。
命令输出 JSON，仅 ok=true 才算成功。网络异常或 chat_update_unconfirmed 后先查 status，不盲目重试。
群描述超长会拒绝，不能删除或截断用户说明来绕过。缺少本地启用记录时，不能仅凭手写远端标记启用。
`;
