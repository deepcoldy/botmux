# 前置要求

## 运行环境

- **Node.js ≥ 22**
- **AI 编程 CLI / 本地 Agent 应用**：至少一种已安装并完成认证，可执行文件在 `PATH` 中：
  - `claude`（Claude Code）、`codex`、`cursor-agent`（Cursor）、`gemini`、`opencode`、`coco`（Trae / CoCo）、`agy`（Antigravity）、`hermes` 等
- **tmux ≥ 3.x**（可选）：安装后自动启用会话常驻——daemon 重启不中断 CLI。
- **zmx ≥ 0.6.0**（可选，macOS / Linux）：轻量持久会话后端，需显式配置 `backendType: "zmx"` 或 `BACKEND_TYPE=zmx`。botmux 不会自动安装/选择；Homebrew 可用 `brew install neurosnap/tap/zmx`，其它安装方式见 [ZMX 后端](/zmx)。

## 推荐部署形态

推荐部署在**常开的开发机**上（而非笔记本），这样 daemon 长期在线、tmux 会话常驻、随时手机遥控。配合 `botmux autostart enable` 实现重启自恢复。
