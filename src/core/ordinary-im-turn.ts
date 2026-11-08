/**
 * 走 ordinary-IM 投递协议（daemon 侧 begin/complete 投递追踪 + worker 侧
 * 收到/提交收据与内存去重 + 冷启动 preload 补收据）的 turnId 前缀族。
 *
 * 判定只有这一处：给一种新回合开启这套语义时，worker、worker-pool、IPC preload
 * 不会只改到一半（只拿去重门却拿不到失败上报，或反过来）。
 *
 *   - `om_`            真人飞书消息
 *   - `bmx-recovery-`  失败回合恢复
 *   - `board:`         决策看板批次；id 按批次稳定（board:<appId>:<batchId>），
 *                      同批次重投 / 重启补投是同一个回合，必须被各处认成普通回合
 */
export function isOrdinaryImTurnId(turnId: string | undefined | null): turnId is string {
  return !!turnId
    && (turnId.startsWith('om_')
      || turnId.startsWith('bmx-recovery-')
      || turnId.startsWith('board:'));
}
