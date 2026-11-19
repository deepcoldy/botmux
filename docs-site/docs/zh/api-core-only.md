# Core-only（apiOnly）API 控制

> 想把 botmux 嵌进自己的系统，用 HTTP 驱动 CLI 跑任务，又不想接飞书？用 core-only。
>
> 它是一个**单进程、固定端口、只监听 `127.0.0.1`** 的 botmux：不需要飞书凭证，不读 `bots.json`，也不起 supervisor 和 dashboard。你的编排器（任务 runner、CI、后端服务、沙箱）通过 HTTP 让它跑 CLI（codex / claude-code 等），轮询结果，需要时再拿一个 Web 终端看现场。

这篇写给**把 botmux 嵌进自己产品**的集成方，比如在沙箱里放一个 botmux 跑 codex。

如果你只是想让外部系统触发一个**已经在飞书群里运行的普通机器人**，请看 [API 编程式触发任务](/api-task-trigger)。两篇是互补的：请求体、幂等、轮询状态这些契约在 core-only 下完全一样，本文只讲 core-only 自己的部分：启动、就绪、中断、Web 终端、鉴权和安全边界。

另外两个相关入口：只想在本机脚本或 CI 里起会话、取结果，用 [无群自动化会话](/headless-session)；想让 OpenAI 协议的工具复用 CLI 的模型登录，用 [模型协议代理](/model-proxy)（它底下跑的就是一个 core-only 实例）。

---

## 一图看懂

```
你的编排器                                botmux serve --api-only（127.0.0.1:8930）
───────────                               ─────────────────────────────────────────
1. 启动进程，等 GET /healthz → 200   ──▶  绑定端口 → 恢复旧会话 → 打印 ready line
2. POST /api/trigger（异步）         ──▶  起 CLI（codex / claude-code …）跑任务
                                     ◀──  { sessionId, triggerId }
3. GET  …/trigger-result 轮询        ──▶  running → completed / failed / interrupted
   （可选）POST …/turns/<triggerId>/interrupt  只停这一轮，会话保留
4. （可选）GET …/write-link（需签名）──▶  返回可输入的 Web 终端 URL
```

日常集成只用到第 1～3 步，都不需要签名。

---

## 1. 它和普通 botmux 有什么不同

| | 普通 `botmux start`（fleet） | `botmux serve --api-only`（core-only） |
|---|---|---|
| 进程 | supervisor + dashboard + 每个机器人一个 daemon | **单进程**，前台运行，进程在服务就在 |
| 飞书凭证 | 必须有 `larkAppSecret` | **完全不需要**，也不连飞书 |
| 机器人配置 | `~/.botmux/bots.json` / `BOTS_CONFIG` | **忽略这两者**，自动生成唯一一个 apiOnly 机器人（仍会读全局 `~/.botmux/.env` 和全局配置） |
| 结果去哪 | 回复发到飞书话题 | **不往飞书发任何消息**，结果只能通过 HTTP 取 |
| 端口 | 被占用时自动往上找 | 固定端口，只绑 `127.0.0.1`，**绑不上就直接退出** |
| 数据目录 | `~/.botmux/data` | 独立的 `~/.botmux/core-only/<botId>/data` |

一句话：core-only 是一个**无界面、单租户、只走本机回环**的 botmux。它保留了完整的 daemon HTTP 接口，只是去掉了飞书那一侧。

---

## 2. 启动

```bash
# 推荐：CLI 子命令。前台运行、继承 stdout，方便 launcher 盯 ready line
BOTMUX_API_PORT=8930 botmux serve --api-only

# 也可以用参数写
botmux serve --api-only --port 8930 --cli codex --working-dir /path/to/repo

# npm 安装时也能直接跑入口文件（嵌入式 spawn 用；单文件二进制版没有 dist/，请用上面的子命令）
BOTMUX_API_PORT=8930 node <pkg>/dist/index-core-only.js
```

参数和环境变量（两者都给时，参数优先）：

