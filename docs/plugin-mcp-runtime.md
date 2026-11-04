# 插件 MCP 运行参数

Bot 可以在 `bots.json` 中通过 `pluginRuntime` 为已启用插件覆盖宿主侧 MCP 运行参数：

```json
{
  "plugins": ["reporting"],
  "pluginRuntime": {
    "reporting": {
      "env": {
        "PROFILE": "production"
      },
      "toolTimeoutMs": 120000
    }
  }
}
```

- `env` 只对该 Bot、该插件的本地 stdio MCP 子进程生效，不会注入模型 CLI。
- `toolTimeoutMs` 是该插件工具调用的总超时，必须为正整数；未配置时保留 MCP SDK 默认值。
- 运行参数只写入权限为 `0600` 的会话 MCP 快照。插件未在当前会话启用时，对应配置不会启动或暴露该插件。
- 机器级 `~/.botmux/config.json` 可通过 `mcpGatewayMaxToolTimeoutMs` 设置所有插件调用的上限，缺省为 `600000`（10 分钟），并受 Node 定时器安全边界约束。
- Codex 的 Botmux Gateway 入口读取同一上限并向上取整到秒；Gateway 仍按每个插件配置的更小超时执行。

配置在下一次 CLI 冷启动或会话运行代刷新时生效。该机制位于插件 Gateway 层，与上层采用单模型还是多模型编排无关。
