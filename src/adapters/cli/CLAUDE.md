# CLI 适配器

每种 CLI 一个文件，实现 `types.ts` 里的 `CliAdapter` 接口。

## 添加新 CLI 适配器

1. 本目录下创建新文件，实现 `CliAdapter` 接口
2. `types.ts` 的 `CliId` 联合类型中添加新 ID
3. `registry.ts` 添加 import、switch case、export
4. `src/worker.ts` 的 `CLI_DISPLAY_NAMES` 添加显示名
5. `src/im/lark/card-builder.ts` 的 `cliDisplayNames` 添加显示名
6. `src/setup/bot-config-editor.ts` 的 `CLI_ID_CHOICES`（序号映射，**新 CLI 一律追加到尾部**——历史序号是脚本化 setup 的稳定接口，插位会让老脚本静默选错）+ `CLI_DISPLAY_LABELS`（dashboard 添加机器人下拉的展示名，缺了会回退显示 id）。setup 级联菜单、dashboard 下拉与 sessions 页 CLI 过滤器均从 `CLI_OPTIONS` 派生，自动跟随，无需另改
7. `README.md`、`README.en.md` 更新 CLI 列表

## 文件沙盒（`sandbox: true`）适配三项必查

新 CLI 若要支持文件沙盒，务必逐项核对（经验来自 #356/#357…，即 codex/opencode/mtr/traex/coco 的踩坑）。沙盒把 `$HOME` 挂成 overlayfs（lower=真实 home，写入隔离到 upper），`authPaths` 列出的路径则以真实可写 `--bind` 绕开 overlay：

1. **CLI 是否在 `$HOME` 下放 SQLite/DB？** overlayfs（内核 + fuse）不支持 SQLite 需要的 POSIX fcntl 字节范围锁，CLI 会连接池超时（~57s）后 exit 1 起不来。→ 把整个状态目录（而非单个 `auth.json`）加进 `authPaths`。
2. **daemon 的 transcript bridge 是否按真实路径读该 CLI 的会话/事件文件？** 窄 carve-out 下 CLI 写进 overlay upper，bridge 在真实路径读不到 → 回复桥断链。claude 系有 `sandboxedClaudeDataDir` 的 homeUpper 重定向兜底，其它 CLI 没有。→ 让 bridge 读的目录也真实 `--bind`（如 coco 的 `~/.cache/coco`）。
3. **`authPaths` 是目录级还是单文件？** 单文件 carve-out 在该文件尚不存在时会被整段跳过（沙盒内首次登录写进 upper、随沙盒销毁丢失），也覆盖不到同目录的 sibling 状态。→ 优先目录级 bind。

验证手段：用 `prepareSandbox` 生成真实 bwrap argv + `node-pty` 拉起真 CLI 跑 ≥90s，观察是否崩、并核对写入是否落到真实目录（见 `test/sandbox.test.ts` 的 symlink 回归用例）。
