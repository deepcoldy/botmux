/**
 * "May the run's initiator operate this bot?" for a workflow node's Gate-2
 * directory (design 2026-11-03 §15.4). The answer decides whether
 * {@link checkNodeWorkingDir} only checks that the directory exists (yes) or
 * also holds it to the bot's configured range (no).
 *
 * "Operate" means exactly what lets a person use `/cd` in a topic of that bot
 * ({@link humanCanRunDaemonCommand} with `/cd`), judged by the executing
 * bot's own daemon against its own configuration and grants.
 *
 * The initiator's open_id is app-scoped: it names them for the run's main bot
 * app only. For any other bot it is never used; their union_id is resolved to
 * that bot's own open_id first. Whenever that cannot be done — no union_id,
 * a failed or definitive lookup, an unreachable daemon — the answer is "no",
 * so the range rule applies and in-range directories keep working.
 */

/** Gate-2 (approve-dag, a CLI process) → an executing bot's daemon: would the
 *  initiator be allowed to operate you in this chat? Trusted host IPC. */
export const WORKFLOW_WORKING_DIR_OPERATOR_ROUTE = '/api/workflow/working-dir-operator-check';

/** An executing bot's daemon → the run's main bot's daemon: the initiator's
 *  union_id, looked up through the main bot's app (the only app their frozen
 *  open_id belongs to). Only for runs with a Gate-2 working dir. */
export const WORKFLOW_INITIATOR_UNION_ROUTE = '/api/workflow/initiator-union-id';

const OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{1,128}$/;
const UNION_ID_RE = /^on_[A-Za-z0-9_-]{1,128}$/;
const CHAT_ID_RE = /^oc_[A-Za-z0-9_-]{1,128}$/;

export const isWorkflowOpenId = (value: unknown): value is string => typeof value === 'string' && OPEN_ID_RE.test(value);
export const isWorkflowUnionId = (value: unknown): value is string => typeof value === 'string' && UNION_ID_RE.test(value);

/** The initiator as a check request names them. `openId` is valid for
 *  `sourceLarkAppId` (the run's main bot) only. */
export interface WorkflowInitiatorIdentity {
  sourceLarkAppId: string;
  openId?: string;
  unionId?: string;
}

export interface WorkflowWorkingDirOperatorRequest {
  chatId: string;
  initiator: WorkflowInitiatorIdentity;
}

export interface WorkflowInitiatorOperatesDeps {
  /** union_id → the open_id `larkAppId`'s own app issues for that person;
   *  undefined for any miss or failure. */
  resolveTargetOpenId(larkAppId: string, unionId: string): Promise<string | undefined>;
  /** The `/cd` gate of `larkAppId` for a human with this (own-app) open_id. */
  canUseCd(larkAppId: string, chatId: string, openId: string, unionId: string | undefined): boolean;
}

/** Whether the initiator may operate `larkAppId` in `chatId`; false when
 *  unsure. */
export async function workflowInitiatorOperates(
  deps: WorkflowInitiatorOperatesDeps,
  input: { larkAppId: string; chatId: string; initiator: WorkflowInitiatorIdentity },
): Promise<boolean> {
  const { initiator } = input;
  try {
    let openId: string | undefined;
    if (input.larkAppId === initiator.sourceLarkAppId && isWorkflowOpenId(initiator.openId)) {
      openId = initiator.openId;
    } else if (isWorkflowUnionId(initiator.unionId)) {
      // Never the main bot's open_id for another app: convert through the
      // tenant-stable union_id, in the executing bot's own app.
      openId = await deps.resolveTargetOpenId(input.larkAppId, initiator.unionId);
    }
    if (!isWorkflowOpenId(openId)) return false;
    return deps.canUseCd(input.larkAppId, input.chatId, openId, isWorkflowUnionId(initiator.unionId) ? initiator.unionId : undefined);
  } catch {
    return false;
  }
}

/** How long one operate answer may take (Lark lookups + daemon IPC) before
 *  it counts as "no": an inbound handoff waits for it, and a stalled lookup
 *  must not hold the node — the range rule still lets in-range dirs start. */
export const WORKFLOW_OPERATOR_BUDGET_MS = 8_000;

/** `answer`, or false once {@link WORKFLOW_OPERATOR_BUDGET_MS} passed or it
 *  failed. */
export function withinOperatorBudget(answer: Promise<boolean>, budgetMs: number = WORKFLOW_OPERATOR_BUDGET_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), budgetMs);
    timer.unref?.();
    answer.then((value) => resolve(value === true), () => resolve(false))
      .finally(() => clearTimeout(timer));
  });
}

/** The request body of {@link WORKFLOW_WORKING_DIR_OPERATOR_ROUTE}, or
 *  undefined when malformed. */
export function parseWorkflowWorkingDirOperatorRequest(raw: unknown): WorkflowWorkingDirOperatorRequest | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const body = raw as Record<string, unknown>;
  const initiator = body.initiator && typeof body.initiator === 'object' && !Array.isArray(body.initiator)
    ? body.initiator as Record<string, unknown>
    : undefined;
  if (typeof body.chatId !== 'string' || !CHAT_ID_RE.test(body.chatId) || !initiator) return undefined;
  const source = initiator.sourceLarkAppId;
  if (typeof source !== 'string' || source.length === 0 || source.length > 256) return undefined;
  if (initiator.openId !== undefined && !isWorkflowOpenId(initiator.openId)) return undefined;
  if (initiator.unionId !== undefined && !isWorkflowUnionId(initiator.unionId)) return undefined;
  return {
    chatId: body.chatId,
    initiator: {
      sourceLarkAppId: source,
      ...(initiator.openId !== undefined ? { openId: initiator.openId as string } : {}),
      ...(initiator.unionId !== undefined ? { unionId: initiator.unionId as string } : {}),
    },
  };
}
