# 插件服务的内置 supervisor

插件服务复用 `FleetSupervisor` 的进程管理，不再依赖 PM2 CLI、God daemon 或运行时打包 PM2 helper。插件入口的 `pm2` 配置字段暂时保留，兼容已有插件；字段名不再代表实现。

## 生命周期与兼容性

- 插件使用独立的 `FleetSupervisor` 实例。`plugin service start` 不要求主 fleet 已运行，普通 bot 重启不影响插件，`--with-plugin` 继续由现有 CLI 编排。
- 支持 `script`、`args`、`cwd`、`env`、`autorestart`、`killTimeoutMs`；linked 插件继续观察 `dist/botmux-build`（不存在时观察 `dist`），按 `watchDelayMs` 合并重建事件。停止服务同时取消 watcher 和待重启计时器。
- JavaScript 服务使用当前 Node/Bun 运行时。单文件版使用自身内嵌 Bun 执行安装到磁盘的脚本，不需要另装 Node、Bun 或 PM2。其他入口须为可执行文件（脚本需有效 shebang）。插件使用的原生扩展仍须兼容所选运行时。
- 单文件版通过私有 preload 在插件代码执行前移除 `BUN_BE_BUN` 启动开关，保留正常 `argv` / `require.main`，避免插件再次调用 botmux 时误入 Bun CLI。
- `auto` / `manual` 服务的选择规则不变。重复启动相同在线配置不会换 PID；配置变更先确认旧子进程退出再启动新进程。
- 启动确认表示操作系统成功创建进程，不是业务健康检查；`service status` 与现有健康 URL 仍用于观察业务状态。

## 状态与故障恢复

状态位于 `~/.botmux/plugin-supervisor/`：

- `desired.json`：服务定义和显式运行意图；目录权限 `0700`、定义文件 `0600`，因为环境中可能含插件私有 token。
- `state.json`：当前子进程及其启动身份；`result.json`：对应请求版本的执行结果。
- `supervisor.log`：宿主诊断；`logs/<plugin-id>-out.log` 与 `-err.log`：插件标准输出与错误输出。

CLI 持有服务生命周期锁，原子发布目标状态，并等待 supervisor 确认。停止确认必须等到子进程退出；超时升级为 SIGKILL，仍无法确认则报错。卸载只有在成员及重启计时器移除后才清理插件文件。损坏的状态和未确认请求都不能被当作“已停止”。

supervisor 的 lifetime lock 防止重复宿主。宿主异常退出后，下次显式服务操作会启动新宿主；新宿主先核对持久化的进程启动身份（Linux 同时绑定 boot ID），回收自己上代的子进程，再恢复目标状态。已显式停止的服务不恢复，被复用的 PID 不发送信号。没有额外的系统启动项；整机重启后的启动仍由现有 botmux 启动流程负责。

## 从旧 PM2 服务迁移

若 `~/.botmux/pm2` 仍有活跃 God daemon，插件操作会返回 `plugin_legacy_pm2_running`，不会同时启动第二套服务，也不会擅自终止旧进程。请在维护窗口使用旧安装停止对应 PM2 fleet（例如确认该 HOME 只属于 botmux 后运行 `PM2_HOME="$HOME/.botmux/pm2" pm2 kill`），关闭可能再次拉起它的旧启动项，然后执行 `botmux plugin service start <id>`。

新安装不需要 PM2。旧版本桌面运行时的只读观察和既有迁移清理仍保留兼容代码，但不作为新插件服务的运行依赖。

## 验证入口

`test/plugin-supervisor.integration.test.ts` 使用隔离 HOME 和真实子进程覆盖生命周期、重启计时器取消、强制停止、热重载、宿主崩溃恢复和失败保护。`scripts/smoke-bun-binary.mjs` 在仓库外安装真实插件并验证 HTTP 响应、运行中卸载拦截、停止、更新和卸载；还断言宿主优雅关闭后真正退出并释放 lifetime lock，启动异常也清理锁并退出 1，不能以强制清理代替成功。运行 `bun run build` 后用 `bun run verify:binary` 执行同一套编译版检查。
