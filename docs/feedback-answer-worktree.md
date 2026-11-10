# 反馈动作使用原答复 worktree

宿主管理者可为反馈 Hook 配置 `answerWorktree: {script, repositoryRoots}`。`script` 是仓内规范相对路径；`repositoryRoots` 指定允许执行的仓库根，沿 Git common-dir 核验同仓 worktree。解释器和其余参数继续来自原 `command`；执行时仅替换 `command[1]` 与 `cwd`，不新建 worktree 或 Agent。

启用后，模型在最终答复前通过现有 `botmux feedback bind --file binding.json` 注册：

```json
{
  "sourceMessageId": "om_question",
  "answerKind": "substantive",
  "routing": {
    "questionTypeId": 123,
    "regions": ["sg"],
    "reason": "原问题及相关追问的归属依据"
  }
}
```

人员名单和路径不在模型提交契约内。宿主验证调用方的会话、轮次、源群和话题；TraeX按精确native session读取实际cwd，其他本地会话使用daemon已登记目录。目录须是已注册worktree，不使用主checkout或已回收目录代替。

新反馈卡保存绑定版本1、实际worktree身份及routing。按钮从已持久卡片绑定读取这些信息，不信任按钮值中的路径。执行前重新验证授权仓库、目录inode、Git目录和脚本路径，读取实际commit/hash。脚本在原worktree更新时后续执行使用更新文件，但不会自动同步远端分支。

旧卡不新增绑定。将某Hook切为worktree模式后，旧卡动作保留状态并提示新问题；已成功任务和unknown回执不会重新执行。缺失binding的新卡不会退回固定脚本。

业务脚本自行消费routing和本地知识关系；宿主不实现业务关键词分类或排班查询。模型不得指定人名，业务脚本从其本地维护关系确定主值班、校验同应用身份并在原话题通知。共享状态目录保持原样，目录回收不会抹去回执。

代码合入与宿主安装/配置切换分开。已有宿主不会自动支持新字段；仅新机制启用后创建的反馈卡使用该执行路径，无历史迁移或重放。
