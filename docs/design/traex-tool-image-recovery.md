# TRAE 工具图片失败恢复

## 问题与行为

TRAE CLI 的工具返回 input_image 后，图片上传可能失败。错误为 `failed to resolve image resource: tool image upload failed; retry the request`，终态携带 `codex_error_info: bad_request`。已保存的工具图片会随纯文字续聊再次进入请求，普通重发或同历史重启可能反复失败。

本次为该原生错误增加稳定错误码与显式「移除工具图片并续跑」动作。动作沿用现有清理图片恢复的权限、冷却、输入拒收回滚、CLI 退出证明、精确 resume 和 checkpoint 续跑流程。botmux 会话保持 active；仅该 CLI 进程在修复时重启。

由于错误不指出具体图片，确认动作移除该会话记录中的全部工具输出 input_image 块，替换为 input_text 占位。文本、工具调用/输出标识、用户输入图片、原图片文件、ordinal、batch 元数据均保留。原记录有完整备份。每条改写行以空格补齐原始字节数，后续 batch start 与 reader offset 不变。

仅处理当前 worker 持有的本地 TRAE 会话。共享/adopt、远端、headless、会话转移或正在工作的新轮不执行。文件名 UUID 和 session_meta.id 必须匹配；根目录独立于目标文件固定，目录内链接、畸形记录、不完整尾行、超预算文件、无法保持字节长度的改写都拒绝。

## 失败与并发

- CLI 未被证明完全退出：不改写、不续跑。
- 备份或临时文件写入失败：不替换原记录；保留已生成的备份。
- 读取后 inode/size/mtime/ctime 或路径变化：不替换更新后的记录。
- 修复失败、部分完成、替代 CLI 未能启动或被另一重启取代：不自动提交续跑输入，并退还点击租约。
- 点击旧轮卡片、已有新输入、无权限、无 live worker：不提交、不消耗冷却。

## 一般失败恢复

TRAE 的 Retry / Edit prompt / Continue 已实现，见 [失败输入恢复设计](traex-prompt-recovery.md)。只有证明未执行任何工作且原生记录检查通过时才回退最近失败请求；已执行或不确定的轮次继续检查现场。编辑保留原始身份与附件，允许移除本轮原图，点击提交前不发送。历史工具图片污染仍通过本页的独立修复动作处理。

## 验证证据

- macOS arm64，Bun 1.4.4：完整 build/typecheck 通过；原有 Claude/Codex transcript、失败卡、权限路由与本次修复定向回归通过。
- TRAE CLI 0.216.0：隔离 HOME 下构造合成 user/custom_tool_call/output 历史，修复后原生 `thread/resume` 接受；native thread ID 相同，保留 1 个历史轮次、总字节数不变。使用合成 provider 仅验证原生历史载入，没有模型请求；原 TRAE provider 的图片上传服务未在本次测试中修复或验证。
- 假时钟真实 worker 函数探针发现并修复两个阻断问题：退出等待期间 Stop 被 backend=null 分支吃掉，稍后仍发续跑；新输入在等待期间先入队，随后追加旧续跑。现在 held lease 在 Stop/新输入时一次性撤销，持久改写前和 replacement 初始化完成后再次核对；已杀掉的 CLI 仍恢复，但旧续跑不提交。
- 已覆盖停止/精确轮次中断、替代 CLI 初始化等待时停止/新输入、部分 backup/temp 写入、并发 append、重复恢复/close 交叠。移除 session identity、路径、字节长度、并发写入、退出证明、失败/替代 respawn 和新输入门禁等守卫，相关行为测试会失败。
- 卡片 PNG 由 Microsoft Edge 的独立临时 profile/headless 模式从候选文案与动作生成，仅为展示示意，非真实飞书客户端截图。
