# Codex profile 选择器验证

浏览器加载真实 `BotAgentSection`、共享搜索下拉和产品 CSS。扫描与保存请求转发到真实 daemon IPC HTTP 服务，目标为临时 Bot 和临时配置目录；无关模型目录请求及 Dashboard 代理跳转使用测试替代，不连接生产 Bot。

- [已选择并保存](profile-selected.png)：搜索 `with`、选择 `withhooks`、保存并核对磁盘、内存和页面回读。
- [候选消失](profile-missing.png)：删除临时 profile 文件后刷新，保留选中值并标红，随后显式选择“不指定”并保存清除。

截图底部 JSON 仅用于测试展示保存后的服务端结果，不是产品页面内容。CLI 是仅支持版本/帮助输出的测试夹具，不执行模型、真实 wrapper 或 hooks。

复跑（Chromium 已安装时）：

```sh
BOTMUX_PROFILE_BROWSER=1 BOTMUX_PROFILE_SCREENSHOT_DIR=/tmp/profile-screenshots \
  bun run test -- test/dashboard-ipc.test.ts -t 'Codex profile selection' --maxWorkers=1
```

可用 `BOTMUX_TEST_BROWSER_EXECUTABLE` 指定现有 Chromium。完整支持范围及实测限制见 [设计与支持矩阵](../../codex-profile-selection.md)。
