# DeepSeek Harness（dsh）接入指南

这份文档面向要把 **dsh（deepseek-harness）** 接入 botmux 的使用者：从零配好一个能用的 dsh 机器人、搞清凭据为什么总是配不上、需要自定义模型路由时知道改哪里。

dsh 适配器由 PR #858 引入。使用前先确认 botmux 包含 dsh 适配器——dashboard 的 CLI 下拉里能看到 **DeepSeek Harness** 选项即说明版本满足。

## 快速接入

### 1. 安装 dsh 运行时

botmux 自带的 dsh 桥接层（`dsh-runner.js`）随构建分发，但底层的 `dsh-jsonrpc-agent` 需要单独安装：

- 安装 pip 包 `deepseek-harness-sdk`（依赖 `deepseek-harness-runtime-bin` 平台 wheel，提供单文件可执行程序 `dsh-jsonrpc-agent`）。
- 确认 `dsh-jsonrpc-agent` 在 daemon 的 PATH 上；不在的话为机器人配置 `pathOverride` 指定绝对路径。

### 2. 配置机器人

dashboard → 选中机器人 →「Agent 配置」→ CLI 下拉选择 **DeepSeek Harness**（`cliId: "dsh"`），并按需配置：

| 字段 | 说明 |
|------|------|
| `cliId` | `"dsh"` |
| `model` | 默认 `deepseek-v4-flash`，可选 `deepseek-v4-pro` |
| `workingDir` | 会话工作目录 |
| `provider` | **不用配置**：runner 固定走 `provider: 'deepseek-official'`，只能通过环境变量 / 组合配置改这条路由的 key 与 baseURL，不能换其它 provider 路由 |

### 3. 配置凭据

dsh 的凭据只认环境变量（见下一节），先把 key 配好再发消息，否则第一轮就会报 `no API key for provider route "deepseek-official"`。

### 4. 验证

群里 @机器人 发条消息。连不上或报 key 相关错误时，对照文末「排错速查」逐条排查。

## 配置凭据（最容易踩坑的地方）

dsh 适配器**不读 `~/.dsh` 全局配置**：botmux 的组合里没有挂 `dsh-settings-file` / `dsh-credentials-local` / `llm-pi-ai`，所以 `~/.dsh/settings.yaml` 和 `~/.dsh/.credentials.yaml` **都不会生效**。凭据只能靠**环境变量**进到进程里——这也是报错会提示 “export DEEPSEEK_API_KEY in the launching environment” 的原因。

要复刻 `~/.dsh` 全局配置的效果，把 settings.yaml 里的信息翻译成三处：**自定义组合（路由的 key / baseURL）+ 环境变量 + bot 的 `model` 字段**。

### 需要哪些环境变量

| 变量 | 何时必填 | 作用 |
|------|----------|------|
| `DEEPSEEK_API_KEY` | 走官方 API 时 | llm-deepseek 默认读取的凭据（`apiKeyEnv` 的默认引用） |
| `OPENCODE_GO_API_KEY` | 走 zen/go 网关时 | 自定义组合里把 `apiKeyEnv` 改指它 |
| `DSH_CORDIS_CONFIG` | 使用自定义组合时 | 指向自定义 cordis.yml 的绝对路径 |
| `DEEPSEEK_BASE_URL` | 可选 | 组合里没写 `baseURL` 时的兜底端点 |

### 注入方式（二选一）

- **per-bot env（推荐）**：`bots.json` 的 `env` 字段，或 dashboard 机器人配置页「运行时环境变量」。按会话注入，**新会话即生效**，不影响其它机器人。
- **daemon 环境**：在 daemon 启动环境里 export 后重启。pm2 保留首次捕获的环境变量，改环境后需要 `pm2 restart --update-env`（或 delete + start）才可靠。

## 自定义组合（可选）

runner 每次启动都会把内置的默认组合**覆写**到 `~/.botmux/dsh/cordis.yml`，所以直接改这个文件没有用。要自定义时设置环境变量 `DSH_CORDIS_CONFIG=<绝对路径>`，runner 会优先使用该文件。

自定义组合 = 默认组合 + 按需覆盖 `llm-deepseek` 路由。走 zen/go 网关的示例：

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

组合里用到的插件都由单文件运行时**内部捆绑**，配置里只写 `name` 即可，不需要单独安装。

## 工作原理

### 进程链

```
飞书消息 → botmux daemon
 → worker → spawn node dsh-runner.js            [botmux 构建内置，无需单独安装]
 → spawn dsh-jsonrpc-agent <config>             [PATH 上的可执行文件，需自行安装]
 → 加载 cordis 组合 → llm-deepseek 适配器 → HTTP 调用模型
```

- `dsh-runner.js`：botmux 自带的桥接层（JSON-RPC stdio ↔ botmux 控制帧），随 botmux 构建分发。
- `dsh-jsonrpc-agent`：deepseek-harness 的**单文件运行时**，必须存在且可执行；botmux 通过 `resolveCommand('dsh-jsonrpc-agent')` 在 PATH 上查找（或机器人的 `pathOverride`）。

### 依赖与版本

| 依赖 | 来源 | 说明 |
|------|------|------|
| botmux（含 dsh 适配器） | 源码构建 / 发布版（PR #858 之后） | 旧版本没有 dsh 适配器，dashboard 不会出现 DeepSeek Harness 选项 |
| `dsh-jsonrpc-agent` | pip 包 `deepseek-harness-sdk` → `deepseek-harness-runtime-bin`（平台 wheel 内的单文件可执行程序） | 安装后确认在 daemon 的 PATH 上 |
| 组合里的 8 个插件（sdk-jsonrpc-server / agent-spine-demo / llm-deepseek / session-persistence-jsonl / session-checkpoint-policy / subprocess-local / bash-local / fs-local） | **捆绑在单文件运行时内部** | 配置里只写 `name`，由运行时解析，无需单独安装 |

版本耦合：botmux 内置的默认组合与 dsh 运行时的协议版本绑定，**升级 dsh 运行时要注意与 botmux runner 的协议兼容**。

### 会话目录

`~/.botmux/dsh/`：会话持久化目录，runner 自动创建；适配器的 `authPaths` 保证文件沙箱内可写。

## 排错速查

| 现象 | 原因 | 处理 |
|------|------|------|
| dashboard 无 DeepSeek Harness 选项 | botmux 版本旧（无 dsh 适配器） | 升级 botmux 到包含 dsh 适配器的版本 |
| 选项在但报「找不到 dsh-jsonrpc-agent」 | 运行时没装 / 不在 PATH | 安装 `deepseek-harness-sdk`，把 `dsh-jsonrpc-agent` 放进 PATH（或配置 `pathOverride`） |
| `no API key for provider route "deepseek-official"` | key 没进进程环境（`~/.dsh/.credentials.yaml` 不算数） | 用 per-bot env 或 daemon 环境配置 key |
| 配了 per-bot env 仍报缺 key | 文件沙箱可能未透传环境变量 | 兜底：export 到 daemon 环境后重启（`pm2 restart --update-env`） |
| `UNKNOWN_MODEL` / 401 | bot 的 model 不在该路由模型列表 / key 错误 | 检查 model 字段、key、baseURL 是否匹配 |

> 诊断：`GET /api/cli-options` 返回 `dsh: available: true/false`，可确认适配器是否可用。
