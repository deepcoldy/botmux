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

`dsh-runner.js` 随 botmux 构建分发，无需安装；需要安装的是 `dsh-jsonrpc-agent`，deepseek-harness 的单文件运行时（要求 Python >= 3.10）：

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

- **per-bot env（推荐）**：`bots.json` 的 `env` 字段，或 dashboard 机器人配置页「运行时环境变量」。按会话注入，新会话生效，不影响其它机器人。沙箱模式下同样生效：worker 把 `env` 作为 `injectEnv` 传给后端（PTY 并入子进程环境，tmux 通过 pane 内 `/usr/bin/env KEY=VAL` 注入），bwrap 不清理环境，key 会被一路继承。
- **daemon 环境**：export 后重启 daemon 生效。用 `botmux restart`（在仓库 checkout 内也可用 `pnpm daemon:restart`）；不要直接用 `pm2 restart --update-env`，会绕过 botmux 的安全重启与会话恢复。

## 自定义组合（可选）

runner 每次启动会把内置的默认组合覆写到 `~/.botmux/dsh/cordis.yml`，直接修改该文件无效。需要自定义时设置 `DSH_CORDIS_CONFIG=<绝对路径>`，runner 优先读取该文件。

内置默认组合如下（与 `src/dsh-runner.ts` 的 `VENDORED_CONFIG` 一致）：

```yaml
# Vendored by botmux dsh-runner. Source: deepseek-harness python/sdk-runtime cordis.yml.
- id: sdk-jsonrpc-server
  name: '@deepseek-ai/dsh-sdk-jsonrpc-server'
- id: agent-core
  name: '@deepseek-ai/dsh-agent-spine-demo'
  config:
    workspaceContext:
      maxBytes: 65536
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
- id: sessions
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js process.env.DSH_SESSION_ROOT ?? './.sessions'
- id: session-checkpoints
  name: '@deepseek-ai/dsh-session-checkpoint-policy'
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
  config:
    cwd: !!js process.env.DSH_CWD ?? process.cwd()
- id: fs-local
  name: '@deepseek-ai/dsh-fs-local'
  config:
    cwd: !!js process.env.DSH_CWD ?? process.cwd()
```

改路由时复制一份，只调整 `llm-deepseek` 段。例如走 zen/go 网关，把该段改为：

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: OPENCODE_GO_API_KEY
    baseURL: https://opencode.ai/zen/go/v1
```

其余段保持默认即可——尤其不要删掉 `sessions.config.root` 与 `bash` / `fs-local` 的 `config.cwd`，否则会话落盘位置会退回 workingDir 下的 `./.sessions`，与下文「会话目录」冲突。

> 沙箱注意：`DSH_CORDIS_CONFIG` 指向的文件必须在文件沙箱可见范围内，否则沙箱内 `existsSync` 判空会**静默回退到内置组合**。最稳妥是放在 `~/.botmux/dsh/`（适配器已把该目录声明为 `authPaths`，例如 `~/.botmux/dsh/custom.yml`），或放在 workingDir 内。

## 会话与版本

- **会话目录**：`~/.botmux/dsh/`，runner 自动创建，适配器将其声明为 `authPaths`，文件沙箱内可写。
- **版本兼容**：botmux 内置默认组合与 dsh 运行时的协议版本绑定，升级 dsh 运行时前需确认与当前 botmux runner 的协议兼容。

## 常见问题

| 现象 | 原因与处理 |
|------|-----------|
| dashboard 无 DeepSeek Harness 选项 | botmux 版本过旧，无 dsh 适配器。升级 botmux |
| 报找不到 dsh-jsonrpc-agent | 运行时未安装或不在 PATH。安装 `deepseek-harness-sdk` 并将 `dsh-jsonrpc-agent` 加入 PATH（或配置 `pathOverride`） |
| `no API key for provider route "deepseek-official"` | key 未进入进程环境（`~/.dsh/.credentials.yaml` 不生效）。通过 per-bot env 或 daemon 环境配置 key |
| 自定义组合不生效（仍走默认路由 / 模型） | `DSH_CORDIS_CONFIG` 指向的文件在沙箱内不可见，`existsSync` 判空后静默回退内置组合。把文件放到 `~/.botmux/dsh/` 或 workingDir 内 |
| `UNKNOWN_MODEL` 或 401 | model 不在该路由的模型列表，或 key 有误。核对 model 字段、key、baseURL |

`GET /api/cli-options` 返回的 `options` 数组中，`id: "dsh"` 条目的 `available` 为 true/false，可确认适配器是否可用。
