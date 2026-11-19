# Plugin Development and Publishing

A Botmux plugin is **one npm package**. Once installed, it can give the Agent Skills and MCP tools, add subcommands to the `botmux` CLI, add a page to the Dashboard, run a long-lived background service, and register Feishu `/slash commands` and card buttons.

Start with what you want to do:

| I want to… | Go to |
| --- | --- |
| Install an existing plugin and turn it on for a Bot | [Install and manage plugins](#install-and-manage-plugins) |
| Write a plugin from scratch | [Five-minute start](#five-minute-start) → [Building each contribution](#building-each-contribution) |
| Publish to npm and list it in the Plugin Market | [Publish to npm](#publish-to-npm) → [Register in the Plugin Market](#register-in-the-plugin-market) |

> Installing a third-party plugin means trusting its author: plugin code runs as the system user that runs Botmux. Confirmed Dashboard installs skip npm lifecycle scripts; ordinary CLI installs may still run them. Only install packages you trust. A catalog listing is not a security endorsement.

## What a plugin can provide

A plugin delivers its capabilities through **fixed directories**. Botmux scans them at install time, so nothing else needs registering. Every entry lives in the build output `dist/`:

| Capability | Purpose | Entry after install (relative to `dist/`) |
| --- | --- | --- |
| Skill | Instructions for the Agent | `skills/<name>/SKILL.md` |
| MCP | Tools for the Agent (at most one server per plugin) | `mcp/index.json` |
| CLI commands | Ops entry points shaped like `botmux <command>` | `cli/index.js` + `cli/commands.json` |
| Dashboard page | A plugin page inside the Dashboard | `dashboard/index.js` |
| Dashboard settings | Server-side adapter the page uses to read/write config (optional) | `server/settings.js` |
| Host Service | A long-running background process, e.g. a local HTTP service | `service/index.js` |
| Feishu slash commands | `/xxx` in a chat goes straight to the plugin | `commands/index.json` (needs a Host Service) |
| Card button callbacks | Button clicks on the plugin's cards go to the plugin | `card-actions/index.json` (needs a Host Service) |

There is no general daemon/worker hook. Put long-running logic in a Host Service, Agent capabilities in MCP or a Skill, and human-facing ops entry points in CLI commands.

## Five-minute start

Plugin development needs **Node.js 22+** with `npm` on `PATH`: the generator uses npm to scaffold, install dependencies, and run tests. (That is only a requirement for developing plugins. Botmux itself is a self-contained binary and does not need Node; see [Quick Start](/en/quickstart).)

```bash
# 1. Install botmux (either way)
curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | sh
# npm install -g botmux@latest

# 2. Generate a plugin project
botmux plugin init my-plugin
cd botmux-plugin-my-plugin

# 3. Install in development mode and enable it
botmux plugin install . --link
botmux plugin enable my-plugin

# 4. Try the sample command
botmux my-plugin:hello
```

`plugin init` creates the project from the official template and runs `npm install` and `npm test` for you (`git init` is best-effort; failing it is fine). Defaults:

| Item | Default |
| --- | --- |
| Directory | `botmux-plugin-my-plugin` |
| npm package name | `@botmux-ai/plugin-my-plugin` |
| Plugin ID | `my-plugin` |
| CLI command prefix | `my-plugin:` |
| Samples | One for each basic contribution type |

`@botmux-ai` is the official npm organization. If you can't publish to that scope, change `name` in `package.json` to a package you control, such as `@your-org/plugin-my-plugin`. The Plugin ID can stay `my-plugin`, but third-party packages must be installed by their full package name.

## Install and manage plugins

### Install

```bash
# Third-party package: use the full name, ideally pinned to an exact version
botmux plugin install @your-org/plugin-my-plugin@1.2.3

# Official short ID: expands to @botmux-ai/plugin-my-plugin
botmux plugin install my-plugin

# A local directory or a packed tarball
botmux plugin install ./path/to/plugin
botmux plugin install "file:/absolute/path/plugin-package.tgz"
```

Installing does three things: download, validate the manifest, and scan the contribution entries, then store `dist/` under `~/.botmux/plugins/<id>/`. **Installing does not run plugin code and does not start the Service.**

### Enable: choose which Bots it applies to

After installing, enable the plugin so it shows up in sessions:

```bash
# Machine default: applies to every Bot (including Bots added later)
botmux plugin enable my-plugin

# One Bot only; all = write an entry for each currently configured Bot
botmux plugin enable my-plugin --bot <name|index|all>

# Turn it off
botmux plugin disable my-plugin
botmux plugin disable my-plugin --bot <name|index|all>
```

- Without `--bot` you get the machine-default scope (stored as `plugins` in `~/.botmux/config.json`). There is no `--global`.
- Per-Bot enablement is stored in that Bot's `plugins` field in `bots.json` and **adds to** the machine default.
- If a plugin is already enabled as machine default, turn the machine default off before configuring it per Bot.
- **After enabling, disabling, or updating, start a new session.** A running CLI does not hot-load new Skills/MCP. Feishu slash commands are the exception: they take effect on the next message.

`botmux plugin list` shows installed plugins and whether each is enabled as machine default.

### Manage from the Dashboard

The **插件** (Plugins) page has **Installed** and **Discover** views using the Dashboard's light and dark themes.

- Installed supports search and source filtering. Cards show the name, description, audience, enablement and management action.
- Management retains machine-default and per-Bot enablement, settings and sidebar pinning. Package details, contribution lists and service controls are under collapsed Advanced settings.
- Discover reads the [plugin catalog](https://github.com/botmux-ai/plugin-market), with search, details and installation. Network failures show cached results or an explicit unavailable state.
- Installation confirmation displays the package name, exact npm version and SHA-512 integrity. It is bound to the management identity, expires after five minutes and must be repeated if the registry state or management credentials change. Installation does not automatically enable a plugin.
- Uninstall requires disabling all scopes and stopping the service before confirming the package and version. The installer rechecks the confirmation before committing changes.

Install and uninstall require the local management identity and CSRF validation. Discovery needs network access; installation also needs `npm` and `tar` on `PATH`. Packages must ship a prebuilt `dist/`, rather than generating runtime files in install scripts.

Card descriptions come from npm `package.json`'s `description`. Optional `botmux.audience` describes the intended audience or prerequisites. These are display fields, not authorization controls.

A plugin's own page lives at `#/plugins/<plugin-id>`. For more on the Dashboard, see [Dashboard](/en/dashboard).

### Manage the Host Service

```bash
botmux plugin service status
botmux plugin service start my-plugin      # or --all
botmux plugin service stop my-plugin
botmux plugin service restart my-plugin
```

A Service has one of two modes (declared in the manifest):

| Mode | Behavior |
| --- | --- |
| `manual` (default) | Starts only when you run `plugin service start` |
| `auto` | `botmux start` / `botmux restart` make sure it is running |

- `botmux stop` **keeps** plugin Services running by default; `botmux stop --with-plugin` stops auto Services too.
- `botmux restart` does not stop auto Services first by default; `botmux restart --with-plugin` stops them and starts them again.
- Services are managed by Botmux's built-in supervisor; you don't need PM2. Logs are in `~/.botmux/plugin-supervisor/logs/<plugin-id>-out.log` and `-err.log`.

### Update and uninstall

To update, install the new version again. If the plugin has a Service, stop it first. Botmux does **not** stop a Service for you during install, update, or uninstall; a running Service makes the command fail:

```bash
botmux plugin service stop my-plugin
botmux plugin install @your-org/plugin-my-plugin@1.2.4
botmux plugin enable my-plugin
botmux plugin service start my-plugin
```

Uninstall:

```bash
botmux plugin service stop my-plugin
botmux plugin uninstall my-plugin
```

Uninstalling removes the plugin's enablement from every scope and deletes the whole `~/.botmux/plugins/<id>/` directory (including plugin config), so back it up first if you need it. It is refused while other enabled plugins depend on it. The `--force` flag shown in help currently cannot bypass dependency or Service protections.

### Tune a plugin's MCP per Bot

To give one Bot's plugin MCP different environment variables or its own timeout, add `pluginRuntime` to that Bot in [bots.json](/en/bots-json):

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

| Field | Meaning |
| --- | --- |
| `env` | Injected only into this plugin's local stdio MCP process for this Bot; never into the model CLI's environment |
| `toolTimeoutMs` | Total timeout per tool call for this plugin (milliseconds, positive integer); defaults to the MCP SDK default |

The machine-wide ceiling is `mcpGatewayMaxToolTimeoutMs` in `~/.botmux/config.json`, default `600000` (10 minutes). `toolTimeoutMs` can't exceed this ceiling; if it does, preparing plugins for a new session fails with an error. Changes apply on the next CLI cold start or new session.

## `package.json` and the manifest

The plugin's root `package.json` is both the npm package description and the plugin manifest (the `botmux` field). Full example:

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

Install-time checks:

- `version` is valid SemVer;
- `keywords` contains `botmux-plugin`;
- `botmux.id` matches `^[a-z][a-z0-9._-]{0,63}$`;
- the package contains a `dist/` directory;
- `service.mode` is `manual` or `auto` (defaults to `manual`);
- every contribution entry exists and is well-formed.

`botmux.dependencies.plugins` lists Plugin IDs only; version ranges are not supported. To enable a plugin, its dependencies must be installed and enabled in the same scope. A plugin that other enabled plugins depend on cannot be disabled or uninstalled.

Keep `files` limited to `dist/` and check `npm pack --dry-run` before publishing. npm still includes `package.json`, README, and LICENSE automatically, so make sure those contain nothing sensitive either.

## Building each contribution

### CLI commands

`src/cli/index.js` default-exports a "command name → handler" object. The official template's build emits both `dist/cli/index.js` and the command index `dist/cli/commands.json`:

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

Users call it directly as `botmux my-plugin:hello [args...]`.

- Command names must match `^[a-z][a-z0-9._:-]{0,63}$`. Botmux adds no namespace, and two enabled plugins with the same command name fail with a conflict, so always prefix with `<plugin-id>:`.
- If `run` returns a string it is printed; a number becomes the exit code.
- From a host terminal, only **machine-default** plugins are searched; inside an Agent session, the plugins enabled for that session are searched.

`ctx` gives you:

- `pluginId`, `pluginDir`, `packageName`, `version`, `manifest`, `args`;
- `api.logger`, `api.resolve(relativePath)`;
- `api.config.get/set/replace`: read and write the plugin's private config at `~/.botmux/plugins/<id>/config.json`;
- `api.settingsPath`.

### Skill

Write it at `skills/<skill-name>/SKILL.md` during development; after the build it must be at `dist/skills/<skill-name>/SKILL.md`.

After enabling or updating, a running Agent does not hot-load the new Skill. Start a new session and Botmux regenerates the plugin and Skill snapshot for that CLI process.

### MCP

Each plugin can provide at most one MCP server, declared in `dist/mcp/index.json`. Two transports are supported.

Local process (stdio):

```json
{
  "transport": "stdio",
  "command": ["node", "./mcp/server.js"],
  "env": {}
}
```

Remote HTTP (Streamable HTTP):

```json
{
  "transport": "streamable-http",
  "url": "https://example.com/mcp",
  "headers": {}
}
```

Things to know:

- only `stdio` and `streamable-http` are supported;
- the MCP name is the Plugin ID automatically, so don't add `name`;
- `./...` paths are relative to the installed `dist/`;
- `${VAR}` string templates are not supported; to vary settings per Bot, use [`pluginRuntime`](#tune-a-plugins-mcp-per-bot) above;
- bundle a local MCP's runtime dependencies into `dist/` instead of relying on the development `node_modules`;
- never put real tokens, cookies, or secrets in the package; read them at runtime from a controlled environment or the plugin's private config.

Botmux aggregates the MCP servers of all plugins enabled for the current session through one MCP Gateway. When tools from different plugins share a name, the Gateway adds a prefix to tell them apart. The plugin set and credential snapshot are fixed per CLI process, so start a new session after changing enablement or config.

#### Trusted caller identity

When a turn is triggered by a real Feishu user, the Gateway attaches a caller identity to forwarded `tools/call` requests. It is **stamped by the host and cannot be forged by the model**, so plugins can enforce per-user permissions or audit.

**Where to read it:**

- `_meta.botmuxTrustedCaller` on the MCP request (both stdio and streamable-http). Common fields:

  | Field | Meaning |
  | --- | --- |
  | `requestUserOpenId` / `requestUserUnionId` | The user who triggered this turn |
  | `requestLarkAppId` | The current Bot's Feishu app ID |
  | `senderType` | `user` or `bot`: whether a human or another Bot opened this turn; absent when it can't be determined |
  | `source` / `taskId` | No `source` = an ordinary Feishu message; `schedule_creator` = a scheduled task running as its creator/claimer (`taskId` is the task ID); `failed_turn_recovery` = an automatic retry of a failed request, not a new human action |
  | `turnId` / `dispatchAttempt` | This turn's ID and delivery attempt, useful for idempotency |

- streamable-http also gets request headers: `x-botmux-trusted-open-id`, `x-botmux-trusted-union-id`, `x-botmux-trusted-app-id`, plus `x-botmux-turn-id` and `x-botmux-dispatch-attempt`. The headers do **not** carry `source`, `taskId`, or `senderType`; read `_meta` when you need them.

**How to use it safely:**

- **Trust only keys in the `botmux` namespace.** Before forwarding, the Gateway unconditionally strips any `_meta` key starting with `botmux` that the model supplied, as well as inbound `x-botmux-trusted-*` headers, so the model cannot impersonate someone else.
- Don't treat bare keys (such as an un-namespaced `requestUserUnionId` or a custom `trustedCaller`) as identity. They are not stripped and the model can fill them freely.
- Not every turn has a user identity: turns without a sender ID carry no `requestUserOpenId` / `requestUserUnionId` (`botmuxTrustedCaller` may hold only `turnId`). **Fail closed** when those user fields are missing (refuse identity-gated operations) and never fall back to values the model reports.
- To confirm "a human just asked for this", check `senderType === "user"` and that `source` is absent.
- The host injects the identity per turn. Don't show it to users, and don't log it together with transport tokens.

#### Keep sensitive results away from the model

Some tool results (business data, report files) shouldn't go to the model. A local stdio MCP can declare a result in the tool response's `_meta.botmuxHostDelivery`, and Botmux delivers it straight to the requester:

```json
{
  "schemaVersion": 1,
  "deliveryId": "report-20261105-0001",
  "markdown": "## Monthly report\n…",
  "files": [{ "path": "report.xlsx" }]
}
```

- A "结果已生成" (result ready) card appears in the chat. Its "查看或下载" (view or download) button opens a host-controlled page that **only the requester of this turn can see**, and the link expires;
- the model only gets a receipt (`delivered`, `deliveryId`, `fileCount`), never the raw result;
- attachments must live under `~/.botmux/plugins/<id>/outbound/` and are deleted after successful delivery; up to 8 files, each ≤ 8 MiB, ≤ 16 MiB in total;
- only local stdio MCP servers can use it, and the turn must carry a trusted human identity; otherwise the tool call fails.
- `botmuxTrustedCaller.hostCapabilities` containing `result_delivery_v1` means the current host supports it.

### Dashboard page

`src/dashboard/index.js` default-exports a component:

```js
export default function PluginDashboard({ pluginId, api }) {
  return `Dashboard loaded for ${pluginId}`;
}
```

The route is fixed at `#/plugins/<plugin-id>`. `api` provides:

| Method | Purpose |
| --- | --- |
| `react` | The host's React instance; reuse it instead of bundling another copy |
| `getServiceStatus()` | Read this plugin's Service status |
| `startService()` / `stopService()` / `restartService()` | Control this plugin's Service |
| `getSettings()` / `saveSettings(value)` | Read/write config through the settings adapter |
| `listBots()` | List manageable Bots |

**Settings adapter**: to use `getSettings` / `saveSettings`, ship `dist/server/settings.js` exporting both functions:

```ts
export function getSettings(api: { config: PluginConfigApi }): unknown | Promise<unknown>;
export function saveSettings(api: { config: PluginConfigApi }, value: unknown): unknown | Promise<unknown>;
```

- The injected `api` has **only `config`**: `get(key?)`, `set(key, value)`, `replace(object)`, and `path`. There is no `logger`, `resolve`, or `settingsPath`.
- Return only fields that are safe to show in a browser; don't echo raw `config.json` or secrets.
- Return values must be JSON-serializable; returning `null`/`undefined` gives the browser `{ "ok": true }`.
- Errors: invalid request JSON → 400; plugin missing or no adapter → 404; unsupported method → 405; plugin updated or replaced while the save was waiting → 409 `plugin_settings_stale` (reload and retry); adapter throws, bad exports, or unserializable result → 500 with the single code `plugin_settings_failed`, never the raw exception.
- The install scan does not run adapter code; exports are checked at request time.

Dashboard code runs within the permissions of the system user that installed Botmux. Don't render sensitive config into the page or browser logs.

### Host Service

A Service needs both of these:

- `botmux.service.mode` in `package.json`;
- `dist/service/index.js`.

Example:

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

- The `pm2` field name is kept only for compatibility with older plugins. Botmux's built-in supervisor interprets it; PM2 is not needed. Supported keys: `script`, `args`, `cwd`, `env`, `autorestart`, `killTimeoutMs`, `watchDelayMs`.
- If the export sets `mode`, it must match the manifest.
- The `host` passed to `urls()` is already URL-ready (IPv6 literals come bracketed).
- The Service process receives `BOTMUX_PLUGIN_ID`, `BOTMUX_PLUGIN_DIR`, and `BOTMUX_PLUGIN_HOME`.
- With the single-file Botmux binary, JS scripts run on its embedded Bun, so no separate Node install is needed.
- While developing with `--link`, the Service restarts automatically when `dist/` changes (only `dist/botmux-build/` is watched if it exists).

### Feishu slash commands

A plugin can register its own Feishu commands. For example, `/work-bind status` in a chat does not go to the CLI; it goes straight to the plugin's Host Service, and Botmux posts the plugin's text or card reply back to the chat.

**Declare**: ship `dist/commands/index.json`; the plugin must have a Host Service:

```json
{
  "schemaVersion": 1,
  "endpoint": "/botmux/commands/v1",
  "commands": [
    { "name": "/work-bind", "description": "Bind or view this chat's work item" }
  ]
}
```

- `name` must be a lowercase `/xxx` (letters, digits, `:` `_` `-`), 1–16 per plugin, no duplicates;
- it can't reuse a Botmux built-in or CLI passthrough command (such as `/help`, `/close`, `/compact`); that is rejected at install time;
- `description` is optional, up to 120 characters, and is listed in the "🧩 Plugin commands" section at the end of `/help`;
- `endpoint` is a relative path. Botmux builds `http://127.0.0.1:<port><endpoint>` itself, so the Service definition **must set a fixed `port`**.

**What users see:**

- the sender must be allowed to talk to this Bot; no session is created, nothing goes to the CLI, and no quota is used;
- in a regular group that requires @-mentioning the Bot (see [Mention mode](/en/mention-mode)), plugin commands need the @ too;
- if two enabled plugins declare the same command, it is disabled and the Bot replies that multiple plugins declared it;
- if the Bot's `customPassthroughCommands` has the same name, passthrough wins;
- if the plugin service is offline, times out (10 seconds), or returns something invalid, the Bot replies that the plugin command is unavailable; it never falls back to sending the message to the CLI;
- enabling or disabling a plugin takes effect on the next message, no restart needed.

**Request and response**: Botmux sends a `POST` to the endpoint with `Authorization: Bearer <token>` (the token is in the Service's `BOTMUX_PLUGIN_CARD_ACTION_TOKEN` environment variable, shared with card callbacks). It is sent once, with no retry:

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

- `eventId` is the triggering message ID; use it for idempotency;
- `args` already has the command name stripped;
- `privileges` is computed by the host on the spot: `canOperate` means the sender can manage this Bot, `canTalk` means they can talk to it. **Use only this for authorization**; never infer identity or permissions from `args`.

The plugin replies:

```json
{ "schemaVersion": 1, "reply": { "text": "Bound" } }
```

`reply` can be `{ "text": "…" }` (up to 4000 characters), `{ "card": { … } }`, or omitted (no reply). Button callbacks in the card may only use actions this plugin declared in `card-actions`.

### Card button callbacks

Buttons on cards the plugin sends can be handled by the plugin when clicked.

**Declare**: ship `dist/card-actions/index.json`; it also needs a Host Service with a fixed `port`:

```json
{
  "schemaVersion": 1,
  "endpoint": "/botmux/card-actions/v1",
  "actions": ["my-plugin.confirm"],
  "actionPrefixes": ["my-plugin."]
}
```

- Provide at least one of `actions` (exact match) and `actionPrefixes` (prefix match); neither may overlap Botmux's own button actions;
- a button's action name comes from its `value.action`, falling back to the button's `name`;
- to send a card with plugin buttons from a session: `botmux send --plugin-card-action my-plugin --card-file card.json` (only together with `--card-file` / `--card-json`).

On click, Botmux `POST`s the operator, card context, button value, and form values to the endpoint (same Bearer token), along with host-computed `privileges`. The plugin can reply:

```json
{
  "schemaVersion": 1,
  "ack": {
    "toast": { "type": "success", "content": "Confirmed" },
    "card": { "schema": "2.0", "body": {} }
  }
}
```

`toast` is a short notice after the click (`success` / `info` / `warning` / `error`); `card` updates the card in place. Both are optional. The plugin must still check `privileges` on every click; permission at send time is not authorization at click time.

## Local build and acceptance

During development:

```bash
npm install
npm test

botmux plugin install . --link
botmux plugin enable my-plugin
botmux my-plugin:hello
```

`--link` is for local directories only; it links the plugin runtime directory to your project's `dist/`. You still need to rebuild after editing source. After adding or removing contribution entries, run `plugin install` again so Botmux rescans.

Before publishing, verify again with a real tarball:

```bash
npm ci
npm test
npm pack --dry-run
npm pack

botmux plugin install "file:/absolute/path/plugin-package.tgz"
botmux plugin enable my-plugin
botmux plugin service start my-plugin   # skip if there is no Service
botmux plugin service status
```

The point is not "it runs inside the repo" but that the extracted `dist/` works on its own, without the source tree or `node_modules`.

## Publish to npm

1. Fill in repository metadata and confirm the package name is in an npm scope you control:

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

2. Check that you are logged in (for an existing package you can also confirm owners with `npm owner ls <package>`; before the first publish the package doesn't exist yet and that returns 404, so skip it):

   ```bash
   npm whoami --registry=https://registry.npmjs.org/
   ```

3. Publish the scoped public package:

   ```bash
   npm publish --access public --registry=https://registry.npmjs.org/
   ```

   Publishing must satisfy the account or package 2FA policy. For long-running CI, prefer npm Trusted Publishing (OIDC) over storing long-lived write tokens. If your account uses a security key/passkey and an older npm CLI only asks for an OTP, use a current CLI temporarily; it prints a browser confirmation link:

   ```bash
   npx --yes npm@latest publish --access public --registry=https://registry.npmjs.org/
   ```

4. Verify after publishing:

   ```bash
   npm view @your-org/plugin-my-plugin@1.2.3 \
     version dist.tarball dist.shasum dist.integrity \
     --json --registry=https://registry.npmjs.org/

   npm view @your-org/plugin-my-plugin dist-tags \
     --json --registry=https://registry.npmjs.org/
   ```

Published npm versions can't be overwritten; every fix needs a new version number.

## Register in the Plugin Market

### The Market and npm are separate

The Botmux Plugin Market (`https://github.com/botmux-ai/plugin-market`) is a standalone static repository. It only stores discovery metadata, hosts no code, and is not a security endorsement.

- Publishing to npm does **not** register the plugin in the Market;
- Botmux currently does **not** read the Market index when installing: `botmux plugin install <short-id>` just expands to `@botmux-ai/plugin-<short-id>` by convention, so registered third-party plugins still need their full package name;
- `botmux plugin search`, `info`, `register`, and `publish` are not implemented yet;
- `compatibility.botmux` in a Market entry is metadata only; the installer doesn't check it.

### Submit an entry

Make sure the npm package is publicly readable first. External contributors fork the Market repository:

```bash
gh repo fork botmux-ai/plugin-market --clone
cd plugin-market
git switch -c register-my-plugin
```

Add `plugins/my-plugin.json`:

```json
{
  "id": "my-plugin",
  "package": "@your-org/plugin-my-plugin",
  "displayName": "My Plugin",
  "description": "One sentence on what problem the plugin solves.",
  "repo": "https://github.com/your-org/botmux-plugin-my-plugin",
  "docs": "https://github.com/your-org/botmux-plugin-my-plugin#readme",
  "categories": ["mcp", "productivity"],
  "compatibility": {
    "botmux": ">=3.8.0"
  }
}
```

| Field | Rule |
| --- | --- |
| `id`, `package`, `displayName`, `description`, `repo`, `categories`, `compatibility.botmux` | Required |
| `docs` | Optional |
| `repo`, `docs` | Must be HTTPS URLs |
| `categories` | Each matches `^[a-z][a-z0-9-]{0,31}$`, no duplicates |
| `package` | With the official scope it must be exactly `@botmux-ai/plugin-<id>` |

`>=3.8.0` is only a placeholder. Fill in the minimum version based on the Botmux capabilities your plugin uses and the versions you tested.

Build the index, validate, and open a PR:

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

Replace `YOUR_GITHUB_USER` with your GitHub username. The PR must include **both** the entry file and the regenerated `index.json`; running only `npm test` without `npm run build` fails validation when the index is stale.

## Security and release checklist

Installing a plugin means trusting its code:

- npm installs may run package lifecycle scripts;
- CLI, MCP, Dashboard, and Service code all run with the permissions of the system user running Botmux;
- in production, install only packages from trusted publishers, pin exact versions, and verify registry integrity;
- never pack tokens, cookies, private keys, browser profiles, logs, or user data into `dist/`;
- don't let `dist/` depend on repo source, the development directory, or undeclared global packages;
- Market registration is a discovery channel, not a substitute for code review.

Before publishing, confirm:

- [ ] `npm ci && npm test` passes;
- [ ] `dist/` is self-contained and runs without the source tree or `node_modules`;
- [ ] `npm pack --dry-run` contains no sensitive files;
- [ ] the manifest and every contribution entry pass validation;
- [ ] the Service export's `mode` matches the manifest; a fixed `port` is set if you use slash commands or card callbacks;
- [ ] both the local directory and the real tarball were installed and checked;
- [ ] after publishing, version, dist-tag, and integrity were verified;
- [ ] the Market entry passed `npm run build && npm test`, and the PR includes both the entry file and `index.json`.

## References

- [Botmux source](https://github.com/deepcoldy/botmux)
- [Official plugin template](https://github.com/botmux-ai/botmux-plugin-template)
- [Botmux Plugin Market](https://github.com/botmux-ai/plugin-market)
- [Agent Chrome plugin example](https://github.com/botmux-ai/botmux-plugin-agent-chrome): a complete example that packs MCP, Skill, and Service into one plugin with per-session isolation
- [npm: Creating and publishing scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
- [npm: Trusted publishing](https://docs.npmjs.com/trusted-publishers/)
