# Cursor 原生用量

Cursor Agent 的 `agent-transcripts/*.jsonl` 只包含消息内容，没有 token 用量。Botmux 分开读取两类数据：

- **当前上下文**：按精确的原生 chat ID，只读打开 Cursor 的 `chats/<projectHash>/<chatId>/store.db`，读取当前 root blob 中的 `token_details`。窗口上限使用原生记录，不按模型名称推测；上下文压缩后会随原生状态下降。
- **本轮及累计 token**：由 Cursor 的 `stop` hook 报告，写入 Botmux 数据目录的 `cursor-usage/<sessionId>.jsonl`。按原生 conversation ID 过滤、generation ID 去重，恢复同一会话后继续累计。

原生数据库位于 `CURSOR_CONFIG_DIR`，缺省依次为 `$XDG_CONFIG_HOME/cursor`、`~/.cursor`。`CURSOR_DATA_DIR` 控制 transcript 等产物的路径，不能用来定位 chats 数据库。支持 Bot 配置中的 `CURSOR_CONFIG_DIR` 和 `XDG_CONFIG_HOME`。

## 采集范围

启动 Botmux 管理的 Cursor 会话时，安装器向 `~/.cursor/hooks.json` 合并一条 `stop` hook，保留用户原有的 hook 和其他字段。重复安装不会追加重复项，已有配置损坏或版本不支持时不覆盖原文件。

这里使用用户级 hook，是因为 Cursor Agent `2026.10.14-0f9edde` 的交互调用入口只检查用户级、项目级的 `stop` 配置：单独通过 `--plugin-dir` 加载的 hook 虽然能被发现，却不会触发。用户级 hook 不依赖内置 skill 或 prompt 注入，因此 `promptInjection: none` 也能采集。

回调必须同时收到 `BOTMUX_SESSION_ID` 和 `SESSION_DATA_DIR` 才会落盘。缺少环境变量、输入过大、解析失败或写入失败时静默退出；不返回跟进提示，不发送消息。只保存模型、会话／generation 标识和计数，不保存提示词、回答正文或凭证。沙盒只开放当前 Botmux 会话的单个 journal 文件，并在启动前创建该文件。

## 计数口径与边界

Cursor hook 的 `input_tokens` 包含缓存读取与缓存写入。Botmux 的新输入字段先减去这两项，计价时分别处理；卡片的输入总量再将三项相加。例如原生报告输入 `14144`、缓存读取 `9000`、缓存写入 `5140`，新输入为 `4`，卡片输入仍为 `14144`。

累计值仅包含安装采集后实际观察到的回调，**不会补算历史 token**。已存在的会话可以先显示数据库里的上下文；采集需在安装 hook 后新启动或恢复 Cursor 进程。外部 adopt 会话若没有 Botmux 会话环境变量，只能读取原生上下文。

完成、中断和错误回调只有携带完整、有效的计数时才被接纳。缺少计数不会补零。重复 generation 的相同记录只算一次；同一 generation 的计数发生冲突时不猜测合并方式，省略累计值。不同模型的金额估算按每个 generation 的模型分别计算，任一模型无法定价时省略金额。

当前上下文采用已验证的 Cursor protobuf 字段布局；不支持的布局、数据库读取失败、损坏的完整 journal 行、超过 16 MiB 的 journal 等情况均返回未知。尚未写完的最后一行留待下次读取。当前数据由既有卡片、Dashboard 和用量账本入口使用，仍遵循机器人的用量显示设置。

## 验证

```sh
bun run build
bun run test -- test/cursor-usage.test.ts test/hook-command-compiled-form.test.ts test/fs-policy.test.ts test/cost-calculator.test.ts test/cost-calculator-cache.test.ts test/cost-calculator-pricing.test.ts test/minimax-usage.test.ts test/cursor-transcript.test.ts test/cli-adapters.test.ts test/usage-ledger.test.ts test/usage-ledger-cost.test.ts test/sandbox-session-data-dir.test.ts test/workflow-cli.test.ts test/streaming-card-usage-arg.test.ts
```

测试覆盖真实 SQLite/WAL、原生 ID 匹配、压缩后上下文、缓存口径、重复回调、会话恢复、未知与损坏数据、真实 CLI 子进程分派、用户 hook 保留，以及普通／无消息权限沙盒的自身文件授权。

Linux 上使用 Cursor Agent `2026.10.14-0f9edde`、`claude-opus-5-5-high`，在隔离 HOME／配置／数据目录里验证了本实现的 hook 安装、回调写入与数据库读取。首轮输入 14,360、输出 4；停止进程后按同一原生 ID 恢复，第二轮输入 14,541、输出 4；累计为输入 28,901、输出 8，第二轮当前上下文为 14,545 / 300,000。测试未启动 Botmux daemon，未发送飞书消息，也未修改现有服务配置。Linux bwrap 实跑和飞书客户端显示仍未验收。
