# 快速上手

<video src="img/video-v1-quickstart.mp4" controls preload="metadata" style="width:100%;border-radius:8px"></video>

跟着下面 3 步，把第一个 AI 机器人拉进飞书。只是在别人已经搭好的群里使用机器人，则不需要安装任何东西。

## 开始前

准备一台 Linux / macOS 机器、一个飞书账号，以及一种**已安装、登录并能在终端正常对话的 AI CLI**（如 Claude Code、Codex）。tmux 等准备项见[前置要求](/prerequisites)。

## 第 1 步 · 安装

```bash
curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | sh
```

装完**开一个新终端**，让 `botmux` 命令生效。安装的是自包含程序，运行不需要 Node；Windows 请在 WSL2 中使用。

也可以执行 `npm install -g botmux`（安装本身需要 Node ≥ 22），两种安装方式得到的是同一个程序。

> **Mac 桌面版**：[GitHub Releases](https://github.com/deepcoldy/botmux/releases) 提供已签名、公证的 DMG。当前版本完全没配过机器人时，仍需先按本页第 1、2 步用命令行完成一次初始化，再回 App 点「启动」；已有 `~/.botmux` 配置可以直接打开。详见 [macOS 桌面版](/desktop)。

## 第 2 步 · 扫码配置机器人

```bash
botmux setup
```

用方向键选择、回车确认，依次完成：

1. **创建飞书应用**：选择「一次扫码创建新应用」，给机器人起名字，再用飞书扫码。botmux 会自动配置权限并发布应用，扫码人自动成为管理员。
2. **选择 CLI**：选这个机器人要使用的 AI CLI，可以输入文字搜索。
3. **选择工作目录**：第一次建议选「固定默认目录」，填一个已存在的项目目录，例如 `~/projects/my-app`。之后新话题会直接在这里启动。

已经有飞书应用，也可以选择已有应用或手动输入凭证。自动配置未完成时，按向导提示处理，详见 [FAQ · 手动补全开放平台配置](/faq#manual-open-platform-setup)。

> 按 `Esc` 会取消本次 setup，不写入配置。扫码登录状态会留在本机，下次添加机器人通常只需确认账号。

## 第 3 步 · 启动并开聊

```bash
botmux start
```

第一次启动若询问「反馈存储」，**直接回车使用默认的 SQLite**。然后在飞书里：

1. 建一个话题群（普通群也可以），在「群设置 → 群机器人」中添加刚配置的机器人。
2. **@ 机器人**发一条消息，例如「@机器人 看看这个项目怎么构建，并跑一下测试」。
3. 等它返回一张实时更新的卡片；完成后，在同一会话里继续追问即可。

![回复卡片：处理中与完成后](/img/unified-reply-card-preview.png)

- **每次都要 @ 吗？** 群里默认需要 @；已开始的话题里，满足条件时可以接着聊。详见 [@ 策略](/mention-mode)。
- **不想建群？** 直接私聊机器人。
- **想让机器重启后自动运行？** 跑通后再执行 `botmux autostart enable`；细节见[开机自启](/cli-commands#autostart)。

## 跑通之后

试着把这些日常任务交给它：

- 「帮我修复这个报错，并补上测试。」
- 「总结一下这个项目最近一周的改动。」
- 「每个工作日早上汇报这个群的待办和风险。」（[定时任务](/schedule)）

更多玩法见[文档首页的日常场景](/#日常能怎么用)。

## 没反应？先看这两项

```bash
botmux status   # 服务是否在运行
botmux logs     # 查看连接、权限和 CLI 启动错误
```

群里发消息要 @ 机器人；改过配置后执行 `botmux restart`。完整排查见 [FAQ · 机器人不回复](/faq#机器人不回复怎么排查)和[常见踩坑](/pitfalls)。

## 需要时再查：进阶配置

| 需求 | 参考页 |
|---|---|
| 脚本化添加机器人、仅本地使用 | [CLI 命令 · 脚本化配置](/cli-commands#scripted-setup) |
| 添加内置清单之外的权限 | [CLI 命令 · 额外权限](/cli-commands#extra-scopes) |
| 设置首次上线欢迎语 | [bots.json · 上线欢迎语](/bots-json#welcome-message) |
| 手动补全应用配置、可选事件 | [FAQ · 手动配置](/faq#manual-open-platform-setup) · [可选事件](/faq#optional-events) |
| 升级、安装指定版本、源码更新 | [CLI 命令 · 升级](/cli-commands#upgrade) |
| 更换反馈存储 | [反馈数据存储与迁移](/feedback-storage) |
