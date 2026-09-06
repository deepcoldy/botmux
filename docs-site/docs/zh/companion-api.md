# 本地 Companion API

Botmux 可为一个显式绑定的隔离测试 Bot 开启封闭的本机管理协议。它不复用 Dashboard token、Dashboard/daemon HMAC 密钥，也不代理任意 Dashboard 路由。

## 启动

```bash
botmux start \
  --companion-secret-file /run/secrets/botmux/companion \
  --companion-bot local_test_bot
```

`restart` 接受相同选项。两个选项必须同时提供；目标必须精确匹配 `bots.json` 中一个启用 `sandbox`、且 `cliId` 为 `codex` 或 `traex` 的 Bot。密钥必须是 canonical 绝对路径上的当前用户所有、非符号链接、非空 `0600` 普通文件。校验失败时拒绝启动该配置，且错误不会包含路径或内容。

## 鉴权

接口复用 Dashboard 的本机监听端口，但在普通 Dashboard 鉴权与路由之外独立验签；它不会授予 Dashboard 管理身份。请求只能来自 loopback。每个请求携带：

- `X-Botmux-Companion-Timestamp`：epoch 毫秒；允许偏差 60 秒；
- `X-Botmux-Companion-Nonce`：一次性随机值；
- `X-Botmux-Companion-Signature`：base64url HMAC-SHA256。

签名材料为：

```text
timestamp\nnonce\nMETHOD\nexact-pathname\nsha256(raw-body)
```

body 上限 64 KiB。重放、过期、签名/方法/路径/body 不匹配均在执行操作前拒绝。

## 固定路由

- `GET /__companion/v1/health`：只返回协议版本和 capability；
- `GET /__companion/v1/role`：返回 `{role, injectMode, revision:null}`；role 最大 32 KiB；
- `PUT /__companion/v1/role`：仅接受 `{requestId, role, injectMode}`；`injectMode` 为 `every|once`，`role:""` 清除；返回 sanitize 后 readback；
- `GET /__companion/v1/runtime`：返回 `{provider, model?, reasoning?}`；
- `PUT /__companion/v1/runtime`：仅接受 `{requestId, provider, model?, reasoning?}`。`provider` 为 `codex|traecli`（分别映射 Botmux `codex|traex`），model 最长 200 字符，reasoning 使用对应 provider/model 的现有闭集。

写操作按 `requestId` 在进程生命周期内幂等。接口不接受 Bot ID、chat ID、任意 settings/env/URL/header/命令，也不提供 trigger/result；所有操作固定作用于启动绑定 Bot。角色文本只在通过 companion HMAC 的该路由返回，不加入 Dashboard/public DTO。响应和错误不包含密钥、文件路径或原生 ID。
