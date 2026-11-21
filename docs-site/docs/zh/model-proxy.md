# 模型协议代理（实验）

> ⚠️ 实验性功能：接口、字段和限制以后可能调整。不影响普通飞书机器人的使用。

`botmux model-proxy serve` 会在本机 `127.0.0.1` 起一个**带鉴权的 OpenAI Chat Completions 兼容入口**。只会说 OpenAI 协议的工具（比如用 OpenAI SDK 写的脚本、代码评审工具），把 `baseURL` 指过来，就能直接用 CLI（Codex、Claude Code 等）**自己的登录**去调模型，不需要另外申请 API key。

```text
你的工具（OpenAI SDK）
   │  HTTP + Bearer token，只走 127.0.0.1
   ▼
botmux model-proxy（本页）
   │  本机签名 IPC
   ▼
独立的 core-only 实例（apiOnly 机器人，有自己的原生登录）
   │
   ▼
CLI 原生模型调用（工具全部关闭，只做推理）
```

## 适合什么场景

| 我想… | 用这个吗 |
|---|---|
| 让一个已有的 OpenAI 协议工具复用 CLI 的模型登录 | ✅ 就是为这个设计的 |
| 工具自己管上下文和工具调用，只缺一个「模型入口」 | ✅ 工具调用会作为**建议**返回，由你的工具自己执行 |
| 让 AI 在飞书里干活、改代码 | ❌ 用普通机器人即可，见[快速开始](/quickstart) |
| 用 HTTP 驱动一个完整的 CLI 会话（能读写文件、跑命令） | ❌ 看 [Core-only（apiOnly）API 控制](/api-core-only) |
| 流式输出、Embeddings、图像、音频、浏览器直连 | ❌ 暂不支持 |

几个要点先说清：

- **只监听本机回环**（`127.0.0.1`），配置里也只能写这个地址，外网访问不到。
- **CLI 不会动你的文件**：每次调用都关掉 CLI 的原生工具，只做推理。返回的 `tool_calls` 只是建议，执行权在你的工具手里。
- **不借用别的登录**：代理只用你指定的那个专用机器人目录里的登录，不会去拿聊天机器人、全局登录或其它机器人的凭据。

## 快速上手

### 第 1 步：起一个专用的 core-only 实例

代理本身不调模型，它把请求转给一个**独立的 core-only 实例**（一种不连飞书、只走本机 HTTP 的 botmux，见 [Core-only](/api-core-only)）。这个实例要满足：

- 是独立进程，有自己的数据目录和端口。**不要复用、也不要为此重启正在跑的飞书机器人 daemon。**
- 机器人 ID 形如 `local_<名字>`，名字里只用字母、数字、`_`、`-`（代理配置不接受 `.`）。
- 用下表里已经接通的 CLI，并且在该机器人的专用目录里完成原生登录。

```bash
export STATE_DIR="$HOME/model-proxy-demo"     # 自己选一个新目录
export BOTMUX_CORE_CLI=codex                  # 或 claude-code / pi / opencode
export BOTMUX_API_ONLY_BOT=local_reasoner
export BOTMUX_CORE_CODEX_AUTH_SYNC=isolated   # 仅 Codex 需要
export BOTMUX_CORE_STATE_DIR="$STATE_DIR/data"
export BOTMUX_API_PORT=8930                   # 选一个空闲端口
botmux serve --api-only
```

这个命令在前台运行，后面的步骤请另开一个终端，并在新终端里重新 `export STATE_DIR=...`（和上面同一个目录）。

登录文件放在 `$STATE_DIR/bots/<机器人 ID>/<子目录>` 下：

| CLI | 子目录 | 需要的登录文件 |
|---|---|---|
| `codex` / `codex-app` | `codex` | `auth.json`，以及包含目标模型的 `models_cache.json`；必须设置 `BOTMUX_CORE_CODEX_AUTH_SYNC=isolated` |
| `claude-code` | `claude` | `.credentials.json`（只存在系统钥匙串里的登录不行） |
| `pi` | `pi` | `auth.json`（API key 或 OAuth，不支持可执行 helper） |
| `opencode` | `opencode` | `auth.json`（仅 API / OAuth 记录） |

以 Codex 为例，可以用 `CODEX_HOME="$STATE_DIR/bots/local_reasoner/codex" codex login` 登录这个目录。

> 这个实例必须保持「干净」：不要开沙盒、不要设 `--backend`、不要给它配额外的环境变量、启动命令或 wrapper。带了这些配置时，代理启动会直接报 `inference_profile_unsupported`。

### 第 2 步：写代理配置文件

把下面的内容存成一个文件，比如 `$STATE_DIR/model-proxy.json`：

