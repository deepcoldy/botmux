# 角色系统部署 runbook

前提：PR1-3（`docs/role-system-design.md` §11.3 的 brandLabel 变量替换 / TUI idle 注入队列 +
`botmux slash` / `botmux cd`）已合入并部署（`pnpm switch:here && botmux restart`）。

## 1. 选定目标 bot

- 确认 `claude --version` ≥ 2.1.205（会话内 `/cd` 保留上下文，本机实测通过的最低版本，
  见 spec §11 第 5 条）。
- 确认该 bot 是否开启 readIsolation（决定第 4 步走哪条信任预置路径、第 5 步用哪套飞书凭证）。
- 确认该 bot 没有指向他处的 oncall 绑定——`defaultWorkingDir`（「仅默认目录」模式）与
  oncall 绑定互斥，二者只能二选一（见 `src/bot-registry.ts` 中 `defaultWorkingDir` 字段注释）。

## 2. 建角色库骨架

```bash
mkdir -p ~/botmux-roles/<bot>/shared/default/knowledge
```

⚠️ **角色目录名必须是 ASCII slug**（`default` / `pm` / `after-sales`），中文名写在该目录
`.botmux-dir.json` 的 `name` 字段：Claude Code 的记忆桶按 cwd 路径 slug 分桶且把非 ASCII 字符
统一替换成 `-`，两个同长度的中文目录名会 slug 成同一个桶导致**记忆串台**。默认角色：

```bash
echo '{"name": "默认助理"}' > ~/botmux-roles/<bot>/shared/default/.botmux-dir.json
```

- 按 `docs/roles/role-protocol-template.md` 写 `~/botmux-roles/<bot>/_role-protocol.md`
  （替换 `<ROLES_ROOT>` 为 `~/botmux-roles/<bot>`）。
- 按 `docs/roles/role-claude-md-template.md` 写
  `~/botmux-roles/<bot>/shared/默认助理/CLAUDE.md`（人设段用模板里给的零人设一行：
  「你是通用助理，未设定特定角色人设。」）。
- **把 `_role-protocol.md` 复制一份进默认角色目录**（每个角色目录都要有自己的副本）：
  ```bash
  cp ~/botmux-roles/<bot>/_role-protocol.md ~/botmux-roles/<bot>/shared/默认助理/
  ```
  原因：角色 CLAUDE.md 的 `@import` 若指向角色目录之外的文件，Claude Code 会判为
  「外部 include」并弹出交互式批准框（`hasClaudeMdExternalIncludesApproved`），而 botmux
  的信任种子只写 `hasTrustDialogAccepted`（`worker-pool.ts:1080` / `worker.ts:254`），
  不覆盖这个标志 —— 会卡住会话。协议放进角色目录内即为本地引用，规避此类交互框。
  「新建角色」流程同样会复制一份（见协议模板）；协议更新后需扫描各角色目录重新分发。

角色库根目录固定为 `~/botmux-roles`（`src/core/role-library.ts` 的 `roleLibraryRoot()`，
v0 硬编码约定、不接受配置），每个 bot 在其下各占一个子目录；`botmux cd` 的越界校验
（`validateRoleLibraryPath()`）也是对着这个全局根做包含性判断，而不是单独按 bot 子目录收紧——
纯信息，不影响本 runbook 操作，仅供理解「角色库外」的确切边界。

## 3. bots.json 配置该 bot

```jsonc
{
  "defaultWorkingDir": "~/botmux-roles/<bot>/shared/默认助理",
  "brandLabel": "[{cwdName}]({cwdUrl})",
  "tuiSlashAllow": ["/compact"]   // 可选，默认空＝通用 slash 注入通道关闭
}
```

字段核对（均为已实现字段，见 `src/bot-registry.ts`）：`defaultWorkingDir`（新话题启动目录，
「仅默认目录」模式）、`brandLabel`（回复卡与 `botmux send` 脚注模板，支持
`{cwdName}`/`{cwd}`/`{cwdUrl}` 变量替换）、`tuiSlashAllow`（`botmux slash` allowlist，
`getBotTuiSlashAllow()` 读取；`/cd` 固定被排除在可注入范围之外，不受此 allowlist 影响）。

## 4. 信任预置

目的：避免 Claude Code 的交互式「是否信任此目录」对话框打断 `botmux cd` 注入。

