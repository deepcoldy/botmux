# Workflow 的冻结启动参数

`botmux workflow approve-dag <runId> --working-dir <absolute-task-directory>` 在首次 Gate-2 授权时把目录写入每个使用者的 bot snapshot，包含循环内继承或显式选择的 bot。省略参数保留已有 bot 默认目录解析。已发布 run 的再次批准只补完原状态；后来的参数或 bots.json 不能改写原快照。

配置的 `wrapperCli` 与 CLI、路径、模型和 sandbox 配置一起冻结，在临时 Worker 的 init 中使用。旧快照缺少 wrapperCli 时保留原启动行为；未知字段/非字符串继续由严格 reader 拒绝。新增字段不改变 bot 配置、身份或权限，不选择新的模型或后端。

影响仅 Workflow v3 的快照与启动参数传递。source/standalone 的进程生成、后端选择和清理机制保持已有实现。回退到旧 reader 前应排空使用新快照的 run；不能用旧快照覆盖运行过程中产生的新结果。
