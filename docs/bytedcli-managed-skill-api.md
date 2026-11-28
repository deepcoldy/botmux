# 受管 Skill 最终 API

目录版本 `2026-11-27.2`，原生 CLI 审核版本 `0.199.0`。严格模式的 `bytedcli --json skill-api <operationId去掉skill-api.前缀> --request '<JSON>'` 进入原有 broker/executor；目标、方法、headers、effect 和 credential realm 来自内置目录，调用方不能传 URL、JWT、cookie、账号或执行身份。

大请求使用 `--body-file <Agent文件>` 或 `--body-file -`。现有 CLI client 在 Agent 内快照文件/标准输入，host 只消费有界字节，不读取调用方提供的宿主路径。总输入上限 2 MiB（附件 base64 和 JSON 合计），小请求 argv 上限 64 KiB；提供的 helper 自动写入私有临时 JSON 并清理。host 重解析输入，复用 lease、authority/current 检查、写前 intent、输出限额、脱敏、重复请求缓存和写入结果未知语义；未知结果不自动重试。

## 插件权限模板

业务权限模板通过外部插件的 `dist/bytedcli/operation-presets.json` 注入。Botmux 负责严格校验、按当前机器人启用的插件发现模板，并提供通用 Dashboard 应用入口；插件启用不会自动授权。配置格式、版本检查和安装更新语义见 [插件 ByteCLI 权限预设](plugin-bytedcli-operation-presets.md)。

Skill 名称仅作来源归档，不能声明权限；同一规范命令被多个 Skill 使用时共享一条规则。机器身份规则可指定已审核写操作；宿主显式 actor/deny 始终优先，未登记命令仍使用触发者身份。业务选择与覆盖台账由各插件维护。

## Realm 与宿主前提

- BITS、Argos、SelfDo、MindAI 使用被选择的 ByteCloud lease。release GET、关联研发单 POST list 和 PUT approvers 分别计为 read/read/write。SelfDo `GET /quest/draft/creation/<jobId>` 会推进建单，计为 write。MindAI create/resume/upload 为 write，auth/events 为 read；events 每次最多收集 15 秒完整 SSE 帧，helper 通过 Last-Event-ID 继续监听，原 watch 总超时仍生效。
- Picko ES 的固定 psm/index/lf/GET DSL 进入 GDPR realm：实际 HTTP POST 是 Kibana console proxy 携带只读搜索 DSL。宿主启动前显式设置 `BOTMUX_BYTEDCLI_GDPR_MACHINE_FILE` 指向已有平台登录缓存中的纯 GDPR JWT；文件须为当前用户持有、私有权限、普通文件、单 hardlink、无 symlink，且有效期超过 60 秒。没有默认路径扫描、交互登录、安装 DoAs 或自动刷新。指纹绑定 GDPR realm、受保护文件和凭据，不把 JWT 自述 subject 伪装为已核验 ByteCloud 账号。actor GDPR 尚无已验证个人来源，直接拒绝，绝不借用 machine cookie。
- Oncall retrieval 需要启动时显式设置 `BOTMUX_BYTEDCLI_MCP_PROXY_ROOT` 指向已安装的 `@byted/mcp-proxy@1.3.21`。固定 Node/包树完整性，bwrap 最小环境只注入被选 lease 的 `USER_JWT_TOKEN`；固定 PSM、CN、retrieval 工具、space 12、目录 69/71。代理自身可在启动时发现该固定服务的工具，caller 不能改服务器或工具。没有 npx 下载、Agent JWT 导出或继承宿主 secrets。
- HTTP 只使用冻结的启动网络环境与 CA 内容，强制 TLS 校验，不跟随 redirect，不回传上游日志。`SSL_CERT_DIR` 暂不支持且 HTTP fail closed；不影响原生操作。`SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS` 支持。没有使用 live 认证或业务网络证明实际账号权限。

## 源码与安装交付

受管 Skill 应使用已有 broker CLI/API，不向 Agent 注入 JWT、cookie 或业务上游 URL。Skill 包维护者负责在发布物中适配受管入口，保留已有 dry-run 与业务确认语义；Lark、ByteCloud 和 GDPR 属于不同凭据域。

未找到 MindAI 与 Picko ES 的源码仓，提供 [版本绑定安装产物](artifacts/bytedcli-managed-skills/)。对目标副本先执行：

```sh
python3 docs/artifacts/bytedcli-managed-skills/install.py mindai --root /absolute/path/to/mindai-chart-generation
python3 docs/artifacts/bytedcli-managed-skills/install.py picko --root /absolute/path/to/picko-es-tag-distribution
```

默认只校验；确认目标版本后在相同命令追加 `--apply`。所有 input/output SHA-256 都在 manifest，原版本不匹配即拒绝，所有检查先完成再逐文件原子替换，已安装可重复校验。恢复时使用原 source/release 副本；不要把源码提交或安装产物视为已部署版本。安装产物仅适配指定版本，部署状态由本机维护记录单独保存。