```json
{
  "port": 8788,
  "models": {
    "review-model": {
      "bot": "local_reasoner",
      "model": "<原生模型名>",
      "deadlineMs": 120000
    }
  },
  "clients": [
    { "id": "review-client", "tokenEnv": "BOTMUX_MODEL_PROXY_TOKEN", "models": ["review-model"] }
  ]
}
```

保存后把权限收紧到只有自己能读写，否则代理拒绝启动：

```bash
export PROXY_CONFIG="$STATE_DIR/model-proxy.json"
chmod 600 "$PROXY_CONFIG"
```

- 文件必须是**属于当前用户的普通文件，权限正好是 `0600`**。
- 它所在的目录（以及上层目录）不能被其他用户写。

### 第 3 步：生成 token 并启动代理

```bash
# token 至少 32 个字符、不含空白；通过安全渠道交给要接入的工具
export BOTMUX_MODEL_PROXY_TOKEN="$(openssl rand -hex 32)"
# 指向第 1 步那个实例的数据目录，代理靠它找到实例
export SESSION_DATA_DIR="$STATE_DIR/data"
botmux model-proxy serve --config "$PROXY_CONFIG"
```

启动成功会打印一行 JSON：

```json
{"listening":"http://127.0.0.1:8788/v1","protocol":"chat-completions-v1"}
```

代理在前台运行，`Ctrl+C`（SIGINT）或 SIGTERM 退出，退出时会取消还在跑的调用。

### 第 4 步：在工具里接入

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:8788/v1',
  apiKey: process.env.BOTMUX_MODEL_PROXY_TOKEN,
  maxRetries: 0, // 要不要重试由你决定；需要去重就带 Idempotency-Key
});

const result = await client.chat.completions.create({
  model: 'review-model', // 写配置里的别名，不是原生模型名
  messages: [{ role: 'user', content: '用一句话解释二分查找。' }],
});
console.log(result.choices[0].message.content);
```

想先确认连通，可以列一下这个 token 能用的模型：

```bash
curl -s http://127.0.0.1:8788/v1/models \
  -H "Authorization: Bearer $BOTMUX_MODEL_PROXY_TOKEN"
