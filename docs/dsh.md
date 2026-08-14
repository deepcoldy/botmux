# DeepSeek Harness（dsh）接入指南

> botmux 通过 `dsh` 适配器把飞书话题群接到 **deepseek-harness（dsh）** 运行时：会话由 dsh 的 agent 组合驱动（subprocess / bash / fs 等本地能力插件 + llm-deepseek 模型适配器）。要求 botmux 为**包含 dsh 适配器的版本**（`cliId: "dsh"` 由 PR #858 引入）。

## 一、进程链（谁依赖谁）

```
飞书消息 → botmux daemon
 → worker → spawn node dsh-runner.js            [botmux 构建内置，无需单独安装]
 → spawn dsh-jsonrpc-agent <config>             [PATH 上的可执行文件，需自行安装]
 → 加载 cordis 组合 → llm-deepseek 适配器 → HTTP 调用模型
```

- `dsh-runner.js` 是 botmux 自己的桥接层（JSON-RPC stdio ↔ botmux 控制帧），随 botmux 构建分发，**无需单独安装**。
- `dsh-jsonrpc-agent` 是 deepseek-harness 的**单文件运行时**，**必须存在且可执行**；botmux 通过 `resolveCommand('dsh-jsonrpc-agent')` 在 PATH 上查找（或机器人配置的 `pathOverride`）。

## 二、依赖清单

| 依赖 | 来源 | 说明 |
|---|---|---|
| botmux（含 dsh 适配器） | 源码构建 / 发布版（PR #858 之后） | 旧版本没有 dsh 适配器，dashboard 不会出现 DeepSeek Harness 选项 |
| `dsh-jsonrpc-agent` | pip 包 `deepseek-harness-sdk` → `deepseek-harness-runtime-bin`（平台 wheel 内的单文件可执行程序） | 安装后确认其在 daemon 的 PATH 上 |
| 运行时组合里的 8 个插件（sdk-jsonrpc-server / agent-spine-demo / llm-deepseek / session-persistence-jsonl / session-checkpoint-policy / subprocess-local / bash-local / fs-local） | **捆绑在单文件运行时内部** | 组合配置里只写 `name`，由运行时解析，**无需单独安装** |
| 版本耦合 | — | botmux 内置的 vendored 组合与 dsh 运行时协议版本绑定：**升级 dsh 运行时要注意与 botmux runner 的协议兼容** |

## 三、快速接入

1. 前提：botmux daemon 正常运行；已安装 `dsh-jsonrpc-agent` 并在 PATH；有一个飞书机器人。
2. dashboard → 选中机器人 →「Agent 配置」→ CLI 下拉选择 **DeepSeek Harness**（`cliId: "dsh"`）。
3. 配置机器人字段：

   | 字段 | 说明 |
   |------|------|
   | `cliId` | `"dsh"` |
   | `model` | 默认 `deepseek-v4-flash`，可选 `deepseek-v4-pro`（来自 runner 的 initialize 请求的 model 字段） |
   | `workingDir` | 会话工作目录 |
   | provider | **不要配置**：runner 硬编码 `provider: 'deepseek-official'`——只能改这条路由的 key/baseURL，不能切换到其它 provider 路由 |

4. 配置凭据（见下一节），然后群里 @机器人 发消息。

## 四、凭据配置（重点）

**dsh 适配器完全不读 `~/.dsh` 全局配置**：botmux 的组合里没有挂 `dsh-settings-file` / `dsh-credentials-local` / `llm-pi-ai`，所以 `~/.dsh/settings.yaml` 与 `~/.dsh/.credentials.yaml` **都不生效**。凭据只能靠**环境变量**进入进程。

要复刻全局配置的效果，就是把 settings.yaml 里的信息翻译成：**自定义组合（provider 路由的 key/baseURL）+ 环境变量 + bot 的 model 字段**。

### 环境变量（必须到达 runner 进程）

| 变量 | 必填 | 作用 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 走官方 API 时必填 | llm-deepseek 的默认凭据引用（`apiKeyEnv`） |
| `OPENCODE_GO_API_KEY` | 走 zen/go 网关时必填 | 自定义组合里把 `apiKeyEnv` 改指它 |
| `DSH_CORDIS_CONFIG` | 使用自定义组合时必填 | 指向自定义 cordis.yml 的绝对路径 |
| `DEEPSEEK_BASE_URL` | 可选 | 组合里不写 `baseURL` 时的兜底端点 |

### 注入方式（二选一）

- **per-bot env（推荐）**：`bots.json` 的 `env` 字段，或 dashboard 机器人配置页「运行时环境变量」。按会话注入，**新会话即生效**，不影响其它机器人。
- **daemon 环境**：在 daemon 启动环境里 export 后重启。注意：pm2 保留首次捕获的环境变量，改环境后需要 `pm2 restart --update-env`（或 delete + start）才可靠。

## 五、组合配置（cordis.yml）——runner 决定用哪份

- **默认**：runner 每次启动把内置的 vendored 组合**覆写**到 `~/.botmux/dsh/cordis.yml`，所以**直接改这个文件没有用**。
- **自定义**：设置环境变量 `DSH_CORDIS_CONFIG=<绝对路径>`，runner 优先使用该文件（文件存在时）。

自定义组合 = 默认组合 + 按需覆盖 llm-deepseek 路由。示例（走 zen/go 网关）：

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

## 六、会话目录

`~/.botmux/dsh/`：会话持久化目录（runner 自动创建；适配器的 `authPaths` 保证文件沙箱内可写）。

## 七、排错速查

| 现象 | 原因 | 处理 |
|---|---|---|
| dashboard 无 DeepSeek Harness 选项 | botmux 版本旧（无 dsh 适配器） | 升级 botmux 到包含 dsh 适配器的版本 |
| 选项在但报「找不到 dsh-jsonrpc-agent」 | 运行时没装 / 不在 PATH | 安装 `deepseek-harness-sdk` 并把 `dsh-jsonrpc-agent` 放进 PATH（或配置 `pathOverride`） |
| `no API key for provider route "deepseek-official"` | key 没进进程环境（`~/.dsh/.credentials.yaml` 不算数） | 用 per-bot env 或 daemon 环境配置 key |
| 配了 per-bot env 仍报缺 key | 文件沙箱可能未透传环境变量 | 兜底：export 到 daemon 环境后重启（`pm2 restart --update-env`） |
| `UNKNOWN_MODEL` / 401 | bot 的 model 不在该路由模型列表 / key 错误 | 检查 model 字段、key、baseURL 是否匹配 |

> 诊断：dsh 适配器可用性可通过 `GET /api/cli-options` 返回的 `dsh: available: true/false` 确认。
