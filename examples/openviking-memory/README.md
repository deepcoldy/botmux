# OpenViking 共享记忆（可选，默认关闭）

所有能执行 shell 的 coding agent 共用同一个 OpenViking 服务、用户和项目记忆。Agent 自己决定何时搜索、读取和保存重要结论。公共入口使用 Node.js 22+，没有 Codex 可执行文件、配置或插件依赖。

**默认关闭。** 常规 Botmux 安装和启动不会执行本示例。配置服务、准备客户端、构建或安装 Botmux 插件均不会自动启用；必须显式绑定选中的 Bot 或本地 Agent。关闭时不投递本功能的 Skill、读取提示词或入口。可选宿主自动采集有独立开关，见下文。

## 结构与能力

```text
Codex / Claude Code / OpenCode / Gemini / 其他具备 shell 的 Agent
  -> 同一份 OpenViking Skill
  -> 公共 CLI search / find / read / remember / status
  -> OpenViking HTTP 服务
  -> 相同用户与项目的长期记忆

可选 Codex 自动会话采集 -> 同一用户和项目 -> 同一后端
```

| 能力 | 接入方式 |
|---|---|
| 所有具备 shell 的 Agent 主动搜索、读取、写入 | `memory.mjs` + 同一份 Skill |
| Botmux 分发给不同 Agent | 标准插件 `openviking`；命令 `botmux openviking` |
| 自动采集普通对话 | 可选宿主适配；当前示例验证 Codex |
| 自动召回、启动资料/恢复归档注入 | 均关闭 |

同一记忆由 `account + user + project peer` 定位。user 显式配置，所有 Agent 复用；peer 来自项目 `.openviking/config.local.json` / `config.json` 的 `peer.id`，或 Git remote、Git common root。Agent、Bot、模型、会话 ID 均不参与项目身份。缺少项目身份时只搜索用户级记忆，项目写入要求明确 peer。

Git 项目根目录、子目录、worktree，以及 SSH/HTTPS remote 拼写会得到相同 peer。非 Git workdir 可以显式设置 peer，或选择 `"peer":{"source":"cwd"}`。原试点已有用户和非 Git cwd 模板继续保留，其他 Agent 指向同一客户端文件即可读到旧记忆。

## 1. 共用服务和客户端（尚未绑定 Agent）

