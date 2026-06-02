# 前置要求

## 运行环境

- **Node.js ≥ 20**
- **AI 编程 CLI / 本地 Agent 应用**：至少一种已安装并完成认证，可执行文件在 `PATH` 中：
  - `claude`（Claude Code）、`codex`、`cursor-agent`（Cursor）、`gemini`、`opencode`、`coco`（Trae / CoCo）、`agy`（Antigravity）、`hermes` 等
  - **CoCo 最低版本 `0.120.32`**：type-ahead（会话忙时即可发新消息，由 CoCo 自己的队列接住）依赖该版本行为；更早版本忙时输入可能丢失，请升级。
- **tmux ≥ 3.x**（可选）：安装后自动启用会话常驻——daemon 重启不中断 CLI。

## CJK 字体（截图渲染中文/emoji 用）

- **macOS**：自带 PingFang / Hiragino，无需配置。
- **Debian / Ubuntu**：daemon 启动时若检测到缺字体，会后台 `apt-get install fonts-noto-cjk fonts-noto-color-emoji`（需免密 sudo 或以 root 运行；装完重启 daemon 生效）。
- **其他 Linux**：手动安装 Noto CJK + Noto Color Emoji。

## 推荐部署形态

推荐部署在**常开的开发机**上（而非笔记本），这样 daemon 长期在线、tmux 会话常驻、随时手机遥控。配合 `botmux autostart enable` 实现重启自恢复。
