# 接入 DeepSeek Harness（dsh）

botmux 的 dsh 适配器把飞书机器人接到 deepseek-harness：会话由 dsh 的 agent 组合驱动，模型调用走组合里的 `llm-deepseek`。需要包含 dsh 适配器的 botmux 版本——dashboard 的 CLI 下拉里能看到 **DeepSeek Harness** 即说明版本满足；看不到说明版本过旧，先升级。

> 最反直觉的一点先放前面：**dsh 的凭据不读 `~/.dsh`**。`settings.yaml`、`.credentials.yaml` 里配了也不生效，key 只能靠环境变量进进程。第一次接入最容易在这里卡住，详见[配置凭据](#配置凭据)。

## 跑起来

要装的东西只有一样：dsh 运行时本体。

botmux 自带的桥接层 `dsh-runner.js` 随构建分发，不用管；要装的是 `dsh-jsonrpc-agent`，deepseek-harness 的单文件运行时：

```bash
pip install deepseek-harness-sdk   # 会带上 deepseek-harness-runtime-bin 平台 wheel，提供 dsh-jsonrpc-agent
```

装完确认 `dsh-jsonrpc-agent` 在 daemon 的 PATH 上；不在就给机器人配 `pathOverride` 指绝对路径。运行时内部捆绑了组合要用的 8 个插件，不需要再装任何插件。

然后 dashboard → 机器人 →「Agent 配置」→ CLI 选 **DeepSeek Harness**（`cliId: "dsh"`），填这几个：

- `model`：默认 `deepseek-v4-flash`，需要更强可选 `deepseek-v4-pro`
- `workingDir`：会话工作目录
- `provider`：无需配置。runner 固定走 `deepseek-official` 路由；想改这条路由的 key / baseURL，只能通过环境变量和组合配置（见下），换不了其它路由

key 按下一节配好后，@机器人 发消息即可。报错对照文末[排错速查](#排错速查)。

## 配置凭据

dsh 在 botmux 里的凭据链路和单独用 dsh 时不一样。botmux 的组合里没有 `dsh-settings-file` / `dsh-credentials-local` / `llm-pi-ai` 这几个插件，所以 `~/.dsh/settings.yaml`（默认模型、路由那些）和 `~/.dsh/.credentials.yaml`（key）**全部不生效**——报错提示 "export DEEPSEEK_API_KEY in the launching environment" 就是这个原因。

想复刻 `~/.dsh` 里的配置，把它拆成三处：环境变量（key）、组合配置（路由的 key 引用和 baseURL）、bot 的 `model` 字段（模型）。

### 环境变量

| 变量 | 什么时候要 | 作用 |
|------|-----------|------|
| `DEEPSEEK_API_KEY` | 走官方 API | `llm-deepseek` 默认读的 key |
| `OPENCODE_GO_API_KEY` | 走 zen/go 网关 | 自定义组合里把 `apiKeyEnv` 指到它 |
| `DSH_CORDIS_CONFIG` | 用了自定义组合 | 指向自定义 cordis.yml 的绝对路径 |
| `DEEPSEEK_BASE_URL` | 可选 | 组合里没写 `baseURL` 时用这个兜底 |

### 怎么把变量送进进程

两种方式，推荐第一种：

- **per-bot env**：`bots.json` 的 `env` 字段，或 dashboard 机器人配置页的「运行时环境变量」。按会话注入，新会话生效，不影响别的机器人。
- **daemon 环境**：export 之后重启 daemon。注意 pm2 只保留首次启动时捕获的环境，改过之后要 `pm2 restart --update-env`（或者 delete + start）才生效，只 `botmux restart` 不行。

per-bot env 在沙箱模式下偶尔透传不进去，遇到这种情况退回 daemon 环境即可。

### 自定义组合（可选）

runner 每次启动会把内置的默认组合**覆写**到 `~/.botmux/dsh/cordis.yml`——直接改这个文件没用，改完下次启动就被覆盖。要自定义，设置 `DSH_CORDIS_CONFIG=<绝对路径>`，runner 优先读这个文件。

默认组合的完整内容如下；需要改路由时复制一份，只调整 `llm-deepseek` 那一段即可。下面是走 zen/go 网关的示例：

```yaml
- id: sdk-jsonrpc-server
  name: '@deepseek-ai/dsh-sdk-jsonrpc-server'
- id: agent-core
  name: '@deepseek-ai/dsh-agent-spine-demo'
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: OPENCODE_GO_API_KEY
    baseURL: https://opencode.ai/zen/go/v1
- id: sessions
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
- id: session-checkpoints
  name: '@deepseek-ai/dsh-session-checkpoint-policy'
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
- id: fs-local
  name: '@deepseek-ai/dsh-fs-local'
```

## 原理速览

一条链：飞书消息 → botmux daemon → worker → `dsh-runner.js`（botmux 的桥接层）→ `dsh-jsonrpc-agent`（你装的运行时）→ 组合里的 `llm-deepseek` → HTTP 调模型。

两个容易忽略的点：

- **升级 dsh 运行时要谨慎**：botmux 内置的默认组合和 dsh 的协议版本绑定，运行时大版本升级前先确认和当前 botmux 的 runner 兼容。
- **会话落在哪**：`~/.botmux/dsh/`，runner 自动创建，适配器把它声明为 `authPaths`，文件沙箱里也可写。

## 排错速查

| 现象 | 原因 | 处理 |
|------|------|------|
| dashboard 里没有 DeepSeek Harness 选项 | botmux 版本旧，没有 dsh 适配器 | 升级 botmux |
| 有选项，但报找不到 dsh-jsonrpc-agent | 运行时没装，或不在 PATH | `pip install deepseek-harness-sdk`，把 `dsh-jsonrpc-agent` 放进 PATH（或配 `pathOverride`） |
| `no API key for provider route "deepseek-official"` | key 没进进程环境，`~/.dsh/.credentials.yaml` 不算数 | 用 per-bot env 或 daemon 环境配 key |
| per-bot env 配了还是报缺 key | 沙箱可能没透传这个变量 | 退回 daemon 环境：export 后 `pm2 restart --update-env` |
| `UNKNOWN_MODEL` 或 401 | model 不在该路由的模型列表里，或 key 不对 | 核对 model 字段、key、baseURL 三者 |

`GET /api/cli-options` 返回 `dsh: available: true/false`，可以快速确认适配器本身是否可用。
