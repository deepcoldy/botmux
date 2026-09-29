# 新会话的飞书工具身份

正常由 Botmux 创建的新会话会自动将 `lark-cli` 绑定到当前 bot 配置中的 App ID 和品牌。不增加 UI 配置，不修改个人终端的默认 profile。

## 使用

```sh
# 默认使用当前机器人的应用身份
lark-cli docs +fetch --doc <文档链接>

# 需要个人资源或 bot 无权时，使用当前用户对同一应用的授权
lark-cli docs +fetch --doc <文档链接> --as user
```

应用固定，`--as user` 只改变执行者，不改变 App ID。尚未授权时，可以在当前会话发 `/login`，或由 agent 按操作申请权限：

```sh
botmux auth request --scope "docx:document:readonly" --json
botmux auth wait --request-id <返回的请求ID> --json
```

bot 读取失败后，agent 可根据任务与错误尝试 user。包装器不会自动重放业务命令；写入超时或部分成功时，应先确认结果，避免重复创建或发送。

## 范围

- 仅功能上线后按标准流程创建的新本地会话接入。已接入的会话再次恢复时保留绑定。
- 旧会话、不按标准方式启动的会话、远端后端、adopt、外部 app-server、workflow 和无飞书通道的会话沿用原有行为。
- 不自动迁移、重启或显示旧会话迁移提示，不改变旧会话的 `/login` 和按用户鉴权流程。
- Linux 与 macOS 使用相同的应用/用户解析路径，没有针对 macOS 的 user 拒绝规则。

## 实现

新会话启动时生成自己的工具入口和配置，记录当前 App ID、品牌与真实 lark-cli 路径。botmux 用已有会话上下文确定当前请求者，并查询该用户在同一应用下的授权。会话入口的访问密钥只用于绑定应用，不引入调用进程扫描、回合证明或后台进程追踪。

工具启动前清除继承的旧应用/用户凭证变量，再注入本次 App ID、品牌及 bot 或 user 凭证。用户 token 不得跨应用使用，未知用户不会借用 owner 或机器默认账户。CLI 原有 stdout、stderr、退出码和工作目录保持。

bot 调用从当前应用的 SDK 获取 tenant access token，复用其缓存和到期刷新，再通过 `LARKSUITE_CLI_TENANT_ACCESS_TOKEN` 交给工具；不向工具传递 App Secret，也不在会话启动时固定 token。凭证获取失败时拒绝执行。

工具路径按合并后的 bot `env.PATH` 解析。参数取值类型和 `--as` 支持情况取自该 lark-cli 二进制的本地 `--help`，包括快捷命令和原生 API 命令；无法识别的参数在执行前报错，不能靠猜测删除业务参数。`event list/schema`、`doctor --offline` 等本地命令不取凭证，也不追加 `--as`。

绑定入口、配置和 shell 启动路径使用真实目录路径。Linux 文件沙箱同时保留会话入口和 bot PATH，直接执行、sh、bash 以及通过符号链接配置的数据根使用同一绑定。

已有 signed dispatch 验证通过的跨机器人任务保留其原请求者：新入口按原 turn 使用已验证的目标应用用户和工具许可，再查询目标应用自己的用户授权。目标访问/工具许可被拒、授权缺失或撤销时沿原任务回报阻塞；后续普通消息不继承该委派。

该功能解决标准新会话默认身份不明确的问题。文件沙箱、既有访问控制和独立 MCP 的凭证规则仍按原有机制运行。

## 验证

覆盖新/旧会话分流、同应用 bot/user、Feishu/Lark 品牌、缺少授权、参数冲突、macOS 无进程校验依赖、真实 runner 与 worker、登录 shell 和编译态入口。真实资源访问仍取决于应用 scope、用户授权及资源共享权限。
