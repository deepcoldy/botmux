# OpenViking 记忆接入（可选示例）

**默认关闭。** Botmux 常规安装和 daemon 启动不会执行这里的脚本，也不会安装插件或启动 OpenViking。`configure` 只准备配置；`bind` 是显式启用入口，修改一个现有 Bot 的 `cliPathOverride`。`unbind` 撤回该字段，保留其他 Bot 的后续变更。

这个示例让 Agent 自己决定什么时候搜索历史，以及读取哪些记忆。读取通过 OpenViking MCP 的 `find`、`search`、`read`；自动捕获在每轮结束后执行，会话结束或压缩前提交，服务后台抽取与索引。部署与测试期间，Codex 全局插件配置保持 `enabled=false`，仅指定 Bot 的启动入口启用适配器。

当前试点宿主是单用户 Codex Bot。复用的上游组件正式显示名为 **OpenViking Memory**，`codex-memory-plugin` 是其 Codex 适配器源码目录；记忆存储与检索由 OpenViking 提供。

## 范围与前提

- Linux 或 macOS、Python 3.11+、Node.js 22+、tmux；实际闭环已在 Linux 验证。
- 一个已存在的 Codex Bot，`allowedUsers` 恰好一项。脚本不创建 Bot、不修改 owner 身份、不复制跨应用 `open_id`。
- 已登录的 Codex，支持 `--no-daemon` 和原生插件/Hook；验证版本为 `0.160.1`。固定使用选定的二进制，不更新全局 CLI。
- 源码 checkout 或 npm 安装版 Botmux，具有可导入的 `dist/adapters/cli/codex.js`。单文件二进制安装需要另行提供已构建的 checkout 供本地测试工具使用。
- 用户已审查的 OpenViking 源码 checkout；验证的服务版本为 `openviking[local-embed]==0.4.23`，插件版本为 `0.10.10`。

| 配置 | 本示例值 |
|---|---|
| 服务 | `http://127.0.0.1:1933`，本地单用户 dev 模式 |
| Embedding | `local / bge-small-zh-v1.5-f16 / 512` |
| 内容与向量存储 | `~/.openviking/data` |
| 记忆抽取与摘要 | `openai-codex`，使用配置的 Codex 模型与登录凭据 |
| 读取方式 | Agent 主动调用 MCP `find` / `search` / `read` |
| 自动注入 | 每轮召回、启动资料注入、恢复归档注入均关闭 |
| 检索范围 | `recallPeerScope=actor`；用户级记忆与当前项目 |
| 项目推导 | Git remote → Git root → cwd；项目 `peer.id` 优先 |
| 增量提交 | 20,000 token 阈值，保留最近 10 条消息 |
| 服务端闲置提交 | 闲置 120 秒，检查间隔 30 秒，最小提交间隔 60 秒 |

Embedding 和存储在本机运行；抽取、摘要会调用登录账户的模型服务。闲置自动提交、actor 范围和关闭召回改写是示例的试点设置。peer 用于组织与检索范围；它不构成同一用户内部的项目授权边界。多人共享 Bot 需要可信发送者映射与服务认证，应单独实现平台记忆桥。

## 准备（尚未启用 Bot）

