# 飞书发起 TRAE CLI 企业登录

`/dashboard trae-login` 复用已有管理员命令组与 sessionless 路由，在没有 AI 登录态或活跃会话时仍能调用。管理员打开私聊授权链接后，将浏览器最终的 `127.0.0.1` 回调 URL 在同一机器人私聊交回，再用 `status` 核验原生 CLI 的退出结果。`cancel` 结束请求。成功后由用户恢复原话题并重发消息，不自动重复之前可能已经执行的输入。

## 原生协议证据

在独立 `TRAE_HOME` 上实际运行 TRAE CLI 0.217.0 的 `login --enterprise`，观察到企业授权 URL 与 `auth_callback_url=http://127.0.0.1:<临时端口>/authorize`。CLI 明确支持把远程浏览器的完整回调 URL 输入 stdin。探测仅截获协议后结束，没有退出或替换当前机器账号。0.216.0 也已观察到同一远程输入提示。

## 目标和身份

v1 仅 Linux 宿主的原生本地 `traex` 配置可用，依赖 util-linux 的 flock/setpriv；macOS/Windows 不开放该入口。远程后端、wrapper/Forge、文件沙箱、readIsolation 或设备凭证隔离均拒绝，避免修改错误的账号目录。按 receiving app 的管理员名单核验真人发送者；请求绑定 app、open_id、随机 request ID 和规范化 TRAE_HOME。完成输入必须在 p2p 私聊；链接投递失败时取消请求，公开消息不包含授权 URL 或回调内容。管理员配置的 TRAE_HOME 和 envPolicy/envUnset 参与目标解析。共享该目录的会话使用同一 TRAE 账号。

## 生命周期和进程

状态为 starting、pending、verifying、succeeded、failed、cancelled。原生 CLI 负责凭据校验与保存，BotMux 不读取或复制 token，不先 logout。请求只保留在 daemon 内存；超时、cancel 与正常 daemon shutdown 都结束原生登录进程。跨进程文件锁覆盖整个原生登录。只有观察到支持的真实授权交互后原生进程退出 0 才报告成功，stdin 写入和已有凭据文件都不是成功证据。请求 ID、防端口/路径替换、超时检查防止旧回调进入新请求。

## 影响范围和验证

新增服务与 `/dashboard` 子模块；共享改动为 daemon 两个消息摘要的回调打码与 shutdown 清理。不改变其他命令的路由规则或已有 CLI 适配器。Linux 原生登录持有内核 flock 锁，setpriv 设置父进程死亡信号；静态 shell 只校验父 PID 后 exec，原生路径通过位置参数传递。macOS/Windows 不开放 v1 入口，其它功能不变。

行为测试覆盖没有/关闭/运行中会话的路由，非管理员与机器人拒绝，私聊投递失败，群回调拒绝、相同请求重试、跨用户/应用隔离、不同 daemon 竞争、错误端口/路径、过期回调和原生失败。真实完成授权仍需管理员本人在企业 SSO 登录页操作；源码/协议探测不等于已完成真实账号登录。

## 对抗复核后的边界修复

实际探针发现父 daemon 强杀后 native 仍存活且原锁可被破除，因此新增独立监督 runner：它持有跨进程锁，父 stdin EOF、期限到达或取消时终止 native，等待真实退出后才释放锁。对请求执行定期权限/配置复核，并在 challenge 发布、callback 提交和终态结算重新检查；终态不能仅依赖计时器是否已经调度。取消按 app、owner、不可变请求 ID 定位，旧 DM 投递失败只取消旧请求，目标配置切换也能取消旧目录请求。

回调在 live 路由中作为不可恢复的控制输入处理，跳过 primary/shadow 正文存储；durable serializer 仍对所有调用作兜底打码，保留消息身份元数据但不保留凭据。topic.new/thread.reply hook 和消息日志摘要也打码。命令只处理当前 daemon 的内存请求，重启后不重放 callback。原有 message ID 去重仍保留。

本机扩大回归时另有 4 条既有测试因 /tmp 与真实缓存路径的软链接规范化产生断言差异；在未修改基线上得到完全相同的 4 条失败（cli-adapters 三条 DSH bridge 路径、trigger-user-auth-policy-off 一条 wrapper 路径），不把这些基线失败标记为本功能通过。

第二轮实机探针又发现监督进程自身强杀后会遗留 native，因此最终方案让 native 通过 flock --no-fork 继承内核锁，并以 setpriv --pdeathsig KILL 绑定父进程死亡；设置后核验 PPID，覆盖父进程在信号设置之前死亡的窗口。普通讨论正文中的命令示例不触发 callback 过滤，仅实际命令头和回调输入受影响。

本机对 bare `traecli login` 的独立目录探测也观察到同一企业授权域、/authorize loopback 回调和 stdin 远程输入指引，所用流程与本机默认登录一致。隐私分类按实际 complete 命令头判断，即使缺请求 ID 或 URL 格式错误也打码；语法校验在控制处理器内完成。历史恢复跳过敏感 callback，REST body.content 的重复正文也打码。
