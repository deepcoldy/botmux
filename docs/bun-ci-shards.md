# Bun CI 分片与文件耗时

CI 将 Bun 单元测试分到四个独立 runner，每片内部仍然每个文件启动一个 Bun 进程。
不合并多个文件到同一进程，以免模块 mock、HOME 与进程状态在测试文件之间泄漏。
模块注册语义不兼容 Bun 的文件继续由原有 selector 留给 Node/Vitest；分片只发生在
selector 计算出的完整 Bun 文件集合上。

分片复用 `scripts/duration-shards.mjs` 的按耗时分配算法，同时先启动片内的长文件。
存在 `test/bun-shard-timings.json` 时使用 Bun 自己的测量，否则用已提交的 Node
`test/shard-timings.json` 作首次估计。新文件按已知文件耗时的中位数估计。
耗时数据只决定分配，不决定是否执行；表缺失、过期或存在已删除文件不会漏掉测试。

本地完整命令仍为 `bun run test:bun`，不加分片参数时保留原文件集合与顺序。
单片复现以及可选的耗时输出：

```bash
bun run test:bun -- --shard=1/4 --timings-output=artifacts/bun-shard-1.json
```

`--shard` 和 `--timings-output` 由 runner 消费，不传给 `bun test`。
`test:bun:self-check` 保持独立，不接受分片或耗时输出，避免将自检误作完整测试证据。
本地报告供诊断使用；汇总仅接受带 GitHub CI 运行与提交标识的报告，避免把不同源码
版本的本地结果混成通过的证据。每次启动先把指定输出标记为不完整，启动失败不会
保留上次成功的报告。

每个完成的文件记录从进程准备、启动到清理的墙钟秒数，以及成功/失败和可选退出信号。
每次完成后原子更新 JSON；取消、超时或 worker 异常留下明确标记为不完整的 checkpoint。
失败文件的耗时同样保留，所有分片都用 `if: always()` 上传各自的
`bun-test-timings-1` … `bun-test-timings-4` artifact。

稳定的必需检查名仍为 `bun-test`。它首先要求所有分片成功，然后校验四份报告属于
同一运行、同一提交和同一完整文件集合，核对文件没有遗漏或重复、全部实际执行且成功。
缺报告、报告不完整、零测试文件或任一失败都不能形成通过的汇总。
通过后上传合并 artifact `bun-test-timings`，并在 Actions summary 展示最慢十个文件。

用一次全绿 CI 产生的 Bun 实测数据校准下一次分配：

```bash
gh run download <run-id> --name bun-test-timings --dir /tmp/bun-ci-timings
cp /tmp/bun-ci-timings/bun-shard-timings.json test/bun-shard-timings.json
git add test/bun-shard-timings.json
```

该表需通过普通代码评审提交；CI 只上传 artifact，不自动写分支。
也可下载四个原始 artifact，重新验证并生成同一格式的表：

```bash
gh run download <run-id> --pattern 'bun-test-timings-*' --dir /tmp/bun-ci-shards
node scripts/merge-bun-test-timings.mjs /tmp/bun-ci-shards --shards=4 --output=test/bun-shard-timings.json
```

调整分片数时同步修改矩阵、分片命令、展示名称和汇总脚本的 `--shards`；
`test/bun-ci-shards.test.ts` 核对这些配置的一致性。