```

## 配置文件详解

### 顶层字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `host` | 否 | 只能是 `127.0.0.1`（默认值） |
| `port` | 否 | 监听端口，默认 `8788`；写 `0` 让系统随机分配 |
| `models` | 是 | 模型**别名**表，至少一项 |
| `clients` | 是 | 允许接入的客户端，1–100 个 |

配置里出现未知字段会直接报错，不会被忽略。

### `models`：模型别名

客户端只看到别名（例如 `review-model`），看不到背后是哪个机器人、哪个原生模型。

| 字段 | 必填 | 说明 |
|---|---|---|
| `bot` | 是 | 第 1 步那个专用实例的机器人 ID，例如 `local_reasoner` |
| `model` | 是 | 原生模型名，由 CLI 自己识别 |
| `reasoningEffort` | 否 | 思考强度：`none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` / `ultra`，最终受 CLI 能力约束 |
| `deadlineMs` | 否 | 单次调用的时限，100–300000 毫秒，默认 `120000`；超时返回 504 |

### `clients`：客户端与 token

| 字段 | 说明 |
|---|---|
| `id` | 客户端名字（字母、数字、`_`、`-`），不能重复 |
| `tokenEnv` | **存 token 的环境变量名**（大写字母开头，如 `BOTMUX_MODEL_PROXY_TOKEN`）。token 本身不写进配置文件 |
| `models` | 这个客户端能用的别名列表，必须都在 `models` 里 |

- token 至少 32 个字符、不含空白；不同客户端的 token 不能相同。
- 这个 token 和 CLI 的订阅凭据**没有关系**，它只决定「能用哪些别名」。
- 换 token 要重启代理。

## 支持的接口和字段

只有两个接口，都要带 `Authorization: Bearer <token>`：

- `GET /v1/models`：列出当前 token 能用的别名。
- `POST /v1/chat/completions`：**非流式**对话补全，`Content-Type` 必须是 `application/json`。

| 字段 | 支持情况 |
|---|---|
| `model` | 必填，写别名，且必须在该客户端的授权列表里 |
| `messages` | `system` / `developer` / `user` / `assistant` / `tool` 五种角色，内容是字符串或只含 `text` 的数组；最多 2000 条 |
| `tools` | 只支持 `function` 类型，最多 128 个；参数 schema 必须是 object |
| `tool_choice` | `auto` / `none` / `required` / 指定某个函数 |
| `parallel_tool_calls` | `false` 时最多返回一个调用建议 |
| `response_format` | `text`、`json_object`、`json_schema` |
| `stream` / `n` | 只能省略，或 `stream: false`、`n: 1` |
| `max_completion_tokens` | 省略或 `null` 表示不指定上限；1–128000 的整数**只有 Claude Code 支持**，其它 CLI 返回 400 `max_completion_tokens_unsupported` |
| 其它字段 | 一律 400 `unsupported_or_invalid_parameter`，包括 `temperature`、`top_p`、`max_tokens`、`seed`、`stop`、`logprobs` 等，**不会悄悄忽略** |

工具参数和 `json_schema` 支持的 JSON Schema 关键字：`type`、`properties`、`required`、布尔型 `additionalProperties`、`items`、`enum`、`description`、`title`、数值上下界、字符串长度、数组长度。`$ref`、`anyOf`/`oneOf` 这类组合、正则等不支持，会直接报错。

### 多轮工具调用

和 OpenAI 的用法一样：模型返回 `tool_calls` → 你的工具执行 → 把结果作为 `tool` 消息（带 `tool_call_id`）放回下一次请求。代理会检查历史是否完整：

- `tool_call_id` 不能重复，每个调用都要有对应的结果。
- 结果没回齐之前，不能插入别的消息。

模型的回答也会被校验：调用了不存在的函数、参数不符合 schema、违反 `tool_choice`，或要求 JSON 却返回了非法 JSON，都返回 502，而不是把坏结果当成功交给你。

### 返回内容

- 成功时 `finish_reason` 是 `stop` 或 `tool_calls`。不会返回 `length`。
- 工具调用 ID 是稳定生成的，同一个幂等请求重放时 ID 不变。
- 标准的 `usage` 字段固定是 `null`。真实用量放在 `botmux.native_invocation_usage` 里，它是**整次 CLI 调用**的汇总（可能包含内部重试），不能当成单次 API 账单。有些工具会把 `null` 显示成 0，这不代表没有消耗。

## 幂等与超时

- 带 `Idempotency-Key` 请求头（字母数字和 `_.:-`，最长 128）时，同一客户端、同一别名下相同的 key + 相同的请求会直接重放结果，不会再调一次 CLI；key 相同但请求不同返回 409。
- 不带 key 的两次请求是两次独立调用。
- 客户端断开连接会取消调用；同一个代理进程里，多个等待同一结果的连接只断一个不会影响其它的。
- 建议每个推理机器人只跑一个代理进程。

## 常见错误

错误格式统一为 `{"error":{"message":"<错误码>","type":"...","param":...,"code":"<错误码>"}}`，不会带出 CLI 的报错输出、凭据或本机路径。

| 状态码 | 常见原因 |
|---|---|
| 400 | 字段不支持或格式不对（看 `param` 指向哪个字段）、工具历史不完整 |
| 401 | token 不对或没带 `Authorization` |
| 403 | 别名不在这个 token 的授权里；或请求带了 `Origin` 头（不支持浏览器直连） |
| 404 | 访问了不支持的接口 |
| 409 | 幂等 key 冲突，或该调用已被取消 |
| 413 | 请求体超过 1 MB，或拼出的提示词太长 |
| 415 | `Content-Type` 不是 `application/json`，或带了压缩编码 |
| 429 | 推理实例容量已满 |
| 502 | 推理失败或模型输出没通过校验，例如 `native_auth_missing`（专用目录没登录）、`native_model_not_found`（模型名不对） |
| 503 | 找不到专用实例（`inference_profile_offline`）、实例配置不符合要求（`inference_profile_unsupported`）、通信失败 |
| 504 | 超过 `deadlineMs` |

## 常见问题

**启动时报 `model_proxy_config_missing` 或权限相关错误？**
检查 `--config` 路径是否存在、文件是否 `chmod 600`、所在目录有没有被其他用户可写。

**启动时报 `model_proxy_token_requires_32_nonwhitespace_characters`？**
`tokenEnv` 指向的环境变量没设置，或者 token 太短、有空格。

**报 `inference_profile_offline`？**
代理没找到专用实例。确认实例正在运行，并且启动代理时 `SESSION_DATA_DIR` 指向实例的数据目录（第 1 步的 `$STATE_DIR/data`）。

**和直接调模型 API 效果完全一样吗？**
不完全一样。对话角色和工具定义会先被整理成文本交给 CLI，再从结构化输出里还原成响应。角色顺序和工具关联会保留，但这不是原生的逐字透传，CLI 内部的提示词和重试也会影响结果。

**输出上限能当费用上限用吗？**
不能。`max_completion_tokens` 只作用于 Claude 的生成请求，CLI 内部的封装和重试也会消耗 token。

## 相关文档

- [Core-only（apiOnly）API 控制](/api-core-only)：专用实例怎么启动、数据目录和安全边界
- [CLI 命令速查](/cli-commands)
- [支持的 CLI](/adapters)
