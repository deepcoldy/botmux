# Herdr 放置配置 Dashboard 入口：浏览器截图验收

2026-10-21。本地真实浏览器截图，使用真实 `HerdrConfigSection` 组件、Dashboard CSS 和真实 IPC 配置读写接口（`PUT /api/bot-herdr`）；Bot 为合成数据（appId `cli_synthetic_demo`、展示名「示例机器人」），配置保存在临时目录，不连接飞书、不修改运行中的机器人。

## 截图

| 文件 | 视口 | 主题 | 内容 |
| --- | --- | --- | --- |
| `mobile-dark.png` | 390 × 844 CSS px（2x DPR） | 暗色 | 预填一份 split 放置配置：宿主会话 `default`、分屏、Tab `3 评审`、向右、仅群聊话题 |
| `mobile-light.png` | 390 × 844 | 亮色 | 同上 |
| `desktop-dark.png` | 760 × 900 | 暗色 | 桌面宽度；「生效聊天类型」两个复选框按既有样式两列排列 |

无横向溢出；下拉、输入框、复选框、保存按钮与状态提示均可见。


> 激活条件：放置配置至少要含「宿主会话名」或「放置方式」之一；只填目标工作区 / 目标 Tab / 分屏方向 / 生效聊天类型时，保存会被后端拒绝（该块即使写进 bots.json 也不会被 worker 采纳）。若已用 `BOTMUX_HERDR_SESSION_NAME` / `BOTMUX_HERDR_PLACEMENT` 全局设置，则可只在机器人配置里覆盖其余字段（字段级叠加）。

## 复现

```sh
node --import tsx test/fixtures/herdr-config/serve.mjs
```

打开 `http://127.0.0.1:18792`（暗色）或 `http://127.0.0.1:18792/?theme=light`（亮色）。此端口仅监听本机；服务每次启动在临时目录创建新的合成 bots.json（终端会打印路径）。fixture 服务器同时充当 daemon-proxy，把 `/api/bots/:appId/<segment>` 改写为 daemon 的 `/api/bot-<segment>`。

浏览器实测保存：清空「宿主会话名」、放置方式改为「新开 Tab」、取消「群聊话题」后保存，状态提示「✓ 已保存（下个新会话生效）」，bots.json 落盘为 `{"placement":"tab","tab":"3 评审","splitDirection":"right"}`（空 sessionName 与空 chatTypes 被归一化剔除）。
