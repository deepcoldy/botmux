# EBSD 适配器配置与部署说明

`ebsd` 适配器使用独立的外部服务身份和原生 OMP 会话目录。部署方必须通过受限权限的文件配置 Diag Gateway token 与 ByteCloud service account，不能将明文密钥写入 `bots.json`。

## 配置示例

在 `bots.json` 中仅配置非敏感元数据和密钥文件路径：

```json
{
  "cliId": "ebsd",
  "workingDir": "/var/lib/botmux/ebsd-work",
  "sandbox": true,
  "env": {
    "EBSD_BOTMUX_DIAG_ENDPOINT": "https://ebsbot.example",
    "EBSD_BOTMUX_DIAG_TOKEN_FILE": "/run/secrets/ebsd-botmux/diag-token",
    "EBSD_BOTMUX_BYTECLOUD_ACCESS_KEY_FILE": "/run/secrets/ebsd-botmux/bytecloud-ak",
    "EBSD_BOTMUX_BYTECLOUD_SECRET_KEY_FILE": "/run/secrets/ebsd-botmux/bytecloud-sk",
    "EBSD_BOTMUX_SUBJECT": "botmux-ebsd@prod",
    "EBSD_BOTMUX_REPOSITORY_ROOT": "/srv/repos"
  }
}
```

## 安全与权限要求

1. **密钥文件权限**：
   - 上述三个密钥文件（`DIAG_TOKEN_FILE`、`ACCESS_KEY_FILE`、`SECRET_KEY_FILE`）必须由运行 BotMux 的用户持有，且权限必须设置为 `0600` 的普通文件（普通读取权限，禁止其它用户访问）。
   - **禁止符号链接**：密钥文件不得为软链接（symlink）。
   - 文件内容、AK/SK 和 Gateway token 绝对不得直接写入 `bots.json`。
2. **工作目录与仓库挂载**：
   - `workingDir` 应为专用的独立空目录。
   - 目标代码仓库通过只读的 `EBSD_BOTMUX_REPOSITORY_ROOT` 暴露。
3. **沙箱隔离**：
   - 在 Linux 下开启 `sandbox: true` 时，系统需预先安装 `bubblewrap`（bwrap）。如果隔离环境建立失败，daemon 会拒绝启动。
4. **密钥轮换**：
   - 当前与上一把 Gateway key 可以在服务端并存以完成平滑轮换，`subject` 保持不变。
