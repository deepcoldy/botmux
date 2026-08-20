# 指控B 真实进程复现：reviewer 第三种探针（修复前 / 修复后对照）

探针形状（reviewer 的第三种，也是唯一能逃过枚举的那种）：
`setsid`（新 session + 新 pgid）+ `env -u BOTMUX_MOJO_TREE_NONCE`（自身 environ 里没有 nonce）
+ wrapper 退出使其 **reparent 到 init**。handle 按生产方式在 turn 子进程**存活时**铸造，
随后 turn 子进程退出，于是 subtree 只剩这个隐形存活者。

harness：`test/probe3-harness.test.ts`（两个 worktree 各跑一次，同一份文件）
平台：Linux（devbox 127990）。**无 Darwin 真机，不宣称 macOS。**
worktree：修复前 `/tmp/weakhandle-baseline` @ c8122d89；修复后 `/tmp/weakhandle` @ 8d764534

## 探针确实是活的、且确实隐形（两轮完全一致）

```
PROBE3 handle_kind=tree-identity        <- weak handle，不是 unprovable
PROBE3 turn_alive=false                 <- 记录的 root 已退出
PROBE3 evader_alive=true                <- 逃逸者活着
PROBE3 evader_ppid=1                    <- 已 reparent 到 init
PROBE3 evader_pgid=<自身 pid>            <- setsid 生效，原 pgid 抓不到它
PROBE3 evader_has_nonce=false            <- environ 里 nonce 已被清掉
PROBE3 scan_ok=true
PROBE3 scan_members=[]                   <- 扫描成功，但一个成员都没枚举到
```

三路信号（同 pgid / nonce / 父子链）全部失效，扫描返回「干净」而进程活着。

## 修复前（c8122d89）—— 漏洞成立

```
PROBE3 verdict_proven=true
PROBE3 verdict_evidence=ABSENT(no evidence field)   <- 证据等级根本没被记录
PROBE3 release_threw=no
PROBE3 release_decision=void(no return value)
PROBE3 handles_left=0                               <- handle 被删除
PROBE3 blocker_retained=false                       <- device-isolation blocker 消失
PROBE3 evader_still_alive_at_end=true               <- 而进程还活着
```

即：**一次干净扫描把一个活着的、持有注入凭据的子树的隔离解除了**，
且 boundaryProof 全程为 false。这与 reviewer 描述的链路逐字吻合。

## 修复后（8d764534）—— 链路被切断

```
PROBE3 verdict_proven=true
PROBE3 verdict_evidence=scan-clean                  <- 证据等级被记录下来
PROBE3 release_threw=no                             <- 不抛错：会话仍可关闭
PROBE3 release_decision={
  "boundaryProof": false,
  "releaseAuthorised": false,
  "evidence": "scan-clean",
  "residual": { "deviceIsolation": true,
    "reason": "scan-clean is a diagnostic signal, not a boundary proof: a descendant
               that calls setsid, scrubs its environ and reparents to init is
               invisible to the scan" },
  "signalsStopped": true                            <- 只授权「停止重复发信号」
}
PROBE3 handles_left=1                               <- handle 保留
PROBE3 blocker_retained=true                        <- blocker 保留
PROBE3 evader_still_alive_at_end=true
```

唯一差异行就是判据本身：`handles_left 0 → 1`、`blocker_retained false → true`，
而 `release_threw` 两侧都是 `no` —— 修复没有把会话变成 unclosable，
这正是 reviewer 要求的第二种方案（只停信号 + 留 residual，不授权普通 closed row）。

## 与 Claims C-3 的对应

C-3 指出 blocker 的唯一判据就是 handle 是否在 store 里，因此「返回值里带 residual」不够。
本复现直接用 `hasUnprovenContainment` 取值验证了这一点：修复后是**真的没有走删除路径**，
不是只在返回值里声明了 residual。

## 复现命令

```
git -C /mlx_devbox/users/liaoxiao.333/playground/botmux-mojo worktree add /tmp/weakhandle-baseline c8122d89
ln -sfn /mlx_devbox/.../botmux-mojo/node_modules /tmp/weakhandle-baseline/node_modules
cp <harness> /tmp/weakhandle-baseline/test/probe3-harness.test.ts
cd /tmp/weakhandle-baseline && npx vitest run test/probe3-harness.test.ts   # 修复前
cd /tmp/weakhandle          && npx vitest run test/probe3-harness.test.ts   # 修复后
```

harness 源文件同目录：`probe3-harness.test.ts`（也已随 commit 进入 /tmp/weakhandle 的 test/ 下）。
