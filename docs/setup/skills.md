# Skill 管理

botmux 支持一套 CLI 无关的自定义 Skill 管理能力。Skill 包本身只描述“能力是什么、什么时候使用、入口和相对资源在哪里”，不绑定 Claude、Codex 或其他 CLI。botmux 在启动每个会话时按 bot 配置解析出 priority skills，再根据目标 CLI 的能力做投递。

## 默认行为

没有给某个 bot 配置 `skills` 字段时，botmux 不生成 session manifest，不注入 prompt catalog，不创建 runtime plugin，也不改 CLI 启动参数。底层 CLI 会完全按自己的默认行为加载原生 skill 目录，例如 Codex 继续读取自己的 `~/.codex/skills`，Claude 继续读取自己的 Claude skill/plugin 目录。

配置了 `skills` 后，默认语义是“优先披露”，不是“独占隔离”。botmux 会把匹配到的 skill 加入本会话的 priority catalog，并提供 `botmux skill show/read/resources` 给 agent 按需读取。底层 CLI 原本能发现的 skill 仍然由 CLI 自己处理。

## Skill 包格式

一个 skill 是一个目录，至少包含 `SKILL.md`：

```text
deploy-runbook/
  SKILL.md
  references/
  scripts/
  assets/
```

推荐在 `SKILL.md` 顶部写 frontmatter：

```markdown
---
name: deploy-runbook
description: Use when handling production deploys and rollbacks.
version: 1.2.0
tags: [deploy, sre]
---

# Deploy Runbook
```

`SKILL.md` 可以引用 `references/`、`scripts/`、`assets/` 等相对路径。agent 读取资源时应使用：

```bash
botmux skill show deploy-runbook
botmux skill read deploy-runbook references/release.md
botmux skill resources deploy-runbook
```

这些命令只在 botmux 会话里可用，依赖本会话的 skill manifest。

## 安装

本地安装默认复制到 botmux registry，不写入任何 CLI 的全局 skill 目录：

```bash
botmux skills install ./skills/deploy-runbook
botmux skills install ./skills/deploy-runbook --link
```

`--link` 用于开发态，registry 记录原目录；不加 `--link` 会 vendor copy 到 `~/.botmux/skills/store`。

Git 仓库安装：

```bash
botmux skills install git+https://github.com/acme/agent-skills.git --path skills/deploy-runbook
botmux skills install git@github.com:acme/agent-skills.git --path skills/deploy-runbook --ref v1.2.0
```

GitHub 简写：

```bash
botmux skills install github:acme/agent-skills/skills/deploy-runbook
botmux skills install github:acme/agent-skills --path skills/deploy-runbook --ref main
```

私有仓库认证交给系统 Git 凭证、SSH agent 或 `gh auth`。botmux 不保存 GitHub token；带 username/password/token 的 HTTPS Git URL 会被拒绝，避免凭证进入 registry 或 Dashboard。
Git/GitHub 的 `--path` 必须是仓库内相对路径；绝对路径、`..` segment 或解析到 checkout 外部的 symlink 会被拒绝。
Git 安装/更新会给底层 Git 命令设置超时，默认 60 秒；需要更长时间时可设置 `BOTMUX_SKILL_GIT_TIMEOUT_MS`。

更新、查看和移除：

```bash
botmux skills list
botmux skills inspect deploy-runbook
botmux skills update deploy-runbook
botmux skills remove deploy-runbook
botmux skills remove deploy-runbook --force
botmux skills doctor
```

`remove` 只删除 registry entry 和 botmux 管理的 store 副本，不会自动改写已经配置到 bot 上的引用。CLI 默认会检查 bots.json，发现引用时拒绝删除；确认要保留 dangling policy 时使用 `--force`。Dashboard 会在删除前提示受影响 bot，并把悬挂引用标记为未安装。

Git / GitHub 来源需要部署机器安装 `git` 命令；本机目录安装不依赖 git。缺少 git 时 CLI 和 Dashboard job 会返回 `git_not_found`。

