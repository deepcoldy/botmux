/**
 * flow 卡片点击的前置门（设计文档 §7.2）：action 白名单 → 字段形状 → nonce → run 登记 →
 * `canOperate` → 交给 runner 裁决（经 daemon IPC）。这里不做任何业务判断——「已消费」「旧 version」
 * 「schema 不符」都由 runner 回答，前置门只把回答翻译成 toast / 冻结卡。
 *
 * 纯逻辑 + 注入 seam（deps），单测不需要 daemon。
 */
import type { ControlRequest, ControlResponse, RunBinding } from '../../flow/types.js';
import {
  FLOW_CANCEL_ACTION,
  FLOW_DECIDE_ACTION,
  FLOW_DECIDE_RUN_ACTION,
  FLOW_RESEND_ACTION,
  FLOW_RESUME_ACTION,
  FLOW_SIGNAL_ACTION,
  buildFlowDecisionCard,
  buildFlowInterruptedCard,
  buildFlowRunPauseCard,
  buildFlowSignalCard,
  flowCardNonce,
  flowDecisionKey,
  isFlowCardAction,
  signalPayloadFromForm,
  type FlowActionValue,
} from './flow-card.js';

export { isFlowCardAction };

export interface FlowCardHandlerDeps {
  /** run.json 里的绑定；不存在的 run 返回 null。 */
  readBinding: (runId: string) => RunBinding | null;
  /** 权限门：复用 canOperate（话题 owner / allowedUsers / oncall）。 */
  canOperate: (binding: RunBinding, operatorOpenId: string | undefined) => boolean;
  /** 转发给活着的 runner；runner 不在时 `null`。 */
  control: (runId: string, request: ControlRequest) => Promise<ControlResponse | null>;
  /** 中断卡：恢复 / 取消（起新 runner）。返回错误文案或 null。 */
  resumeInterrupted: (runId: string, by: string, choice: 'resume' | 'cancel') => Promise<string | null>;
  /** 中断卡对应的 gen 是否仍是最新（run 已被别处恢复过就失效）。 */
  interruptedGenIsCurrent: (runId: string, gen: number) => boolean;
  scriptName: (runId: string) => string;
  interruptedInfo: (runId: string) => { reason: string; inflight: string[] } | null;
  /** 最近一次快照里的 run 级暂停（冻结卡回显用）。 */
  lastRunPause: (runId: string) => { reason: 'failed_manual' | 'uncertain' | 'journal_integrity' | 'container_unavailable' | 'escape'; detail: string } | null;
}

const RUN_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function toast(type: 'info' | 'warning' | 'error' | 'success', content: string): unknown {
  return { toast: { type, content } };
}

