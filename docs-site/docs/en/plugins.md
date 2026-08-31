# Plugin Development and Market Registration

A Botmux Plugin uses one publishable npm package to deliver Skills, MCP, CLI
commands, a Dashboard page, and a Host Service. This guide is for plugin authors
and operators. It covers the complete path from project creation and package
validation to npm publishing and Plugin Market registration.

> Current boundary: the Plugin Market is a separate discovery index. Publishing
> a package to npm does **not** register it in the market, and the current
> stable Botmux release does not read that index during installation. The full
> npm package name is always the most reliable installation entry point.

## How Botmux loads a Plugin

The root `package.json` is the development, validation, and npm publishing
envelope. Botmux reads its manifest during installation, then keeps only the
package's `dist/` directory as the runtime unit. Contributions are discovered at
fixed paths:

| Capability | Source | Installed entry |
| --- | --- | --- |
| Skill | `skills/<name>/SKILL.md` | `dist/skills/<name>/SKILL.md` |
| MCP | `src/mcp/` | `dist/mcp/index.json` |
| CLI command | `src/cli/` | `dist/cli/{index.js,commands.json}` |
| Dashboard | `src/dashboard/` | `dist/dashboard/index.js` |
| Host Service | `src/service/` | `dist/service/index.js` |

There is currently no general worker/daemon hook contribution. Put long-running
processes in a Host Service, Agent tools in MCP or a Skill, and operational
entry points in CLI commands.

Installation and enablement are separate operations:

1. `plugin install` downloads the package, validates its manifest, discovers
   contributions, and stores `dist/`.
2. `plugin enable` binds the plugin as a machine default or to selected Bots and
   prepares Skill/MCP snapshots for future sessions.

Botmux does not intentionally invoke the plugin's CLI, Dashboard, MCP, or
Service entry during installation. However, an npm installation **may run npm
lifecycle scripts**. Installing a third-party plugin still means trusting its
publisher.

## Create a project

Plugin **development** requires Node.js 22 or newer with `npm` on your `PATH` —
the generator shells out to npm to scaffold, install, and test the project. (This
is a requirement of plugin development specifically; botmux itself is a
self-contained binary and needs no Node — see [Quickstart](/en/quickstart).)

Install botmux by whichever route you prefer, then run the generator:

```bash
curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | sh
# or, if you'd rather install through npm: npm install -g botmux@latest

botmux plugin init my-plugin
cd botmux-plugin-my-plugin
```

The generator creates a project from the official template, including:

- npm package name `@botmux-ai/plugin-my-plugin`;
- Plugin ID `my-plugin`;
- `my-plugin:` CLI command prefix;
- examples for all five contribution types;
- completed `npm install` and `npm test` runs, plus a best-effort `git init`.

`@botmux-ai` is the official npm organization. Third-party authors without
publishing access to that scope must change `package.json.name` to a package
they control:

```json
{
  "name": "@your-org/plugin-my-plugin"
}
```

The Plugin ID can remain `my-plugin`. Users must install a third-party package
by its full npm package name.

## `package.json` and the manifest

This complete example includes a plugin dependency and a Service:

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

The installer validates that:

- `version` is valid SemVer;
- `keywords` contains `botmux-plugin`;
- `botmux.id` matches `^[a-z][a-z0-9._-]{0,63}$`;
- the package contains a `dist/` directory;
- `service.mode` is either `manual` or `auto`;
- every declared contribution has a valid fixed entry.

Restrict `files` to `dist/` and inspect `npm pack --dry-run` before publishing.
npm may still include root files such as `package.json`, README, and LICENSE
automatically, so those files must not contain secrets either.

`botmux.dependencies.plugins` contains Plugin IDs only; version ranges are not
supported. Before the current plugin can be enabled, every dependency must be
installed and enabled in the same machine-default or Bot scope. Botmux also
refuses to disable or uninstall a plugin while another enabled plugin depends on
it.

## Develop contribution types

### CLI commands

`src/cli/index.js` default-exports a handler map. The official template emits
both `dist/cli/index.js` and the command index during the build:

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

Command names must match `^[a-z][a-z0-9._:-]{0,63}$`. Botmux does not add a
namespace automatically. If two enabled plugins expose the same command name,
execution fails with a conflict, so use a consistent `<plugin-id>:` prefix.

A handler can read:

