# 插件 ByteCLI 权限预设

Botmux 提供通用的声明式权限模板扩展。业务插件发布模板，管理员在机器人 Dashboard 应用模板；最终执行仍由宿主审核目录、身份规则和 broker 校验决定。

## 插件配置

在插件发布物中包含固定文件 `dist/bytedcli/operation-presets.json`。安装器读取 runtime 下的 `bytedcli/operation-presets.json`，不执行插件 JavaScript。示例：

```json
{
  "schema": "botmux.bytedcli-operation-presets.v1",
  "presets": [
    {
      "id": "support",
      "title": "Support policy",
      "description": "Reviewed support commands",
      "policy": {
        "schema": "botmux.bytedcli-operation-policy.v2",
        "cliVersion": "0.199.0",
        "catalogVersion": "2026-11-27.2",
        "rules": {
          "codebase.mr.close": "machine",
          "codebase.mr.list": "actor"
        }
      }
    }
  ]
}
```

预设 ID 为小写字母开头的 1–64 个字母、数字、点、下划线或连字符；同一插件内唯一。跨插件以 `(pluginId, presetId)` 区分。标题必填，最长 128 UTF-8 字节；描述可省略，最长 512 字节，文本不允许控制字符。仅接受声明的字段。每插件最多 8 个预设、文件最多 256 KiB；一次最多展示 64 个预设，超限插件整组不展示并报告问题。

`policy` 复用宿主的版本化校验，只能配置审核目录中的精确 operationId 和 `machine` / `actor` / `deny`。不接受通配符、未知命令、凭据、执行路径、上游地址或脚本。目标、参数匹配、effect 和 credential realm 仍来自宿主目录，插件不能扩展可执行命令目录。审核目录见 [命令审核](bytedcli-operation-audit.md)。

文件必须是 runtime 内的普通单链接文件，拒绝内部目录或文件 symlink、hardlink、越界和读取期间变化。无效发布物会拒绝安装更新并保留原安装。

## 安装、发现与应用

按既有流程构建并安装插件，例如 `botmux plugin install /absolute/path/to/plugin`。安装器保存经过校验的 contribution 快照到插件注册表。模板更新后重新构建并安装插件；直接修改源 JSON 不会改变已安装快照。

Dashboard → 机器人默认配置 → 安全 → 触发者身份 → ByteCLI 命令权限中，展示当前已安装且对该机器人启用的插件模板。有效插件为全局启用插件与机器人插件的并集。模板旁显示来源插件、版本和根据宿主 effect 计算的机器写入例外。错误记录只返回问题码，不展示原始配置或私有描述符，也不阻止健康模板和手动规则编辑。

选中严格 `read-machine-write-actor` 模式和 ByteCloud 能力后，管理员可以显式应用模板；总开关关闭时可编辑 dormant 规则。应用替换该机器人的整套 `bytedcliOperationPolicy`，保留磁盘上的最新其他身份配置。宿主显式 actor/deny 优先；已审核读取默认 machine、写入默认 actor，未登记命令使用 actor。权限规则不是 Skill 级隔离，同一规范命令共享一条规则。

安装、启用或升级插件不会自动应用或合并模板。停用、卸载只移除可选模板，已保存机器人规则独立保留。清除机器人规则使用既有手动清除入口。

## API 与过期处理

既有认证 GET `/api/bots/:app/trigger-user-auth-status` 增加 `bytedcliOperationPresets: {presets, issues}`。每个模板带 `pluginId`、`id`、`pluginVersion`、`revision`、`policy` 和 `machineWriteExceptions`；修订为插件 ID、版本与规范化模板定义的 SHA-256。

PUT `/api/bots/:app/trigger-user-auth` 可提交来源引用：

```json
{
  "bytedcliOperationPreset": {
    "pluginId": "support",
    "presetId": "support",
    "revision": "sha256:<GET 返回的 43 字符 base64url 摘要>"
  }
}
```

此形式与原 `triggerUserAuth` 形式互斥。服务端持有插件生命周期锁和机器人配置锁，重新读取当前全局/机器人绑定、安装贡献与版本后保存，成功响应返回最终 `triggerUserAuth`。来源停用、卸载或修订变化返回 409，不写配置；非法引用、互斥形式或模式不符合返回 400。Dashboard 失败后刷新模板并保留现有规则，不自动重试写入。

该扩展只注入可审阅的配置建议。实际调用持续遵循 [身份和读写规则](bytedcli-read-write-identity.md)，机器写入例外仍按真实写操作进行 intent、审计和结果未知处理。
