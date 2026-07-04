# 5 分钟快速接入

> 💡 **TL;DR**：`npm i -g botmux` → `botmux setup` 扫码建应用、选 CLI、填工作目录 → `botmux start` → `botmux autostart enable` → 拉机器人进群开聊。

## Step 1 · 安装

```bash
npm install -g botmux
```

要求 **Node.js ≥ 22**，且本地已安装并登录好至少一种 AI 编程 CLI（`claude` / `codex` / `cursor-agent` / `gemini` / `opencode` / `coco` / `agy` 等）。推荐安装 **tmux**（≥3.x），装了就自动启用会话常驻。

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

> 🔧 **扫码创建会自动配好全部权限并发版**，无需手动操作。只有加 `botmux setup --no-open-platform-auto`（跳过自动配置）或手动建应用时，才需自己去开放平台导入权限 JSON（setup 会把完整权限写到 `~/.botmux/lark-scopes.json` 并打印一键复制命令）并创建发布版本，可用性范围选「仅自己可见」自动通过。

## Step 3 · 启动

```bash
botmux start            # 启动 daemon
botmux autostart enable # 开机自启（推荐，重启机器不丢，无需 sudo）
```

## Step 4 · 建群开聊

1. 飞书里创建一个**话题群**（普通群也支持）。
2. 群设置 → 群机器人 → 添加你刚建的机器人。
3. 群里直接发消息，机器人自动响应——它会弹一张仓库选择卡片，选项目后 CLI 就在该目录启动。

也可以**私聊机器人**直接开聊，或用 `botmux dashboard` 切到 Group Tab 一键拉群。

## 收不到消息？自查

绝大多数"收不到消息"是**本地配置或网络问题**，不是 botmux 的 bug。botmux 本就接了 AI agent——**用你的 CLI 跑一条 headless 自查命令**，让它读日志、查配置、直接给结论。

先把排查任务存成变量（单行，省得重复粘）：

```bash
DIAG='botmux 在飞书群收不到消息，请只读排查（别改任何东西），依次执行并给出最可能原因+修复步骤：botmux status（daemon 在跑吗）；botmux logs --lines 150（找 WebSocket 连接失败、token 鉴权、权限报错 401/403/411/400、CLI spawn 失败）；cat ~/.botmux/bots.json（确认 AppID/Secret/CLI 配置）；判断长连接是否被公司网/代理/防火墙挡住。最后给结论。'
```

按你装的 CLI 选一条（都是非交互模式，跑完直接打印结论）：

```bash
claude -p "$DIAG" --allowedTools "Bash"   # Claude Code
codex exec "$DIAG"                         # Codex
gemini -p "$DIAG" --yolo                   # Gemini
coco  -p "$DIAG" --yolo                    # Trae / CoCo（别名 trae-agent / ta）
cursor-agent -p "$DIAG"                    # Cursor
```

> 末尾那些 flag（`--allowedTools` / `--yolo` 等）是让 agent 能真正执行命令读日志——纯只读排查。`botmux logs` 几乎能定位所有问题，是排查金标准。

仍没头绪时手动核对（多为本地侧）：

- **daemon 没跑 / 改了配置没重启** → `botmux status` 看状态，`botmux restart` 重启。
- **机器人权限不全 / 复用了旧应用创建的机器人**（最常见）→ 见 [常见踩坑](/pitfalls)，用最新 `botmux setup` 扫码重建。
- **事件订阅 / 机器人能力**（仅手动建应用需查）：开放平台订阅 `im.message.receive_v1` + `card.action.trigger`（长连接 WebSocket）、应用功能 → 机器人 已开通。
- **网络**：长连接 WebSocket 出不去（公司网络 / 代理 / 防火墙）→ agent 在 logs 里能看到连接错误。

确认后 `botmux restart`。更多见 [FAQ / 排错](/faq)。
