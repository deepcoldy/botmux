# 一键新建会话群

`/group <群名>`（别名 `/g`）：自动**新建一个飞书群**、邀请你进群、转让群主，**整个群作为一个独立的 CLI 会话**（chat-scope）。适合给一个项目 / 任务单独开一个干净的协作空间。

```bash
/g 卡片竞态 bug
```

机器人回一张卡片：「✅ 已新建群「卡片竞态 bug」👉 <加群链接>」，点进去直接开聊即可——整个群就是一个独立会话。

> 空群名时用时间戳兜底。建好后**不自动开会话**，进群找机器人开聊即可。

## 多机器人一起建群

命令里 @ 的机器人会被**一并拉进新群**（由第一个被 @ 的机器人负责建群）：

```bash
@Claude @Codex /g review 群授权
```

回复会列出「群内机器人：Claude、Codex」。这样新群天然就是一个多机器人协作空间，进去 @ 谁谁干活。

## Bootstrap Role Profile

如果你已经在 [role profile](/roles) 里维护了一套可复用的协作人设，建群时加 `--role-profile <profile>`：

```bash
@Claude @Codex /g --role-profile collab-main review 群授权
```

群创建成功后，创建者 bot 会先直接应用自己的 entry，再在新群里发送 `@Codex /role profile apply collab-main --quiet` 给其它 bot。每个 bot 只应用自己的本地 profile entry，并 materialize 成该 bot 的本群 Role。缺 entry 是安全的，会继续 fallback 到默认角色。

## 在 Dashboard 里建群

不想用命令的话，`botmux dashboard` 的 **Groups** 面板也能可视化建群、把指定 bot 拉进群、自动转让群主、@ 提醒，还能解散群 / 让 bot 退群（关联会话自动清理）。新建群弹窗可以选择 Role Profile；已有群行里的「应用配置集」会跳到 **角色配置集** 页面，并把该群预选为 Apply 目标。详见 [Dashboard 管控面](/dashboard)。

![Dashboard 新建群](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780033300986_dash-newgroup.png)
<p class="cap">「New Group」：填群名、绑定目录、勾选要拉进群的机器人</p>

## 私聊自动建群：关闭后切换标签

使用 `p2pMode: "group"` 时，可以在 Dashboard「Bot 配置 → 会话 → 会话模式 → 私聊/专属群 → 会话群标签」填写**关闭后标签名**，例如「已关闭」。留空时维持现有行为；也可在对应 Bot 的 `bots.json` 配置：

```json
{
  "p2pMode": "group",
  "sessionGroup": {
    "tag": {
      "mode": "feed-group",
      "name": "进行中",
      "closedName": "已关闭"
    }
  }
}
```

`/close`（包括调用该命令的关闭卡按钮）正常关闭成功后，当前会话群先加入关闭分组，再从原自动分组移出。目标分组不存在时创建，同名分组可复用；原分组本身、其它群和当前群的历史均保留。标签名去除首尾空白并限制为 60 个 Unicode 码点。

- 仅支持用户个人消息分组 `feed-group`，沿用**建群用户**的标签授权；授权缺失时通过 `/login tags` 补齐。
- 关闭失败、存在未清理残留、`/stop`、崩溃、后台清理和普通群/话题不会触发切换。
- 切换在后台执行，失败时单独提示；添加失败时保留原关联。原分组与目标相同则不移除。
- 恢复会话不会自动移回原分组；清空 `closedName` 可关闭这项功能，不批量迁移历史会话群。

## 解散专属会话群：`/dismiss`

在专属会话群顶层发送 `/dismiss`，确认影响后发送机器人返回的确认命令。仅建群用户本人且具备 Bot 操作权限可执行。Bot 必须是群主，或是创建者且有 `im:chat:operate_as_owner` 权限。

先安全关闭当前会话，再解散整个群，成功后私聊通知发起人。其它活跃会话、关闭失败或运行时残留都会阻止解散；解散失败时会话保持关闭，可再次发送 `/dismiss` 确认重试。普通群、私聊、子话题和 adopt 共享会话不支持。

解散会影响所有群成员，无法通过恢复会话重建原群。代码和 worktree 不删除，不执行关闭标签迁移；只想保留群聊并换标签时用 `/close`。