| 参数 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `--port` | `BOTMUX_API_PORT` | 无，**必填** | 监听端口，绑不上就退出 |
| `--bot` | `BOTMUX_API_ONLY_BOT` | `local_riff` | 机器人 id，必须形如 `local_<名字>`（字母、数字、`.`、`_`、`-`） |
| `--cli` | `BOTMUX_CORE_CLI` | `codex-app` | 跑哪个 CLI，如 `codex`、`claude-code` |
| `--working-dir` | `BOTMUX_CORE_WORKING_DIR` | 当前目录 | CLI 的工作目录 |
| `--state-dir` | `BOTMUX_CORE_STATE_DIR` | `~/.botmux/core-only/<botId>/data` | 会话数据放哪 |
| `--backend` | `BOTMUX_CORE_BACKEND` | `tmux` | `tmux` 或 `pty`。宿主起不了可靠的 tmux 时再选 `pty`；`pty` 在 daemon 重启后接不回原来的终端 |
| 无 | `BOTMUX_CORE_MODEL` | 未设置 | 覆盖默认模型 |
| 无 | `BOTMUX_CORE_CODEX_AUTH_SYNC` | 未设置（共享） | 设为 `isolated` 时，Codex 只用这个机器人自己的 `CODEX_HOME`，不读也不复制机器上的全局登录 |

**选哪个 CLI？**

- `codex-app`（默认）：走 app-server，结果是结构化的，**没有可视终端**。
- `codex`、`claude-code` 等：在 tmux 里跑真正的 TUI，可以通过 Web 终端围观或接手（见第 4 节）。

### 什么时候算「起好了」

daemon 是**先绑端口、再恢复旧会话**的。端口能连上不代表能接任务，要等就绪：

- **stdout 的 ready line**（格式固定，可用正则 `^\[core-only\] listening on ` 匹配），恢复完成后才打印：
  ```
  [core-only] listening on 127.0.0.1:8930 (bot local_riff, cli codex-app)
  ```
- **`GET /healthz`**（无需签名）：
  - 还没好 → `503 {"ok":false,"status":"starting"}`
  - 好了 → `200 {"ok":true}`

没就绪时，`/api/trigger`、`trigger-result`、`insight`、`host-facts` 和中断接口也都会直接返回 `503 starting`，所以即使你跳过探针，也不会把任务发进正在恢复的会话。推荐做法仍然是：**先轮询 `/healthz` 到 200，再发第一条任务**。

> `/__health` 也是公开的，但它**永远返回 200**，只能说明进程活着，不能用来判断能不能接任务。

---

## 3. 跑任务：触发、轮询、中断

请求体、幂等键、轮询状态的完整说明见 [API 编程式触发任务](/api-task-trigger)。core-only 下多了几条规则：

| 规则 | 说明 |
|---|---|
| 必须指定 HTTP 应答方式 | `options.waitForFinalOutput`（同步等结果）或 `options.asyncReturnSessionId`（异步拿 sessionId），二选一。都不传 → `400 bad_request`，因为没有飞书群可以回复 |
| 不能指向飞书 | 传真实的飞书 `chatId` 或 `rootMessageId` → `400` |
| 可以续接自己的会话 | `target.sessionId` 只能是本服务自己的会话，用来在同一会话里追加一轮 |
| 指令放顶层 `instruction` | 不是 `prompt` |
| 轮询用完整 sessionId | 是 UUID，不是日志里 `[worker:xxxxxxxx]` 那种短 tag，用短 tag 会得到 `session_not_found` |
| `options.model` / `options.reasoningEffort` | 只对支持切换模型/思考强度的 CLI 生效，且只作用于新建会话，细节见触发文档 |

### 触发和轮询