/** 返回飞书 card-action 应答：冻结卡对象或 `{toast}`。 */
export async function handleFlowCardAction(
  raw: Record<string, unknown> | undefined,
  operatorOpenId: string | undefined,
  formValue: Record<string, unknown> | undefined,
  deps: FlowCardHandlerDeps,
): Promise<unknown> {
  const value = raw as Partial<FlowActionValue> | undefined;
  if (!value || !isFlowCardAction(value.action)) return toast('warning', '未知的 flow 动作');
  if (typeof value.runId !== 'string' || !RUN_ID_RE.test(value.runId)) return toast('warning', '卡片已失效（非法 run）');
  const runId = value.runId;
  if (!operatorOpenId) return toast('error', '无法识别操作者身份');
  const binding = deps.readBinding(runId);
  if (!binding) return toast('warning', 'run 不存在或没有话题绑定');
  if (!deps.canOperate(binding, operatorOpenId)) return toast('warning', '你没有权限操作这个 run');
  const by = operatorOpenId;

  switch (value.action) {
    case FLOW_CANCEL_ACTION: {
      if (value.nonce !== flowCardNonce(runId, 'cancel', '')) return toast('warning', '卡片已失效（nonce 不匹配）');
      const res = await deps.control(runId, { t: 'cancel', by });
      if (!res) return toast('warning', 'run 已中断，先恢复再取消（见中断卡）');
      return res.ok ? toast('success', '已请求取消') : toast('error', res.error);
    }
    case FLOW_DECIDE_ACTION: {
      const v = value as Partial<Extract<FlowActionValue, { action: typeof FLOW_DECIDE_ACTION }>>;
      if (typeof v.identity !== 'string' || !Number.isInteger(v.attempt) || typeof v.content !== 'string' || (v.choice !== 'accept-failed' && v.choice !== 'retry')) return toast('warning', '卡片已失效（字段不完整）');
      if (v.nonce !== flowCardNonce(runId, 'decide', flowDecisionKey(v.identity, v.attempt!))) return toast('warning', '卡片已失效（nonce 不匹配）');
      const status = await deps.control(runId, { t: 'status' });
      if (!status) return toast('warning', 'run 已中断，先恢复（见中断卡）');
      if (!status.ok) return toast('error', status.error);
      const pending = status.pending.find((p) => p.identity === v.identity && p.attempt === v.attempt && p.content === v.content);
      if (!pending) return toast('info', '这个决策已处理过或已失效');
      const res = await deps.control(runId, { t: 'decide', identity: v.identity, content: v.content, attempt: v.attempt!, choice: v.choice, by });
      if (!res) return toast('warning', 'run 已中断，先恢复');
      if (!res.ok) return toast('error', res.error);
      return JSON.parse(buildFlowDecisionCard({ runId, decision: pending, resolution: { choice: v.choice, by } }));
    }
    case FLOW_DECIDE_RUN_ACTION: {
      const v = value as Partial<Extract<FlowActionValue, { action: typeof FLOW_DECIDE_RUN_ACTION }>>;
      if (v.choice !== 'accept-journal' && v.choice !== 'assume-clean' && v.choice !== 'cancel') return toast('warning', '卡片已失效（字段不完整）');
      const nonceGen = typeof v.nonce === 'string' && v.nonce.startsWith(`flow:${runId}:pause:`) ? Number(v.nonce.slice(`flow:${runId}:pause:`.length)) : NaN;
      if (!Number.isInteger(nonceGen)) return toast('warning', '卡片已失效（nonce 不匹配）');
      const status = await deps.control(runId, { t: 'status' });
      if (!status) return toast('warning', 'run 已中断，先恢复（见中断卡）');
      if (!status.ok) return toast('error', status.error);
      const res = v.choice === 'cancel'
        ? await deps.control(runId, { t: 'cancel', by })
        : await deps.control(runId, { t: 'decide-run', choice: v.choice, by });
      if (!res) return toast('warning', 'run 已中断，先恢复');
      if (!res.ok) return res.code === 'not_paused' ? toast('info', 'run 已不在这个暂停点') : toast('error', res.error);
      const pause = deps.lastRunPause(runId) ?? { reason: 'container_unavailable' as const, detail: '' };
      return JSON.parse(buildFlowRunPauseCard({ runId, gen: nonceGen, pause, resolution: { choice: v.choice, by } }));
    }
    case FLOW_SIGNAL_ACTION: {
      const v = value as Partial<Extract<FlowActionValue, { action: typeof FLOW_SIGNAL_ACTION }>>;
      if (typeof v.identity !== 'string' || !Number.isInteger(v.version)) return toast('warning', '卡片已失效（字段不完整）');
      if (v.nonce !== flowCardNonce(runId, 'signal', `${v.identity}:${v.version}`)) return toast('warning', '卡片已失效（nonce 不匹配）');
      const status = await deps.control(runId, { t: 'status' });
      if (!status) return toast('warning', 'run 已中断，先恢复（见中断卡）后再提交');
      if (!status.ok) return toast('error', status.error);
      const wait = status.waits.find((w) => w.identity === v.identity);
      if (!wait) return toast('info', '这个信号已提交过或已失效');
      if (wait.version !== v.version) return toast('warning', `这张卡已过期（当前是 v${wait.version}，请用新卡片）`);
      const payload = signalPayloadFromForm(wait.schema, formValue, typeof v.choice === 'string' ? { field: typeof v.field === 'string' ? v.field : undefined, choice: v.choice } : undefined);
      if (!payload.ok) return toast('error', payload.error);
      const res = await deps.control(runId, { t: 'signal', identity: v.identity, version: v.version!, content: wait.content, by, value: payload.value });
      if (!res) return toast('warning', 'run 已中断，先恢复');
      if (!res.ok) {
        switch (res.code) {
          case 'consumed':
            return toast('info', '这个信号已提交过');
          case 'stale_version':
            return toast('warning', '这张卡已过期，请用最新的卡片');
          case 'schema_mismatch':
          case 'payload_too_large':
            return toast('error', res.error);
          case 'no_wait':
            return toast('info', '没有等待中的信号');
          default:
            return toast('error', res.error);
        }
      }
      return JSON.parse(buildFlowSignalCard({ runId, wait, resolution: { how: 'consumed', by, value: payload.value } }));
    }
    case FLOW_RESEND_ACTION: {
      const v = value as Partial<Extract<FlowActionValue, { action: typeof FLOW_RESEND_ACTION }>>;
      if (typeof v.identity !== 'string' || !Number.isInteger(v.version)) return toast('warning', '卡片已失效（字段不完整）');
      if (v.nonce !== flowCardNonce(runId, 'signal', `${v.identity}:${v.version}`)) return toast('warning', '卡片已失效（nonce 不匹配）');
      const res = await deps.control(runId, { t: 'resend', identity: v.identity, by });
      if (!res) return toast('warning', 'run 已中断，先恢复');
      if (!res.ok) return res.code === 'no_wait' ? toast('info', '没有等待中的信号') : toast('error', res.error);
      const wait = res.waits.find((w) => w.identity === v.identity);
      return toast('success', wait?.delivery === 'failed' ? `已重发为 v${wait.version}，但投递失败：${wait.deliveryError ?? ''}` : `已重发为 v${wait?.version ?? '?'}`);
    }
    case FLOW_RESUME_ACTION: {
      const v = value as Partial<Extract<FlowActionValue, { action: typeof FLOW_RESUME_ACTION }>>;
      if (!Number.isInteger(v.gen) || (v.choice !== 'resume' && v.choice !== 'cancel')) return toast('warning', '卡片已失效（字段不完整）');
      if (v.nonce !== flowCardNonce(runId, 'interrupted', String(v.gen))) return toast('warning', '卡片已失效（nonce 不匹配）');
      const info = deps.interruptedInfo(runId);
      const scriptName = deps.scriptName(runId);
      if (!deps.interruptedGenIsCurrent(runId, v.gen!)) {
        return JSON.parse(buildFlowInterruptedCard({ runId, gen: v.gen!, scriptName, reason: info?.reason ?? '', inflight: info?.inflight ?? [], resolution: { choice: 'stale' } }));
      }
      const error = await deps.resumeInterrupted(runId, by, v.choice);
      if (error) return toast('error', error);
      return JSON.parse(buildFlowInterruptedCard({ runId, gen: v.gen!, scriptName, reason: info?.reason ?? '', inflight: info?.inflight ?? [], resolution: { choice: v.choice, by } }));
    }
    default:
      return toast('warning', '未知的 flow 动作');
  }
}