先按 OpenViking 的[服务端配置](https://docs.openviking.ai/zh/configuration/01-server)和 [Codex 集成](https://docs.openviking.ai/zh/agent-integrations/04-codex)准备模型授权与插件源码。以下命令在 Botmux 仓库根目录执行：

```bash
python3 -m venv ~/.local/share/openviking/venv
~/.local/share/openviking/venv/bin/pip install 'openviking[local-embed]==0.4.23'

cd examples/openviking-memory
python3 pilot.py configure --bot-index 0 \
  --codex /absolute/path/to/codex \
  --botmux-root /absolute/path/to/built-or-installed/botmux \
  --vlm-model '<model-supported-by-your-Codex-account>'
```

`--bot-index` 必须明确选择现有 Bot 的索引。`--bots-config` 可指定其他配置文件，默认遵循 `BOTS_CONFIG` 或 `~/.botmux/bots.json`。`--memory-user` 可指定稳定的 OpenViking 用户，默认每个 Bot 使用不同用户。已有服务配置会被保护；确认要复用本地服务时加 `--use-existing-server`，该选项保留现有 `ov.conf`。

首次启用 `openai-codex` 后，需要在 OpenViking 中授权。上述固定版本可导入已有 Codex 凭据：

```bash
~/.local/share/openviking/venv/bin/python -c \
  'from openviking.models.vlm.backends.codex_auth import bootstrap_codex_auth; bootstrap_codex_auth()'
~/.local/share/openviking/venv/bin/openviking-server doctor
```

检查插件定义与命令，再显式信任 Hook：

```bash
node install-plugin.mjs --source=/absolute/path/to/reviewed/OpenViking
# 阅读 evidence/hooks.json 和对应源码后：
node install-plugin.mjs --source=/absolute/path/to/reviewed/OpenViking --trust-hooks
```

安装工具检查六个预期 Hook 的完整命令和当前哈希，默认只列出，信任需要 `--trust-hooks`。它保留其他 Hook 的配置，最终将 OpenViking 插件的全局启用状态设为 false。此过程是显式准备操作，常规 Botmux 启动不调用它。

服务可由自己的 supervisor 管理：

```bash
~/.local/share/openviking/venv/bin/openviking-server --config ~/.openviking/ov.conf
```

也可在 `configure` 时传入 `--pm2 /absolute/path/to/pm2`，之后执行 `python3 pilot.py start`。这个路径使用独立的 `~/.openviking/pm2`，保存进程状态并自动恢复进程异常退出；机器重启后的启动项由部署方管理。

## 验证与显式启用

```bash
python3 pilot.py health
python3 -m unittest discover -s . -p 'test_*.py' -v
python3 smoke.py

# 完成验证后显式启用选定 Bot：
python3 pilot.py bind
```

按现有部署方式重启**选定的 Bot daemon**并新建话题。`bind` 本身不启动进程、不重启其他 Bot、不发送飞书消息。部署到稳定目录后再绑定，避免删除临时 worktree 造成入口失效。

```bash
node verify-runtime.mjs
```

启动入口保持 `HOME` 和 `CODEX_HOME` 原值，校验 `BOTMUX_LARK_APP_ID` 并启动固定的 Codex。它使用已安装适配器的项目推导逻辑，按 Codex 的 `-C` / `--cd` 解析当前项目。Hook 使用专用客户端解析出的凭据与项目身份；读取通过名为 `openviking` 的原生 HTTP MCP 连接直连服务，显式设置用户与当前项目的身份请求头。上游适配器的 stdio MCP 入口在本进程关闭，避免同时存在两个读取入口。API key 如有配置，使用环境变量传递，不写入命令行。

`--no-daemon` 让 Hook 使用当前进程配置。启动入口强制关闭 `autoRecall`、资料注入和恢复归档注入，Agent 可以根据工具说明和上游 `openviking-memory` 技能按需查询。Botmux 的 history 和 session 恢复继续使用原有 Codex 数据。适配器是该接入路径唯一的自动 OV 会话写入者。

`memory-usage.md` 是固定的工具使用说明，随这个启动入口附加到已有 developer instructions：依赖当前会话中缺失的历史信息时先检索，自包含任务直接处理。它保留已有全局或选定 profile 的说明，不包含任何历史记忆内容、不执行检索，也不修改全局 Codex 配置。

当前服务版本的普通项目检索使用 `search(mode="context", purpose="coding", peer_scope="actor")`；三个参数都应明确提供。省略 `purpose` 的平坦检索路径可能返回其他项目内容。需要自行筛选原始命中时，使用 `find` 或 list 模式的 `search` 并明确 `target_uri`。跨项目查询由 Agent 根据用户请求主动选择，peer 范围属于检索约定。

已有话题恢复后可能继续复用原来的 CLI 进程，需要新建话题加载插件。`verify-runtime.mjs` 检查配置、固定二进制、daemon 和服务健康；它不证明飞书消息进入或回复交付。

## 效果验证及证据边界

`smoke.py` 调用实际安装版本的 Codex adapter，运行五次交互式会话：

| 场景 | 验收要求 |
|---|---|
| 关闭插件的基线 | 回答没有测试约定，无 OpenViking 上下文 |
| 记录项目约定 | Stop 捕获；SessionEnd 提交；后台 task 完成且新增记忆 |
| 无需历史的普通问题 | 无自动注入，也不调用记忆工具 |
| 新会话执行依赖历史的任务 | 无自动注入；Agent 主动调用 MCP 检索；工具返回记忆 URI 与内容；回答遵守约定 |
| 另一项目执行任务 | 默认检索不返回其他 peer 目录；回答不套用只适用于原项目的规则 |

测试关闭 Codex 内置 Memory，并使用临时目录、新的专用 peer，以及每次独立的项目名和验收标签，避免旧测试记忆影响本轮。临时目录的信任配置只传给这次 CLI 进程，不修改全局项目信任。用户提问不包含约定中的验收标签，也不指定必须调用哪个工具；测试要求模型自主选择记忆检索。脚本检查没有 `<openviking-context>` 自动注入，并验证真实 `memory_diff.json`、索引查询、MCP 调用及工具结果，记录到 git 忽略的 `evidence/`，会调用账户模型。

示例约定为“每份发布摘要以墨桐已验收开头，最后一行是验收标签：紫杉-6419”。关闭插件时应得到普通发布摘要；新会话按需检索后应输出：

```text
墨桐已验收

本次发布修复登录页面错误，恢复用户正常登录。

验收标签：紫杉-6419
```

这个案例验证跨会话项目约定可被主动检索使用。Agent 主动检索也可能漏查历史；真实评估需要分别测量依赖历史的任务和无需历史的任务，记录错答、遗漏检索、不必要检索、token 与耗时。完整飞书入口与回复交付，以及整体体验收益，仍需另外评估。

用户级记忆本来就共享给该用户的项目，可能包含对某个项目的描述。负例分别检查其他 peer 的检索范围和回答是否误用规则；它不要求所有用户级记忆都不提及其他项目。实际验证曾返回用户级的项目规则，Agent 根据其适用范围没有套用到另一项目。

## 撤回

```bash
python3 pilot.py unbind
# 按原部署方式重启同一个 Bot daemon
```

撤回只恢复该 Bot 原来的入口字段；其他配置与 OpenViking 数据保留。备份含 Bot 配置，权限为 0600，不上传 git。服务仍可能供其他 Agent 使用，确认独占后再执行 `python3 pilot.py stop`。

源码、`runtime.json` 和 `evidence/` 位于示例目录；配置与凭据文件使用本机目录。日志在 `~/.openviking/logs/`。提交 PR 时只提交本示例源码与文档，排除运行配置、账户凭据、真实会话和完整 Bot 配置。
