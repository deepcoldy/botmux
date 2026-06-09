# 5 分钟快速接入

> 💡 **TL;DR**：`npm i -g botmux` → `botmux setup` 扫码建应用、选 CLI、填工作目录 → `botmux start` → `botmux autostart enable` → 拉机器人进群开聊。

## Step 1 · 安装

```bash
npm install -g botmux
```

要求 **Node.js ≥ 20**，且本地已安装并登录好至少一种 AI 编程 CLI（`claude` / `codex` / `cursor-agent` / `gemini` / `opencode` / `coco` / `agy` 等）。推荐安装 **tmux**（≥3.x），装了就自动启用会话常驻。

## Step 2 · 配置（`botmux setup`）

```bash
botmux setup
```

交互式向导，跟着选即可：

1. **新建配置**：输入 `1` 回车。（已有配置时输入 `2` 添加机器人）
2. **创建机器人**：
   - 输入 `1` → **扫码创建**（推荐）：飞书扫码，自动建出 PersonalAgent 应用并落盘 AppID/AppSecret，事件订阅 + bot 能力默认已配好。
   - 输入 `2` → **手动创建**：去 [飞书开放平台](https://open.larkoffice.com/app) 建企业自建应用，粘 AppID/AppSecret。
3. **选择 CLI**：选本次要接入的 CLI（如接 Claude Code 就选 `1`）。
4. **默认工作目录**：通常填 git 项目的**父级目录**（如 `~/projects`），最多向下查找 3 层。尽量别填 `~`（要遍历太多文件夹）。

> ✅ **飞书 (feishu.cn) 与 Lark 国际版 (larksuite.com) 均支持**：扫码建应用时自动识别租户类型，手动粘贴时可选。同机可混跑两种。

## Step 3 · 启动

```bash
botmux start            # 启动 daemon
botmux autostart enable # 开机自启（推荐，重启机器不丢，无需 sudo）
```

## Step 4 · 申请权限

setup 完成后会把完整权限 JSON 写到 `~/.botmux/lark-scopes.json` 并打印一键复制命令。把它复制到剪贴板，进开放平台「权限管理 → 批量导入/导出权限」粘贴提交。可用性范围选「仅自己可见」会自动通过。

```bash
# macOS
cat ~/.botmux/lark-scopes.json | pbcopy
# Linux 桌面
cat ~/.botmux/lark-scopes.json | xclip -selection clipboard
# SSH / 无 DISPLAY：直接 cat 后在本地终端鼠标选中
cat ~/.botmux/lark-scopes.json
```

## Step 5 · 发版

进开放平台「版本管理与发布 → 创建版本」并发布，可用性范围选「仅自己可见」自动通过审核。

## Step 6 · 建群开聊

1. 飞书里创建一个**话题群**（普通群也支持）。
2. 群设置 → 群机器人 → 添加你刚建的机器人。
3. 群里直接发消息，机器人自动响应——它会弹一张仓库选择卡片，选项目后 CLI 就在该目录启动。

也可以**私聊机器人**直接开聊，或用 `botmux dashboard` 切到 Group Tab 一键拉群。

## 收不到消息？自查

PersonalAgent 默认配好订阅，正常不用动。如果 bot **完全收不到任何消息**：

- **事件订阅**：开放平台 → 事件与回调 → 应订阅 `im.message.receive_v1` + `card.action.trigger`，方式为「长连接 (WebSocket)」，且 daemon 已在跑。
- **机器人能力**：开放平台 → 应用功能 → 机器人 应已开通。

确认后 `botmux restart`。更多见 [FAQ / 排错](/faq)。
