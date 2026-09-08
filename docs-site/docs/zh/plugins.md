# Plugin 开发与市场注册

Botmux
Plugin 用一个可发布的 npm 包，同时交付 Skill、MCP、CLI 命令、Dashboard 页面和 Host
Service。本文面向插件作者与运维者，说明从创建项目、构建验收到 npm 发布和插件市场登记的完整流程。

> 当前边界：插件市场是独立的发现索引。把包发布到 npm
> **不会**自动登记市场；当前稳定版 Botmux 也不会在安装时读取市场索引。完整包名始终是最可靠的安装入口。

## Plugin 如何被加载

插件项目的根 `package.json`
是开发、校验和 npm 发布外壳；Botmux 安装时读取 manifest，然后只把包内的 `dist/`
保存为运行单元。扩展能力按固定目录扫描：

| 能力 | 源目录 | 安装入口 |
| --- | --- | --- |
| Skill | `skills/<name>/SKILL.md` | `dist/skills/<name>/SKILL.md` |
| MCP | `src/mcp/` | `dist/mcp/index.json` |
| CLI 命令 | `src/cli/` | `dist/cli/{index.js,commands.json}` |
| Dashboard | `src/dashboard/` | `dist/dashboard/index.js` |
| Host Service | `src/service/` | `dist/service/index.js` |

当前没有通用的 worker/daemon hook 扩展点。插件应把长期进程放进 Host
Service，把 Agent 工具放进 MCP 或 Skill，把运维入口放进 CLI。

安装和启用是两个动作：

1. `plugin install` 下载、校验 manifest、扫描扩展点并保存 `dist/`；
2. `plugin enable`
   把插件绑定到机器默认或指定 Bot，并为后续会话生成 Skill/MCP 快照。

Botmux 安装阶段不会主动调用插件的 CLI、Dashboard、MCP 或 Service 入口，但从 npm 安装时底层
`npm install` **可能执行 npm lifecycle
scripts**。安装第三方插件仍等同于信任其发布者。

## 创建项目

插件**开发**需要 Node.js 22 或更高版本，且 `npm` 在 `PATH` 中——生成器会调用 npm
来搭脚手架、装依赖、跑测试。（这是插件开发本身的要求；botmux 自己是自包含二进制，
不需要 Node，见 [快速接入](/quickstart)。）

按你习惯的方式装好 botmux，然后运行生成器：

```bash
curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | sh
# 或者走 npm 安装：npm install -g botmux@latest

botmux plugin init my-plugin
cd botmux-plugin-my-plugin
```

生成器会创建官方模板项目，默认得到：

- npm 包名 `@botmux-ai/plugin-my-plugin`；
- Plugin ID `my-plugin`；
- `my-plugin:` CLI 命令前缀；
- 一套五种扩展点的示例；
- 已执行的 `npm install`、`npm test`，以及尽力执行的 `git init`。

`@botmux-ai` 是官方 npm organization。第三方作者没有该 scope 的发布权限时，应把
`package.json.name` 改成自己控制的包名，例如：

```json
{
  "name": "@your-org/plugin-my-plugin"
}
```

Plugin ID 仍可保留为 `my-plugin`。第三方包安装时必须使用完整 npm 包名。

## `package.json` 与 manifest

下面是包含插件依赖和 Service 的完整示例：

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

安装器会校验：

- `version` 是合法 SemVer；
- `keywords` 包含 `botmux-plugin`；
- `botmux.id` 匹配 `^[a-z][a-z0-9._-]{0,63}$`；
- 包内存在目录 `dist/`；
- `service.mode` 只能是 `manual` 或 `auto`；
- 每个已声明扩展点的固定入口都存在且格式合法。

建议将 `files` 限制为 `dist/`，并在发布前检查
`npm pack --dry-run`。npm 仍可能自动包含根目录的
`package.json`、README 和 LICENSE，因此也要检查这些文件是否含敏感信息。

`botmux.dependencies.plugins` 只声明 Plugin
ID，不支持版本范围。启用当前插件时，依赖插件必须已安装，并在同一机器默认或 Bot 作用域中启用；禁用或卸载仍被其他已启用插件依赖的插件会被拒绝。

## 开发扩展点

### CLI 命令

`src/cli/index.js` 默认导出 handler map。官方模板会在构建时同时生成
`dist/cli/index.js` 和命令索引：

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

命令名必须匹配
`^[a-z][a-z0-9._:-]{0,63}$`。Botmux 不会自动增加命名空间；两个已启用插件提供同名命令时会直接报冲突，因此建议统一使用
`<plugin-id>:` 前缀。

