# 飞书应用注册与权限补配

默认创建使用 `@larksuiteoapi/node-sdk` 1.73.0 的 `registerApp`。命令行与 Dashboard 先显示确认链接，Dashboard 把链接显示为主按钮，展开「使用手机扫码」后在浏览器里绘制同一链接的矢量二维码。确认页的 `appPreset` 预填名称和描述，`createOnly` 限制为新建。权限自检使用 `clientID` 指向已有应用，将按 tenant/user 分桶计算出的缺失项发给当前 owner 确认。

## 配置步骤对照

| 步骤 | 改造后 | 验证与边界 |
| --- | --- | --- |
| 登录开发者后台、创建应用 | 官方 `registerApp` | 默认无 Web session。选择已有应用并读取凭证、显式切换 Web 登录账号或上传本地应用图标仍使用旧路径。 |
| 读取 App ID 和密钥 | SDK 注册轮询 | 密钥只用于配置与应用鉴权。增量确认结果必须匹配请求的 App ID，回读使用当前应用的配置凭证。 |
| 申请权限 | `addons.scopes.tenant/user` | 以 `GET /open-apis/application/v6/scopes` 中 `grant_status=1` 和 `scope_type` 回读。两桶同名项独立计算。旧的 `bitable:app` 保留供手动导入，注册清单已有细分 `base:*`，不把旧总权限列为缺失。 |
| 添加基础、可选、VC 事件和卡片回调 | `addons.events.items`、`addons.callbacks.items` | 通过应用信息回读线上消息订阅和卡片回调。缺核心订阅时，飞书租户仍走网页补配。 |
| OAuth redirect 白名单 | 应用开发配置 OpenAPI 的 `security.add.redirect_urls` | 增量追加，回读生效地址。失败后优先复用可用 Web session 单独补白名单，无可用会话时展示手动说明。缺白名单会影响 `botmux auth request`。 |
| 长连接订阅方式 | 应用开发配置 OpenAPI 的 `event.subscription_type`、`callback.callback_type` | 在新应用上补为 `websocket` 并回读。官方接口文档限制可更新的应用来源，拒绝或未生效时由网页补配。 |
| 权限可访问的数据范围 | 保留网页 `privilege/all` 和对应更新 | 官方 `contacts` / `visibility` 配置面向应用级范围，接口没有逐权限的数据范围表单。只在进入网页完整补配时处理。 |
| 创建和发布版本 | 已有线上版本且核心订阅生效时跳过 | 以线上版本和配置回读为依据。网页补配产生待发布变更时沿用旧流程。受管 Dashboard 上线和恢复依赖同一 owner 会话的版本及事件确认，继续使用网页验证。 |

官方接口参考：[查询租户授权状态](https://open.feishu.cn/api-explorer?apiName=list&project=application&resource=scope&version=v6)、[获取应用信息](https://open.feishu.cn/api-explorer?apiName=get&project=application&resource=application&version=v6)、[更新应用开发配置](https://open.feishu.cn/api-explorer?apiName=patch&project=application&resource=application.config&version=v7)。

## 授权回读与灰度降级

- 全部授予时继续检查线上长连接、回调和 redirect。确认页已经发布并生效的应用无需额外创建版本。
- 部分授予时按 tenant 和 user 列出缺失项。可用范围、管理员审批和确认页过滤都可能导致部分缺失。
- 创建后间隔两秒回读，若两次 tenant 清单授予比例均不超过 10%，则视为疑似平台未开启 addons。自动针对同一个 App ID 调用网页补配，只申请回读缺失的权限，完成后再次回读。自查明确因权限不足被拒时也走网页补配，回读状态保持未验证。网络失败或响应格式异常不能用来判断灰度。Lark 国际版没有对应的飞书网页补配路径，界面会展示手动检查步骤。
- `setup add --json` 在 stderr 显示显式创建所需的确认链接。网页降级只复用已有登录态，缺会话时通过 JSON 返回继续配置入口。Dashboard 的补配会话按任务隔离，补配结束后清除。
- 存量自愈只发送增量确认链接。若自查权限不足，先申请用于自查的 `application:application:self_manage`。确认后再次读取授权状态，未生效的项照实列出。
- 确认链接已发出但轮询连接中断时，先到开放平台检查应用，避免重复创建。
- `--compatibility-mode` 保留直接打印确认链接的旧行为。国际版轮询仍由 SDK 处理 `domain_switched`。

## 租户验收

1. 用字节飞书账号打开新建确认链接，核对页面是否展示 user 权限。确认后比较两桶授权和线上事件、回调、redirect 与版本。
2. 对测试机器人各发一条私聊和群 @，再点击机器人卡片按钮。用交互结果验证消息和卡片回调的实际投递。
3. 在专用测试应用撤掉几项可重新授予的权限，启动自检。核对 owner 私聊链接的 App ID 与申请项，确认后检查二次回读。
4. 用国际版测试租户走一遍确认流程，确认轮询切换域名后仍可获取凭证并回读。