- `pluginId`, `pluginDir`, `packageName`, `version`, `manifest`, and `args`;
- `api.logger`;
- `api.resolve(relativePath)`;
- `api.config.get/set/replace`;
- `api.settingsPath`.

Private plugin configuration lives under `~/.botmux/plugins/<id>/` and is
readable and writable by the current system user.

### Skill

The source entry for each Skill is:

```text
skills/<skill-name>/SKILL.md
```

After the build it must be present at:

```text
dist/skills/<skill-name>/SKILL.md
```

Running Agents do not hot-load new Skills after a plugin is enabled or updated.
Start a new session so Botmux can regenerate the Plugin/Skill snapshot for the
new CLI process.

### MCP

Each plugin can currently contribute at most one MCP server. The built
`dist/mcp/index.json` supports two transports.

stdio:

```json
{
  "transport": "stdio",
  "command": ["node", "./mcp/server.js"],
  "env": {}
}
```

Streamable HTTP:

```json
{
  "transport": "streamable-http",
  "url": "https://example.com/mcp",
  "headers": {}
}
```

Constraints and caveats:

- only `stdio` and `streamable-http` are supported;
- the MCP name is the Plugin ID; do not add a separate `name`;
- `./...` paths are relative to the installed `dist/`;
- `${VAR}` string templates are not supported in this configuration;
- bundle local MCP runtime dependencies into `dist/` rather than relying on the
  development `node_modules`;
- never put real tokens, cookies, or secrets in the package; runtime code should
  read them from a controlled environment or private plugin configuration.

Botmux aggregates the enabled MCP servers for a session through one MCP Gateway.
The plugin set and credential snapshot are fixed for the lifetime of a CLI
process, so create a new session after changing bindings or configuration.

#### Trusted caller identity injection

When a turn is triggered by a real IM user, the Gateway injects a
**host-stamped, model-unforgeable** caller identity into forwarded `tools/call`
requests, for plugins that need per-user authorization or auditing. The
contract:

- The identity appears in two places: `_meta.botmuxTrustedCaller` on the MCP
  request (injected for both `stdio` and `streamable-http`), and, for
  `streamable-http`, the `x-botmux-trusted-open-id` / `x-botmux-trusted-union-id`
  / `x-botmux-trusted-app-id` request headers (plus `x-botmux-turn-id` /
  `x-botmux-dispatch-attempt`). The fields inside `botmuxTrustedCaller` are
  `requestUserOpenId` / `requestUserUnionId` / `requestLarkAppId`.
- **Trust only these `botmux`-namespaced keys.** Before injecting, the Gateway
  **unconditionally strips** any client- (model-) supplied `_meta` key that
  starts with `botmux`, and any inbound `x-botmux-trusted-*` header — whether or
  not a host identity exists for the turn. A model therefore cannot impersonate
  anyone by putting `_meta.botmuxTrustedCaller` in the tool arguments.
- Conversely, do **not** read bare keys (an un-namespaced `requestUserUnionId`,
  a custom `trustedCaller`, etc.) as an identity source: those are outside the
  strip set and can be freely set by the model.
- Not every turn has a trusted identity: system/recovery turns, and turns whose
  sender has no `open_id`/`union_id`, inject nothing. Plugins must **fail closed**
  when `botmuxTrustedCaller` is absent (refuse the identity-bound operation)
  rather than falling back to any model-reported value.
- The identity lives only in the host worker's process memory, set per turn, and
  is never written to a file; do not surface it (or the transport token) to users
  or logs.

