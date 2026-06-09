# 测试套件基准 & 提速

`pnpm test`（单元测试）从 **142s 降到 ~10s**（约 **14×** 墙钟；串行总工作量 142s→84s，−41%），不改变任何一条断言、不牺牲覆盖率。本文记录优化手段、量化方法和复现实验。

## 优化前的瓶颈

全量单测有 264 个文件、约 3900 个用例，但 `pnpm test` 当时很慢，根因有两个：

1. **全局串行。** `vitest.config.ts` 里设了 `fileParallelism: false`。它本意是稳住**浏览器 e2e**（共享一个 daemon + 单个登录态浏览器，并发会互相干扰，见 commit `27318ab`），却把 264 个纯单元测试也一起锁成单进程串行。16 核机器上 CPU 利用率长期只有 1 核。

2. **一个热点文件吃满墙钟。** `test/write-input.test.ts` 单文件 **~69s**，是次慢文件的 ~10 倍。它的 93 个用例逐个真实等待适配器 `writeInput()` 的「提交确认」时序——按 Enter 前的 `submitDelay`、轮询 CLI history/transcript 的 budget（claude 4×800ms、coco/codex 数百 ms…）。即便开了并行，整套墙钟也会被这一个文件门控。

## 优化手段

### 1. 拆分 unit / e2e 两个 project，单测并行

`vitest.config.ts` 改用 `projects`：

| project | 匹配 | 执行 | 入口 |
| --- | --- | --- | --- |
| `unit` | `*.test.ts` | **并行**（forks，每文件一进程） | `pnpm test`（默认） |
| `e2e` | `*.e2e.ts` | **串行** + globalSetup | `pnpm test:e2e` / `test:codex` 等（opt-in） |

并行对单测是安全的：绑端口的测试都用 `listen(0)` 临时端口；`process.env` / `process.chdir` 的改动在 forks 下按文件进程隔离。实测并行前后**断言结果逐一致**（同样的预存失败、同样的通过数）。

`pnpm test` 现在 `--project unit`，默认不再跑需要真实 CLI / 浏览器的 e2e。

### 2. 集中式可缩放延时 `BOTMUX_TIME_SCALE`

把各适配器里重复了 12 份的 `function delay(ms)` 收敛到 `src/utils/timing.ts`，并引入一个全局时间缩放因子：

```ts
// 默认 1：生产行为逐字节不变（env 未设时 scaleMs 原样返回、delay 等价旧写法）
export function scaleMs(ms: number): number { /* ms * BOTMUX_TIME_SCALE */ }
export function delay(ms: number): Promise<void> { /* setTimeout(scaleMs(ms)) */ }
```

适配器的 `submitDelay`、逐行打字节流、以及轮询 budget（`Date.now() + scaleMs(timeoutMs)`）全部走它。

`test/write-input.test.ts` 用 memfs mock 了 `node:fs`——文件写入是**同步**的，提交标记在轮询开始时就已就位，真实等待纯属浪费。该文件设 `BOTMUX_TIME_SCALE=0.1`，把所有延时/budget 压缩到 1/10，**不改变代码走的任何分支**。少数自带真实时序编排的用例（定时追加 transcript）按同一因子缩放自己的延时，保持与（同样缩短的）budget 的相对顺序。

> 生产默认 `BOTMUX_TIME_SCALE` 未设 = `1`，与优化前完全一致。这是个测试/运维可选旋钮，不是行为变更。

结果：`write-input.test.ts` **69s → ~7s**，93 个用例全过（含被缩放的时序编排用例）。

## 基准工具

```bash
pnpm test:bench                     # 跑一次（生产配置），打印最慢文件 + 并行效率
pnpm test:bench --compare           # 串行 / 并行 / 并行+缩放 三档对比 + speedup
pnpm test:bench --top 25            # 调整最慢文件展示条数
pnpm test:bench --json out.json     # 结果落盘，供 CI 消费
pnpm test:bench --threshold 30      # 墙钟超 30s 则 exit 1（CI 回归闸）
```

脚本：`scripts/bench-tests.ts`。它用 `--reporter=json` 解析每文件耗时，报告墙钟、各文件耗时之和、**并行效率**（= Σ文件耗时 / 墙钟）、最慢文件占比，并能输出三档对比与 speedup。

