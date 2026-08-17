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
 * A LOCAL residual names a host subtree whose containment could not be proven
 * gone; a REMOTE one names a cloud session that could not be cancelled. They
 * demand OPPOSITE remediation, so no UI may render one as the other.
 */
export function closeResidualIsLocal(residual: ParsedCloseResidual | undefined): boolean {
  return residual?.reason === 'local_subtree_unprovable_on_platform'
    || residual?.reason === 'local_subtree_boundary_unproven';
}

/**
 * Short label for a residual, for log lines and summaries. Never returns an
 * empty string, so a missing value cannot render as a blank.
 *
 * For a REMOTE residual this is the surviving task id (the thing to clean up).
 * For a LOCAL one there is no remote id — returning `taskId ?? 'unknown remote
 * id'` here is exactly how a local host-process concern got mislabelled as a
 * phantom remote session — so it returns a description of the host subtree
 * instead.
 */
export function describeCloseResidual(residual: ParsedCloseResidual | undefined): string {
  if (!residual) return '';
  if (closeResidualIsLocal(residual)) {
    return residual.reason === 'local_subtree_unprovable_on_platform'
      ? '本地残留子进程无法在本平台证明已终止'
      : '本地残留子进程未取得终止边界证明';
  }
  return residual.taskId ?? 'unknown remote id';
}

/**
 * The full user-facing clause for a close that left a residual, correct for
 * BOTH kinds. Callers used to hardcode "远端会话未取消（…）", which misdirects an
 * operator to a nonexistent remote session when the concern is a local host
 * process still holding the injected credential.
 */
export function closeResidualClause(residual: ParsedCloseResidual | undefined): string {
  if (!residual) return '';
  return closeResidualIsLocal(residual)
    ? `本地可能残留带凭证的子进程未确认终止（${describeCloseResidual(residual)}），需人工核查该主机进程`
    : `远端会话未取消（${describeCloseResidual(residual)}），需人工清理`;
}
