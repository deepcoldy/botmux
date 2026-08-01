# 角色系统部署 runbook

前提：PR1-3（`docs/role-system-design.md` §11.3 的 brandLabel 变量替换 / TUI idle 注入队列 +
`botmux slash` / `botmux role switch`）已合入并部署（`pnpm switch:here && botmux restart`）。

> 命名：角色切换命令为 `botmux role switch <目录>`（曾用名 `botmux cd`，已移除）。
> ⚠️ 存量部署的 `~/botmux-roles/<appId>/_role-protocol.md`（及各角色目录内的副本）里的
> 命令名需刷新为 `botmux role switch` 并重新分发到各角色目录，否则模型发的旧命令会失败。

## 1. 选定目标 bot

- 确认 `claude --version` ≥ 2.1.205（会话内 `/cd` 保留上下文，本机实测通过的最低版本，
  见 spec §11 第 5 条）。
- 确认该 bot 是否开启 readIsolation（决定第 4 步走哪条信任预置路径、第 5 步用哪套飞书凭证）。
- 确认该 bot 没有指向他处的 oncall 绑定——`defaultWorkingDir`（「仅默认目录」模式）与
  oncall 绑定互斥，二者只能二选一（见 `src/bot-registry.ts` 中 `defaultWorkingDir` 字段注释）。

## 2. 建角色库骨架

⚠️ **每-bot 目录名必须 = 该 bot 的 `larkAppId`**（`cli_xxxxxxxx`），不是人类可读名。

```bash
mkdir -p ~/botmux-roles/<appId>/shared/default/knowledge
```

原因：这一层是**沙盒的 per-bot scoping key**。`buildFsPolicy()` 只把
`<角色库根>/<larkAppId>` 纳入白名单（`src/adapters/cli/fs-policy.ts`），`botmux role switch`
的越界校验也按它收窄到本 bot 自己的子树（`validateRoleLibraryPath()` 的 `ownAppId`）。
目录名换成别的，开了 `sandbox: true` 的 bot 角色系统会**整体 EPERM**（列/切/新建角色、
切换后写 knowledge 全部失败），且 `botmux role switch` 对这个 bot **fail-closed 拒绝**
（`own_role_library_missing`，不会误切进别的 bot 的目录）——迁移后恢复，见第 8 节。appId
同时是 botmux 其余每-bot 资源的统一 key（`~/.botmux/bots/<appId>`、
`data/sessions-<appId>.json`、`data/attachments/<appId>`、`~/.lark-cli-bots/<appId>`），
角色库对齐它而非另起一套命名。

人类可读名不写在目录名里——写在各角色目录 `.botmux-dir.json` 的 `name`（卡片脚注与
「切到XX」匹配都读它）。同理下一层角色目录名也必须是 ASCII slug，见下。

存量部署若这一层用的是人类 slug：见文末「8. 迁移」。

⚠️ **角色目录名必须是 ASCII slug**（`default` / `pm` / `after-sales`），中文名写在该目录
`.botmux-dir.json` 的 `name` 字段：Claude Code 的记忆桶按 cwd 路径 slug 分桶且把非 ASCII 字符
统一替换成 `-`，两个同长度的中文目录名会 slug 成同一个桶导致**记忆串台**。默认角色：

```bash
echo '{"name": "默认助理"}' > ~/botmux-roles/<appId>/shared/default/.botmux-dir.json
```

- 按 `docs/roles/role-protocol-template.md` 写 `~/botmux-roles/<appId>/_role-protocol.md`
  （替换 `<ROLES_ROOT>` 为 `~/botmux-roles/<appId>`）。
- 按 `docs/roles/role-claude-md-template.md` 写
  `~/botmux-roles/<appId>/shared/default/CLAUDE.md`（人设段用模板里给的零人设一行：
  「你是通用助理，未设定特定角色人设。」）。