Handler 可读取：

- `pluginId`、`pluginDir`、`packageName`、`version`、`manifest` 和 `args`；
- `api.logger`；
- `api.resolve(relativePath)`；
- `api.config.get/set/replace`；
- `api.settingsPath`。

插件私有配置位于 `~/.botmux/plugins/<id>/`，由当前系统用户读写。

### Skill

每个 Skill 的开发入口是：

```text
skills/<skill-name>/SKILL.md
```

构建后必须位于：

```text
dist/skills/<skill-name>/SKILL.md
```

启用或更新插件后，已经运行的 Agent 不会热加载新 Skill。请新建会话，让 Botmux 重新生成本次 CLI 进程使用的 Plugin/Skill 快照。

### MCP

每个插件当前最多贡献一个 MCP server。构建后的 `dist/mcp/index.json`
支持两种 transport。

stdio：

```json
{
  "transport": "stdio",
  "command": ["node", "./mcp/server.js"],
  "env": {}
}
```

Streamable HTTP：

```json
{
  "transport": "streamable-http",
  "url": "https://example.com/mcp",
  "headers": {}
}
```

约束与注意事项：

- 只支持 `stdio` 和 `streamable-http`；
- MCP 名称自动使用 Plugin ID，不要另写 `name`；
- `./...` 路径相对安装后的 `dist/`；
- 配置不支持 `${VAR}` 字符串模板；
- 本地 MCP 运行依赖应被打包进 `dist/`，不要依赖开发目录的 `node_modules`；
- 不要把真实 token、Cookie 或密钥写进包；运行代码应从受控环境或插件私有配置读取。

Botmux 通过统一 MCP Gateway 聚合当前会话已启用插件的 MCP
server。插件集合与凭证快照以 CLI 进程为边界，因此修改绑定或配置后应新建会话。

#### 可信调用身份注入

当一轮对话由某个真实 IM 用户触发时，Gateway 会在转发 `tools/call` 时注入一份**宿主侧盖章、模型无法伪造**的调用身份，供需要按用户做权限或审计的插件使用。契约如下：

- 身份出现在两处：MCP 请求的 `_meta.botmuxTrustedCaller`（stdio 与 streamable-http 都注入），以及 streamable-http 的 `x-botmux-trusted-open-id` / `x-botmux-trusted-union-id` / `x-botmux-trusted-app-id` 请求头（另有 `x-botmux-turn-id` / `x-botmux-dispatch-attempt`）。`botmuxTrustedCaller` 里的字段为 `requestUserOpenId` / `requestUserUnionId` / `requestLarkAppId`。
- **只信这些带 `botmux` 命名空间的键**。Gateway 会在注入前**无条件剥离**客户端（模型）在 `_meta` 里自带的、以 `botmux` 开头的任意键，以及入站的 `x-botmux-trusted-*` 头——无论这一轮是否存在宿主身份。因此模型无法通过在工具参数里塞 `_meta.botmuxTrustedCaller` 来冒充他人。
- 反过来，插件**不要**去读裸键（如未加命名空间的 `requestUserUnionId` 或自定义的 `trustedCaller`）当作身份来源：这类键不在剥离范围内，可被模型自由填写。
- 并非每一轮都有可信身份：系统/恢复轮、以及拿不到发送方 `open_id`/`union_id` 的场景不会注入。插件必须对「无 `botmuxTrustedCaller`」**fail-closed**（拒绝需要身份的操作），不要在缺身份时回退到模型自报值。
- 身份仅存在于宿主 worker 进程内存中、按轮设置，不落任何文件；不要把它连同 transport token 一起对用户展示或写进日志。

