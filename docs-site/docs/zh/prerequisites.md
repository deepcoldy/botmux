# 前置要求

装 botmux 之前，先确认这几样齐了——**「装完连不上 / 会话起不来」很多都是这里缺件**（CLI 没登录、tmux 没装、PATH 里找不到）。

**适用**：任何要跑 botmux daemon 的机器（开发机 / devbox / 服务器）。
**不适用**：你只是在别人已部署好的群里 @ 机器人用——那不需要本机装任何东西。

## 运行环境

- **botmux 本身：不需要 Node**。默认的 [curl 安装方式](/quickstart)装的是自包含单文件二进制，运行时已嵌在里面。**只有走 npm 安装路径时才要 Node ≥ 22**——那是执行 `npm i -g` 本身的要求，不是跑 botmux 的要求。（`botmux plugin init` 这类插件开发命令会调用 npm，也需要 Node。）
- **AI 编程 CLI / 本地 Agent 应用**：至少一种**已安装并完成认证**、可执行文件在 `PATH` 中：
  - `claude`（Claude Code）、`codex`、`cursor-agent`（Cursor）、`gemini`、`opencode`、`coco`（Trae / CoCo）、`agy`（Antigravity）、`hermes` 等（完整 `cliId` 见 [多 CLI 适配器](/adapters)）。
  - ⚠️ botmux 只是桥接层，不代管登录——**先在终端里手动跑一次该 CLI 确认能对话**，再接 botmux。
  - ⚠️ 这些 CLI 自己的运行时要求另算：不少是 npm 包（`claude` / `codex` / `gemini` 等），装它们仍然要 Node。「botmux 不需要 Node」说的是 botmux 自己。
- **tmux ≥ 3.x**（**默认后端，强烈建议装**）：**默认配置下**会话后端就是 tmux，装了才能起会话——tmux 不可用时 botmux **不再静默降级 pty**，而是硬拦截并弹卡提示装 tmux（见 [tmux 会话常驻](/tmux)）。要跑无 tmux 环境，可显式选别的后端：`BACKEND_TYPE=pty` / per-bot `backendType`（`pty`/`herdr`/`zellij`）——pty 不跨 daemon 重启存活；herdr/zellij 需各自二进制。（riff 是云 Agent，不占本地后端。）

## 推荐部署形态

推荐部署在**常开的开发机 / devbox** 上（而非笔记本），这样 daemon 长期在线、tmux 会话常驻、随时手机遥控。配合 `botmux autostart enable` 实现重启自恢复。

## 常见失败

- 装完 `botmux: command not found` → `~/.botmux/bin` 没进 PATH。安装器会写你当前 shell 的启动文件，但**要开个新终端才生效**；仍然找不到就看 [常见踩坑](/pitfalls)。
- 走 npm 安装且 `node -v` < 22 → 升级 Node（nvm / fnm 装 22+），或直接改用 curl 安装方式，绕开 Node。
- CLI 没在 PATH / 没登录 → 会话起不来或首条消息无响应；先手动跑通 CLI，再看 [FAQ · 会话起不来](/faq)。
- 装了 CLI 但 botmux 找不到 → PATH 在非交互 shell 里没生效，见 [常见踩坑](/pitfalls)。

**下一步**：环境齐了就去 [5 分钟快速接入](/quickstart)。
