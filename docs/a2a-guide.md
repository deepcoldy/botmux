# Botmux 跨设备协作使用指南

这套能力用于把同一台机器或不同机器上的多个 AI 执行者放进一个真实飞书群，由一个监管者统一派任务、验收、处理求助，并把结果留在可追溯的交付记录中。

## 先记住两个概念

- **平台团队**：机器和执行者的可信名单，用来发现彼此、免去逐个授权。它不是飞书群。
- **目标群**：真正发生派任务、提交结果、求助和验收的飞书群。使用者、监管者和本次需要的执行者都必须在群里。

跨设备协作需要两者同时存在：先让机器加入同一个平台团队，再为具体目标创建一个真实飞书群。

## 1. 准备每台机器

Canary 期间，每台参与协作的机器安装同一个版本：

```bash
npm install -g botmux@canary
# 或
pnpm add -g botmux@canary
```

首次使用先完成本机机器人配置并启动：

```bash
botmux setup
botmux start
botmux status
```

然后在平台网页复制“绑定新机器”命令，在每台机器执行：

```bash
botmux bind <平台生成的绑定凭证>
```

在平台上把这些机器加入同一个团队。绑定和加入团队都不要求重启 daemon。

## 2. 创建目标群

跨设备场景优先通过平台的团队拉群能力创建群，也可以手工建飞书群。群里至少需要：

- 发起人；
- 一个监管者；
- 本次要用的所有执行者。

同一台机器上的机器人也可以用 CLI 建群：

```bash
botmux create-group \
  --name "目标名称" \
  --bot "监管者名称" \
  --bot "执行者名称"
```

不要把平台的“团队同步表”当作群聊。只有能在飞书消息列表中打开、能看到成员和消息的会话，才是目标群。

## 3. 启动监管者

通常由主控自动完成。手工操作时，在目标群创建监管会话：

```bash
botmux goal supervise \
  --chat-id "<目标群 chatId>" \
  --title "<目标名称>" \
  --brief "<目标、约束和最终验收标准>"
```

监管者负责拆任务、派任务、验收、驳回、处理求助和最终汇总。执行者不直接越级找人拍板。

## 4. 派任务

### 同一台机器

同机执行者可以直接使用群绑定的目录，或显式传本机路径：

```bash
botmux dispatch \
  --chat-id "<目标群 chatId>" \
  --title "实现功能 X" \
  --bot "<执行者 open_id>:执行者名称:开发" \
  --repo "/本机/项目路径" \
  --brief "完成 X，并补齐测试" \
  --acceptance-hint "测试通过且产物存在"
```

### 跨设备

不同机器的本地路径通常不同，所以不要传发送方的绝对路径。传 Git remote URL：

```bash
botmux dispatch \
  --chat-id "<目标群 chatId>" \
  --title "实现功能 X" \
  --bot "<远端执行者 open_id>:远端执行者:开发" \
  --needs-repo "https://github.com/acme/project.git" \
  --brief "完成 X，并补齐测试" \
  --acceptance-hint "测试通过且提交关键证据"
```

接收机器会根据 remote URL 在自己的目录中查找项目，而不是照搬发送机器的路径：

- 找到且 remote 匹配：直接在该目录启动执行者；
- 找不到：立即向监管者报告“缺少项目环境”；
- 不会弹仓库选择卡，也不会把任务一直暂存。

`/repo` 和 `--repo` 只适合同机路径预热；跨设备代码任务使用 `--needs-repo`。

## 5. 执行者提交结果或求助

完成后必须提交带证据的结果，不能只在群里说“完成了”：

```bash
botmux report \
  --task "<taskId>" \
  "已完成 X，测试通过" \
  --artifact "/监管者可读取的产物路径"
```

跨设备时，监管者通常读不到远端文件路径，优先提交自包含证据：

```bash
botmux report \
  --task "<taskId>" \
  "已完成 X，测试通过" \
  --artifact-text "test=测试命令与关键输出" \
  --artifact-text "result=核心结果或 diff 摘要"
```

卡住时使用求助，不要假装完成，也不要自行判失败：

```bash
botmux help \
  --task "<taskId>" \
  --kind access \
  --blocker "缺少项目环境或权限"
```

## 6. 监管者验收与处置

查看目标内的交付记录：

```bash
botmux delivery list --goal "<目标群 chatId>"
botmux delivery show --task "<taskId>"
```

核验证据后执行：

```bash
# 验收通过
botmux delivery accept --task "<taskId>" \
  --evidence-checked "已核对测试输出和产物"

# 驳回重做
botmux delivery reject --task "<taskId>" \
  --reason check_failed \
  --retry-brief "修复失败用例后重新提交"

# 需要人决定
botmux delivery escalate --task "<taskId>" \
  --reason "需要确定范围或授权"

# 任务已不再需要
botmux delivery cancel --task "<taskId>" \
  --reason "范围调整，不再执行"
```

目标看板会把需要拍板、卡住、缺项目环境和待验收事项集中显示。可以直接使用行内按钮让监管者重派、换执行者、处理求助或升级给人。

## 7. 收尾

所有任务验收后，监管者向主控汇总。使用者确认结束后：

- 关闭本部署中的监管者和执行者会话；
- 保留目标群和交付记录；
- 不删除群聊，方便后续审计和复盘。

当前版本不会自动清理另一台机器上的远端会话；远端会话清理属于后续增强，不影响交付结果。

## 最短使用路径

1. 每台机器安装同一版本并运行 `botmux setup`。
2. 每台机器执行 `botmux bind`，加入同一个平台团队。
3. 创建一个真实飞书目标群，把人、监管者和执行者都拉进去。
4. 启动监管者，让它拆任务并派发。
5. 同机任务用本机目录；跨设备代码任务用 `--needs-repo <remote URL>`。
6. 执行者用 `botmux report --task` 带证据提交，卡住用 `botmux help --task`。
7. 监管者核验后通过、驳回、重派或升级给人。
8. 全部验收后汇总并结束会话，群和交付记录保留。

## 常见问题

### 机器人在平台团队里，但群里看不到

平台团队不是飞书群。需要另外创建目标群，并把机器人和使用者加入该群。

### 远端执行者一直弹仓库选择卡

检查派任务时是否错误使用了 `--repo` 或只发了普通消息。跨设备派任务必须使用 `--needs-repo <Git remote URL>`，并确保接收机器运行支持项目自检的同一 Botmux 版本。

### 远端执行者没有启动

依次检查：

1. 目标群是否是真实飞书群；
2. 执行者是否已在群里；
3. 监管者会话是否已经启动；
4. 两台机器的 `botmux status` 是否正常；
5. 两台机器是否安装同一个版本；
6. 项目自检是否返回“缺少项目环境”。

### 群里有完成消息，但看板还是未提交

完成说明必须通过 `botmux report --task` 发送，并带 `--artifact` 或 `--artifact-text`。普通聊天消息不会被当作正式提交。

### 缺少项目环境算失败吗

不算。它是可恢复的求助状态。监管者可以安排准备环境、换一台已有项目的执行者，或升级给人决定。
