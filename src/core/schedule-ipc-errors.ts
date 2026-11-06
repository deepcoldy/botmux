/** Actionable CLI text for the schedule IPC refusals a sandboxed (capability-only)
 *  session can hit. Unknown codes fall through unchanged so existing callers keep
 *  their raw-code behavior. */
const SCHEDULE_IPC_ERROR_TEXT: Record<string, string> = {
  schedule_working_dir_forbidden:
    '沙盒会话只能把定时任务钉在当前工作目录（含其子目录）或本 bot 角色库 ~/botmux-roles/<appId>/ 子树内；'
    + '请改用这些目录下的 --workdir，或到宿主终端操作。',
  schedule_mutation_scope_forbidden:
    '沙盒会话只能管理本会话所在群、且工作目录在当前目录或本 bot 角色库内的定时任务；'
    + '请到任务所在的群里操作，或到宿主终端操作。',
  schedule_direct_task_limit:
    '本轮对话创建的定时任务已达上限（删除任务不会退回额度）；请在下一条消息里继续创建。',
  schedule_run_as_invalid: '--run-as 需要本 bot 应用下的 open_id（ou_ 开头）或飞书邮箱。',
  schedule_run_as_unresolved: '无法解析 --run-as 用户的 union_id；确认 open_id 属于本 bot 应用，或邮箱对本 bot 可见。',
  schedule_run_as_not_allowed: '--run-as 用户当前不能操作本 bot（不在允许名单内），定时任务未创建。',
};

export function scheduleIpcErrorMessage(code: string | undefined): string | undefined {
  return code ? SCHEDULE_IPC_ERROR_TEXT[code] : undefined;
}