- **把 `_role-protocol.md` 复制一份进默认角色目录**（每个角色目录都要有自己的副本）：
  ```bash
  cp ~/botmux-roles/<appId>/_role-protocol.md ~/botmux-roles/<appId>/shared/default/
  ```
  原因：角色 CLAUDE.md 的 `@import` 若指向角色目录之外的文件，Claude Code 会判为
  「外部 include」并弹出交互式批准框（`hasClaudeMdExternalIncludesApproved`），而 botmux
  的信任种子只写 `hasTrustDialogAccepted`（`worker-pool.ts:1080` / `worker.ts:254`），
  不覆盖这个标志 —— 会卡住会话。协议放进角色目录内即为本地引用，规避此类交互框。
  「新建角色」流程同样会复制一份（见协议模板）；协议更新后需扫描各角色目录重新分发。

角色库根目录固定为 `~/botmux-roles`（`src/core/role-library.ts` 的 `roleLibraryRoot()`，
v0 硬编码约定、不接受配置），每个 bot 在其下各占一个以自己 `larkAppId` 命名的子目录。
`botmux role switch` 的越界校验（`validateRoleLibraryPath()`）**按 `<根>/<appId>` 收窄到该
bot 自己的子树**：切到别的 bot 的角色目录会被拒（`outside_own_role_library`，403）。
存量部署若这一层不是 appId 命名，`botmux role switch` **fail-closed 直接拒绝**
（`own_role_library_missing`，409）并在 daemon 日志打一行迁移指引 —— 不回落全局根
（回落是 fail-open：会让存量部署继续能跨 bot 切并经 workingDir 拿 rw）。沙盒下角色系统
本就整体 EPERM 不可用，fail-closed 不额外损失可用功能；非沙盒部署迁移一次（见第 8 节）
即恢复。

> 注意：飞书 IM 里人工敲的 `/cd` 走的是通用工作目录校验（`validateWorkingDir`，允许任意
> 已存在目录、可自动创建），**不经**角色库校验 —— 它的信任契约是「运营自己输入的目录」。
> 收窄只作用于模型驱动的 `botmux role switch`。

## 3. bots.json 配置该 bot

```jsonc
{
  "defaultWorkingDir": "~/botmux-roles/<appId>/shared/default",
  "brandLabel": "[{cwdName}]({cwdUrl})",
  "tuiSlashAllow": ["/compact"]   // 可选，默认空＝通用 slash 注入通道关闭
}
```

字段核对（均为已实现字段，见 `src/bot-registry.ts`）：`defaultWorkingDir`（新话题启动目录，
「仅默认目录」模式）、`brandLabel`（回复卡与 `botmux send` 脚注模板，支持
`{cwdName}`/`{cwd}`/`{cwdUrl}` 变量替换）、`tuiSlashAllow`（`botmux slash` allowlist，
`getBotTuiSlashAllow()` 读取；`/cd` 固定被排除在可注入范围之外，不受此 allowlist 影响）。

## 4. 信任预置

目的：避免 Claude Code 的交互式「是否信任此目录」对话框打断角色切换后的新会话启动。

`botmux role switch` 现走进程 respawn（daemon 收敛 workingDir 后杀 CLI、在新目录
`--resume` 重开）。信任如何落到新 cwd，按**三条路径**分流——注意最常见的非隔离活 worker
**并不预种**：

- **整 worker 冷启动**（无活 worker：daemon 重启后惰性恢复 / 会话崩溃停掉 / 新话题首次
  spawn）：daemon 走 `forkWorker`，其中 `ensureClaudeFolderTrust(cwd, stateJsonPath)`
  （`src/core/worker-pool.ts`，`forkWorker` 内 spawn 前）对当次 `cwd` 写
  `projects[<realpath>].hasTrustDialogAccepted = true`，**预种**。
- **readIsolation bot 的 in-worker respawn**：worker 内 `provisionIsolatedBotHome()` →
  `seedAndTrustClaudeState()`（`src/worker.ts`）对新 cwd 写该 bot 专属
  `<BOT_HOME>/claude/.claude.json`，**预种**。
- **非隔离 bot 的 in-worker respawn（最常见的角色切换路径）**：worker 内直接
  `restartCliProcess → spawnCli`，**不 refork、不经过 daemon 的 `ensureClaudeFolderTrust`，
  也不预种**。真实兜底是 worker 侧的**运行时兜底**：识别到 Claude 的信任对话框后自动回车
  接受（`src/worker.ts` 的 trust-dialog auto-accept，`TRUST_DIALOG_PATTERN`）。