## Bot Priority Policy

bot 级配置只表达“这个 bot 优先披露哪些 Skill”。注入方式和是否读取工作区 Skill 都是全局配置，不支持 per-bot override。配置写在 `bots.json` 的 `skills` 字段，也可以通过 `/botconfig set skills '<json>'` 修改：

```json
{
  "skills": {
    "include": ["skill:deploy-runbook"]
  }
}
```

字段含义：

- `include`: priority skill 列表，只支持 `skill:<name>`。这些 Skill 会优先披露给该 bot；底层 CLI 原生 Skill 发现机制保持原样。
- 全局工作区 Skill：`off | all`，决定解析 priority skill 时是否把当前工作区 `.agents/skills` 和 `.botmux/skills` 纳入候选。旧配置里的 `trusted` 会作为 `all` 的兼容别名读取，并在解析诊断里提示 deprecated；当前没有单独的项目 trust store。
- 全局 delivery：`auto | prompt | native`。`auto` 会优先使用可用 native 投递，否则走 prompt；`native` 在目标 CLI 不支持时会阻止新会话启动并报配置错误。

聊天里可以用快捷命令管理当前 bot 的 registry skill：

```text
/skills
/skills attach deploy-runbook
/skills detach deploy-runbook
```

`attach` 只接受已通过 `botmux skills install` 安装的 registry skill。项目内 skill 可通过全局“读取工作区 Skill”开关进入解析候选，但 bot 侧仍只维护 direct priority skill 列表。

Dashboard 的 `Skills` 页也提供同一套管理入口：

- 安装、更新、删除 registry skill（支持本机目录、Git、GitHub 简写）。
- 设置全局 project skill 默认值和全局 delivery 默认值。
- 为每个 bot attach/detach 已安装 skill，维护 direct priority skill 列表。

Dashboard 的安装/更新会作为后台 job 执行，页面显示处理中状态并轮询结果；慢 Git clone/fetch 不会占住整个 HTTP 请求。

## Delivery 行为

通用路径是 prompt delivery：botmux 在首轮 prompt 后追加 priority catalog，告诉 agent 先查看这些 skill，并用 `botmux skill show/read/resources` 读取内容。这对 Codex、OpenCode、Gemini、Cursor 等 CLI 都可用，而且不会写入 `~/.codex/skills` 或其他 CLI 全局目录。

Claude Code 支持 scoped plugin 优化：botmux 会为当前 session 生成 runtime plugin，并通过 `--plugin-dir` 注入。这个目录是会话派生物，不进入 Git，不污染全局 `~/.claude/skills`。同时仍保留 prompt catalog，方便 agent 明确知道哪些是 botmux priority skills。

检查某个 bot 或 CLI 的解析结果：

```bash
botmux skills resolve --bot <appId|name|index> --cwd <repo>
botmux skills delivery --bot <appId|name|index> --cwd <repo>
botmux skills delivery --cli codex --mode auto
botmux skills delivery --cli claude-code --mode auto
```

## Sandbox

开启文件 sandbox 时，prompt delivery 仍通过 `botmux skill read` 按 manifest 读取 selected skills；本功能不会额外把 `~/.botmux/skills` 作为可写目录挂给 CLI，也不会把 selected skills 写入 CLI 全局目录。注意 botmux 当前 sandbox 是 read-all / write-isolated 模型，host 文件系统的只读可见性仍遵循既有 sandbox 规则；需要隐藏具体路径时继续使用 bot 的 sandbox hidePaths 配置。Claude native delivery 需要 CLI 直接读取 runtime plugin 目录，botmux 会把这个会话级目录以只读方式挂入 sandbox。

## 排障

常用命令：

```bash
botmux skills doctor
botmux skills resolve --bot <appId|name|index> --cwd <repo>
botmux skills delivery --bot <appId|name|index> --cwd <repo>
```

如果某个 bot 没有配置 custom skills，`resolve` 会显示 `skills: default`，表示新能力没有接管或改变底层 CLI 的默认 skill 加载行为。