```bash
# 触发（异步）：无需签名
curl -s http://127.0.0.1:8930/api/trigger -X POST -H 'content-type: application/json' -d '{
  "source": {"type": "webhook"},
  "target": {"kind": "turn", "botId": "local_riff"},
  "envelope": {"format": "text", "sourceName": "my-runner", "trusted": false},
  "instruction": "跑一下测试并报告结果",
  "options": {"asyncReturnSessionId": true}
}'
# → {"ok":true, "triggerId":"trg_...", "async":{"sessionId":"<uuid>", ...}}

# 轮询：无需签名
curl -s "http://127.0.0.1:8930/api/sessions/<uuid>/trigger-result"
# → state: running / completed / failed / not_found，被中断的轮次是 interrupted
```

> 请使用 **v3.9.0 及以上**版本。更早的版本里，core-only 跑 claude-code 时首轮可能一直停在 `running`。

### 只停这一轮（会话不关）

任务跑偏了、想停下来但保留会话继续聊，用中断接口（无需签名）：

```bash
curl -s -X POST "http://127.0.0.1:8930/api/sessions/<uuid>/turns/<triggerId>/interrupt"
# → {"ok":true, "action":"interrupted", "sessionId":"<uuid>", "triggerId":"trg_..."}
```

- 只会停**你指定的那一轮**。botmux 会先确认 CLI 当前跑的确实是这一轮，才发送中断；确认不了就拒绝，绝不会误停别的轮次。
- 之后轮询这一轮会得到 `state: "interrupted"`。会话仍然开着，可以用 `target.sessionId` 再发下一轮。
- 重复中断同一轮会直接返回成功（带 `idempotent: true`）。
- 可能的失败：`404`（会话不存在或已关闭，或这个会话里没有这一轮）、`409`（这一轮已经结束、不在当前 daemon 进程里跑，或 CLI 当前跑的已不是这一轮）、`503`（中断没送达，可以稍后重试）。

想**连会话一起关掉**，用 `POST /api/sessions/:id/close`，它需要签名，见 [API 编程式触发任务](/api-task-trigger) 的「关闭整个会话」一节。

### 读取会话宿主信息

如果你把 botmux 当成 CLI 会话的宿主，需要知道「这个会话还在不在」，可以读：

```bash
curl -s "http://127.0.0.1:8930/api/sessions/<uuid>/host-facts"
```

返回 `{ ok: true, facts: {...} }`，里面有：

| 字段 | 含义 |
|---|---|
| `sessionId` / `cli` / `backend` / `sessionStatus` | 会话 id、CLI、后端（tmux/pty）、会话是 `active` 还是 `closed` |
| `liveness` | `exists` / `missing` / `unknown` 三种 |
| `worker.present` / `ready` / `generation` | worker 是否在、是否就绪、第几代 |
| `native.sessionId` | CLI 自己的 session/thread id |
| `native.activeTurnId` | botmux 当前这一轮的 id（不是 CLI 内部的 turn id） |

它**不会**返回 tmux socket、PID、worker token、环境变量或终端写入权限。

两点注意：

- `unknown` 不等于 `missing`，不要据此另起一个替代会话。
- CLI 这一轮结束了，不代表你的业务完成了。编排器仍要自己校验结果、保存证据，再推进自己的状态。

---

## 4. Web 终端

用可视 CLI（`--cli codex`、`claude-code` 等）时，可以在浏览器里看 CLI 的实时画面，甚至直接输入。

### 只读：轮询结果里自带

只要会话的 worker 还活着，`trigger-result` 的响应会额外带上 `readOnlyUrl` 和 `viewToken`。打开 `readOnlyUrl` 就能看画面，但不能输入。

会话已关闭、或者重启后还没有活着的 worker 时，不会带这两个字段，所以拿到的链接总是能连上的。这是 core-only 独有的；普通 fleet 的轮询响应里没有它们。

`viewToken` 跟着 worker 走：worker 重启后会换一个新的，旧链接随之失效。所以只读链接请以最近一次轮询返回的为准，不要长期缓存。

### 可输入：调用 `write-link`（需签名）

```bash
# write-link 要带第 6 节的签名头
curl -s "http://127.0.0.1:8930/api/sessions/<sid>/write-link" \
  -H "X-Botmux-Cli-Ts: ..." -H "X-Botmux-Cli-Nonce: ..." -H "X-Botmux-Cli-Auth: ..."
# → {"ok":true, "url":"http://127.0.0.1:<proxyPort>/s/<sid>?token=<写token>"}
```