**现有信任种子机制的两条实际路径**（按 bot 是否 readIsolation 分流）：

- **非隔离 bot**：`ensureClaudeFolderTrust(workingDir, stateJsonPath)`
  （`src/core/worker-pool.ts:1062`），写入全局 `~/.claude.json` 的
  `projects[<realpath(workingDir)>].hasTrustDialogAccepted = true`；由
  `src/core/worker-pool.ts:1692`（`forkWorker` 内）在**每次 CLI (re)spawn** 时对当次 `cwd`
  自动调用，无需手工干预。
- **readIsolation bot**：`seedAndTrustClaudeState(statePath, workingDir, log)`
  （`src/worker.ts:235`，由 `provisionIsolatedBotHome()` 在 `src/worker.ts:169` 调用），
  写入该 bot 专属的 `<BOT_HOME>/claude/.claude.json`，同样是 spawn 时机自动执行。

**已知限制、待部署时用真机核实**：上述两条路径都只在「CLI (re)spawn」这一刻，对**当次 cwd**
打信任标记；而 spec §11.1 的「热注入」路径——CLI 存活、适配器 `supportsSessionCwdMove` 为
true 时，daemon 直接向 TUI 注入会话内 `/cd <目录>`（`src/core/dashboard-ipc-server.ts:339-346`，
不杀进程、不重新 spawn）——不会走到这两个信任种子函数。也就是说，若某个角色目录此前从未被
spawn 过（典型场景：「新建角色」后立刻「切到XX」），第一次热注入 `/cd` 到它，理论上可能撞上
Claude Code 自己的交互式信任对话框、卡住会话；这一点未在真机上专项验证过。

缓解与验证顺序（部署时按此核实，不要假设已解决）：

1. **部署前**：至少对 `defaultWorkingDir` 指向的默认角色目录执行一次真实 spawn（新话题跟它
   说句话即可），确认信任已种下（`~/.claude.json` 或隔离 bot 的
   `<BOT_HOME>/claude/.claude.json` 里能看到该 realpath 的 `hasTrustDialogAccepted: true`）。
2. **第 6 步真机验证时**重点盯住「新建角色→立即切到XX」这条路径（清单第 6/11 项）：
   如果观察到会话卡在信任框，冷启动兜底（CLI 未存活时 `canInject=false` 分支，daemon 杀进程、
   下条消息在新目录冷启动）会在下一次消息时自动补种信任，可作为临时规避——但用户体验是丢一次
   会话连续性；根治需要回到 T3-T10 评估「新建角色时预种信任」的代码改动（本 runbook 范围外）。
3. 若第 2 步验证下来热注入路径实际未触发信任框（例如 Claude Code 对同一父目录下的子目录
   有自己的信任继承逻辑），在此记录真机结论并更新本节，去掉「待核实」字样。

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

- [ ] 中途切换角色：对话上下文保留（新角色能引用切换前的讨论）；切换后能引用新角色已有记忆（MEMORY.md 补读生效）

- [ ] 若 bot 开了读隔离：角色库与 .botmux-dir.json 读写正常、记忆桶正常；botmux cd / botmux slash 全链路可用（自识别→findDaemon→鉴权→POST，全程未触碰 bots.json。鉴权双路径：非隔离进程用 .dashboard-secret 做 trusted-host HMAC 签名；沙箱/读隔离 CLI 读不到 secret，改带本会话每轮轮换的 origin capability（/api/asks 同款），daemon 侧与活跃会话记录比对）

- [ ] 回复卡片左下角显示当前角色名；配置了 .botmux-dir.json url 时点击跳转正确；切换角色后脚注随之变化；非角色目录会话仍显示原 brand

补充核实项（本 runbook 第 4 步补记，不在原 §12 清单内，建议在验证「新建角色→切到XX」时顺带确认）：

- [ ] 「新建角色」后立即「切到XX」（CLI 存活、走热注入路径），确认没有卡在 Claude Code
      的交互式信任对话框；如卡住，记录现象并按第 4 步的缓解顺序处理

## 7. 回滚

`bots.json` 还原 `defaultWorkingDir` / `brandLabel` 即回到无角色状态；角色库目录
（`~/botmux-roles/<bot>/`）与记忆桶（`projects/<slug>/memory/`）原样保留，不影响其它功能，
可安全留存以便下次重新启用。
