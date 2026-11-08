# 受管不可变目录的引用屏障

此能力供部署方的后台回收器使用。Botmux 不启动定时扫描、不递归删除用户目录，也不关闭会话。
外部回收器决定受管根、保留规则和候选；Botmux 协调引用发布与精确目录 inode 的退役。

## 接入与发布

精确二进制的 `botmux capabilities --json` 必须声明 `managed_directory_retention_v1`。
在 daemon 启动前，在权威 `bots.json` 同目录创建仅本人可读的 `.managed-directories.json`：

```json
{
  "schemaVersion": 1,
  "statePath": "/srv/runtime-maintenance/state.json",
  "roots": [{ "path": "/srv/runtime/versions", "hashLength": 40 }]
}
```

根只包含按完整 40/64 位十六进制散列命名的不可变版本；所有参与者使用相同 `statePath`。
状态父目录须事先创建并对运行账号私有。配置在进程内冻结，修改它要求重启全部参与者。
必须停止无此能力的旧进程后再启用，不能仅更新 CLI 二进制便宣称旧 daemon 已受保护。
未配置的普通安装不参与该协议。声明配置后解析或写入错误会明确失败，不忽略引用。

Botmux 的以下持久写入均参与屏障，新引用在发布前持久登记，未提交事务在
成功 COMMIT 或 ROLLBACK 前保持登记；COMMIT/END 失败仍保留登记，直到重试成功、
回滚或连接关闭。扫描开始时继承在途登记：

- 会话主库 `sessions.db`（全部 `sessions` 表 INSERT/UPDATE 路径，含离线 CAS 与恢复回填）
- 首次启动的 JSON→SQLite 导入：登记覆盖 staging 库打开、构建到 `rename` 发布的全程，
  打开失败也释放登记
- 权威定时任务库 `schedule-authority.sqlite`（direct/delegated 新建、编辑、legacy 回填）
  及其 JSON 投影 `schedules.json`
- Bot 配置 `bots.json`（setup、daemon、dashboard 全部原子写路径）
- Skill 注册表与本地 Skill 源复制
- headless 会话记录、文档订阅注册表、白板 meta 与索引

精确 CAS 没有改变目录引用时不产生维护状态写入。引用了**当前不存在**的版本目录
（从未安装、已隔离、从别处恢复的备份）只跳过该条登记，不会让整快照写入失败；
而指向仍存在但已退役 inode 的引用仍明确拒绝。扫描不持有 Botmux 锁；只有登记、
退役提交和原子改名使用短互斥。

配置根可以经过符号链接的父目录（如 `/srv/versions` 实际指向 `/data/srv/versions`）：
加载时按 realpath 归一化，literal 与 real 两种拼写在登记、退役和 `resume` 中等价。

## 收集协议

以下命令均从标准输入接收 JSON，成功时标准输出返回 `ok: true` 与同一 protocol。
退出码非零、JSON 不完整或无法读取任意引用源时，调用方不得递归删除正式目录。

1. `botmux managed-directories begin`，输入 `{"protocol":"botmux.managed-directories.v1"}`，得到本轮 `id`。
2. 在锁外完成所有权威持久引用和进程引用的扫描，构建不可变候选的传递引用图。
3. 在外部安装锁内调用 `botmux managed-directories retire`：

```json
{
  "protocol": "botmux.managed-directories.v1",
  "id": "begin 返回的代次",
  "retained": ["/srv/runtime/versions/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  "candidates": [{
    "path": "/srv/runtime/versions/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "dev": "1",
    "ino": "42",
    "ctimeNs": "1234567890000000000",
    "references": []
  }]
}
```

提交合并扫描期间的新引用并求闭包。设备号、inode 和纳秒 ctime 均按十进制字符串传递，避免 64 位 inode 被 JSON 浮点数截断。全部候选身份校验成功后，先持久化退役决定，再原子改名为
`.gc-<hash>-<dev>-<ino>`，返回 `quarantined`。递归删除这些隔离目录由外部回收器在锁外限速执行。
不可对名称相同、inode 不同的新安装版本套用旧删除决定。

进程被杀或改名只完成一部分时，`botmux managed-directories resume` 继续已有退役决定。
输入可带一个精确 `path`，供安装器在重新使用该版本前隔离旧 inode；调用者仍须持有安装锁。
不存在或已经换成新 inode 的原路径不会再被移动。该命令不扫描会话，也不递归删除。
新一轮 `begin` 会使旧扫描的提交失效；死亡写入者的登记按 PID 与进程出生身份清理。

## 边界

初始扫描仍由调用方证明完整，包括休眠会话、引擎恢复状态、当前配置、任务、备份和存活进程。
该协议只协调受控写入者；手工修改持久状态、任意外部程序新建引用，以及篡改不可变版本均不受保护。
部署方的安装器也必须使用安装锁，并在复用已退役版本前完成 `resume`。
不能以协议成功推断物理空间已释放，实际删除结果和运行影响须由回收器记录并验收。
本协议只适用于本地主机/共享文件系统上的目录，不承担远端 Mojo/Riff 工作区的生命周期。

首次启用建议先干跑：全部参与者升级重启后执行一轮 `begin`/`retire`，核对
`quarantined` 为空（或仅含确认无用的候选），再让回收器删除隔离目录。

测试使用临时目录、真实 SQLite 事务和自建写入进程；不访问飞书或重启现有 daemon。
