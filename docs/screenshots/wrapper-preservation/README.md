# Agent 启动方式保存回归（#2022）

截图来自真实 Chromium 中的 `BotAgentSection`，保存请求转发至临时配置目录中的真实 Dashboard IPC 服务。模型目录等无关请求使用固定响应；下方 JSON 是测试页展示的服务端保存结果，不属于产品界面。

- `wrapper-preserved.png`：未切换 CLI，保存后保留 `codex --profile withhooks`。
- `wrapper-replaced.png`：在 CLI 下拉中再次点击当前 Codex，保存后清除 wrapper，显示官方 runtime。

复跑（需要已安装 Playwright Chromium）：

```sh
BOTMUX_WRAPPER_BROWSER=1 bun run test -- test/dashboard-ipc.test.ts -t 'through real browser controls'
```

可用 `BOTMUX_TEST_BROWSER_EXECUTABLE` 指定浏览器二进制，`BOTMUX_WRAPPER_SCREENSHOT_DIR` 指定截图目录。测试使用隔离的 bots.json 和动态端口，不操作运行中的 Bot 配置。
