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
