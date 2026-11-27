# botmux

<video src="img/video-v0-overview.mp4" controls preload="metadata" style="width:100%;border-radius:8px"></video>

<p class="lead">在飞书里像拉同事一样，把 AI 编程工具拉进群干活。</p>

让它们写代码、查问题、做评审，或定时汇报进展。手机上随时看进度、追问和打断，回到电脑还能接着处理同一个任务。

## 3 步上手

### 1. 安装

```bash
curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | sh
```

支持 Linux / macOS（x64 / arm64），运行不需要 Node；Windows 请在 WSL2 中使用。

### 2. 扫码配置第一个机器人

```bash
botmux setup
```

按向导用飞书扫码，选择已安装并登录的 CLI，再选一个默认工作目录。应用创建、权限配置和发布会自动完成。

### 3. 启动，拉进群开干

```bash
botmux start
```

把机器人拉进飞书群，@ 它说「看看这个项目怎么构建」，或「帮我修复这个报错」。不想建群，直接私聊机器人也可以。

➡️ 第一次安装请看[快速上手](/quickstart)；先确认 CLI、tmux 等准备项见[前置要求](/prerequisites)。

> Mac 也可以安装已签名、公证的 [Botmux Desktop](/desktop)。当前版本首次使用仍需先完成一次命令行初始化；已有配置可直接打开 App。

## 日常能怎么用

| 想做什么 | 可以直接这样说 / 看这里 |
|---|---|
| 写代码、修问题 | 「@机器人 修复这个报错，并补上测试。」 · [实时卡片](/cards) |
| 排查故障、值班答疑 | 「@机器人 看看这段日志，最可能是什么原因？」 · [Oncall 模式](/oncall) |
| 多个 AI 一起评审 | 让不同机器人独立检查同一个改动 · [多机器人协作](/multi-bot) |
| 定时汇报 | 「每个工作日早上总结昨天的进展和今天的风险。」 · [定时任务](/schedule) |
| 在手机上继续跟进 | 随时追问、打断，需要时直接操作 · [Web 终端](/web-terminal) |
| 接续电脑上已有的任务 | 接入正在运行的会话，或搬到另一个群 · [会话接入](/adopt) · [会话接力](/relay) |

## 按需探索更多能力

- **并行与编排**：[多话题协作](/multi-topic) · [项目进度卡](/project-card) · [决策看板与管家](/decision-board)
- **团队与自动化**：[角色与团队](/roles) · [Webhook](/webhook) · [无群自动化会话](/headless-session)
- **管理与个性化**：[Dashboard](/dashboard) · [语音总结](/voice) · [文件沙盒](/sandbox)
- **多机器协作**：[中心化平台（开源）](/platform)，单机使用不需要部署它

[查看支持的 30+ CLI / Agent](/adapters)，或浏览左侧功能目录找到完整说明。

## 需要进阶信息时

- **配置与命令**：[CLI 命令](/cli-commands) · [斜杠命令](/slash-commands) · [bots.json](/bots-json) · [全局设置](/global-settings) · [最佳实践](/best-practices)
- **深入原理**：[架构总览](/architecture) · [会话与话题模型](/session-model)
- **遇到问题**：[FAQ / 排错](/faq) · [常见踩坑](/pitfalls)

> 项目地址：<https://github.com/deepcoldy/botmux>
