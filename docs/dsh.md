# DeepSeek Harness（dsh）机器人接入指南

> dsh 适配器把飞书机器人接到 deepseek-harness 运行时：botmux 内置的 `dsh-runner.js` 启动 `dsh-jsonrpc-agent`（需单独安装），后者加载 cordis 组合，模型调用走组合里的 `llm-deepseek`。要求 botmux 包含 dsh 适配器——dashboard 的 CLI 下拉里能看到 **DeepSeek Harness** 即满足要求。

## 快速接入

1. 前提：botmux daemon 正常运行；已安装 `dsh-jsonrpc-agent`（见「安装 dsh 运行时」）；有一个飞书机器人。
2. 打开 dashboard → 选中机器人 →「Agent 配置」→ CLI 下拉选择 **DeepSeek Harness**（`cliId: "dsh"`）。
3. 配置项：

   | 字段 | 说明 |
   |------|------|
   | `model` | 默认 `deepseek-v4-flash`，可选 `deepseek-v4-pro` |
   | `workingDir` | 会话工作目录 |
   | `provider` | 无需配置。runner 固定使用 `deepseek-official` 路由；该路由的 key / baseURL 只能通过环境变量与组合配置调整（见下），不支持更换其它 provider 路由 |

4. 配置凭据（见「凭据配置」）。
5. 群里 @机器人 发消息即可。报错对照文末「常见问题」逐条排查。

## 安装 dsh 运行时

`dsh-runner.js` 随 botmux 构建分发，无需安装；需要安装的是 `dsh-jsonrpc-agent`，deepseek-harness 的单文件运行时：

```bash
pip install deepseek-harness-sdk   # 依赖 deepseek-harness-runtime-bin，提供 dsh-jsonrpc-agent
```

安装后确认 `dsh-jsonrpc-agent` 在 daemon 的 PATH 上；不在则给机器人配置 `pathOverride` 指定绝对路径。组合所需插件（sdk-jsonrpc-server / agent-spine-demo / llm-deepseek / session-persistence-jsonl / session-checkpoint-policy / subprocess-local / bash-local / fs-local）捆绑在运行时内部，配置里只写 `name`，无需单独安装。

## 凭据配置

dsh 适配器**不读取 `~/.dsh` 全局配置**：botmux 的组合里没有挂载 `dsh-settings-file` / `dsh-credentials-local` / `llm-pi-ai`，`~/.dsh/settings.yaml` 与 `~/.dsh/.credentials.yaml` 均不生效，凭据只能通过环境变量传入进程（报错 "export DEEPSEEK_API_KEY in the launching environment" 即由此而来）。

要复刻 `~/.dsh` 的配置效果，将其拆成三处：环境变量（key）、组合配置（key 引用与 baseURL）、bot 的 `model` 字段（模型）。

### 环境变量

| 变量 | 何时需要 | 作用 |
|------|---------|------|
| `DEEPSEEK_API_KEY` | 走官方 API | `llm-deepseek` 默认读取的 key |
| `OPENCODE_GO_API_KEY` | 走 zen/go 网关 | 自定义组合中把 `apiKeyEnv` 指向它 |
| `DSH_CORDIS_CONFIG` | 使用自定义组合 | 自定义 cordis.yml 的绝对路径 |
| `DEEPSEEK_BASE_URL` | 可选 | 组合未配置 `baseURL` 时的兜底端点 |

### 注入方式

- **per-bot env（推荐）**：`bots.json` 的 `env` 字段，或 dashboard 机器人配置页「运行时环境变量」。按会话注入，新会话生效，不影响其它机器人。沙箱模式下该变量可能不会传递，遇到时改用 daemon 环境。
- **daemon 环境**：export 后重启 daemon。pm2 保留首次启动时捕获的环境，修改后需 `pm2 restart --update-env`（或 delete + start）才会更新。

## 自定义组合（可选）

runner 每次启动会把内置的默认组合覆写到 `~/.botmux/dsh/cordis.yml`，直接修改该文件无效。需要自定义时设置 `DSH_CORDIS_CONFIG=<绝对路径>`，runner 优先读取该文件。

默认组合如下；需要改路由时复制一份，仅调整 `llm-deepseek` 段。以下为走 zen/go 网关的示例：

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

## 会话与版本

- **会话目录**：`~/.botmux/dsh/`，runner 自动创建，适配器将其声明为 `authPaths`，文件沙箱内可写。
- **版本兼容**：botmux 内置默认组合与 dsh 运行时的协议版本绑定，升级 dsh 运行时前需确认与当前 botmux runner 的协议兼容。

## 常见问题

| 现象 | 原因与处理 |
|------|-----------|
| dashboard 无 DeepSeek Harness 选项 | botmux 版本过旧，无 dsh 适配器。升级 botmux |
| 报找不到 dsh-jsonrpc-agent | 运行时未安装或不在 PATH。安装 `deepseek-harness-sdk` 并将 `dsh-jsonrpc-agent` 加入 PATH（或配置 `pathOverride`） |
| `no API key for provider route "deepseek-official"` | key 未进入进程环境（`~/.dsh/.credentials.yaml` 不生效）。通过 per-bot env 或 daemon 环境配置 key |
| per-bot env 已配置仍报缺 key | 沙箱未传递该环境变量。改用 daemon 环境（export 后 `pm2 restart --update-env`） |
| `UNKNOWN_MODEL` 或 401 | model 不在该路由的模型列表，或 key 有误。核对 model 字段、key、baseURL |

`GET /api/cli-options` 返回 `dsh: available: true/false`，可确认适配器是否可用。
