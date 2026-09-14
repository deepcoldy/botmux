# 会话级 Codex 实例

同一个飞书 Bot 可以为普通新会话按静态权重选择 Codex 登录目录。后续消息、失败重试、冷恢复及 fork 使用已保存的实例，不重新抽签。默认路由通过 `defaultInstanceId` 明确指定账号目录。

这项能力固定的是目录与 CLI runtime，不保证账号不可被管理员换掉，也不提供额度轮换、账号共享或安全沙箱。

## 配置

在 `bots.json` 的目标 Bot 条目中配置：

```json
{
  "cliId": "codex",
  "backendType": "tmux",
  "codexInstancePool": {
    "enabled": true,
    "defaultInstanceId": "a",
    "scope": "ordinary-feishu",
    "strategy": "random",
    "instances": [
      { "id": "a", "codexHome": "/data/codex-accounts/a", "weight": 3 },
      { "id": "b", "codexHome": "/data/codex-accounts/b", "weight": 1 }
    ]
  }
}
```

`codexHome` 必须是本机显式绝对路径，不展开 `~` 或环境变量；不是工作仓库目录。ID → 目录映射只维护在这里。省略 weight 为 1；只接受正安全整数。3:1 表示新会话概率为 75%:25%，不承诺小样本比例。

普通会话池仅接受本机 Codex + tmux；不支持 wrapper、非空 bot env、sandbox/readIsolation 或 external app server。多个实例共用顶层 CLI runtime / executable 配置。普通飞书来源由 daemon 标记，不从消息内容或消息 ID 推断。

| 创建方式 | 路由 |
| --- | --- |
| 普通飞书新话题、新 chat-scope 对话、显式新建的 `/repo` 会话 | 池启用时加权随机，否则默认实例 |
| schedule、HTTP、会议接收、入群自动开工、文档评论等 | 默认实例 |
| workflow 新 run | run 的 BotSnapshot 冻结默认实例；保持 workflow 原有内部 PTY 执行方式，不意味着普通会话池支持 PTY |
| 已有会话、恢复、fork | 已保存绑定；旧会话迁移 legacy 路径，不随机 |
| 外部 `/adopt` / Codex App 通知接管 | 不参与实例分配；已绑定会话不能被原地接管 |

`enabled=false` 只停止随机分配，新会话仍使用默认实例。单个实例的 `enabled=false` 只退出随机候选，不撤销已有会话或默认路由。分配前排除本地预检不可用的随机候选；全部候选不可用或默认实例不可用会报错。一旦选定并持久化，后续启动失败不会换号。

## 初始化、登录、检查

新目录必须显式初始化，普通启动不会创建目录，也不会复制全局配置或凭据：

```sh
botmux codex-instances init --bot <appId> --instance a
botmux codex-instances login --bot <appId> --instance a
botmux codex-instances check --bot <appId>
```

登录只为该子进程设置 `CODEX_HOME`，使用 `codex login --device-auth`。已有登录过期时，用 `login ... --reauth` 明确对**原账号**重新授权；另一个账号必须使用新实例目录。Botmux 会读取本地凭据结构作预检，但不输出、记录或复制 token，不自动验证账号身份未变化。

配置实例池的 Bot 在创建会话时即冻结 Codex，所以包括首条 `/cli` 消息在内，也不能再切换该会话的 CLI；无实例池的 Bot 保留原有 `/cli` 选择能力。外部 adopt / Codex App 通知沿用独立的外部会话入口，不参与实例分配，不能接管已绑定实例的会话。

已有账号目录可直接引用：目录应由运行 daemon 的用户拥有，权限 0700；`auth.json`、`config.toml` 为该用户的普通单链接文件，权限 0600。拒绝 leaf symlink、目录重叠和不同 Bot 共用目录。`config.toml` 根部必须显式设置：

```toml
cli_auth_credentials_store = "file"
```

初始化已有目录只校验，不覆盖旧数据。检查命令显示配置路径、规范路径、默认标记、有效权重、会话冻结路径及路径变更；`local-credential-present` 仅表示本地文件结构可用，**不是远端登录有效或账号身份已验证**。身份显示 `unverified`。需要的模型/provider/skills 配置由管理员在各 home 中准备；不会整体同步全局 `.codex`。MCP 的 Botmux 自有块在实例根带锁更新。

## 修改配置与恢复

修改权重、默认 ID 或 codexHome 仅影响之后的新会话。旧会话继续旧的规范路径；缺失旧目录/原生 transcript 会明确失败，不搜索其他实例或清空上下文。运行同一路径的 CLI 可以正常升级，但本功能不冻结二进制版本。

管理写入口拒绝删除仍有可恢复会话引用的实例（包括 closed 行），建议只关闭随机分配。不要手工绕过检查删除配置或目录。所有旧记录迁移成功后才允许新分配；歧义路径报错。SQLite 事务和行 compare-and-set 保证进程崩溃/正常重启恢复绑定，不额外承诺突然掉电的持久性。

`legacy` 也有意保持绑定：它的 `instanceId=null` 表示原有全局/每 Bot 目录，不表示未绑定。若只有 legacy 会话引用，可以移除整个池；之后即使把 Bot 默认 CLI 改为 Traex 等，已迁移会话仍使用冻结的 Codex runtime/home，运行中检查和重启恢复都不会因默认 CLI 不同而自动关闭它们，已有 pane 也保留。这与从未启用过实例池的未绑定会话不同，后者继续沿用原有 mismatch-close 行为。

需要让老话题改用新的默认 CLI 时，明确 `/close` 旧会话，再创建新会话；恢复旧 session ID 仍沿用原绑定。删除池配置不等于撤销账号访问或终止老进程，停用账号前必须显式关闭相应会话。只要还有 pool/default 会话引用实例（包括 closed 但可恢复的记录），移除池仍会被配置写保护拒绝。

tmux 保存非敏感 binding/runtime identity；恢复发现标记不一致或丢失时暂停，保留原 pane，不自动杀掉它。`/status` 和 Dashboard 显示实例 ID / source，完整 home 只在本机检查中显示。

关闭功能不等于可安全降级旧二进制：旧版本不识别绑定，会错误恢复到全局目录。需保留 binding 读取能力，或先受控停用/隔离所有实例会话并备份。

## 验证边界

自动化测试使用临时数据根、假凭据、受控子进程和 mock worker 验证规则、持久化、workflow init 与兼容性；真实 worker IPC → workflow PTY → 假 Codex 验证冻结 HOME、认证环境清理及缺失 HOME 时拒绝启动。

此外，经独立授权在 macOS 本机用两个真实账号完成冷恢复和飞书端到端测试：同一个 Bot 的两个新话题分别命中 A/B，实际 CLI 进程环境与绑定一致，均收到最终回复；原话题续聊保持实例和原生会话 ID。详见 [验收记录](plans/session-cli-instances-acceptance.md)。未验证 Linux 实机、突然断电或真实额度耗尽；功能不会自动登录或自动换号。
