# Workflow v2 run 静态归档

v2 runtime 已下线；历史 run 可一次性固化成私有、内容寻址的静态归档。归档不是可执行资产，也不保留执行能力；它只保存审计字节与冻结的 ops projection。

## 命令

```bash
# 零写入扫描：必须先确认所有 run 已终态
botmux template archive-runs

# 创建归档；发布后自动执行静态校验 + live source/projection 对账
botmux template archive-runs --commit

# 查看归档时重新执行静态 + source-aware 双关校验
botmux template archive-runs --verify sha256:<digest>

# 部署“v2 入口退休”版本并停止旧 daemon 后，原子冻结源目录
botmux template archive-runs --retire sha256:<digest> --ack-daemon-stopped
```

默认源目录为 `BOTMUX_WORKFLOW_RUNS_DIR`，否则为 Botmux durable dataDir 下的 `workflow-runs/`；归档默认写入同一 dataDir 下的 `workflow-archives/v2-runs/`。可用 `--runs-dir` / `--archive-dir` 显式覆盖。

## 归档契约

- 每个有效 run 的源目录逐字节复制到 `runs/<runId>/raw/`，并用删除前的 `ops-projection` 生成 `projection.json`。
- 无事件日志的历史残目录/文件也复制到 `residual/`，不会静默丢弃。
- `manifest.json` 覆盖全部目录拓扑（包括空目录）、文件长度和 SHA-256、终态 verdict、缺失的历史可选文件与 warning。
- `COMMITTED` 是最终 commit marker，认证 manifest；目标目录由 manifest content hash 决定。
- 目录强制 `0700`、文件强制 `0600`。归档包含参数、日志预览和绝对路径等敏感审计数据，不提供 dashboard/public reader。

## 发布与验证

发布在同文件系统 staging 中完成：严格预扫 → 安全 fd 复制 → 再次全量哈希与 projection → 写 manifest → 原子 rename → 写 commit marker → 静态 + source-aware 校验。任何 symlink、hardlink、FIFO/socket/device、坏 journal、非终态 run、并发修改或已有目标冲突都会 fail-loud；不会修复或覆盖源数据。

静态 verifier 不信任 manifest：它会独立遍历目录，拒绝 extra/missing/type/mode 变化并重算所有 hash。source-aware verifier 还会重算 live source 树和当前 ops projection。
原 source 已成功退休且路径为 `ENOENT` 后，`--verify` 自动退化为静态校验并明确输出 `sourceVerified=false`；只对真正缺失的路径这样处理，仍存在但不可读、类型异常或内容变化的 source 一律 fail-loud。

### 未提交的内容寻址目录

进程若在原子发布目录后、写入 `COMMITTED` 前崩溃，archive base 中可能留下一个
名称匹配 `sha256-<64 hex>`、包含 `manifest.json` 但没有 `COMMITTED` 的直接子目录。
用 `--verify <该目录>` 检查时，只有在 manifest 与目录结构检查后明确报
`ARCHIVE_NOT_COMMITTED` 时才按本节处理。它是崩溃证据，不是可验证归档；不要
手工补写 `COMMITTED`。源数据未变化时应先重跑 `archive-runs --commit`，让发布
协议校验并补齐 marker。

若源数据随后已变化，重跑会发布另一个 archive id，旧目录会继续保留。只有在
当前源的新归档已通过 `--verify`（`staticVerified=true` 且 `sourceVerified=true`）、
旧 digest 没有对应的 `v2-run-retirement-<digest>.json` receipt 或
`.<源目录名>.retired-<digest>` quarantine、并确认没有 archive/retire 命令并发运行
后，才可把旧目录移入权限为 `0700` 的人工隔离区，并按本地审计保留策略删除。
不要用目录年龄判断，也不要批量清理所有缺少 marker 的目录；工具不会自动 GC
这些内容。

## 退休源目录

`--retire` 不会直接删除历史字节。它与归档发布共用同一把
`.v2-run-archive-publication` 跨进程锁，并在锁内完成：校验已提交归档 →
第一次 source-aware 校验 → 紧接着第二次 source-aware 校验 → 原子 rename
为同级的 `.workflow-runs.retired-<archive digest>` → 对 quarantine 再做一次
完整 source parity 校验 → 在 archive base 写入 durable retirement receipt。

历史事件中的 `OutputRef.outputPath` 可能是原 run 目录下的绝对路径，所以 rename
之后禁止重新 replay projection（那会把合法旧路径误判成迁移漂移）。两次 rename
前校验负责证明 projection；rename 后及崩溃恢复只按 manifest 的 `rawRoot` 记录
逐项核对完整源拓扑与文件 hash，extra/missing/changed/迟到 append 都会拒绝。

rename 是唯一线性化点；没有 `rm -rf`。进程若在 rename 或 receipt 发布前后
崩溃，重复同一命令会从 source/quarantine/receipt 三者的持久状态幂等收敛。
receipt 不写入内容寻址的 immutable archive 目录。源目录不存在且没有任何
quarantine/receipt，或源目录确实为空时，命令返回 `nothing_to_retire`，不要求
归档，也不会创建 archive base。

`--ack-daemon-stopped` 是非空源的强制人工确认。文件锁只协调新版的 archive /
retire 命令，**不能阻止旧 daemon 通过已打开的 fd 继续追加 journal**。正确运维
顺序必须是：先部署已经关闭所有 v2 新运行入口的版本 → 停止/切走仍可能写 v2
run 的旧 daemon → 执行 `--retire ... --ack-daemon-stopped`。禁止在旧 live daemon
仍运行时执行退休命令。

## 源目录退休门

只有同时满足以下条件，才允许把原 v2 run 源目录退休到 quarantine：

1. 最新归档 `staticVerified=true`；
2. 对仍存在的 live v2 runs 执行校验得到 `sourceVerified=true`；
3. inventory 中不存在非终态 run；
4. manifest 覆盖所有 run 与 residual，warning 已人工审阅。
5. `--retire` 已产生 durable receipt，且原 source 已原子迁入 quarantine。

本地 SHA-256 用于发现损坏与普通并发修改，不宣称抵御同一 OS 用户主动同时篡改源和 manifest；需要防篡改审计时应使用签名或 WORM/远端存储。
