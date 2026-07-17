# 角色目录 CLAUDE.md 模板

> 复制到 `<角色目录>/CLAUDE.md`，替换「人设」段。角色**目录名是 ASCII slug**（如 `pm`），
> 中文名写在同目录 `.botmux-dir.json` 的 `name` 字段（记忆桶按路径 slug 分桶，中文目录名会撞桶）。
> **同时把角色库根的 `_role-protocol.md` 复制一份进该角色目录**——协议必须是角色目录内的
> 本地文件，`@import` 才不会被 Claude Code 判为「外部 include」而弹出交互式批准框
> （botmux 只自动种 `hasTrustDialogAccepted`，不种 `hasClaudeMdExternalIncludesApproved`）。

```markdown
# 角色：<角色名>

<人设：角色定位 / 语气 / 专长 / 边界。新建角色流程由模型按用户一句话描述起草。
默认角色「默认助理」此段仅一行：你是通用助理，未设定特定角色人设。>

@_role-protocol.md
@knowledge/INDEX.md
```

说明：`@import` 使 协议 + 知识索引 随每个新会话机制性加载；三个引用（协议、知识索引）
均为角色目录内的相对路径，不触发外部 include 批准框；`knowledge/INDEX.md` 不存在时
import 静默失败不影响会话（首次沉淀会创建）。

协议更新后需同步到各角色目录：`for d in <ROLES_ROOT>/{shared,users/*}/*/; do cp <ROLES_ROOT>/_role-protocol.md "$d"; done`