**因此**：切到一个此前从未被 spawn 过的新角色目录（典型：「新建角色后立即切到它」）时，
非隔离 bot 不是靠预种、而是靠这条运行时自动接受兜住——旧「热注入 `/cd`（进程不重启、连
运行时兜底都摸不到）」那条独有的卡死路径已不存在，但**非隔离首次切新目录仍应真机验证一次**
（下方第 2 项）。

验证（部署时顺带确认）：

1. **部署前**：至少对 `defaultWorkingDir` 指向的默认角色目录执行一次真实 spawn（新话题跟它
   说句话即可），确认信任已种下（`~/.claude.json` 或隔离 bot 的
   `<BOT_HOME>/claude/.claude.json` 里能看到该 realpath 的 `hasTrustDialogAccepted: true`）。
2. **第 6 步真机验证时**盯「非隔离 bot：新建角色→立即切到XX」：新 cwd 无预种，靠运行时
   trust-dialog 自动接受兜底，确认没有卡在信任框；若真机观察到异常，在此记录结论并更新本节。

## 5. 飞书凭证验证

在 bot 会话内跑通「建测试文档 → 写入 → 分享给角色主人」一遍：

- 非隔离 bot：`lark-cli --as bot` 或 app 凭证走 OpenAPI（HTTP 用 curl，Node fetch 不吃代理）。
- 隔离 bot：用该 bot 自己的 send-cred 凭证（隔离 bot 读写走自己的桶，不读全局 `bots.json`，
  避免触发「读隔离打断 CLI 子命令」的已知坑）。

## 6. `botmux restart` 后真机验证

```bash
pnpm switch:here && botmux restart
```

按下列清单逐项在飞书真机验收，全部打勾（内容照搬 `docs/role-system-design.md` §12，
一字不改）：

- [ ] 新话题不做任何操作，机器人以「默认助理」人设应答（CLAUDE.md 自动加载生效）

- [ ] 说「切换角色」，列表只含 shared + 我自己的角色（sender open_id 过滤）

- [ ] 回复数字/角色名：先收到确认消息，下一条消息起新人设生效

- [ ] 对角色说出一个领域事实，检查该角色的记忆桶（projects/<slug>/memory/）有新文件

- [ ] 另开新话题切到同一角色，能引用上一话题积累的记忆（跨话题共享）

- [ ] 「新建角色：xxx」全流程可用，目录落在自己的 users/<open_id>/ 下

- [ ] 「沉淀知识」后 knowledge/ 生成主题文档、INDEX 更新，新话题里角色能引用沉淀的知识

- [ ] 沉淀后：知识飞书文档已创建/更新且分享给角色主人；.botmux-dir.json 回填 url；脚注点角色名可打开文档；在文档中人工修订后说「同步知识」，新话题里修订生效

- [ ] 用另一个飞书账号尝试切换他人私有角色，被拒绝

- [ ] 诱导机器人 cd 到角色库外的目录，daemon 拒绝

- [ ] 中途切换角色：对话上下文保留（新角色能引用切换前的讨论）；切换后新角色的记忆索引/已有记忆在新会话开场自动可用（respawn 冷启动机制性加载，无需手动补读）

- [ ] 若 bot 开了读隔离：角色库与 .botmux-dir.json 读写正常、记忆桶正常；botmux role switch / botmux slash 全链路可用（自识别→findDaemon→鉴权→POST，全程未触碰 bots.json。鉴权双路径：非隔离进程用 .dashboard-secret 做 trusted-host HMAC 签名；沙箱/读隔离 CLI 读不到 secret，改带本会话每轮轮换的 origin capability（/api/asks 同款），daemon 侧与活跃会话记录比对）

- [ ] 回复卡片左下角显示当前角色名；配置了 .botmux-dir.json url 时点击跳转正确；切换角色后脚注随之变化；非角色目录会话仍显示原 brand

