# 多 CLI 适配器

botmux 通过适配器桥接不同 CLI，`bots.json` 里用 `cliId` 选择。一键切换，进程隔离。

## 支持的 CLI

| `cliId` | CLI | 支持 model 参数 |
|---------|-----|:--:|
| `claude-code` | Claude Code（默认） | ✅ |
| `codex` | Codex | ✅ |
| `codex-app` | Codex App | |
| `cursor` | Cursor（cursor-agent） | ✅ |
| `gemini` | Gemini | ✅ |
| `opencode` | OpenCode | ✅ |
| `coco` | CoCo / Trae（需 ≥ 0.120.32） | ✅ |
| `aiden` | Aiden | |
| `antigravity` | Antigravity（agy） | |
| `hermes` | Hermes | |
| `copilot` | GitHub Copilot（copilot） | ✅ |

> 还有社区贡献的 MTR、ttadk、Mira 等接入方式。`model` 字段只对支持模型参数的适配器生效，其它会忽略。

## 套 wrapper / 网关接入

很多场景下你不是直接跑原生 CLI，而是套一层网关 / 路由（内网代理 + SSO、模型路由等），比如 `ccr`、`ttadk`、`aiden x claude`、`aiden x codex`。这时**不需要新适配器**：`cliId` 仍填底层真实 CLI（`claude-code` / `codex` …），只把启动入口换成一个 **wrapper 脚本**，用 `cliPathOverride` 指过去（`botmux setup` 编辑机器人时的「CLI 可执行文件路径覆盖」就是填它）。

**通用四步：**

1. **先登录网关**（一次性）：用跑 daemon 的**同一系统用户**完成 SSO 登录，token 缓存在该用户家目录。token 过期会弹交互登录卡住 PTY，注意保持登录态。
2. **写 wrapper 脚本** 放 `~/.botmux/bin/`，把 botmux 传入的参数透传给真实 CLI（注意：有的网关拒收 botmux 注入的 `--settings`，要在脚本里剥掉）。
3. **`chmod +x` 加可执行位（最容易漏！）**——botmux 用 node-pty 直接 exec 脚本，没有可执行位会 `EACCES`、CLI 起来即退、bot 崩溃重启。
4. **直接执行脚本验证**（用 `~/.botmux/bin/xxx --version`，别用 `bash xxx` 测——走 bash 不需要可执行位会掩盖第 3 步问题）。然后在 `bots.json` 配 `cliPathOverride`（写**绝对路径**，别用 `~`），`botmux restart` 生效。

各网关的**具体 wrapper 脚本**见对应配置文档（这些文档随上游更新，这里只放链接、不复制原文）：

- **aiden × claude / aiden × codex** — [配置文档](https://bytedance.larkoffice.com/docx/T63VdOsCxoLnlSxCjARcd6ocnNf)（aiden×codex 需用 `script` 强套 PTY）
- **ttadk** — [配置指南](https://bytedance.larkoffice.com/docx/SkG3dVFLsoRnNgxzE6NcvdeCnws)（含各 CLI 的 wrapper 脚本一览）
- **MTR** — [使用文档](https://bytedance.larkoffice.com/wiki/XjYKwXjlTivKoWksIVtcnmN6noH)（社区贡献，`npm i -g @metamove-code/mtr-cli@latest`）
>
> 排查 wrapper 问题的通用手法：`botmux logs` 找 `Spawning fresh CLI:` 那行，复制完整命令在本地手动跑一遍即可定位（权限 / 参数黑名单 / 登录态）。

## 添加新适配器（贡献者）

1. `src/adapters/cli/` 下新建文件，实现 `CliAdapter` 接口
2. `src/adapters/cli/types.ts` 的 `CliId` 联合类型加新 ID
3. `src/adapters/cli/registry.ts` 加 import / switch case / export
4. `src/worker.ts` 的 `CLI_DISPLAY_NAMES`、`card-builder.ts` 的 `cliDisplayNames` 加显示名
5. `src/cli.ts` setup 交互菜单加选项
6. 更新 README

详见 [CONTRIBUTING.md](https://github.com/deepcoldy/botmux/blob/master/CONTRIBUTING.md)。