先按官方[服务端配置](https://docs.openviking.ai/zh/configuration/01-server)部署 OpenViking。已有服务可以直接复用。Embedding、提取与摘要模型配置在服务端，各 Agent 只配置连接。

当前本地试点：OpenViking `0.4.23`，`http://127.0.0.1:1933`，本地 `bge-small-zh-v1.5-f16` / 512 维，数据 `~/.openviking/data`；提取和摘要使用已授权的 `openai-codex` 模型。客户端使用哪种 Agent 不影响这些服务端设置。更换提取提供方按服务端文档操作。

准备一个用户私有客户端文件，例如 `~/.openviking/ovcli.conf`，权限设为 0600。示例结构：

```json
{
  "url": "http://127.0.0.1:1933",
  "api_key": "",
  "account": "default",
  "user": "my-shared-memory-user",
  "peer": { "source": "git" }
}
```

所有 Agent 使用同一文件。需要复用试点历史时，直接使用已有客户端与 user，不新建另一套用户空间。API key 可改为 `api_key_env` 指定环境变量名；不在命令行或 Skill 内写密钥。当前入口适用于同一操作系统用户的个人开发环境；多用户 Bot 与隔离凭据的沙箱需要另行接入可信身份桥。

无论哪个 Agent，均可显式调用：

```bash
node /absolute/path/to/examples/openviking-memory/memory.mjs \
  --config /absolute/path/to/shared/ovcli.conf search '此前约定的发布摘要格式'
```

`search` 默认固定 `mode=context,purpose=coding,peer_scope=actor`；`find` 指定用户记忆与当前 peer 目录；`read` 限制到该用户的通用记忆和当前项目。项目隔离是检索约定，不构成同一操作系统用户的授权边界。

`remember --scope project --text '已确认的项目决策'` 会明确项目提取 policy 并逐条传 peer_id，`--scope user` 保存跨项目偏好。返回 task_id 只代表已提交后台提取，通过 `status TASK_ID` 查看完成情况。失败的写入不自动重试，先检查服务中的会话与任务状态。

## 2. 显式绑定本地 Agent

支持 Skill 的宿主，指定它实际使用的技能目录；每次绑定只操作该目录里的 `openviking-memory`：

```bash
node setup-shared.mjs agent-bind \
  --config /absolute/path/to/shared/ovcli.conf \
  --skills-dir /absolute/path/to/this-agent/skills

# 撤回本地 Skill，之后启动新会话
node setup-shared.mjs agent-unbind --skills-dir /absolute/path/to/this-agent/skills
```

安装器复制同一份 CLI/客户端并生成绝对路径的使用说明。不覆盖已有同名 Skill；文件有手动修改时拒绝替换或删除。每个 Agent 使用同一客户端配置、同一项目，即共享记忆。没有 Skill 机制的宿主也可以显式调用公共 CLI，或在启用后把相同工具使用规则配置为宿主指令。

启用后 Agent 在历史信息缺失时主动查询；自包含任务直接处理。提示规则可能漏查，记忆是参考证据，当前用户指令优先。

## 3. 显式绑定 Botmux 的任意 coding-agent Bot

此路径使用当前 Botmux 的公共插件 API，无需修改每个 CLI adapter。选一个已有的单用户 Bot，索引从 0 开始：

```bash
# 安装和设置连接，仍未启用
node setup-shared.mjs plugin-install --bot-index 0 \
  --botmux-root /absolute/path/to/built-or-installed/botmux \
  --config /absolute/path/to/shared/ovcli.conf

# 显式启用，然后按原部署方式重启该 Bot、启动新话题
node setup-shared.mjs plugin-bind --bot-index 0 \
  --botmux-root /absolute/path/to/built-or-installed/botmux

# 撤回共享入口，启动新 CLI 会话后生效
node setup-shared.mjs plugin-unbind --bot-index 0 \
  --botmux-root /absolute/path/to/built-or-installed/botmux
```

可传 `--bots-config FILE`，默认使用 `BOTS_CONFIG` 或 `~/.botmux/bots.json`。绑定只增删选中 Bot 的 `plugins` 中 `openviking`，保留 CLI、已有自动采集适配与其他 Bot 的变更。插件薄封装同一客户端，通过 Skill 和 `botmux openviking search/read/remember/status` 提供能力。

本机旧 Botmux `2.71.3` 缺少该公共插件 API，安装器会明确报错。旧版本可使用独立 Skill/CLI 和已验证的试点启动器；新版插件分发需要部署具备该 API 的版本。源码完成和本机 daemon 生效分别验证。

## 4. 可选 Codex 自动会话采集

`pilot.py`、`bin/codex-openviking` 与 `install-plugin.mjs` 属于可选 Codex 宿主适配。它负责 Stop 捕获、SessionEnd/压缩前提交；公共读取和显式写入不依赖这些文件。当前自动采集按官方 [Codex 集成](https://docs.openviking.ai/zh/agent-integrations/04-codex)验证；其他宿主需要各自的采集适配。

```bash
python3 pilot.py configure --bot-index 0 \
  --codex /absolute/path/to/codex \
  --botmux-root /absolute/path/to/built-or-installed/botmux \
  --memory-user 'my-shared-memory-user' \
  --vlm-model '<model-supported-by-your-Codex-account>'
# 已有服务加 --use-existing-server，保留 ov.conf。

node install-plugin.mjs --source=/absolute/path/to/reviewed/OpenViking
# 阅读列出的六个 Hook 与源码后，显式信任：
node install-plugin.mjs --source=/absolute/path/to/reviewed/OpenViking --trust-hooks

python3 pilot.py bind
```

新部署本地 Embedding 需 `openviking[local-embed]==0.4.23`，Python 3.11+；按服务端文档完成提取模型授权。服务可由自己的 supervisor 管理，也可 configure 时指定 `--pm2` 后执行 `pilot.py start/stop/health`。服务运行本身不会绑定任何 Agent。

适配器保持 HOME/CODEX_HOME，固定 Codex `0.160.1 --no-daemon`，按 `-C/--cd` 解析项目并调用同一 `client.mjs`；全局原生插件保持 disabled，仅该启动入口启用 capture。原生记忆 MCP 在本进程关闭，读取改用公共 CLI。短工具使用说明追加到现有 developer instructions，既不查历史也不注入记忆内容。

此适配是本会话唯一的自动写入者；公共 CLI 的 remember 只保存额外的明确事实，避免重复普通对话。

**两个独立开关：** `setup-shared.mjs ...-unbind` 关闭共享 Skill/插件，`pilot.py unbind` 撤回 Codex 采集启动器及其兼容读取说明。完整关闭需撤回当前已启用的两种绑定，并重启对应会话；服务和已有记忆继续保留。

## 验证

```bash
node --test test_shared.mjs
python3 -m unittest discover -s . -p 'test_*.py'

# 真实服务写入→提取完成→项目 URI→两种 Agent 主动搜索/读取→遵守约定
node smoke-shared.mjs --config /absolute/path/to/shared/ovcli.conf \
  --codex /absolute/path/to/codex \
  --opencode /absolute/path/to/opencode --opencode-model '<provider/model>'

# 已配置可选 Codex adapter 时，验证原生 capture 生命周期
python3 smoke.py
node verify-runtime.mjs
```

跨 Agent 测试每次使用独立项目和未知验收标签，Codex 内置 Memory 与原生 OV 插件在共享入口测试中关闭。测试同时检查另一个项目不返回原 peer 的目录。原生 TUI 测试覆盖普通问题不查询、新会话主动搜索、自动捕获/提交/提取。证据写入 git 忽略的 `evidence/`，会话和配置文件不提交 PR。

Botmux 测试 `test/openviking-memory-example.test.ts` 验证 Codex、Claude Code、OpenCode、Gemini 的公共分发与默认关闭，以及非 Codex Bot 命令使用固定的共享配置。安装器还经过隔离运行验证：非 Codex Bot 绑定/撤回、保留其他 Bot 和采集配置、拒绝覆盖手动修改。真实模型验证以实际记录的宿主为准；公共目录生成不证明每种模型都正确查询。完整飞书进入、worker 处理与回复交付未由上述本地测试覆盖。
