# 本地 Companion API

Companion API 是一个**只在本机可用**的小接口，让你的本地工具（比如测试脚本、桌面伴侣程序）读写**某一个**测试 Bot 的两样东西：

- **角色**：这个 Bot 的默认角色（人设），以及它的注入方式；
- **运行配置**：用哪个 CLI（Codex 或 TRAE）、哪个模型、什么思考强度。

它默认关闭，开启时只绑定启动时指定的那一个 Bot。它不复用 Dashboard 的登录 token，也不能代理 Dashboard 的其它接口。

## 适合谁用

| 你想做的事 | 是否适合 |
|---|---|
| 用脚本自动切换测试 Bot 的人设、模型，跑对比测试 | 适合 |
| 在本机做一个伴侣程序，给测试 Bot 改配置 | 适合 |
| 管理生产 Bot、多个 Bot，或让远程服务调用 | 不适合，请用 [Dashboard](/dashboard) 或 [任务触发 API](/api-task-trigger) |

## 第 1 步：准备一个专用测试 Bot

在 `bots.json` 里准备一个**和生产 Bot 分开**的 Bot，满足下面三条：

| 字段 | 要求 |
|---|---|
| `larkAppId` | 在 `bots.json` 里只出现一次 |
| `sandbox` | 写成 `true`（开启[白名单沙盒](/sandbox)）。注意要写布尔值 `true`，写成字符串 `"oncall"`、`"scratch"` 或只开 `readIsolation` 都不行 |
| `cliId` | `codex` 或 `traex`（`codex-app` 不行） |

```json
{
  "larkAppId": "cli_xxx_test",
  "larkAppSecret": "…",
  "cliId": "codex",
  "sandbox": true
}
```

## 第 2 步：准备密钥文件

密钥是一段你自己生成的随机字符串，用来给请求签名。文件要求：

- 放在**绝对路径**上，路径里不能经过符号链接；
- 本身是普通文件，不是符号链接；
- 属于当前用户，权限 `0600`；
- 内容不为空，且不超过 1 KiB（首尾空白会被去掉）；
- 所在目录也要属于当前用户，且组内和其它用户不能写（所以别放在 `/tmp` 这类公共目录）。

```bash
mkdir -p ~/.secrets && chmod 700 ~/.secrets
openssl rand -base64 32 > ~/.secrets/botmux-companion
chmod 600 ~/.secrets/botmux-companion
```

## 第 3 步：启动

```bash
botmux restart \
  --companion-secret-file "$HOME/.secrets/botmux-companion" \
  --companion-bot cli_xxx_test
```

- `start` 和 `restart` 都接受这两个选项，而且**必须一起给**。
- 也可以用环境变量代替：`BOTMUX_COMPANION_SECRET_FILE`、`BOTMUX_COMPANION_BOT_APP_ID`。
- 如果 fleet 已经在运行，`start` 会直接报错，请改用 `restart` 让选项生效。
- 校验不通过时会拒绝启动。报错是固定文案，不会带出 app id、文件路径或密钥内容：

| 报错 | 原因 |
|---|---|
| `companion configuration requires both secret-file and bot selection` | 两个选项只给了一个 |
| `companion_secret_invalid` | 密钥文件不满足第 2 步的要求 |
| `companion bot selection must match exactly one isolated codex/traex Bot` | Bot 不存在、重复，或不满足第 1 步的要求 |

## 第 4 步：发请求

接口挂在 Dashboard 的本机端口上（默认 `7891`，实际端口记在 `~/.botmux/.dashboard-port`），路径都以 `/__companion/v1/` 开头。

### 签名方法

每个请求都要带三个请求头：

| 请求头 | 内容 |
|---|---|
| `X-Botmux-Companion-Timestamp` | 当前时间，毫秒级时间戳，和服务器相差不能超过 60 秒 |
| `X-Botmux-Companion-Nonce` | 每次都不同的随机值，用过一次就不能再用 |
| `X-Botmux-Companion-Signature` | 用密钥对下面的内容做 HMAC-SHA256，结果用 base64url 编码 |

参与签名的内容是五行，用 `\n` 连接：

```text
时间戳
nonce
请求方法（大写，如 GET / PUT）
路径（如 /__companion/v1/role，不带查询参数）
请求体的 sha256（十六进制；没有请求体就是空字符串的 sha256）
```

一个可以直接用的 Node.js 例子：

```js
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const secret = readFileSync(`${process.env.HOME}/.secrets/botmux-companion`, 'utf8').trim();
const port = readFileSync(`${process.env.HOME}/.botmux/.dashboard-port`, 'utf8').trim();

async function call(method, path, body) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const bodyHash = createHash('sha256').update(raw).digest('hex');
  const signature = createHmac('sha256', secret)
    .update([timestamp, nonce, method, path, bodyHash].join('\n'))
    .digest('base64url');
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'X-Botmux-Companion-Timestamp': timestamp,
      'X-Botmux-Companion-Nonce': nonce,
      'X-Botmux-Companion-Signature': signature,
    },
    body: raw || undefined,
  });
  return res.json();
}

console.log(await call('GET', '/__companion/v1/health'));
```