- 返回的 URL 带写 token，打开就是可以输入的终端。写 token **只能**从这里拿，不会出现在轮询结果里。
- 常见错误：`401`（签名不对）、`404 session_not_active`（会话不在运行）、`409 terminal_unavailable`（worker 终端暂时不可用）。

**建议每次「打开终端」时现取 URL，只保存 sessionId。** 同一个会话的写 token 在 worker 换代、daemon 重启后都不变，但 URL 里的端口、主机以及 worker 是否在线可能会变。现取一次很轻（本机请求 + 签名），拿到的总是当前能连上的地址。

> 单个 core-only 会话不会因为空闲被回收（默认最多 30 个活跃 worker，且默认没有空闲超时），所以正常情况下终端一直可用。

---

## 5. 哪些接口要签名

core-only 的接口分三层。**集成方只需要第一层**，后两层帮你理解安全边界。

**第一层：公开接口（无需签名）**，只有这几条：

| 接口 | 方法 | 用途 |
|---|---|---|
| `/healthz` | GET | 就绪探针 |
| `/api/trigger` | POST | 发起一轮任务 |
| `/api/sessions/:id/trigger-result` | GET | 轮询结果 |
| `/api/sessions/:id/insight` | GET | 轮询对话和进度 |
| `/api/sessions/:id/host-facts` | GET | 读取会话宿主信息 |
| `/api/sessions/:id/turns/:triggerId/interrupt` | POST | 只中断指定的一轮 |

另外 `/__health` 在任何模式下都公开，但它只表示进程活着。

这份名单是刻意收窄的：同机的其他进程（包括模型自己跑的命令）也能访问 `127.0.0.1`，所以只放开「驱动自己的任务、读自己的结果」这几条。比如回答 AskUserQuestion 的 `/api/asks/answer` 就**不在**名单里，因为它不绑定会话，放开会让别的进程替你回答。

**第二层：会话内部接口（由 CLI 自己证明身份）**。例如 `POST /api/session-ready`、`POST /api/asks`、`POST /api/sessions/:id/{slash,cd,close,…}`、`POST /api/hooks/emit`。调用方是会话里的 CLI 本身，用的是每轮轮换、绑定会话的凭证，只能操作自己的会话。集成方一般不会直接调。

**第三层：宿主 / 运维接口（需要第 6 节的签名）**。除上面两层外的所有接口，比如 `GET /api/sessions/:id/write-link`、`GET /api/sessions/:id`（会话详情）、`POST /api/sessions/:id/close`。

> `close` 比较特殊：外部调用要签名，会话内的 CLI 也能用第二层凭证关闭自己。

---

## 6. 签名怎么算（最容易错的是 bind）

需要签名的请求带三个请求头：

| 请求头 | 值 |
|---|---|
| `X-Botmux-Cli-Ts` | Unix 时间戳，单位是**秒**，允许误差 ±30 秒 |
| `X-Botmux-Cli-Nonce` | 随机 hex 字符串，60 秒内不能重复 |
| `X-Botmux-Cli-Auth` | `HMAC_SHA256(secret, msg)`，用 **base64url** 编码 |

`secret` 是 `~/.botmux/.dashboard-secret` 里那串 43 个字符的 base64url 文本，**原样当作 key，不要先 base64 解码**。请求必须从本机回环地址发出。

`msg` 里必须带上 bind，把签名绑定到「方法 + 路径 + 端口」，防止被拿去重放到别的接口：

```
bind = `${METHOD} ${pathname} ${port}`     // 例："GET /api/sessions/<sid>/write-link 8930"
msg  = `${ts}:${nonce}:${bind}`
```

三个常见错误：

1. `port` 是服务**实际监听的端口**（如 `8930`），不是 Host 头里的值。
2. `pathname` **不带查询串**（用 `new URL(...).pathname`）。
3. `secret` 直接用原始字符串，不要解码。

