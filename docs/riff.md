# Riff 机器人接入指南

> Riff 后端：消息发给飞书机器人 → riff 云端沙箱运行 agent（aiden / codex 等）→ 结果自动回到飞书。agent 跑在远端沙箱里，本机无需安装任何 CLI；botmux 自动把仓库、环境变量、回投凭证带进沙箱。要求 botmux ≥ 2.109.0。

## 快速接入（约 5 分钟）

1. 前提：botmux daemon 正常运行；有一个飞书机器人（dashboard「添加机器人」可创建）；daemon 机器内网可访问 riff 服务。
2. 打开 dashboard → 选中机器人 → 「Agent 配置」板块 → CLI 下拉选择 **Riff**。
3. 下方出现「Riff 后端配置」面板：

   | 字段 | 怎么填 |
   |------|--------|
   | Base URL | **必填**。线上 `https://riff.bytedance.net`；BOE 测试环境 `https://riff-infra-boe.bytedance.net` |
   | Agent | 默认 `aiden`；可选 `aiden-claude` / `codex` / `opencode` |
   | 模型 | **留空**（推荐，使用 riff 侧默认模型） |
   | JWT 环境变量 | 一般**留空**，见「认证（JWT）」 |
   | System Prompt / 额外初始化命令 | 可选。自定义 System Prompt 是**追加**在内置路由规则之后，不会替换它 |

4. 点「保存 Riff 配置」——CLI 与会话后端自动配对切换到 riff（该机器人现存旧会话会被关闭）。
5. 群里 @机器人 发消息即可。首轮任务约 2-5 分钟（沙箱冷启动）；继续对话秒级接续同一沙箱与上下文。

## 认证（JWT）

riff API 使用 ByteCloud JWT 鉴权。botmux 每次调用 riff 时按以下优先级取 token：

1. `bots.json` 中 `riff.jwt` 直填——不推荐（明文存储、时效短需手动更换）
2. 「JWT 环境变量」字段指定的环境变量（默认变量名 `RIFF_JWT`）——需在 daemon 启动环境中 export 并自行刷新
3. **全部留空（推荐）→ 自动读取本机 ByteCloud keychain**

### 留空（推荐）该怎么做

在**运行 botmux daemon 的机器**上，安装并登录任意一个 ByteCloud 系 CLI（`kaboo-cli` / `aiden-cli` / `cjadk`），登录一次即可：

```bash
# 任选其一，首次运行会拉起 SSO 浏览器授权
kaboo-cli   # 或 cjadk / aiden-cli
```

登录态（含 `bytecloud_jwt`）写入本机 keychain（如 `~/.config/kaboo-cli/bytecloud-auth/keychain/auth/cn/default`）。botmux **每次调用 riff 时实时读取**——无需配置任何字段、无需重启 daemon。

### 手动获取 JWT（只有走方式 ①/② 才需要）

登录上述任一 CLI 后，从 keychain 取出 token：

```bash
python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.config/kaboo-cli/bytecloud-auth/keychain/auth/cn/default')))['bytecloud_jwt'])"
```

⚠️ ByteCloud JWT 时效很短（约 1~2 小时）。直填 / 环境变量方式必须自己保证定期刷新，否则任务会开始报 401——这是推荐留空走 keychain 的原因。

### Token 过期了怎么办

- 表现：卡片报「创建 riff 任务失败 … 401」或日志提示 `JWT not found`。
- 自救：在 daemon 机器重新运行一次 `kaboo-cli` / `cjadk` 刷新登录态即可，botmux 无需重启。

## 仓库怎么进入沙箱

- **自动复用**：会话工作目录是内部仓（code.byted.org）checkout 时，任务自动带上「该仓库 + 当前分支」。分支须已推送；本地未提交/未推送内容沙箱看不到（卡片状态行会提示）。
- **仓库选择卡**：未配置默认工作目录时新会话弹卡选仓；「🔀 多仓库」可多选——批量建 worktree 全部带入，首仓为主仓（沙箱工作目录）。
- **新建 worktree**：riff 机器人先自动把新分支 push 到远端再启动任务。
- **限制**：仅支持 code.byted.org 内部仓库；GitHub 等外部仓自动跳过。

## 卡片按钮说明

| 按钮 | 作用 |
|------|------|
| 📖 显示输出 / 打开 Web 终端 | 任务日志页（状态行、进度、任务完成报告） |
| 🔑 获取操作链接 | AIO Sandbox 网页终端（可操作沙箱），私密发送给点击者 |
| ❌ 关闭会话 | 结束会话并取消远端正在运行的任务 |

## 常见问题

| 现象 | 原因与处理 |
|------|-----------|
| 发消息后没回复 | ① JWT 过期（见上）② Agent 名不受支持（只认 aiden / aiden-claude / codex / opencode）③ 打开「Web 终端」日志页看 `[riff] 错误` 行 |
| 报「仓库 xxx 不存在」 | Base URL 环境与仓库不匹配，或填了外部仓库；确认是 code.byted.org 上的 `group/repo` |
| 保存配置报 invalid_base_url | Base URL 必填且必须以 http(s) 开头 |
| 继续对话每轮都要几分钟 | 正常应为秒级（follow-up 复用暖沙箱）；若每轮冷启动，检查是否每次 /close 后重开、或配置中途被改 |
| 状态行里看不到沙箱链接 | 沙箱链接是可写能力，只经「获取操作链接」私密下发，群内状态行/日志不展示 |