Background and design (Feishu docs): [Botmux Plugin Development and Market
Registration Guide](https://bytedance.larkoffice.com/docx/FE2mdNdSgoFMVuxWTS7ctqO6nFb)
and the [Agent Chrome Plugin Guide](https://bytedance.larkoffice.com/docx/RJPfdn0oHoC5zgxVXH1cKMjFnqc)
(the latter is a full worked example of packaging MCP + Skill + Service into a
`@botmux-ai/plugin-*` with per-session isolation).

### Dashboard

`src/dashboard/index.js` default-exports a component:

```js
export default function PluginDashboard({ pluginId, api }) {
  return `Dashboard loaded for ${pluginId}`;
}
```

The fixed route is `#/plugins/<plugin-id>`. The current Dashboard Plugin API
provides:

- `getServiceStatus()`;
- `startService()`;
- `stopService()`;
- `restartService()`.

Dashboard code runs inside the authority boundary of the user who installed
Botmux. Do not render sensitive configuration into the page or browser logs.

### Host Service

A Service requires both:

- `package.json#botmux.service.mode`;
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

`host` is already safe to interpolate into a URL, including brackets for an IPv6
literal. If the Service export includes `mode`, it must match the manifest:

- `manual`: starts only after an explicit `plugin service start`;
- `auto`: `botmux start` and `botmux restart` ensure the Service is online.

A normal `botmux stop` leaves plugin Services running.
`botmux stop --with-plugin` also stops auto Services.

## Local build and acceptance

Development mode:

```bash
npm install
npm test

botmux plugin install . --link
botmux plugin enable my-plugin
botmux my-plugin:hello
```

`--link` is for local-directory development only. It links the installed runtime
directory to the project's current `dist/`. Source edits still require another
build. After adding or removing a contribution entry, reinstall the plugin so
Botmux rescans it.

Build the real release tarball:

```bash
npm ci
npm test
npm pack --dry-run
npm pack
```

Then test the tarball itself:

```bash
botmux plugin install "file:/absolute/path/plugin-package.tgz"
botmux plugin enable my-plugin
botmux plugin service start my-plugin
botmux plugin service status
```

Omit the Service commands for a plugin without a Service. The important
acceptance criterion is not merely that the repository works, but that the
extracted `dist/` remains functional without source files or the development
`node_modules`.

## Installation, enablement, and Service lifecycle

Install from npm:

```bash
# Third-party package: use the full name and pin an exact version
botmux plugin install @your-org/plugin-my-plugin@1.2.3

# Official short ID: expands to @botmux-ai/plugin-my-plugin
botmux plugin install my-plugin
```

Enablement scopes:

```bash
# Machine default, effective for every Bot
botmux plugin enable my-plugin

# One Bot, or every currently configured Bot explicitly
botmux plugin enable my-plugin --bot <name|index|all>

botmux plugin disable my-plugin
botmux plugin disable my-plugin --bot <name|index|all>
```

Without `--bot`, the machine default is used; `--global` is neither needed nor
accepted. If the plugin is already enabled as a machine default, disable that
default before configuring individual Bots. Start a new Agent session after
enabling or updating a plugin.

Service management:

```bash
botmux plugin service status
botmux plugin service start my-plugin
botmux plugin service stop my-plugin
botmux plugin service restart my-plugin
```

Updating currently means installing the new version again. Stop an existing
Service first:

```bash
botmux plugin service stop my-plugin
botmux plugin install @your-org/plugin-my-plugin@1.2.4
botmux plugin enable my-plugin
botmux plugin service start my-plugin
```

Botmux never stops a running Service implicitly during install, update, or
uninstall.

Uninstall:

```bash
botmux plugin service stop my-plugin
botmux plugin uninstall my-plugin
```

Uninstall removes plugin bindings and `~/.botmux/plugins/<id>/`, which can
include private plugin configuration. Back it up first when needed. Although
current help text lists `--force`, the implementation does not use it to bypass
dependency or Service lifecycle guards.

## Publish to npm

Before publishing, add repository metadata and confirm that the package name
belongs to an npm scope you control:

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

Check the npm login:

```bash
npm whoami --registry=https://registry.npmjs.org/
```

For an existing package, you can also verify its owners. Skip this before the
first publication because the package does not exist yet and the command will
return 404:

```bash
npm owner ls @your-org/plugin-my-plugin \
  --registry=https://registry.npmjs.org/
```

Publish a public scoped package:

```bash
npm publish --access public --registry=https://registry.npmjs.org/
```

Publishing must satisfy the account and package 2FA policy or use explicitly
authorized automation credentials. Prefer npm Trusted Publishing/OIDC for
long-lived CI instead of storing a long-lived write token.

If the account uses a security key or Passkey but an older npm CLI only asks for
an OTP, use the current npm CLI in an interactive terminal:

```bash
npx --yes npm@latest publish \
  --access public \
  --registry=https://registry.npmjs.org/
```

The CLI prints a WebAuthn page URL where the security-key challenge can be
completed.

Verify the published package:

```bash
npm view @your-org/plugin-my-plugin@1.2.3 \
  version dist.tarball dist.shasum dist.integrity \
  --json \
  --registry=https://registry.npmjs.org/

npm view @your-org/plugin-my-plugin dist-tags \
  --json \
  --registry=https://registry.npmjs.org/
```

An npm version cannot be overwritten. Every fix requires a new version.

## Register in the Plugin Market

### npm and the Market are separate paths

The Botmux Plugin Market is a standalone static repository:

```text
https://github.com/botmux-ai/plugin-market
```

It stores discovery metadata only. It neither hosts plugin code nor establishes
a security trust boundary. Make sure the npm package is publicly readable before
opening the Market PR.

External contributors should fork the Market repository. This GitHub CLI command
clones the contributor's fork and retains the official repository as upstream:

```bash
gh repo fork botmux-ai/plugin-market --clone
cd plugin-market
git switch -c register-my-plugin
```

Maintainers with write access to `botmux-ai/plugin-market` may clone the
upstream repository directly instead.

Add `plugins/my-plugin.json`:

```json
{
  "id": "my-plugin",
  "package": "@your-org/plugin-my-plugin",
  "displayName": "My Plugin",
  "description": "One sentence describing the problem this plugin solves.",
  "repo": "https://github.com/your-org/botmux-plugin-my-plugin",
  "docs": "https://github.com/your-org/botmux-plugin-my-plugin#readme",
  "categories": ["mcp", "productivity"],
  "compatibility": {
    "botmux": ">=3.8.0"
  }
}
```

Required fields:

- `id`;
- `package`;
- `displayName`;
- `description`;
- `repo`;
- `categories`;
- `compatibility.botmux`.

`docs` is optional. `repo` and `docs` must be HTTPS URLs. Category values must
match `^[a-z][a-z0-9-]{0,31}$` and must be unique. A package in the official
scope must be named exactly `@botmux-ai/plugin-<id>`.

The `>=3.8.0` value in the example is only a placeholder. Set the minimum
version from the Botmux APIs the plugin actually uses and the compatibility
tests you have run.

Generate the aggregate index and validate it:

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

Replace `YOUR_GITHUB_USER` with the GitHub account that owns the fork.

Commit both the source entry and the regenerated `index.json`. The abbreviated
Market README flow mentions only `npm test`, but validation rejects a stale
index and instructs the author to run `npm run build` first.

### Current CLI boundary

As of stable `botmux@3.8.0`, with current `master` behaving the same way:

- `botmux plugin search`, `info`, `register`, and `publish` are not implemented;
- `botmux plugin install <short-id>` does not read the Market index; it expands
  by convention to `@botmux-ai/plugin-<short-id>`;
- even after a third-party plugin is registered in the Market, it must currently
  be installed by its full npm package name;
- `compatibility.botmux` is currently Market metadata; the installer does not
  enforce its SemVer range.

The available verbs are `list`, `init`, `install`, `uninstall`, `enable`,
`disable`, `emit`, and `service`. `emit` is a legacy Codex Notifier
compatibility entry, not a general Plugin event or daemon-hook contribution.
Treat `botmux plugin --help` as the final source of truth.

## Security and release checklist

Installing a plugin means trusting its code:

- npm installation may run package lifecycle scripts;
- CLI, MCP, Dashboard, and Service code all run with the authority of the system
  user who installed Botmux;
- in production, install only trusted publishers, pin an exact version, and
  verify registry integrity;
- never package tokens, cookies, private keys, browser profiles, logs, or user
  data in `dist/`;
- do not make `dist/` depend on repository source, the development directory, or
  undeclared global packages;
- inspect the complete `npm pack --dry-run` file list;
- enable dependency auditing, code review, branch protection, and Trusted
  Publishing;
- Market registration is discovery, not a substitute for code review.

Final acceptance:

- [ ] `npm ci && npm test` passes;
- [ ] `dist/` is self-contained and works without source files or
      `node_modules`;
- [ ] `npm pack --dry-run` contains no sensitive files;
- [ ] manifest, CLI command, MCP, and Service entries pass validation;
- [ ] Service mode matches between the manifest and the exported definition;
- [ ] both local-directory and real-tarball installation have been tested;
- [ ] the npm version, dist-tag, and integrity have been verified after
      publication;
- [ ] the Market entry passes `npm run build && npm test`;
- [ ] the Market PR contains both the entry file and `index.json`.

## References

- [Botmux source](https://github.com/deepcoldy/botmux)
- [Official Plugin template](https://github.com/botmux-ai/botmux-plugin-template)
- [Botmux Plugin Market](https://github.com/botmux-ai/plugin-market)
- [Agent Chrome Plugin example](https://github.com/botmux-ai/botmux-plugin-agent-chrome)
- [npm: creating and publishing scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
- [npm: Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
