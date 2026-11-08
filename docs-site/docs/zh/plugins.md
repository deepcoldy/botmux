# 插件（Plugin）开发与发布

Botmux 插件就是**一个 npm 包**。装上之后，它可以给 Agent 加 Skill 和 MCP 工具，给 `botmux` 命令行加子命令，给 Dashboard 加页面，跑一个常驻的后台服务，还能注册飞书里的 `/斜杠指令` 和卡片按钮。

先看你要做什么：

| 我想… | 看这里 |
| --- | --- |
| 装一个现成的插件、给某个 Bot 开启 | [安装和管理插件](#安装和管理插件) |
| 从零写一个插件 | [五分钟上手](#五分钟上手) → [开发各类扩展](#开发各类扩展) |
| 把插件发到 npm、登记到插件市场 | [发布到 npm](#发布到-npm) → [登记插件市场](#登记插件市场) |

> 安装第三方插件就等于信任它的作者：插件代码以运行 Botmux 的系统用户身份执行。Dashboard 的确认安装会跳过 npm 生命周期脚本；普通 CLI 安装仍可能运行这些脚本。只装你信得过的包，目录收录不代表安全背书。

## 插件能提供什么

插件按**固定目录**交付能力，Botmux 安装时自动扫描，不需要额外注册。所有入口都在构建产物 `dist/` 里：

| 能力 | 用途 | 安装后入口（相对 `dist/`） |
| --- | --- | --- |
| Skill | 给 Agent 的操作说明 | `skills/<name>/SKILL.md` |
| MCP | 给 Agent 的工具（每个插件最多一个 server） | `mcp/index.json` |
| CLI 命令 | `botmux <命令>` 形式的运维入口 | `cli/index.js` + `cli/commands.json` |
| Dashboard 页面 | Dashboard 里的插件专属页 | `dashboard/index.js` |
| Dashboard 设置 | 插件页读写配置的服务端适配器（可选） | `server/settings.js` |
| Host Service | 常驻后台进程，比如本地 HTTP 服务 | `service/index.js` |
| 飞书斜杠指令 | 群里发 `/xxx` 直接交给插件处理 | `commands/index.json`（需要 Host Service） |
| 卡片按钮回调 | 插件发的卡片，按钮点击交给插件处理 | `card-actions/index.json`（需要 Host Service） |

没有通用的 daemon/worker 钩子。长期运行的逻辑放进 Host Service，给 Agent 的能力放进 MCP 或 Skill，给人用的运维入口放进 CLI 命令。

## 五分钟上手

开发插件需要 **Node.js 22+**，并且 `npm` 在 `PATH` 里：生成器会用 npm 搭脚手架、装依赖、跑测试。（这只是开发插件的要求，Botmux 本身是自包含二进制，不需要 Node，见 [快速接入](/quickstart)。）

```bash
# 1. 装好 botmux（任选一种）
curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | sh
# npm install -g botmux@latest

# 2. 生成插件项目
botmux plugin init my-plugin
cd botmux-plugin-my-plugin

# 3. 以开发模式安装并启用
botmux plugin install . --link
botmux plugin enable my-plugin

# 4. 试一下示例命令
botmux my-plugin:hello
```

`plugin init` 会基于官方模板生成项目，并自动跑完 `npm install`、`npm test`（`git init` 尽力而为，失败不影响）。默认得到：

| 项 | 默认值 |
| --- | --- |
| 目录名 | `botmux-plugin-my-plugin` |
| npm 包名 | `@botmux-ai/plugin-my-plugin` |
| Plugin ID | `my-plugin` |
| CLI 命令前缀 | `my-plugin:` |
| 示例 | 每种基础扩展各一个 |

`@botmux-ai` 是官方 npm 组织。你没有这个 scope 的发布权限时，把 `package.json` 的 `name` 改成你自己的包名，比如 `@your-org/plugin-my-plugin`。Plugin ID 可以保持 `my-plugin`，但安装第三方包时要写完整包名。

## 安装和管理插件

### 安装

```bash
# 第三方包：写完整包名，建议固定精确版本
botmux plugin install @your-org/plugin-my-plugin@1.2.3

# 官方短 ID：自动展开为 @botmux-ai/plugin-my-plugin
botmux plugin install my-plugin

# 本地目录或打好的 tarball
botmux plugin install ./path/to/plugin
botmux plugin install "file:/absolute/path/plugin-package.tgz"
```

安装只做三件事：下载、校验 manifest、扫描扩展入口并把 `dist/` 存到 `~/.botmux/plugins/<id>/`。**安装不会执行插件代码，也不会启动 Service**。

### 启用：选择对哪些 Bot 生效

安装后还要启用，插件才会出现在会话里：

```bash
# 机器默认：对所有 Bot 生效（包括以后新加的 Bot）
botmux plugin enable my-plugin

# 只对某个 Bot 生效；all = 给当前所有 Bot 各写一份
botmux plugin enable my-plugin --bot <name|index|all>

# 关闭
botmux plugin disable my-plugin
botmux plugin disable my-plugin --bot <name|index|all>
```

- 不带 `--bot` 就是机器默认作用域（写在 `~/.botmux/config.json` 的 `plugins`），不需要 `--global`。
- 按 Bot 启用写在 `bots.json` 对应 Bot 的 `plugins` 字段，和机器默认是**叠加**关系。
- 已经在机器默认启用的插件，要先关掉机器默认，才能按 Bot 单独配置。
- **启用、禁用或更新后，请新开一个会话**。已在运行的 CLI 不会热加载新的 Skill/MCP。飞书斜杠指令例外：下一条消息就生效。

`botmux plugin list` 查看已安装插件和机器默认是否启用。

### 在 Dashboard 里管理

Dashboard 侧栏的「插件」页有「已安装」和「发现」两个视图，沿用 Dashboard 的深浅主题。

- 「已安装」支持搜索和来源筛选，默认显示名称、介绍、适用范围、启用状态和管理入口。
- 「管理」保留机器默认、按 Bot 启用、插件设置与侧栏固定；技术能力、包信息和后台服务控制收进默认折叠的「高级设置」。
- 「发现」读取 [插件目录](https://github.com/botmux-ai/plugin-market)，支持搜索、详情和安装。目录暂不可达时显示缓存或明确的不可用状态。
- 安装前展示 npm 包名、精确版本和 SHA-512 完整性。确认只对当前管理身份有效，五分钟过期；期间插件记录改变、被替换或管理凭证失效，需要重新确认。安装不会自动启用插件。
- 卸载前必须关闭全部启用范围并停止后台服务，再确认所卸载的软件包与版本。确认后的检查还会在实际落盘前重做。

安装和卸载只开放给本机管理身份，并校验 CSRF。目录浏览与安装依赖网络，安装还要求 `npm` 和 `tar` 在 `PATH` 中。插件包必须预先构建 `dist/`，不能依赖安装脚本生成运行时文件。

插件卡片的介绍来自 npm `package.json` 的 `description`；可选的 `botmux.audience` 用于显示适用人群或前提条件。这些字段只是展示信息，不能代替插件自身的鉴权检查。

插件自带的页面在 `#/plugins/<plugin-id>`。更多 Dashboard 说明见 [Dashboard](/dashboard)。

### 管理 Host Service

```bash
botmux plugin service status
botmux plugin service start my-plugin      # 或 --all
botmux plugin service stop my-plugin
botmux plugin service restart my-plugin
```

Service 有两种模式（在 manifest 里声明）：

| 模式 | 行为 |
| --- | --- |
| `manual`（默认） | 只在你显式 `plugin service start` 时启动 |
| `auto` | `botmux start` / `botmux restart` 时自动确保在线 |

- `botmux stop` 默认**保留**插件 Service；`botmux stop --with-plugin` 才会一起停掉 auto Service。
- `botmux restart` 默认不先停 auto Service，`botmux restart --with-plugin` 会先停再启动。
- Service 由 Botmux 内置的 supervisor 托管，不需要另装 PM2。日志在 `~/.botmux/plugin-supervisor/logs/<plugin-id>-out.log` 和 `-err.log`。

### 更新和卸载

更新就是重新 install 一个新版本。插件有 Service 时要先停掉，Botmux **不会**在安装、更新、卸载时帮你隐式停止 Service，Service 还在跑会直接报错：

```bash
botmux plugin service stop my-plugin
botmux plugin install @your-org/plugin-my-plugin@1.2.4
botmux plugin enable my-plugin
botmux plugin service start my-plugin
```

卸载：

```bash
botmux plugin service stop my-plugin
botmux plugin uninstall my-plugin
```

卸载会清掉所有作用域的启用记录，并删除整个 `~/.botmux/plugins/<id>/`（包括插件配置），需要保留请先备份。还有其他已启用插件依赖它时，卸载会被拒绝。帮助里的 `--force` 目前绕不过依赖检查和 Service 保护。

### 按 Bot 调整插件 MCP 的运行参数

想给某个 Bot 的插件 MCP 换一套环境变量或单独设超时，在 [bots.json](/bots-json) 里给这个 Bot 加 `pluginRuntime`：

```json
{
  "plugins": ["reporting"],
  "pluginRuntime": {
    "reporting": {
      "env": { "PROFILE": "production" },
      "toolTimeoutMs": 120000
    }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `env` | 只注入这个 Bot 下该插件的本地 stdio MCP 进程，不会进入模型 CLI 的环境 |
| `toolTimeoutMs` | 这个插件每次工具调用的总超时（毫秒，正整数）；不填用 MCP SDK 默认值 |

机器级上限在 `~/.botmux/config.json` 的 `mcpGatewayMaxToolTimeoutMs`，默认 `600000`（10 分钟）。`toolTimeoutMs` 不能超过这个上限，超过时新会话准备插件环境会报错。改完后在下一次 CLI 冷启动或新会话里生效。

## `package.json` 与 manifest

插件根目录的 `package.json` 既是 npm 包描述，也是插件 manifest（`botmux` 字段）。完整示例：

```json
{
  "name": "@your-org/plugin-my-plugin",
  "version": "0.1.0",
  "description": "Botmux plugin: My Plugin.",
  "type": "module",
  "keywords": ["botmux-plugin"],
  "scripts": {
    "build": "node ./scripts/build.mjs",
    "validate": "node ./scripts/validate.mjs",
    "test": "npm run build && npm run validate",
    "prepublishOnly": "npm test"
  },
  "botmux": {
    "schemaVersion": 1,
    "id": "my-plugin",
    "displayName": "My Plugin",
    "dependencies": {
      "plugins": ["another-plugin"]
    },
    "service": {
      "mode": "manual"
    }
  },
  "files": ["dist/"],
  "publishConfig": {
    "registry": "https://registry.npmjs.org/",
    "access": "public"
  },
  "license": "MIT"
}
```

安装时会校验：

- `version` 是合法 SemVer；
- `keywords` 里有 `botmux-plugin`；
- `botmux.id` 符合 `^[a-z][a-z0-9._-]{0,63}$`；
- 包里有 `dist/` 目录；
- `service.mode` 只能是 `manual` 或 `auto`（不写默认 `manual`）；
- 每个扩展入口都存在且格式正确。

`botmux.dependencies.plugins` 只写 Plugin ID，不支持版本范围。启用插件时，它依赖的插件必须已安装，并且在同一作用域已启用；还被别的已启用插件依赖的插件，不能禁用或卸载。

建议把 `files` 限制为 `dist/`，发布前用 `npm pack --dry-run` 检查。npm 仍会自动带上 `package.json`、README 和 LICENSE，这些文件也要确认没有敏感信息。

## 开发各类扩展

### CLI 命令

`src/cli/index.js` 默认导出一个「命令名 → handler」的对象。官方模板构建时会同时生成 `dist/cli/index.js` 和命令索引 `dist/cli/commands.json`：

```js
export default {
  "my-plugin:hello": {
    description: "Print a hello response.",
    run(ctx) {
      return JSON.stringify({
        pluginId: ctx.pluginId,
        version: ctx.version,
        args: ctx.args,
      });
    },
  },
};
```

用户直接 `botmux my-plugin:hello [参数...]` 调用。

- 命令名要符合 `^[a-z][a-z0-9._:-]{0,63}$`。Botmux 不会自动加命名空间，两个已启用插件有同名命令时会直接报冲突，所以统一用 `<plugin-id>:` 做前缀。
- `run` 返回字符串会打印出来，返回数字会作为退出码。
- 在宿主终端里运行时，只查找**机器默认**启用的插件；在 Agent 会话里运行时，按当前会话启用的插件查找。

`ctx` 里可以用：

- `pluginId`、`pluginDir`、`packageName`、`version`、`manifest`、`args`；
- `api.logger`、`api.resolve(relativePath)`；
- `api.config.get/set/replace`：读写插件私有配置 `~/.botmux/plugins/<id>/config.json`；
- `api.settingsPath`。

### Skill

开发时写在 `skills/<skill-name>/SKILL.md`，构建后必须在 `dist/skills/<skill-name>/SKILL.md`。

启用或更新后，已经在跑的 Agent 不会热加载新 Skill。新开一个会话，Botmux 会为这个 CLI 进程重新生成插件和 Skill 快照。

### MCP

每个插件最多提供一个 MCP server，在 `dist/mcp/index.json` 里声明。支持两种传输方式。

本地进程（stdio）：

```json
{
  "transport": "stdio",
  "command": ["node", "./mcp/server.js"],
  "env": {}
}
```

远程 HTTP（Streamable HTTP）：

```json
{
  "transport": "streamable-http",
  "url": "https://example.com/mcp",
  "headers": {}
}
```

注意事项：

- 只支持 `stdio` 和 `streamable-http`；
- MCP 名字自动用 Plugin ID，不用另写 `name`；
- `./...` 路径相对安装后的 `dist/`；
- 不支持 `${VAR}` 这类字符串模板；需要按 Bot 换参数时用上面的 [`pluginRuntime`](#按-bot-调整插件-mcp-的运行参数)；
- 本地 MCP 的运行依赖要打包进 `dist/`，不要依赖开发目录的 `node_modules`；
- 不要把真实 token、Cookie 或密钥写进包里，运行时从受控环境或插件私有配置读取。

Botmux 通过统一的 MCP Gateway 把当前会话启用的所有插件 MCP 聚合给 Agent。不同插件的工具重名时，Gateway 会自动加前缀区分。插件集合和凭证快照按 CLI 进程固定，改了启用状态或配置要新开会话。

#### 可信调用身份

当一轮对话由真实飞书用户触发时，Gateway 在转发 `tools/call` 时会附上一份**由宿主盖章、模型伪造不了**的调用身份，方便插件按人做权限控制或审计。

**在哪里读：**

- MCP 请求的 `_meta.botmuxTrustedCaller`（stdio 和 streamable-http 都有）。常用字段：

  | 字段 | 含义 |
  | --- | --- |
  | `requestUserOpenId` / `requestUserUnionId` | 触发这一轮的用户 |
  | `requestLarkAppId` | 当前 Bot 的飞书应用 ID |
  | `senderType` | `user` 或 `bot`：这一轮是真人还是另一个 Bot 发起的；判断不出来时不带 |
  | `source` / `taskId` | 不带 `source` = 普通的飞书消息；`schedule_creator` = 定时任务以其创建者/认领人身份运行（`taskId` 是任务 ID）；`failed_turn_recovery` = 自动重试一轮失败的请求，不代表有新的人工操作 |
  | `turnId` / `dispatchAttempt` | 这一轮的标识和投递次数，可用于幂等 |

- streamable-http 还会带请求头：`x-botmux-trusted-open-id`、`x-botmux-trusted-union-id`、`x-botmux-trusted-app-id`，以及 `x-botmux-turn-id`、`x-botmux-dispatch-attempt`。请求头里**没有** `source`、`taskId`、`senderType`，需要这些信息时读 `_meta`。

**怎么用才安全：**

- **只信带 `botmux` 命名空间的键。** Gateway 转发前会无条件删掉模型自己塞进 `_meta` 的、以 `botmux` 开头的键，以及传入的 `x-botmux-trusted-*` 头，所以模型冒充不了别人。
- 不要读裸键（比如没有命名空间的 `requestUserUnionId` 或自定义的 `trustedCaller`）当身份，这些键不在清理范围，模型可以随便填。
- 不是每一轮都有用户身份：拿不到发送者 ID 的轮次不会带 `requestUserOpenId` / `requestUserUnionId`（`botmuxTrustedCaller` 里可能只有 `turnId`）。对「没有这些用户字段」要 **fail-closed**（拒绝需要身份的操作），不要退回去用模型自报的值。
- 要确认「这是真人刚刚发起的」，就检查 `senderType === "user"` 并且没有 `source`。
- 身份由宿主按轮注入。不要把它展示给用户，也不要和传输 token 一起写进日志。

#### 敏感结果不经过模型

有些工具结果（比如业务数据、报表文件）不适合交给模型。本地 stdio MCP 可以在工具返回的 `_meta.botmuxHostDelivery` 里声明一份结果，由 Botmux 直接交付给发起人：

```json
{
  "schemaVersion": 1,
  "deliveryId": "report-20261105-0001",
  "markdown": "## 本月报表\n…",
  "files": [{ "path": "report.xlsx" }]
}
```

- 群里会出现一张「结果已生成」卡片，点「查看或下载」进入宿主提供的受控页面，**只有这次请求的发起人能看**，入口有有效期；
- 模型只拿到一个回执（`delivered`、`deliveryId`、`fileCount`），看不到原始结果；
- 附件必须放在 `~/.botmux/plugins/<id>/outbound/` 下，交付成功后源文件会被删除；最多 8 个文件，单个 ≤ 8 MiB、总计 ≤ 16 MiB；
- 只对本地 stdio MCP 开放，并且这一轮必须带有真人的可信身份；条件不满足时工具调用直接报错。
- `botmuxTrustedCaller.hostCapabilities` 包含 `result_delivery_v1` 时表示当前宿主支持这个能力。

### Dashboard 页面

`src/dashboard/index.js` 默认导出一个组件：

```js
export default function PluginDashboard({ pluginId, api }) {
  return `Dashboard loaded for ${pluginId}`;
}
```

页面路由固定为 `#/plugins/<plugin-id>`。`api` 提供：

| 方法 | 作用 |
| --- | --- |
| `react` | 宿主的 React 实例，请复用它，不要再打包一份 React |
| `getServiceStatus()` | 查看本插件 Service 的状态 |
| `startService()` / `stopService()` / `restartService()` | 控制本插件 Service |
| `getSettings()` / `saveSettings(value)` | 通过设置适配器读写配置 |
| `listBots()` | 列出可管理的 Bot |

**设置适配器**：要用 `getSettings` / `saveSettings`，插件需要提供 `dist/server/settings.js`，同时导出两个函数：

```ts
export function getSettings(api: { config: PluginConfigApi }): unknown | Promise<unknown>;
export function saveSettings(api: { config: PluginConfigApi }, value: unknown): unknown | Promise<unknown>;
```

- 注入的 `api` **只有 `config`**：`get(key?)`、`set(key, value)`、`replace(object)` 和 `path`。没有 `logger`、`resolve`、`settingsPath`。
- 只挑能在浏览器里展示的字段返回，不要原样回传 `config.json` 或敏感信息。
- 返回值要能 JSON 序列化；返回 `null`/`undefined` 时浏览器收到 `{ "ok": true }`。
- 错误码：请求 JSON 不合法 → 400；插件不存在或没有适配器 → 404；方法不支持 → 405；保存时插件刚被更新或替换 → 409 `plugin_settings_stale`，刷新后重试；适配器抛错、导出不对或结果无法序列化 → 500，错误码统一为 `plugin_settings_failed`，不会暴露原始异常。
- 安装扫描时不会执行适配器代码，导出是否正确在请求时才检查。

Dashboard 代码运行在安装 Botmux 的系统用户权限范围内。不要把敏感配置渲染进页面或打到浏览器日志里。

### Host Service

要提供 Service，下面两条缺一不可：

- `package.json` 里有 `botmux.service.mode`；
- `dist/service/index.js` 存在。

示例：

```js
export default {
  mode: "manual",
  port: 9360,
  pm2: {
    script: "./service/server.js",
    env: {
      PORT: "9360",
    },
    autorestart: true,
  },
  urls({ host, port }) {
    return {
      openUrl: `http://${host}:${port}/`,
      healthUrl: `http://${host}:${port}/health`,
    };
  },
};
```

- `pm2` 这个字段名只是为了兼容老插件保留的，实际由 Botmux 内置 supervisor 解析，不需要装 PM2。支持 `script`、`args`、`cwd`、`env`、`autorestart`、`killTimeoutMs`、`watchDelayMs`。
- 导出里的 `mode` 如果写了，必须和 manifest 一致。
- `urls()` 拿到的 `host` 已经是能直接拼进 URL 的格式（IPv6 自带方括号）。
- Service 进程会拿到环境变量 `BOTMUX_PLUGIN_ID`、`BOTMUX_PLUGIN_DIR`、`BOTMUX_PLUGIN_HOME`。
- 用单文件版 Botmux 时，JS 脚本由它内嵌的 Bun 执行，不需要另装 Node。
- 用 `--link` 开发时，`dist/` 有变化（存在 `dist/botmux-build/` 时只看它）Service 会自动重启。

### 飞书斜杠指令

插件可以注册自己的飞书指令，比如在群里发 `/work-bind status`，消息不会进 CLI，而是直接交给插件的 Host Service，插件返回的文字或卡片由 Botmux 发回群里。

**声明**：提供 `dist/commands/index.json`，并且插件必须有 Host Service：

```json
{
  "schemaVersion": 1,
  "endpoint": "/botmux/commands/v1",
  "commands": [
    { "name": "/work-bind", "description": "绑定或查看本群的工作项" }
  ]
}
```

- `name` 必须是小写的 `/xxx`（字母、数字、`:` `_` `-`），每个插件 1–16 条，不能重复；
- 不能和 Botmux 内置指令或 CLI 透传指令（如 `/help`、`/close`、`/compact`）同名，安装时就会被拒绝；
- `description` 可选，最多 120 字，会显示在 `/help` 末尾的「🧩 插件指令」一节；
- `endpoint` 是相对路径，Botmux 自己拼成 `http://127.0.0.1:<port><endpoint>`，所以 Service 定义里**必须写固定的 `port`**。

**用户这边的行为：**

- 发送者需要有和这个 Bot 对话的权限；不建会话、不进 CLI、不扣额度；
- 普通群如果要求 @ Bot 才响应（见 [@ 模式](/mention-mode)），插件指令也一样要 @；
- 两个已启用插件声明了同名指令时，这条指令会被停用，并回复「多个插件同时声明了指令」；
- Bot 的 `customPassthroughCommands` 里有同名指令时，以透传为准；
- 插件服务离线、超时（10 秒）或返回不合法时，回复「插件指令暂不可用」，不会退回去当普通消息发给 CLI；
- 启用或禁用插件后，下一条消息就生效，不用重启。

**请求和响应**：Botmux 向 endpoint 发 `POST`，带 `Authorization: Bearer <token>`（token 在 Service 的环境变量 `BOTMUX_PLUGIN_CARD_ACTION_TOKEN` 里，和卡片回调共用），只发一次、不重试：

```json
{
  "schemaVersion": 1,
  "eventId": "om_xxx",
  "larkAppId": "cli_xxx",
  "command": "/work-bind",
  "args": "status",
  "chat": { "chatId": "oc_xxx", "chatType": "group", "anchor": "om_xxx" },
  "sender": { "openId": "ou_xxx", "unionId": "on_xxx" },
  "privileges": { "canOperate": true, "canTalk": true },
  "locale": "zh"
}
```

- `eventId` 是触发消息的 ID，用来做幂等；
- `args` 已经去掉了开头的指令名；
- `privileges` 由宿主当场计算：`canOperate` 表示能管理这个 Bot，`canTalk` 表示能和它对话。**权限只看这里**，不要从 `args` 推断身份或权限。

插件返回：

```json
{ "schemaVersion": 1, "reply": { "text": "已绑定" } }
```

`reply` 可以是 `{ "text": "…" }`（最多 4000 字）、`{ "card": { … } }`，或者省略（不回复）。卡片里的按钮回调只能用本插件在 `card-actions` 里声明过的 action。

### 卡片按钮回调

插件发的卡片上的按钮，点击后可以交给插件处理。

**声明**：提供 `dist/card-actions/index.json`，同样需要 Host Service 和固定 `port`：

```json
{
  "schemaVersion": 1,
  "endpoint": "/botmux/card-actions/v1",
  "actions": ["my-plugin.confirm"],
  "actionPrefixes": ["my-plugin."]
}
```

- `actions`（精确匹配）和 `actionPrefixes`（前缀匹配）至少写一个；不能和 Botmux 自己的按钮 action 重叠；
- 按钮的 action 名取自按钮 `value.action`，没有时取按钮的 `name`；
- 在会话里发带插件按钮的卡片：`botmux send --plugin-card-action my-plugin --card-file card.json`（只能和 `--card-file` / `--card-json` 一起用）。

点击后，Botmux 把操作者、卡片上下文、按钮值和表单值 `POST` 到 endpoint（同一个 Bearer token），并附带宿主算好的 `privileges`。插件可以返回：

```json
{
  "schemaVersion": 1,
  "ack": {
    "toast": { "type": "success", "content": "已确认" },
    "card": { "schema": "2.0", "body": {} }
  }
}
```

`toast` 是点击后的轻提示（`success` / `info` / `warning` / `error`），`card` 用来原地更新卡片，都可省略。插件仍要在每次点击时自己校验 `privileges`，不能把发卡时的权限当成点击时的授权。

## 本地构建与验收

开发时：

```bash
npm install
npm test

botmux plugin install . --link
botmux plugin enable my-plugin
botmux my-plugin:hello
```

`--link` 只用于本地目录，它把插件运行目录链接到当前项目的 `dist/`。改了源码还是要重新 build；新增或删除扩展入口后，重新 `plugin install` 一次，让 Botmux 重新扫描。

发布前，用真正的 tarball 再验一遍：

```bash
npm ci
npm test
npm pack --dry-run
npm pack

botmux plugin install "file:/absolute/path/plugin-package.tgz"
botmux plugin enable my-plugin
botmux plugin service start my-plugin   # 没有 Service 的插件跳过
botmux plugin service status
```

验收的重点不是「仓库里能跑」，而是解压后的 `dist/` 离开源码和 `node_modules` 也能正常工作。

## 发布到 npm

1. 补齐仓库信息，确认包名在你能控制的 npm scope 下：

   ```json
   {
     "repository": {
       "type": "git",
       "url": "git+https://github.com/your-org/botmux-plugin-my-plugin.git"
     },
     "homepage": "https://github.com/your-org/botmux-plugin-my-plugin#readme",
     "bugs": {
       "url": "https://github.com/your-org/botmux-plugin-my-plugin/issues"
     }
   }
   ```

2. 确认登录状态（更新已有包时，可再用 `npm owner ls <包名>` 确认 owner；首次发布时包还不存在，这条会返回 404，跳过即可）：

   ```bash
   npm whoami --registry=https://registry.npmjs.org/
   ```

3. 发布 scoped 公开包：

   ```bash
   npm publish --access public --registry=https://registry.npmjs.org/
   ```

   发布要满足账户或包的 2FA 策略。长期跑 CI 时优先用 npm Trusted Publishing（OIDC），不要保存长期有效的写 token。如果账户用的是安全密钥/Passkey，而旧版 npm CLI 只让你输 OTP，可以临时用新版 CLI，它会给出一个浏览器确认链接：

   ```bash
   npx --yes npm@latest publish --access public --registry=https://registry.npmjs.org/
   ```

4. 发布后验证：

   ```bash
   npm view @your-org/plugin-my-plugin@1.2.3 \
     version dist.tarball dist.shasum dist.integrity \
     --json --registry=https://registry.npmjs.org/

   npm view @your-org/plugin-my-plugin dist-tags \
     --json --registry=https://registry.npmjs.org/
   ```

npm 上已发布的版本不能覆盖，任何修复都要升版本号。

## 登记插件市场

### 市场和 npm 是两回事

Botmux Plugin Market（`https://github.com/botmux-ai/plugin-market`）是一个独立的静态仓库，只存插件的发现信息，不托管代码，也不是安全背书。

- 发到 npm **不会**自动登记市场；
- 当前 Botmux 安装插件时**不读**市场索引：`botmux plugin install <短 ID>` 只是按约定展开成 `@botmux-ai/plugin-<短 ID>`，第三方插件即使登记了，也要用完整包名安装；
- `botmux plugin search`、`info`、`register`、`publish` 还没有实现；
- 市场条目里的 `compatibility.botmux` 目前只是元数据，安装器不会检查。

### 提交登记

先确保 npm 包已经公开可读。外部贡献者 fork 市场仓库：

```bash
gh repo fork botmux-ai/plugin-market --clone
cd plugin-market
git switch -c register-my-plugin
```

新增 `plugins/my-plugin.json`：

```json
{
  "id": "my-plugin",
  "package": "@your-org/plugin-my-plugin",
  "displayName": "My Plugin",
  "description": "一句话说明插件解决什么问题。",
  "repo": "https://github.com/your-org/botmux-plugin-my-plugin",
  "docs": "https://github.com/your-org/botmux-plugin-my-plugin#readme",
  "categories": ["mcp", "productivity"],
  "compatibility": {
    "botmux": ">=3.8.0"
  }
}
```

| 字段 | 要求 |
| --- | --- |
| `id`、`package`、`displayName`、`description`、`repo`、`categories`、`compatibility.botmux` | 必填 |
| `docs` | 可选 |
| `repo`、`docs` | 必须是 HTTPS URL |
| `categories` | 每项符合 `^[a-z][a-z0-9-]{0,31}$`，不能重复 |
| `package` | 用官方 scope 时必须正好是 `@botmux-ai/plugin-<id>` |

`>=3.8.0` 只是占位，请按插件实际用到的 Botmux 能力和你测过的版本填写。

生成索引、校验并提 PR：

```bash
npm install
npm run build
npm test

git add plugins/my-plugin.json index.json
git commit -m "feat: register my-plugin"
git push -u origin register-my-plugin
gh pr create \
  --repo botmux-ai/plugin-market \
  --head YOUR_GITHUB_USER:register-my-plugin
```

把 `YOUR_GITHUB_USER` 换成你的 GitHub 用户名。PR 里要**同时**包含条目文件和重新生成的 `index.json`；只跑 `npm test` 不跑 `npm run build` 时，索引过期会导致校验失败。

## 安全与发布清单

安装插件等于信任它的代码：

- npm 安装可能执行包的生命周期脚本；
- CLI、MCP、Dashboard、Service 都以运行 Botmux 的系统用户权限执行；
- 生产环境只装可信发布者的包，固定精确版本，核对 registry integrity；
- 不要把 token、Cookie、私钥、浏览器 Profile、日志或用户数据打进 `dist/`；
- 不要让 `dist/` 依赖仓库源码、开发目录或没声明的全局包；
- 市场登记只是发现渠道，代替不了代码审计。

发布前逐项确认：

- [ ] `npm ci && npm test` 通过；
- [ ] `dist/` 自包含，离开源码和 `node_modules` 能运行；
- [ ] `npm pack --dry-run` 不含敏感文件；
- [ ] manifest、各扩展入口都通过校验；
- [ ] Service 导出的 `mode` 和 manifest 一致；用了斜杠指令或卡片回调时写了固定 `port`；
- [ ] 本地目录和真实 tarball 都装过、验过；
- [ ] npm 发布后核对版本、dist-tag 和 integrity；
- [ ] 市场条目跑过 `npm run build && npm test`，PR 同时包含条目文件和 `index.json`。

## 参考

- [Botmux 源码](https://github.com/deepcoldy/botmux)
- [官方 Plugin 模板](https://github.com/botmux-ai/botmux-plugin-template)
- [Botmux Plugin Market](https://github.com/botmux-ai/plugin-market)
- [Agent Chrome 插件示例](https://github.com/botmux-ai/botmux-plugin-agent-chrome)：把 MCP、Skill、Service 打包成一个插件、按会话隔离的完整例子
- [npm：发布 scoped public package](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
- [npm：Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
