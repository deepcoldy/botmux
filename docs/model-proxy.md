# 模型透明代理模式：公共 Chat Completions 入口（实验版 v1）

Botmux 通过模型透明代理模式，为 Bot 接入更多专业能力提供公共基础。一些能力框架已经负责上下文、业务工具、权限和任务流程，只需要模型调用入口。Botmux 提供标准请求协议，复用 CLI 的模型调用与原生认证，让外部应用通过模型 SDK 配置 endpoint、访问凭据和模型别名接入。

调用链：**外部应用（如 [OpenCodeReview（OCR）](https://github.com/alibaba/open-code-review)）→ 模型 SDK → Botmux 公共协议适配 → 签名 IPC → 受约束推理执行层 → CLI 原生模型调用**。业务工具调用作为建议返回，执行权仍属于客户端。协议适配层复用既有执行层的 deadline、幂等、并发和进程回收，不另外运行任务调度器。

## 已验证的范围

| 路径 | 本次验证 |
|---|---|
| OpenAI JavaScript SDK → 公共入口 → Codex | 文本、函数调用、调用 ID 与工具结果回填；真实 CLI + 本机合成 provider，原生工具列表为空 |
| OpenAI JavaScript SDK → 公共入口 → Claude Code | 同上；原生工具仅保留内部 JSON 序列化用的 StructuredOutput |
| OCR v1.12.3 → 公共入口 → Claude Code | 未修改发布源码的 macOS 构建版执行合成仓库 review；规划、文件工具往返、1/1 文件覆盖，工具失败为 0 |
| OCR v1.12.3 → 公共入口 → Codex | 原生配置 `extra_body` 将输出上限设为 null 后，真实 CLI + 合成 provider 完成规划、文件工具往返及 1/1 文件覆盖；正整数上限仍返回 400 |
| 公共入口 → 专用身份 → 真实订阅 | 本次未验收；需要已有授权且符合准入要求的专用原生登录。此前执行层的真实订阅测试不能代替本入口验收 |

合成 provider 返回预设输出，用于验证协议、原生 CLI 约束和客户端行为，不证明真实模型的评审质量。OCR 本次无候选评论，因此没有覆盖候选评论复核阶段；领域集成、完整 MR 对比与生产切换属于后续集成验收。

## 部署与身份路由

先按[受约束推理执行层说明](constrained-invocations.md#接入)启动**独立的 core-only apiOnly 实例**并在该 Bot 专用目录完成原生登录。该流程与现有聊天 Bot 相互独立；不要为试用本功能重启现有生产 daemon。

- Codex：专用原生目录使用 `codexAuthSync: isolated`，需要 `auth.json` 和包含目标模型的 `models_cache.json`。
- Claude Code：专用原生目录需要受支持的 `.credentials.json` 文件登录；只在系统凭证库中的登录不满足当前文件身份路径。
- Botmux 会把指定 Bot 的原生身份整体提供给每次隔离执行单元，不提取订阅 token，不改变上游 endpoint。临时身份的刷新不回写原目录，原生登录有效性由管理员维护。
- 同一账户是否允许用于另一个专用执行 Bot，应通过原生 CLI 支持的登录方式验证。本功能不会自动借用聊天 Bot、全局登录或其他 Bot 凭据；当前没有“自动复用当前聊天身份”的验收结论。

公共代理是一个可单独启动的前台进程，固定监听 `127.0.0.1`。客户端 token 与原生订阅凭据无关：token 只授权使用管理员列出的模型别名。将下面的配置保存为仅当前用户可读写的文件（0600），父目录也应由当前用户控制：

```json
{
  "port": 8788,
  "models": {
    "review-model": {
      "bot": "local_reasoner",
      "model": "claude-sonnet-4-5",
      "deadlineMs": 120000
    }
  },
  "clients": [
    { "id": "review-client", "tokenEnv": "BOTMUX_MODEL_PROXY_TOKEN", "models": ["review-model"] }
  ]
}
```

`bot` 是已启动专用实例的稳定 ID，`model` 是由管理员选择的原生模型标识；这里的名称仅为配置示例。需要 Codex 时配置其专用 Bot 和模型，客户端仍使用别名。`reasoningEffort` 可由管理员在模型路由配置中指定，受原生 CLI 能力约束。

```bash
# 生成独立访问凭据（至少 32 个无空白字符），通过安全渠道配置给获准的客户端。
export BOTMUX_MODEL_PROXY_TOKEN="$(openssl rand -hex 32)"
# 与专用实例使用同一个 daemon 发现目录；不要填成已有生产目录。
export SESSION_DATA_DIR="$STATE_DIR/data"
botmux model-proxy serve --config "$PROXY_CONFIG"
```

宿主代理通过已有 daemon IPC secret 调用执行层；客户端不获得这个宿主凭据，也不能指定身份目录、原生可执行文件或上游 endpoint。启动时检查专用 Bot 准入，实际原生登录与模型可用性在请求时核验。token 更新需重启这个代理进程。

普通 OpenAI SDK 的接入方式：

```javascript
import OpenAI from 'openai';
const client = new OpenAI({
  baseURL: 'http://127.0.0.1:8788/v1',
  apiKey: process.env.BOTMUX_MODEL_PROXY_TOKEN,
  maxRetries: 0, // 重试策略由调用方选择；需要去重时传 Idempotency-Key
});
const result = await client.chat.completions.create({
  model: 'review-model',
  messages: [{ role: 'user', content: '用一句话解释二分查找。' }],
});
console.log(result.choices[0].message.content);
```

未修改 OCR 的原生 API 模式可配置 `OCR_LLM_URL=http://127.0.0.1:8788/v1`、`OCR_LLM_TOKEN` 和 `OCR_LLM_MODEL=review-model`；协议选择 `OCR_LLM_PROTOCOL=openai`。无需推理 wrapper。当前包含输出预算的 OCR 路径仅在上表列出的 CLI 和测试范围内验证。

OCR v1.12.3 默认发送正整数 `max_completion_tokens`。接入 Codex 时，若调用方接受不显式指定输出上限，可通过 OCR 自身的配置覆盖该字段。以下是独立 OCR 配置目录中 `~/.opencodereview/config.json` 的完整 `llm` 块示例（替换访问凭据和模型别名）：

```json
{
  "llm": {
    "url": "http://127.0.0.1:8788/v1",
    "auth_token": "<proxy-client-token>",
    "model": "review-model",
    "protocol": "openai",
    "extra_body": { "max_completion_tokens": null }
  }
}
```

也可用 OCR 原生的 `ocr config set llm.<字段> <值>` 写入这些配置，例如 `ocr config set llm.extra_body '{"max_completion_tokens":null}'`。此方式应使用独立 OCR 配置，且不设置会优先选用另一条配置路径的 `OCR_LLM_URL` / `OCR_LLM_TOKEN` / `OCR_LLM_MODEL`；仅在已有环境变量配置旁补 `llm.extra_body` 不会生效。使用命名 provider 的调用方应在实际选中的 provider 条目里设置 `extra_body`。

这里的 null 表示调用方未指定该上限，保留原生 CLI / 模型的默认限制，**不代表无限输出或费用上限**。需要严格输出预算的调用方不能用 null 绕过要求；Codex 正整数上限仍未适配，必须返回 `max_completion_tokens_unsupported`。

## 协议子集与语义边界

只提供 `GET /v1/models` 和非流式 `POST /v1/chat/completions`，均要求 `Authorization: Bearer <token>`。模型发现仅返回该凭据获准使用的别名，不暴露 Bot 身份和凭据目录。暂不提供 Responses、Embeddings、图像、音频或 CORS 浏览器接口。

| 字段 | 行为 |
|---|---|
| `model` | 服务端模型别名，必须在客户端授权列表中 |
| `messages` | 保留 system/developer/user/assistant/tool 的角色、内容和顺序；文本字符串或仅 text 类型的内容数组 |
| assistant `tool_calls` / tool `tool_call_id` | 保留历史 ID 和原始参数 JSON 字符串；拒绝重复 ID、缺失/重复/无对应调用的结果、在结果齐备前插入其他消息 |
| `tools` | function 类型；只作为模型输入数据，Botmux 不执行。参数 schema 见下文 |
| `tool_choice` | auto、none、required 或指定函数；响应会校验是否满足 |
| `parallel_tool_calls` | false 时最多返回一个建议；默认允许最多 16 个 |
| `response_format` | text、json_object，或下述 schema 子集的 json_schema；校验 content 中的 JSON，不改写工具参数 |
| `stream` / `n` | 仅省略、`stream:false`、`n:1` |
| `max_completion_tokens` | 省略或 null 均不指定上限，不生成 `maxOutputTokens`；1–128000 的整数仅 Claude 路径支持，传给原生 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`，其他路径明确拒绝；非法值返回 400 |
| 其他参数 | 400 `unsupported_or_invalid_parameter`，包括 temperature、top_p、max_tokens、seed、stop、logprobs 和未知扩展；不会静默忽略 |

**角色和工具通过统一的文本序列化层传给 CLI，再从结构化输出恢复响应。** 角色顺序和工具关联得到保留，但不是原生消息角色与 function calling 的无损透传；CLI 的内部提示、序列化和重试会影响推理行为。这是有明确子集的协议兼容，不承诺与直接模型 API 的推理语义完全等价。

工具参数的 JSON Schema 支持 `type`（含类型数组）、`properties`、`required`、布尔 `additionalProperties`、`items`、标量 `enum`、`description`、`title`、数值上下界、字符串长度和数组长度。可选字段保持可选，省略 `additionalProperties` 保持开放对象含义；不补默认值。`$ref`、组合 schema、正则等未实现关键字直接报错。原生输出 schema 只约束响应信封，参数放在 JSON 字符串中，再用原始 schema 独立校验，避免把原生“全部属性必填”的限制强加给客户端。

[OpenAI Chat Completions 官方协议](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)将 `max_completion_tokens` 定义为可选 number 或 null；[官方 SDK 类型](https://github.com/openai/openai-node/blob/master/src/resources/chat/completions/completions.ts)也允许 null。Botmux 在入口将 null 规范化为省略，因此两者生成相同的执行请求，可复用同一幂等键；正整数不会被转换或忽略。

输出上限作用于 Claude 原生生成请求，**不是整个 CLI 调用的总消耗上限**：序列化信封也占输出，CLI 可能内部重试。不能据此承诺与直接模型 API 相同的可见内容 token 数或费用上限。不会将事后字符串截断伪装成生成预算。不能完整生成有效结果时返回错误，不伪造 `finish_reason:length`。

成功响应有 `choices[0].message.content` 和可选 `tool_calls`；工具调用 ID 根据请求 ID 与序号稳定生成，幂等重放不会换 ID。`finish_reason` 只在完整结果通过校验后返回 `stop` 或 `tool_calls`。未知工具、无效参数、违反 tool_choice 或无效 JSON 返回 502，不以成功结果交给客户端。

## 用量、生命周期与错误

- 标准 `usage` 返回 `null`。CLI 原生报告的是整次原生调用汇总，可能含内部重试、序列化等，不能直接包装为 Chat Completions 单请求账单。
- `botmux.native_invocation_usage` 保留真实原生 input/output/cache 计数；未知时为 null。`usage_source` 标明 `native_thread_total` 或 `native_result`，`usage_scope` 为 `whole_native_invocation`。不做本地 token 估算。部分客户端（例如 OCR）会把未知用量显示成 0；这不意味着没有消耗。
- `Idempotency-Key` 在客户端 ID、模型别名和 Bot 范围内去重；相同 key 与相同请求重放持久结果，不再调用 CLI。改动请求返回 409。同一个 key 的取消/失败结果也不会自动重新执行。无 key 的重复 HTTP 请求是独立调用。
- 管理员配置的 `deadlineMs` 由现有执行层落实，超时取消原生进程后返回 504。断连或 SIGINT/SIGTERM 会取消没有其他等待者的调用。同一代理进程中，一个重复等待者断连不会取消其他等待者。
- 每个推理 Bot 应使用一个代理进程管理这些客户端。多个代理进程之间不共享等待者引用计数；跨进程重复连接的断连取消不具备协调保证。
- 代理崩溃后 daemon 仍按 deadline 回收调用；代理等待执行层回读有有限超时。IPC 断连导致结果不明时按原 ID 尝试取消，不生成新 ID 自动重跑；无法联系 daemon 时由其 deadline 兜底。保留 key 可查询/重放已落盘结果。
- 输入 JSON 最大 1 MB，序列化 prompt 最大 512000 字符。工具 schema 深度/规模有边界，未知参数和不支持组合在执行前拒绝。
- 错误遵循 `{ "error": { "message": "稳定错误码", "type": "...", "param": null, "code": "..." } }`。401 鉴权失败、403 路由未授权、400 参数不支持、409 幂等冲突或已取消、429 执行容量不足、502 推理/协议失败、503 配置或传输不可用、504 超时。HTTP 错误不包含原生 stderr、凭据或宿主路径。

## 可复现验证

先运行聚焦单测和构建。原生 E2E 为 opt-in：以下变量是**测试程序路径**，不在产品请求中开放；SDK 在工作树外安装，避免写入共享依赖。

```bash
bun run test -- --configLoader runner test/model-proxy.test.ts test/model-proxy-ipc.test.ts test/constrained-invocation.test.ts test/ipc-constrained-invocation.test.ts
bun run build

export BOTMUX_CONSTRAINED_CODEX="$(command -v codex)"
export BOTMUX_MODEL_ONLY_CLAUDE="$(command -v claude)"
export BOTMUX_MODEL_PROXY_OPENAI_SDK="$SDK_DIRECTORY/node_modules/openai/index.mjs"
export BOTMUX_MODEL_PROXY_OCR="$OCR_RELEASE_BUILD"
bun x vitest run --configLoader runner --project e2e test/constrained-codex.e2e.ts test/model-only-claude.e2e.ts test/model-proxy.e2e.ts
```

本次 SDK 为 OpenAI JavaScript 6.32.0；OCR 使用未修改 v1.12.3 发布源码构建版。fixture 只创建合成算术源码、临时 HOME 和无凭证 loopback provider；不会发送 IM 消息或对真实 MR 发布评论。测试检查 OCR 的 selected/completed 对应、失败/豁免为空、文件工具内容回填，而非只检查 exit 0。原生 CLI 的强制宿主工具调用拒绝和父进程退出回收由相邻原生测试覆盖。