### 接口一览

| 接口 | 作用 | 请求体 |
|---|---|---|
| `GET /__companion/v1/health` | 查看协议版本和支持的能力 | 无 |
| `GET /__companion/v1/role` | 读取默认角色 | 无 |
| `PUT /__companion/v1/role` | 写入默认角色 | `{requestId, role, injectMode}` |
| `GET /__companion/v1/runtime` | 读取运行配置 | 无 |
| `PUT /__companion/v1/runtime` | 修改运行配置 | `{requestId, provider, model?, reasoning?}` |

成功时返回 `{"ok": true, ...}`。`health` 返回协议版本 `botmux.companion.v1` 和能力列表；读接口的结果在 `value` 里；写接口返回 `requestId` 和写入后的回读值 `value`。

**读写角色**

- 读到的是 `{role, injectMode, revision: null}`。这里的角色就是 [角色与团队](/roles) 里的「默认角色」，和 `/role team set`、Dashboard 的「默认角色」编辑器是同一份。
- `role`：Markdown 文本，最大 32 KiB（UTF-8 字节）；传空字符串 `""` 表示清除。
- `injectMode`：`every`（每轮都注入）或 `once`（只在首轮注入）。

```js
await call('PUT', '/__companion/v1/role', {
  requestId: 'role-20261105-001',
  role: '你是一个严格的代码审查员。',
  injectMode: 'every',
});
```

**读写运行配置**

- 读到的是 `{provider, model?, reasoning?}`，没设置的字段不返回。
- `provider`：`codex` 或 `traecli`，分别对应 Botmux 里的 `codex` 和 `traex`。传另一个值就会把 Bot 切到另一个 CLI。
- `model`：可选，最长 200 个字符；不传会清掉已设置的模型，回到 CLI 默认。
- `reasoning`：可选，思考强度，只能用该 CLI 和模型支持的档位（如 `low` / `medium` / `high` / `xhigh`）；不传会清掉已设置的思考强度。
- 每次写入都是整份覆盖：想保留原来的模型或思考强度，先读一次，再把它们一起写回去。

```js
await call('PUT', '/__companion/v1/runtime', {
  requestId: 'runtime-20261105-001',
  provider: 'codex',
  model: '<模型名>',
  reasoning: 'high',
});
```

请求体只接受上面列出的字段，多一个都会被拒绝。

### 重试与 requestId

- `requestId` 由你生成，8～128 个字符，只能包含字母、数字、`_`、`-`。
- 同一个 `requestId` 的**成功**写入会在 10 分钟内记住结果，重复发送不会重复执行，直接返回上次的结果。
- 失败或超时的结果不会记住，可以用同一个 `requestId` 重试。
- 单次操作超过 10 秒会返回 `timeout`。这时底层操作可能还在进行，建议先读一次确认结果，再决定要不要重试。

### 错误码

| HTTP 状态 | `error` | 含义 |
|---|---|---|
| 400 | `invalid_body` | 请求体不是合法 JSON、多了字段、字段值不合法或缺少 `requestId` |
| 401 | `unauthorized` | 缺请求头、时间戳超出 60 秒或签名不对 |
| 403 | `forbidden` | 请求不是从本机（loopback）发出的 |
| 404 | `unknown_endpoint` | 路径或方法不在上表里（带查询参数也算） |
| 404 | `companion_disabled` | 本次启动没有开启 Companion API，或 Dashboard 启动时校验 Bot / 密钥没通过（看 Dashboard 日志里的 `[companion] disabled`） |
| 409 | `replayed` | nonce 已经用过 |
| 413 | `body_too_large` | 请求体超过 64 KiB |
| 500 | `timeout` / `operation_failed` | 操作超时或执行失败（比如绑定的 Bot 已不满足第 1 步）；临时问题可以重试 |

## 安全边界

- **只认本机**：请求必须来自 `127.0.0.1` 这类本机地址。如果你主动开启了平台隧道，隧道转进来的请求同样要过签名校验，签名是这条路径上真正的门槛。
- **独立鉴权**：签名校验在 Dashboard 普通登录之前单独进行，通过了也不会获得 Dashboard 管理员身份。
- **范围固定**：接口不接受 Bot ID、群 ID，也不接受任意配置、环境变量、URL、请求头或命令；所有操作都只作用于启动时绑定的那个 Bot，并且每次操作前都会重新确认它仍满足第 1 步的条件。
- **不泄露信息**：角色文本只通过这个签名接口返回，不会出现在 Dashboard 的公开数据里；响应和报错都不包含密钥、文件路径或内部 ID。
