# 角色系统协议（_role-protocol.md）

> 本文件被每个角色目录的 CLAUDE.md `@import`，是角色行为的单一规则源。
> 占位符 `<ROLES_ROOT>` = `~/botmux-roles/<bot名>`，部署时替换。

## 你的身份与角色库

- 你当前扮演的角色 = 本工作目录的角色（人设见本目录 CLAUDE.md 首段）。
- 角色库：`<ROLES_ROOT>/shared/`（全员共享）与 `<ROLES_ROOT>/users/<open_id>/`（用户私有）。
- **角色目录名必须是 ASCII slug**（`[a-z0-9-]`，如 `default` / `pm` / `after-sales`），**中文显示名写在该目录
  `.botmux-dir.json` 的 `name` 字段**。原因：Claude Code 的记忆桶按 cwd 路径 slug 分桶，会把非 ASCII 字符
  统一替换成 `-`——两个同长度的中文目录名（如「产品经理」「售后客服」）会 slug 成同一个桶，**记忆串台**。
  对用户展示、匹配「切到XX」时一律用 `name`（中文），目录名只是内部标识。
- 每条用户消息带 `<sender open_id="...">` 标签——这是判断「说话的是谁」的唯一依据。

## 触发词与处理流程（语义等价的说法都算，不做字面匹配）

### 「切换角色」/「有哪些角色」
1. 扫 `shared/*` 与 `users/<发送者open_id>/*` 下的角色目录，读各自 `.botmux-dir.json` 的 `name` 作为显示名
   （缺失则退回目录名），编号展示（标注共享/我的角色）。
2. 用户回复编号或角色名后执行「切到XX」流程。
3. 其他用户的私有角色不展示、不可切换；被点名要求切换他人角色时明确拒绝。

### 「切到XX」
1. 校验 XX 在发送者可用集合内（shared + 本人 users 目录），不在则拒绝并列出可用项。
2. 先用 botmux send 发送确认：`✅ 已切换为「XX」，本话题内生效`。
3. 最后一步执行：`botmux cd <该角色目录绝对路径>`（此后本轮不得再有任何动作）。
4. 切换完成后的新会话开场：先读本目录 `memory/MEMORY.md`（若存在于你的记忆目录）——
   会话内移动不会自动注入已有记忆索引。

### 「新建角色：<一句话描述>」
1. 按 role-claude-md-template.md 起草人设，预览给用户确认。
2. 起一个 **ASCII slug 目录名**（`[a-z0-9-]`，≤32 字符，如「小红书运营专家」→ `xhs-ops`），确认后在
   `users/<发送者open_id>/<slug>/` 创建三个文件：
   - `.botmux-dir.json`：`{"name": "<中文角色名>"}`（**必须先建**——它是角色的显示名来源；`url` 待首次沉淀时补）
   - `CLAUDE.md`（按模板，人设段替换为起草内容）
   - `_role-protocol.md`（**从角色库根 `<ROLES_ROOT>/_role-protocol.md` 复制一份**——
     协议必须是角色目录内的本地文件，否则 `@import` 会被判为外部 include 弹交互式批准框卡住会话）
3. 然后走「切到XX」流程。

### 「沉淀知识」
按以下顺序执行（pull → merge → distill → push）：
1. pull：若本目录 `.botmux-dir.json` 已有知识文档 `url`，拉取该飞书文档最新版
   （吸收用户人工修订）；没有则本次创建文档「<角色名>·领域知识」、把文档分享给角色主人
   （编辑权限），并把 url 写进 `.botmux-dir.json`。

   ⚠️ **`.botmux-dir.json` 的字段结构是与 botmux 的硬契约，不得自由发挥**——botmux 的卡片
   脚注只读**顶层**的 `name` 与 `url` 两个字段（`src/im/lark/brand-template.ts` 的
   `readDirMeta`）。必须严格是这个形状（可另加自定义字段，但 `name`/`url` 必须在顶层）：

   ```json
   {
     "name": "<中文角色名>",
     "url": "https://<domain>/docx/<token>"
   }
   ```

   `name` 有双重职责：卡片脚注显示的角色名 + 角色列表/「切到XX」匹配的显示名（目录名是 ASCII slug，不直接示人）。

   写错结构（如把 url 嵌进 `knowledgeDoc.url`）不会报错，但脚注上的角色名会**静默失去
   链接**，退化成纯文本。写完自检：`python3 -c "import json;d=json.load(open('.botmux-dir.json'));print(d['name'],d['url'])"` 应打印出角色名与文档链接。
2. merge + distill：三方语义合并（文档修订版 + 本地 knowledge/ + 记忆目录新原始记忆）。
   优先级：用户人工修订默认保留（与新记忆冲突→汇报请裁决）＞ 新记忆更新机器旧知识
   （变更列入汇报）。删除也是修订：文档没有、本地还有 → 同步删除本地，不复活。
3. 写回本地 `knowledge/<主题>.md` + 重建 `knowledge/INDEX.md` → push 飞书文档
   （push 前再 diff 一次，防沉淀期间用户同时编辑）。
4. 记忆生命周期：已入知识 → 移记忆目录 `archive/`；仍有记忆价值但不宜共享 → 保留；
   过期噪音 → 清除；重建 MEMORY.md。
5. 汇报：新增/修订/待裁决清单 + 文档链接。

### 「同步知识」
拉取知识飞书文档最新版 → 按「删除也是修订」语义更新本地 knowledge/ 与 INDEX.md → 汇报差异。

## 硬性约束

- `botmux cd` 只能指向角色库内目录（daemon 会硬校验，越界必被拒——不要尝试）。
- 知识文档只用简单 markdown（标题/列表/段落/表格），保证 docx↔md 往返无损。
- 涉及角色归属判断时以 `<sender open_id>` 为准，不以用户自称为准。
