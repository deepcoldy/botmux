# 建群默认配置与可选装饰

`/g`（别名 `/group`）可以邀请本机部署的机器人，选择个人消息分组，并生成含群名的文字头像：

```text
/g 项目讨论 --agents Review,Build,Check --tag 项目群 --avatar name
/g Project work --agents cli_review_app --tag "Project work"
```

`--agents` 接受逗号分隔的机器人显示名或 app ID；名称不区分大小写。机器人可以不在来源群内，但必须存在于本机当前 `bots.json` 配置中且启用飞书连接；`bots-info.json` 只辅助解析显示名，历史条目不参与成员选择。未知名称或重名会在建群前报错，重名时请使用 app ID。创建机器人始终保留。

每个 Bot 可在 `bots.json` 的对应条目配置默认值，也可使用 `/botconfig set groupCreation <JSON>` 修改：

```json
{
  "groupCreation": {
    "agents": ["cli_review_app", "cli_build_app", "cli_check_app"],
    "tag": "项目群",
    "avatar": "name"
  }
}
```

显式参数覆盖相应默认值。命令有 `@机器人` 时继续由第一个被 @ 的机器人创建群，并补齐默认名单，按 app ID 去重。例如默认配置三个机器人时，只 @ 其中一个执行 `/g`，也会邀请整个组合。显式 `--agents` 替换默认名单，`--no-agents` 忽略默认名单，`--no-tag` 忽略默认分组，`--avatar off` 忽略默认头像。这些选项不会删除明确 @ 的机器人。

未配置 `groupCreation` 且未传选项时，行为与之前相同；只创建当前机器人及明确 @ 的机器人所在的群。`--role-profile` 可以与上述选项组合使用。

`--tag` 指飞书**发起人个人侧边栏的消息分组**，不是租户共享的企业群标签。分组名最多 60 个 Unicode 码点。使用创建机器人对应应用下、属于命令发起人的用户授权；没有授权时群仍会建好，回执提示缺少授权。需要该应用开启用户权限 `im:feed_group_v1:read` 和 `im:feed_group_v1:write`，并完成 `/login --scope im:feed_group_v1:read im:feed_group_v1:write offline_access`。旧的无用户归属凭证不会冒充当前发起人。按名称复用分组；如果同名分组属于其他应用且不可访问，会明确报告失败，不会静默换名。

`--avatar name` 使用最终群名（含全局前缀）生成 360×360 PNG，按可用宽度换行并缩小字号，保留 Unicode 字素。复用截图的中英文字体配置，需要可选原生依赖 `@napi-rs/canvas`；Linux 中文字体由 `botmux setup` 安装到 `~/.botmux/fonts`。先完成机器人邀请，再在转移群主前设置头像；个人消息分组移到群主转移处理之后再写入，避免分组授权刷新把群主交接时间拉长（即便 transfer 失败，personal tag 仍会按本契约执行，失败独立不影响已建群）。

未知的 `--word` 不会报错，会原样保留到群名正文里，便于后续新增选项时老用户命令继续可用。已知 flag 只有在后面紧跟 `=`、空白或输入结束时才被识别：`--tag.foo`、`--avatar:off`、`--tagged` 等整体视为群名正文。需要让某个已知选项字样（如 `--tag`、`--avatar`）作为群名文字时，可以用一个独立的 `--` 作为选项结束符：`--` 之后的所有内容（包括已知 flag）都会进入群名正文；`--=foo` 不是 sentinel，会原样保留。已知选项仍强制校验：缺值、非法值、重复 `--option`、以及等号/空格 quoted value 后紧跟非空白字符（如 `--tag="A"suffix`）都会在建群前报错。

机器人邀请、个人分组或头像设置失败会在建群回执中单独提示；已创建的群不会因此重建。个人分组写入后会回读确认；授权刷新及分组 API 共用 10 秒超时预算。无头像配置的调用不会加载原生绘图依赖。

![群名文字头像示意](../assets/group-name-avatar.png)
