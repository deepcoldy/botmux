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
  schedule_child_one_shot_disabled:
    '当前宿主未开启“定时任务创建一次性子任务”；请由管理员在 Dashboard 实验性设置中开启。定时任务未创建。',
  schedule_child_one_shot_parent_ineligible:
    '当前定时轮缺少可复核的真人控制人，或控制人已失去管理员/群成员资格；定时任务未创建。',
  schedule_child_one_shot_descendant_denied:
    '一次性子任务不能继续创建孙任务；定时任务未创建。',
  schedule_child_one_shot_scope_invalid:
    '定时子任务只能使用当前 Bot、当前群、当前话题和完全相同的工作目录；不支持跨群、顶层、新话题、跟随话题、日历或 until-done。定时任务未创建。',
  schedule_child_one_shot_requires_once:
    '定时子任务只接受未来一次性时间，不接受 cron 或 interval。定时任务未创建。',
  schedule_child_one_shot_in_past:
    '定时子任务的执行时间已经过去；请换一个将来的时间。定时任务未创建。',
  schedule_child_one_shot_horizon_exceeded:
    '定时子任务超出宿主允许的最远时间窗；请缩短延迟，或由管理员调整 childOneShotMaxDelayMinutes。定时任务未创建。',
  schedule_child_one_shot_identity_isolation_required:
    '当前 Bot 未启用完整的 triggerUserAuth 身份隔离，无法保证子任务不继承旧会话凭据；定时任务未创建。',
  schedule_child_one_shot_authority_changed:
    '创建期间父任务的授权发生变化；本次没有创建任务，请重新执行。',
  schedule_child_one_shot_task_limit:
    '当前定时轮创建的一次性子任务已达上限（删除任务不会退回额度）；定时任务未创建。',
  schedule_run_in_flight: '任务这次执行还没结束，频率暂时不能改；等这次执行完再改。未执行任何修改。',
  schedule_in_past: '新的一次性执行时间已经过去；请换一个将来的时间。未执行任何修改。',
  delegated_schedule_reauthorization_required: '这是委托创建的任务，修改需要重新授权；未执行任何修改。',
  calendar_once_unsupported:
    '绑定了工作日历的任务不能改成一次性执行；请改用循环频率，或同时加 --calendar none 解绑日历。未执行任何修改。',
  schedule_precondition_update_failed:
    '保存修改时出错，已全部回滚，未执行任何修改；请稍后重试，仍失败请查看 daemon 日志。',
  schedule_run_as_invalid: '--run-as 需要本 bot 应用下的 open_id（ou_ 开头）或飞书邮箱。',
  schedule_run_as_unresolved: '无法解析 --run-as 用户的 union_id；确认 open_id 属于本 bot 应用，或邮箱对本 bot 可见。',
  schedule_run_as_not_allowed: '--run-as 用户当前不能操作本 bot（不在允许名单内），定时任务未创建。',
  silent_message_listener:
    '来源群已设置静默执行，不能把定时任务投到来源群；任务需要定时发往其他群时请显式指定 --chat-id。定时任务未创建。',
};

export function scheduleIpcErrorMessage(code: string | undefined): string | undefined {
  return code ? SCHEDULE_IPC_ERROR_TEXT[code] : undefined;
}
