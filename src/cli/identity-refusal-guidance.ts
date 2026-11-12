import type { IdentityRefusalReason } from './current-execution.js';

/**
 * What a person (or their agent) reads when a managed tool refuses to run
 * because its per-turn identity could not be fetched. One stable first line
 * keeps the error code greppable; the next two name the failing step and the
 * one thing to do about it. Nothing here comes from the session or the daemon
 * beyond the reason enum: no paths, tokens or environment.
 *
 * Most of these are NOT authorization problems. Saying so explicitly is the
 * point: an undifferentiated refusal sent people through /login, enroll and
 * setup again while the cause was on the botmux side.
 */
const GUIDANCE: Record<IdentityRefusalReason, { cause: string; next: string }> = {
  invalid_request: {
    cause: 'daemon 拒收了取票请求（参数不完整）。',
    next: '发 /restart 重建会话后重试；仍失败请把这几行报错发给 Bot 管理员。',
  },
  peer_unresolved: {
    cause: 'daemon 无法从本机连接识别出发起命令的进程（/proc 不可读，或命令经由代理/隔离环境转发）。',
    next: '在会话 CLI 里直接运行该命令；仍失败请把这几行报错发给 Bot 管理员。不是授权问题，不用重新授权。',
  },
  lineage_unproven: {
    cause: 'daemon 没能证明这条命令属于会话当前正在执行的轮次（常见于后台任务或上一轮遗留进程里调用、轮次已结束、CLI 正在重启）。',
    next: '在当前轮次里由 CLI 直接执行。可先运行 `botmux execution current --json`：它也失败，说明当前没有可证明的轮次，重发一条消息再试。不是授权问题，不用重新授权。',
  },
  identity_decision_missing: {
    cause: 'daemon 没有收到本会话 worker 上报的身份模式，按安全默认拒绝取票（本命令属于当前轮次，这一步已通过）。',
    next: '稍等几秒重试；仍失败发 /restart 重启会话 CLI。不是授权问题，不用重新授权、enroll 或 setup。',
  },
  identity_decision_conflict: {
    cause: 'worker 上报的身份模式与会话结构不符（例如会话运行中改过 Bot 配置），daemon 暂停下发身份。',
    next: '发 /restart 让会话按当前配置重建；仍失败请 Bot 管理员查看 daemon 日志里的 [trigger-user-auth]。',
  },
  identity_model_single: {
    cause: '会话当前按单快照身份模式运行，与本包装脚本使用的进程证明模式不一致。',
    next: '发 /restart 让包装脚本与会话模式重新对齐。不是授权问题，不用重新授权。',
  },
  identity_material_unavailable: {
    cause: '已证明是当前轮次，但 daemon 没有这一轮的身份材料（尚未准备、已被回收，或 daemon 刚重启）。',
    next: '重发一条消息开启新轮次后重试；连续出现再发 /login status 查看授权状态。',
  },
  invalid_invocation: {
    cause: '包装脚本的参数不完整（会话、应用、端口或工具名缺失）。',
    next: '发 /restart 重建包装脚本。',
  },
  daemon_unreachable: {
    cause: '连不上 daemon 的本机取票接口（daemon 正在重启，或会话所在环境到不了本机回环地址）。',
    next: '稍等几秒重试；daemon 重启完成后仍失败，发 /restart 重启会话。',
  },
  daemon_timeout: {
    cause: '取票请求超时（daemon 正在等待平台凭据，或负载过高）。',
    next: '稍后重试；持续超时请 Bot 管理员查看 daemon 日志里的 [trigger-user-auth]。',
  },
  response_mismatch: {
    cause: 'daemon 返回的身份与本会话或本工具不匹配，按安全默认拒绝。',
    next: '重试一次；持续出现请联系 Bot 管理员（可能有另一个 daemon 占用了端口）。',
  },
  unspecified: {
    cause: 'daemon 拒绝了取票但没有说明原因（daemon 可能是较旧的版本）。',
    next: '先运行 `botmux execution current --json`：它失败说明当前没有可证明的轮次，重发一条消息再试；它成功则发 /restart 重启会话。',
  },
};

export function identityRefusalLines(tool: string, code: string, reason: IdentityRefusalReason): string[] {
  const guidance = GUIDANCE[reason] ?? GUIDANCE.unspecified;
  return [
    `botmux: ${code} [reason=${reason}]`,
    `botmux: ${tool} 未执行：${guidance.cause}`,
    `botmux: 下一步：${guidance.next}`,
  ];
}
