# Antigravity 零注入：zmx 与 scratch 支持（进行中）

目标：让 Antigravity 在零注入模式分别支持 zmx 后端，以及 PTY/tmux 的 scratch 沙盒。现有 scratch 框架不支持 zmx，组合使用不在本次能力范围内。现有拒绝门禁必须保留，直到各路径完成实现与验证。

## zmx

Antigravity 的 transcript 中无工具调用的 planner response 只是候选终态，后台任务及 stop hook 可以继续执行。现有实现需要终端当前视口证明空闲，才释放候选；zmx 的 history 包含滚屏且当前几何尺寸不可确定，不能把其中的旧 ready 标记当作当前状态。zmx tail 仅作变更信号，不是原始终端输出字节流，现有 ACP runner 的 OSC 控制帧也不能直接复用。

实现应提供可归属当前 session、generation 和 turn 的可靠完成证据，明确处理中间候选、后台任务、停止钩子、取消、断连和重连；证据不可用时保持 fail-closed。不得放宽共用的屏幕可信度检查。测试需覆盖旧 ready 滚屏、连续多轮、候选后续工作、终态丢失/重复，以及重启恢复。现有 ACP runner 依赖 OSC 控制帧，也不能使用 zmx；在可靠通道就绪前启动时明确拒绝。

## scratch

日志写入隔离视图，宿主侧读取必须定位同一个 session 的副本，而不是实际 HOME。除了 transcript，还需覆盖提交历史确认、`--log-file` 写入路径与读取路径、会话 ID 发现、CoT、usage、冷恢复和 reattach。Linux 容器内使用原生路径，宿主读取 merged 视图；macOS 的 `.gemini` 当前不是必需 clone，必须改为必需的 COW clone，失败时拒绝启动；CLI 与宿主均需指向该 clone。HOME 存在符号链接时，应先解析已存在的 HOME 再拼尚未创建的子路径，不能对不存在的完整路径仅做 lexical resolve。不得在隔离视图缺失时回退宿主历史。

符号链接解析必须考虑链出映射范围、EACCES/ELOOP 和缺失视图；不能对任意最近存在祖先直接 realpath 后回退宿主路径。需要在 Linux overlay 和 macOS clone 分别测试新会话、延迟创建、原生 ID、连续轮次、重启与缺失视图；测试需证明宿主会话数据未被改写，且并发会话不会互相读取。保留对 `zmx + scratch` 的明确拒绝。

## 验收

- 定向测试覆盖上述失败场景及其它 CLI、普通注入模式的回归。
- 在隔离测试环境使用真实 agy 验证首轮、多轮和恢复；不用现有 fleet 或用户的实际历史目录。
- 构建和测试通过后再开放对应能力门禁，并更新支持矩阵；现有配置在实现期间继续拒绝不支持的组合。