## 实测结果

单测 project，16 核 / macOS，264 文件 / 3932 用例，`pnpm test:bench --compare`：

| 配置 | 墙钟 | 相对基线 | 并行效率 | 最慢文件 |
| --- | --- | --- | --- | --- |
| 串行，缩放 OFF（= 优化前） | 142.3s | 1.00× | 0.7× | write-input **69.0s**（占 48%） |
| 并行，缩放 OFF | 70.6s | 2.02× | 1.7× | write-input **68.9s**（占 98%，门控） |
| **并行，缩放 ON（第一轮后）** | **9.3s** | **15.3×** | 6.1× | write-input 7.2s、workflow-cli 6.5s… |

> 并行效率 = Σ各文件耗时 / 墙钟。串行下 <1 是因为墙钟还含每文件的模块加载/转译开销（未计入单文件"执行"窗口）；并行下работа重叠，效率 >1。

两个台阶清楚地分开了两类收益：**并行**把墙钟砍一半（被 write-input 门控，所以只有 2×）；**缩放**消掉那个离群文件后，墙钟才真正由并行决定，跌到 ~9s。缩放后墙钟由「最慢的若干个 ~5–7s 文件」决定，不再被单一离群文件门控。

## 预存失败（与本次优化无关）

`seed-adapter` / `claude-code-cwd` / `card-integration` 共 3 文件 12 用例，在**优化前的原始代码、串行、原配置**下同样失败——主要是 macOS 把 `/var` 软链到 `/private/var` 导致 realpath 断言不符。本次改动前后失败集合一致，未引入新失败，也未顺手修这些既有问题（超出范围）。

> 上表中并行档偶尔多 1 个失败（13 vs 12）：是 `card-integration` 那个本就在失败的文件里有个 IPC 用例在高并发下抖动（端口/时序敏感），与本次提速无关，复跑即恢复。

## 第二轮（纯等待消除）

继续削掉两个「纯等待、不吃 CPU」的热点：

- **`file-lock.test.ts`** 的「does not break a lock held by a live PID」单测死等 `MAX_WAIT_MS=5s` 超时。给 `withFileLock` 加可选 `{ maxWaitMs, minStaleAgeMs }`（默认值不变，纯增量 API），测试注入 `maxWaitMs: 500` —— 被测行为（不抢活锁 + 抛 timeout）与超时长短无关。**5.4s → ~0.5s**。
- **`test/write-input.test.ts`** 的 `BOTMUX_TIME_SCALE` 由 `0.1` 调到 `0.05`（memfs 同步，余量充足：confirm budget 160ms vs 编排 42ms）。**7.2s → ~3.6s**。

这两个文件不再是瓶颈。但 16 核**墙钟没怎么变（~10s）**：消掉它们后，瓶颈转移到下面这簇 spawn 测试的 CPU 争抢上。真正的收益体现在**总工作量**——串行（无争抢，≈ work）从 **142s 降到 84s（−41%）**，这直接加速少核 CI（墙钟 ≈ work ÷ 核数）。

## 当前瓶颈 & 后续可优化项

16 核墙钟的下限（~10s）现在由 8 个**真实 spawn `node dist/cli.js`** 的集成测试门控（`workflow-cli` / `workflow-cli-ls-tail` / `preset-export-cli` / `worker-budget-cli` / `workflow-c0-isolation` / `seed-adapter` / `hook-installer` / `tmux-env-isolation`）。它们 **CPU-throughput-bound**：14 个 vitest fork + 每用例再 spawn 一个 node 子进程，16 核被超额订阅，单文件耗时在 5–9s 间抖动。

- **（大杠杆，需取舍）in-process 跑 CLI。** 从 4138 行的 `src/cli.ts` 抽出可测的 `main(argv): Promise<number>` 入口，让这 8 个文件直接进程内调用而非 spawn `node`。能同时砍掉串行总工作量和并行争抢，但牺牲「真实启动二进制 / argv 解析 / 退出码」的保真度，是较大的重构。
- **（CI 侧）`vitest --shard=i/N`** 跨 runner 分片，缩短 CI 墙钟（不影响本地）。
- `file-lock` 剩余的过期语义测试（`MIN_STALE_AGE_MS` 等待，~0.2s）属正确性敏感原语，不再压。
