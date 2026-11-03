/**
 * Turn ids for main-session turns the daemon opens to hand a workflow run's
 * own events to its main bot (design §13.1 / §13.6, M1).
 *
 * Shape: `workflow-event:<runId>:<eventSeq>`. Only the run-owning daemon
 * mints them, and they reach a CLI only through the worker's authenticated
 * process-tree marker — never through env or argv. Parsing alone never
 * authorizes: `resolveCurrentTurnProvenance` refuses these turns unless the
 * caller supplies a run-bound verifier, and that verifier proves the session
 * is THIS run's main session and the event exists. Every other synthetic
 * mint (`trg_…`, recovery ids, …) stays refused as before.
 */

/** Same charset as v3 run ids; `:` is not in it, so the split is unambiguous. */
const WORKFLOW_EVENT_TURN_RE = /^workflow-event:([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([1-9][0-9]{0,8})$/;

export interface WorkflowEventTurnRef {
  runId: string;
  /** 1-based journal position of the event that woke the main session. */
  eventSeq: number;
}

export function mintWorkflowEventTurnId(runId: string, eventSeq: number): string {
  const turnId = `workflow-event:${runId}:${eventSeq}`;
  if (!WORKFLOW_EVENT_TURN_RE.test(turnId)) {
    throw new Error(`invalid workflow event turn (${JSON.stringify(runId)}, ${eventSeq})`);
  }
  return turnId;
}

export function parseWorkflowEventTurnId(turnId: string): WorkflowEventTurnRef | null {
  const match = WORKFLOW_EVENT_TURN_RE.exec(turnId);
  if (!match) return null;
  return { runId: match[1]!, eventSeq: Number(match[2]) };
}

/** A turn opened by an inbound chat message (a Lark message id, or the
 *  auto-start join turn) — never a daemon-minted synthetic turn. When a wake
 *  turn is overtaken, only such a turn may take over its request. */
export function isInboundMessageTurnId(turnId: string): boolean {
  return turnId.startsWith('om_') || turnId.startsWith('join_');
}

/** Run-bound verification of a workflow event turn (injected by the caller
 *  that owns the run's binding). */
export type WorkflowEventTurnVerifier = (input: WorkflowEventTurnRef & {
  turnId: string;
  session: {
    sessionId: string;
    larkAppId: string;
    chatId: string;
    rootMessageId?: string;
    /** The session's live turn pointers. A message arriving during the event
     *  turn advances them; the verifier then reports `stale` (generation join)
     *  and the caller authenticates the request as that newer turn. */
    quoteTargetId?: string;
    currentReplyTargetTurnId?: string;
  };
}) => { ok: true; callerOpenId: string } | { ok: false; reason: string; stale?: boolean };
