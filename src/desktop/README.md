# Botmux Desktop

正式版本会随 `v*` tag 在 GitHub Release 中提供 Apple Developer ID 签名并完成公证的 Universal DMG 和 ZIP，同时支持 Intel 与 Apple Silicon Mac。源码 checkout 仍可按下述方式进行本地 ad-hoc 构建和安装。

## 正式发布

`.github/workflows/release.yml` 在 macOS runner 上完成 Universal 构建、Developer ID 签名、Apple 公证和 stapling，再把 DMG/ZIP 作为附件加入同一个 GitHub Release。签名 job 只接受 `deepcoldy` 发起或重新运行，并且必须通过受保护的 `macos-signing` Environment 审批。以下凭据配置为该 Environment 的 Secrets，不应配置成仓库级 Secrets：

其他 contributor 从分支推送 canary、beta、rc 或其它 prerelease tag 时，仍会发布对应的 npm dist-tag 和 GitHub prerelease，但签名 job 会被跳过，因此不会读取签名凭据，也不会生成 macOS 附件。正式版缺少成功的签名产物时会直接拒绝发布。

需要为已有版本重新生成桌面附件时，可以手动运行 `Release` workflow 并填写 `release_tag`。该模式只覆盖对应 Release 的 macOS 附件并校验上传内容，不会再次发布 npm、修改 tag 或改写 Release 正文。

- `MAC_CSC_LINK`
- `MAC_CSC_KEY_PASSWORD`
- `APPLE_API_KEY_P8`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

## 要求

- macOS
- Node.js 22 或更高版本
- pnpm
- 已下载本仓库源码

如果没有 pnpm，可以先执行：

```bash
corepack enable
```

## 安装

在仓库根目录执行：

```bash
bash src/desktop/install-local.sh
```

脚本会执行这些步骤：

1. 安装依赖（如 `node_modules` 缺失）。
2. 构建 botmux runtime 与 Desktop bundle。
3. 下载并校验用于 Universal App 的官方 Node arm64/x64 runtime（后续构建复用本机缓存）。
4. 解析源码版本号，并使用 electron-builder 生成本机 `Botmux.app`。
5. 退出正在运行的 Botmux App。
6. 安装到 `/Applications/Botmux.app`。
7. 使用本机 ad-hoc 签名并移除 quarantine。
8. 默认打开 App。

脚本只安装 App，不会安装、升级、link 或修改用户机器上的全局 `botmux` CLI。App 自带版本匹配的 Node、botmux 和 PM2，不依赖用户的 PATH、fnm、nvm 或 Homebrew Node。

App 与命令行继续共用 `~/.botmux` 中的机器人配置、会话、日志和专用 PM2_HOME。启动时若检测到全局 CLI 留下的 botmux fleet，会先优雅停止旧 core 进程，再使用内置 runtime 重建；不会删除用户配置，也不会操作默认 `~/.pm2` 中的无关应用。

常用参数：

```bash
bash src/desktop/install-local.sh --no-open
bash src/desktop/install-local.sh --skip-build
bash src/desktop/install-local.sh --skip-deps
bash src/desktop/install-local.sh --app-path /Applications/Botmux.app
```

`--skip-build` 适合已经运行过 `pnpm desktop:bundle && pnpm exec electron-builder --mac dir --config electron-builder.yml -c.extraMetadata.version=<version>` 的开发场景。

如果源码不是 git checkout，脚本无法通过 tag 推导版本号，可以显式传入：

```bash
BOTMUX_DESKTOP_VERSION=2.103.0 bash src/desktop/install-local.sh
```

## 更新

拉取最新源码后重新执行：

```bash
git pull
bash src/desktop/install-local.sh
```

这个脚本只更新 App 本体和 App 内置 runtime，不会变更全局 CLI。Desktop 运行期间由内置 runtime 管理 daemon；终端里单独安装的 CLI 不作为 App 的运行依赖。

## 验证

安装后可以运行：

```bash
pnpm desktop:smoke --skip-dashboard
```

如果已经用当前源码启动了 botmux runtime，也可以运行完整检查：

```bash
pnpm desktop:smoke
```

## 说明

这个安装方式只适合本机体验和开发。它不会产出可给别人直接安装的公证包；其他用户也需要下载源码并在自己的机器上执行安装脚本。
