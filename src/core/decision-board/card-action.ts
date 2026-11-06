/**
 * 拍板卡片的回调入口（card-action-routes.ts 的 `board_card_` 前缀路由）：把飞书回调转成
 * {@link DecisionBoardService.cardClick}，再把结果整形成卡片回调的应答（toast / 换卡 / afterAck）。
 *
 * 看板服务每个 daemon 一份（一个 bot 一个 daemon），启动时由 daemon 登记进来；没登记（非管家
 * 进程、测试）时一律回「卡片已失效」。操作人身份只取飞书事件里的 operator，不信 value。
 */
import type { CardActionData } from '../../im/lark/card-handler.js';
import { logger } from '../../utils/logger.js';
import type { DecisionBoardService } from './service.js';

let service: DecisionBoardService | undefined;

export function setDecisionCardService(next: DecisionBoardService | undefined): void {
  service = next;
}

export async function handleDecisionCardAction(data: CardActionData, larkAppId: string): Promise<any> {
  const value = (data.action?.value ?? {}) as Record<string, unknown>;
  if (!service || value.app !== larkAppId) {
    return { toast: { type: 'warning', content: '这张卡片已失效，去看板上处理' } };
  }
  let res: ReturnType<DecisionBoardService['cardClick']>;
  try {
    res = service.cardClick({
      operatorOpenId: data.operator?.open_id,
      operatorUnionId: data.operator?.union_id,
      value,
      formValue: data.action?.form_value,
      messageId: data.context?.open_message_id ?? data.open_message_id,
    });
  } catch (error) {
    // 不让异常落到分发层（那里只会回一个空应答，点了像没反应）：给 owner 一个看得见的失败提示。
    logger.warn(`[decision-board] card click failed: ${error instanceof Error ? error.message : String(error)}`);
    return { toast: { type: 'error', content: '提交失败，去看板上处理' } };
  }
  const out: Record<string, unknown> = {};
  if (res.toast) out.toast = res.toast;
  if (res.card) out.card = { type: 'raw', data: res.card };
  // 投递可能要冷启管家会话（几秒到十几秒），放在应答之后跑；结果由投递后的卡片同步原地刷新。
  if (res.deliver) out.afterAck = res.deliver;
  return out;
}