> 只签了 `ts:nonce`、漏了 bind，会得到 `401 {"reason":"sig_mismatch"}`。因为公开接口不验签，这个问题往往在**第一次调 write-link** 时才暴露，很容易误以为是密钥或时间不对。其他 `reason`：`ts_window`（时间差超过 30 秒）、`replay`（nonce 重复）、`missing_headers`（缺请求头）。

参考实现（逻辑与仓库里 `src/core/daemon-ipc-auth.ts` 的 `daemonIpcAuthHeaders()` 一致）：

```js
import { createHmac, randomBytes } from 'node:crypto';

function coreOnlyAuthHeaders(secret, method, path, port) {
  const pathname = new URL(path, `http://127.0.0.1:${port}`).pathname; // 去掉查询串
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(8).toString('hex');
  const bind = `${method.toUpperCase()} ${pathname} ${port}`;
  const sig = createHmac('sha256', secret)          // secret = 原始 base64url 字符串
    .update(`${ts}:${nonce}:${bind}`)
    .digest('base64url');
  return {
    'X-Botmux-Cli-Ts': ts,
    'X-Botmux-Cli-Nonce': nonce,
    'X-Botmux-Cli-Auth': sig,
  };
}
```

---

## 7. 安全边界

core-only 不连飞书、只服务一个租户、只走本机回环。围绕这一点，它默认做了这些隔离：

- **不连飞书**：不创建飞书客户端，也不把 `larkAppSecret` 交给 CLI 子进程。
- **不读真实机器人配置**：忽略 `~/.botmux/bots.json`，并从环境里删掉 `BOTS_CONFIG`，CLI 读不到同机其他机器人的凭证。
- **数据目录独立**：会话数据固定放在 `~/.botmux/core-only/<botId>/data`（或你指定的 `--state-dir`），不会因为继承了父进程的 `SESSION_DATA_DIR` 去读写正式 fleet 的数据。任务回报用的内部签名密钥也单独放在这个目录里，不和同机 fleet 共用。（第 6 节外部签名用的 `~/.botmux/.dashboard-secret` 不在此列。）
- **只监听本机**：worker 的 Web 服务和对外广告的终端地址都固定为 `127.0.0.1`，不会暴露到其他网卡。
- **不碰宿主安装**：不跑自动更新、自动重启和 `botmux restart`；给 CLI 用的 `botmux` 命令包装放在自己数据目录下的 `bin/`，不会覆盖同机的 `~/.botmux/bin`。
- **本机回环不等于可信**：同机进程（包括默认共享网络的沙箱）也能访问 `127.0.0.1`，所以除第一层公开接口外，其余接口一律要鉴权。

---

## 附：接口速查

| 接口 | 方法 | 鉴权 | 用途 |
|---|---|---|---|
| `/healthz` | GET | 公开 | 就绪探针（503 starting / 200 ok） |
| `/api/trigger` | POST | 公开 | 发起一轮任务（必须指定 HTTP 应答方式） |
| `/api/sessions/:id/trigger-result` | GET | 公开 | 轮询结果；worker 活着时附带 `readOnlyUrl` + `viewToken` |
| `/api/sessions/:id/insight` | GET | 公开 | 轮询对话和进度 |
| `/api/sessions/:id/host-facts` | GET | 公开 | 会话、CLI、后端与存活状态 |
| `/api/sessions/:id/turns/:triggerId/interrupt` | POST | 公开 | 只中断指定一轮，会话保留 |
| `/api/sessions/:id/write-link` | GET | **签名** | 可输入的 Web 终端 URL（建议打开时现取） |
| `/api/sessions/:id` | GET | **签名** | 会话详情 |
| `/api/sessions/:id/close` | POST | **签名**，或会话内 CLI 自己的凭证 | 关闭会话 |

请求体字段、错误码、轮询状态的含义和重启后的行为，见 [API 编程式触发任务](/api-task-trigger)。