补充核实项（本 runbook 第 4 步补记，不在原 §12 清单内，建议在验证「新建角色→切到XX」时顺带确认）：

- [ ] 「新建角色」后立即「切到XX」（该目录首次被 spawn，走 respawn 在新目录冷启动），
      确认 respawn 已对新 cwd 种信任、没有卡在 Claude Code 的交互式信任对话框；如卡住，
      记录现象并按第 4 步核实

## 7. 回滚

`bots.json` 还原 `defaultWorkingDir` / `brandLabel` 即回到无角色状态；角色库目录
（`~/botmux-roles/<appId>/`）与记忆桶（`projects/<slug>/memory/`）原样保留，不影响其它功能，
可安全留存以便下次重新启用。

## 8. 迁移：每-bot 目录名改为 appId

存量部署（这一层曾用人类可读名）按下面改。**迁移前**：daemon 不会崩，但该 bot 的
**角色系统不可用**——沙盒下整体 EPERM，且 `botmux role switch` 会 **fail-closed 拒绝**
（不会误切进别的 bot 的角色目录，这正是 fail-closed 相对旧「回落全局根」的安全改进）：

- 沙盒会话启动时 worker 日志会打 `[sandbox] role library dir mismatch: … is not a real directory`；
- `botmux role switch` 会返回 `own_role_library_missing`（409），daemon 日志打
  `[role] 角色库每-bot 目录名不是 appId（期望 ~/botmux-roles/<appId>）——role switch 已 fail-closed 拒绝`。

```bash
APP=cli_xxxxxxxx            # 目标 bot 的 larkAppId
OLD=~/botmux-roles/<旧目录名>
botmux stop                  # 或至少确保该 bot 无活跃会话
mv "$OLD" ~/botmux-roles/$APP
```

然后逐项跟着改（漏一项就是半迁移状态）：

1. `bots.json` 的 `defaultWorkingDir` → `~/botmux-roles/<appId>/shared/default`。
2. `~/botmux-roles/<appId>/_role-protocol.md` 里的 `<ROLES_ROOT>` 实际值 → 新路径；
   **并重新分发到每个角色目录**（每个角色目录都有自己的副本）：
   ```bash
   for d in ~/botmux-roles/$APP/shared/*/ ~/botmux-roles/$APP/users/*/*/; do
     [ -d "$d" ] && cp ~/botmux-roles/$APP/_role-protocol.md "$d"
   done
   ```
3. 各角色目录 `CLAUDE.md` 里若硬写了旧绝对路径，一并替换。
4. **存量会话的 cwd**：`defaultWorkingDir` 只影响**新话题**；已存在的会话把 cwd 记在
   session store 里（`~/.botmux/data/sessions-<appId>.json`），`mv` 之后它们仍指向旧路径
   —— `botmux stop` 只是停 daemon，不等于关掉或重钉这些会话。迁移前先关掉相关活跃/可恢复
   会话（或迁移后逐个 `botmux role switch` 重钉到新路径），重启后确认旧话题恢复时进的是
   新目录，而不是已被移走的旧路径。
5. `botmux start` 后自查：新话题进入默认角色、`botmux role switch` 可切换、
   开了沙盒的 bot 能读到 `~/botmux-roles/<appId>/` 下的兄弟角色目录、
   切别的 bot 的角色目录被拒（403 `outside_own_role_library`）。

**记忆桶会换**：记忆按 cwd 路径 slug 分桶（`~/.claude/projects/<slug>/` 或
`~/.botmux/bots/<appId>/claude/projects/<slug>/`），目录一改 slug 就变，旧桶里的
`MEMORY.md` 与记忆文件不会自动跟过来。迁移前若有需要保留的记忆，把旧桶的
`memory/` 整个拷进新桶：

```bash
# <OLDSLUG>/<NEWSLUG> = 旧/新 cwd 的 slug（绝对路径里非字母数字全换成 -，含前导 -）
cp -R <projects>/<OLDSLUG>/memory <projects>/<NEWSLUG>/memory
```

角色目录名（下一层，如 `default`/`pm`）**不受本次迁移影响**，仍是 ASCII slug 约定。
