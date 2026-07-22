# 前置要求

## 运行环境

- **Node.js ≥ 22**
- **AI 编程 CLI / 本地 Agent 应用**：至少一种已安装并完成认证，可执行文件在 `PATH` 中：
  - `claude`（Claude Code）、`codex`、`cursor-agent`（Cursor）、`gemini`、`opencode`、`coco`（Trae / CoCo）、`agy`（Antigravity）、`hermes` 等
- **tmux ≥ 3.x**（可选）：安装后自动启用会话常驻——daemon 重启不中断 CLI。
- **zmx ≥ 0.7.1**（可选，macOS / Linux）：仅显式配置 `backendType: "zmx"` 或 `BACKEND_TYPE=zmx` 时启用；将 0.7.1 视为假定包含 [PR #202](https://github.com/neurosnap/zmx/pull/202) `send` 行为的首个发布版，安装与完整前置见 [ZMX 后端](/zmx)。

## 推荐部署形态

推荐部署在**常开的开发机**上（而非笔记本），这样 daemon 长期在线、tmux 会话常驻、随时手机遥控。配合 `botmux autostart enable` 实现重启自恢复。
