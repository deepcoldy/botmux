/**
 * The ONE place that decides whether a close response left a remote session
 * running, for every consumer on the far side of a JSON boundary.
 *
 * Why this module exists: `CloseSessionResult` makes `outcome` a required
 * discriminant, which helps across a typed call and does nothing at a JSON seam —
 * the daemon IPC route, the CLI's daemon POST, the Lark session card and the web
 * dashboard all receive `any`. Review found each of those independently flattening
 * a residual into an ordinary success, i.e. telling the operator a still-running
 * remote agent (holding an injected credential) was gone.
 *
 * Dependency-free on purpose: the web dashboard bundle imports it too, so it must
 * not drag in the daemon.
 */

/** A remote session the daemon closed LOCALLY but could not cancel. */
export interface ParsedCloseResidual {
  /** Why it could not be cancelled. Free-form: new daemons may add reasons. */
  reason?: string;
  /** The surviving remote id, when the daemon knew it. */
  taskId?: string;
}

/**
 * Read a residual out of a close response body.
 *
 * Fails CLOSED in both directions that matter:
 *  - a body that DECLARES `outcome: 'closed_with_residual'` yields a residual even
 *    when `residual` is missing or malformed. A generic "remote not cancelled"
 *    warning is correct; degrading to an ordinary success because the payload was
 *    the wrong shape is how the whole class of bug came back last time.
 *  - a body with no `outcome` at all is an OLDER daemon that predates the field,
 *    which is treated as an ordinary close. That is the only compatibility hole,
 *    and it is deliberate: such a daemon also never leaves a residual.
 *
 * Field types are validated rather than trusted; a non-string taskId is dropped
 * so callers can render "unknown id" instead of `[object Object]`.
 */
export function parseCloseResidual(body: unknown): ParsedCloseResidual | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  if (record.outcome !== 'closed_with_residual') return undefined;
  const raw = record.residual;
  const residual: ParsedCloseResidual = {};
  if (raw && typeof raw === 'object') {
    const { reason, taskId } = raw as Record<string, unknown>;
    if (typeof reason === 'string' && reason) residual.reason = reason;
    if (typeof taskId === 'string' && taskId) residual.taskId = taskId;
  }
  return residual;
}

/** True when this response closed the row but left a remote session running. */
export function hasCloseResidual(body: unknown): boolean {
  return parseCloseResidual(body) !== undefined;
}

/**
 * Short label for the surviving remote session, for log lines and summaries.
 * Never returns an empty string, so a missing id cannot render as a blank.
 */
export function describeCloseResidual(residual: ParsedCloseResidual | undefined): string {
  if (!residual) return '';
  return residual.taskId ?? 'unknown remote id';
}
