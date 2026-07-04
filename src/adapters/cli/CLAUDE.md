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