背景与设计见飞书文档：[Botmux 插件开发与市场注册指南](https://bytedance.larkoffice.com/docx/FE2mdNdSgoFMVuxWTS7ctqO6nFb)、[Agent Chrome 插件安装与使用指南](https://bytedance.larkoffice.com/docx/RJPfdn0oHoC5zgxVXH1cKMjFnqc)（后者是「MCP + Skill + Service 打包成 `@botmux-ai/plugin-*`、按会话隔离」的完整范例）。

### Dashboard

`src/dashboard/index.js` 默认导出一个组件：

```js
export default function PluginDashboard({ pluginId, api }) {
  return `Dashboard loaded for ${pluginId}`;
}
```

固定路由是 `#/plugins/<plugin-id>`。当前 Dashboard Plugin API 提供：

- `getServiceStatus()`；
- `startService()`；
- `stopService()`；
- `restartService()`。

Dashboard 代码在安装 Botmux 的系统用户权限边界内运行。不要把敏感配置渲染进页面或浏览器日志。

### Host Service

要提供 Service，必须同时满足：

- `package.json#botmux.service.mode` 存在；
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

`host` 已是可直接插入 URL 的格式，包括带方括号的 IPv6 literal。Service 导出的
`mode` 如果存在，必须与 manifest 一致：

- `manual`：只在显式执行 `plugin service start` 时启动；
- `auto`：`botmux start` 和 `botmux restart` 会确保 Service 在线。

普通 `botmux stop` 默认保留插件 Service；`botmux stop --with-plugin`
才会一并停止 auto Service。

## 本地构建与验收

开发模式：

```bash
npm install
npm test

botmux plugin install . --link
botmux plugin enable my-plugin
botmux my-plugin:hello
```

`--link` 仅用于本地目录开发，它把插件运行目录链接到当前项目的
`dist/`。修改源代码后仍要重新 build；新增或删除扩展入口后，建议重新执行
`plugin install`，让 Botmux 重新扫描贡献项。

发布前构建真实 tarball：

```bash
npm ci
npm test
npm pack --dry-run
npm pack
```

再安装 tarball 验收：

```bash
botmux plugin install "file:/absolute/path/plugin-package.tgz"
botmux plugin enable my-plugin
botmux plugin service start my-plugin
botmux plugin service status
```

没有 Service 的插件省略 Service 命令。验收重点不是“仓库里能跑”，而是解压后的
`dist/` 脱离源码与 `node_modules` 仍能工作。

## 安装、启用和 Service 生命周期

从 npm 安装：

```bash
# 第三方包：使用完整包名，并建议固定精确版本
botmux plugin install @your-org/plugin-my-plugin@1.2.3

# 官方短 ID：展开为 @botmux-ai/plugin-my-plugin
botmux plugin install my-plugin
```

启用范围：

```bash
# 机器默认，对所有 Bot 生效
botmux plugin enable my-plugin

# 指定 Bot，或显式配置所有现有 Bot
botmux plugin enable my-plugin --bot <name|index|all>

botmux plugin disable my-plugin
botmux plugin disable my-plugin --bot <name|index|all>
```

无 `--bot` 就是机器默认作用域，不需要
`--global`。如果插件已在机器默认作用域启用，必须先关闭机器默认绑定，才能按 Bot 单独配置。启用或更新后请新建 Agent 会话。

Service 管理：

```bash
botmux plugin service status
botmux plugin service start my-plugin
botmux plugin service stop my-plugin
botmux plugin service restart my-plugin
```

更新当前通过重新 install 完成。存在 Service 时必须先停止：

```bash
botmux plugin service stop my-plugin
botmux plugin install @your-org/plugin-my-plugin@1.2.4
botmux plugin enable my-plugin
botmux plugin service start my-plugin
```

Botmux 不会在安装、更新或卸载时隐式停止正在运行的 Service。

卸载：

```bash
botmux plugin service stop my-plugin
botmux plugin uninstall my-plugin
```

卸载会清理插件绑定和
`~/.botmux/plugins/<id>/`，其中可能包含插件配置；需要保留时请先备份。帮助文本中的
`--force` 当前不能绕过依赖或 Service 生命周期保护。

## 发布到 npm

发布前补齐仓库元数据，并确认包名属于你控制的 npm scope：

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

确认 npm 登录状态：

```bash
npm whoami --registry=https://registry.npmjs.org/
```

更新已存在的包时，还可以确认 owner；首次发布前包尚不存在，此命令会返回 404，应跳过：

```bash
npm owner ls @your-org/plugin-my-plugin \
  --registry=https://registry.npmjs.org/
```

发布 scoped public 包：

```bash
npm publish --access public --registry=https://registry.npmjs.org/
```

npm 发布需要满足账户/包的 2FA 策略，或使用被明确允许发布的自动化凭证。长期 CI 优先使用 npm
Trusted Publishing/OIDC，避免保存长期写 token。

账户使用安全密钥/Passkey，而旧 npm
CLI 只显示 OTP 输入时，可在交互式终端临时使用当前 npm CLI：

```bash
npx --yes npm@latest publish \
  --access public \
  --registry=https://registry.npmjs.org/
```

CLI 会输出 WebAuthn 页面链接，在浏览器中完成安全密钥确认。

发布后验证：

```bash
npm view @your-org/plugin-my-plugin@1.2.3 \
  version dist.tarball dist.shasum dist.integrity \
  --json \
  --registry=https://registry.npmjs.org/

npm view @your-org/plugin-my-plugin dist-tags \
  --json \
  --registry=https://registry.npmjs.org/
```

npm 已发布版本不能覆盖；任何修复都必须增加版本号。

## 注册插件市场

### npm 与市场是两条链路

Botmux Plugin Market 是独立静态仓库：

```text
https://github.com/botmux-ai/plugin-market
```

它只保存发现元数据，不托管插件代码，也不是安全信任边界。先确保 npm 包公开可读，再提交市场 PR。

外部贡献者应 fork 市场仓库；下面的 GitHub
CLI 命令会 clone 自己的 fork，并保留官方仓库作为 upstream：

```bash
gh repo fork botmux-ai/plugin-market --clone
cd plugin-market
git switch -c register-my-plugin
```

有 `botmux-ai/plugin-market` 写权限的维护者也可以直接 clone 官方仓库。

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

必填字段：

- `id`；
- `package`；
- `displayName`；
- `description`；
- `repo`；
- `categories`；
- `compatibility.botmux`。

`docs` 可选。`repo` 和 `docs` 必须是 HTTPS URL；分类名必须匹配
`^[a-z][a-z0-9-]{0,31}$` 且不能重复。如果包使用官方 scope，名称必须严格等于
`@botmux-ai/plugin-<id>`。

示例中的 `>=3.8.0` 只是占位。请根据插件真实使用的 Botmux
API 和完成过的兼容性测试填写最低版本。

生成索引并校验：

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

把 `YOUR_GITHUB_USER` 替换成 fork 所属的 GitHub 用户名。

必须同时提交源条目和重新生成的 `index.json`。市场 README 的简版流程只写了
`npm test`，但索引过期时校验会要求先执行 `npm run build`。

### 当前 CLI 边界

截至稳定版 `botmux@3.8.0`，并且当前 `master` 仍是以下行为：

- `botmux plugin search`、`info`、`register`、`publish` 尚未实现；
- `botmux plugin install <short-id>` 不读取市场索引，只按命名约定展开为
  `@botmux-ai/plugin-<short-id>`；
- 第三方市场插件即使完成登记，当前仍需用完整 npm 包名安装；
- `compatibility.botmux` 当前是市场元数据，安装器尚不执行 SemVer 兼容性判断。

当前可用 verbs 是
`list`、`init`、`install`、`uninstall`、`enable`、`disable`、`emit` 和
`service`。其中 `emit` 是 legacy Codex Notifier 兼容入口，不是通用 Plugin
事件或 daemon hook 扩展点。以 `botmux plugin --help` 为最终准确信息。

## 安全与发布清单

安装插件等于信任其代码：

- npm 安装可能执行 package lifecycle scripts；
- CLI、MCP、Dashboard 和 Service 都以安装 Botmux 的系统用户权限运行；
- 生产环境只安装可信发布者的包，固定精确版本并核对 registry integrity；
- 不要把 token、Cookie、私钥、浏览器 Profile、日志或用户数据打进 `dist/`；
- 不要让 `dist/` 依赖仓库源码、开发目录或未声明的全局包；
- 发布前逐项检查 `npm pack --dry-run` 的文件清单；
- 为仓库启用依赖审计、Code Review、分支保护和 Trusted Publishing；
- 市场登记只是发现机制，不能代替代码审计。

最终验收：

- [ ] `npm ci && npm test` 通过；
- [ ] `dist/` 自包含，脱离源码和 `node_modules` 可运行；
- [ ] `npm pack --dry-run` 不含敏感文件；
- [ ] manifest、CLI 命令、MCP 和 Service 入口通过校验；
- [ ] Service 的 manifest mode 与导出定义一致；
- [ ] 本地目录和真实 tarball 都完成安装验收；
- [ ] npm 发布后校验版本、dist-tag 和 integrity；
- [ ] 市场条目执行 `npm run build && npm test`；
- [ ] 市场 PR 同时包含条目文件和 `index.json`。

## 参考

- [Botmux 源码](https://github.com/deepcoldy/botmux)
- [官方 Plugin 模板](https://github.com/botmux-ai/botmux-plugin-template)
- [Botmux Plugin Market](https://github.com/botmux-ai/plugin-market)
- [Agent Chrome Plugin 示例](https://github.com/botmux-ai/botmux-plugin-agent-chrome)
- [npm：发布 scoped public package](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
- [npm：Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
