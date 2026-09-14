import type { TrustedCaller } from '../types.js';

export interface TurnAuthorityIdentity {
  turnId?: string;
  dispatchAttempt?: number;
  caller?: TrustedCaller;
  /** Stable controller of the surrounding task/session. The active caller may
   * be a reviewer bot or scheduled continuation, but that must not demote the
   * authenticated task owner into a cross-principal proposer. */
  controller?: TrustedCaller;
}

export interface ActiveTurnAuthoritySnapshot extends TurnAuthorityIdentity {
  started: boolean;
  reservedAtMs: number;
}

function mayControlActiveTurn(
  active: ActiveTurnAuthoritySnapshot,
  incoming: TurnAuthorityIdentity,
): boolean {
  return compatibleAuthorityPrincipal(active.caller, incoming.caller)
    || (!!active.controller
      && !!incoming.caller
      && sameTrustedPrincipal(active.controller, incoming.caller));
}

function frozenCaller(caller: TrustedCaller | undefined): TrustedCaller | undefined {
  return caller ? Object.freeze({ ...caller }) : undefined;
}

function compatibleAuthorityPrincipal(
  left: TrustedCaller | undefined,
  right: TrustedCaller | undefined,
): boolean {
  // Legacy/non-IM transports historically carry no caller on either side and
  // still need serial turn delivery. A one-sided absence is different: it must
  // not downgrade a known authenticated authority into an unknown caller.
  if (!left && !right) return true;
  return sameTrustedPrincipal(left, right);
}

/** Compare the authenticated principal, not the message/turn envelope. */
export function sameTrustedPrincipal(
  left: TrustedCaller | undefined,
  right: TrustedCaller | undefined,
): boolean {
  if (!left || !right) return false;
  if (left.requestLarkAppId !== right.requestLarkAppId) return false;
  if (left.senderType !== right.senderType) return false;
  const leftSource = left.source ?? 'interactive';
  const rightSource = right.source ?? 'interactive';
  if (leftSource !== rightSource) return false;
  if (leftSource === 'schedule_creator') {
    return left.taskId === right.taskId
      && !!left.taskId
      && left.requestUserOpenId === right.requestUserOpenId
      && left.requestUserUnionId === right.requestUserUnionId;
  }
  if (left.requestUserUnionId && right.requestUserUnionId) {
    return left.requestUserUnionId === right.requestUserUnionId;
  }
  return !!left.requestUserOpenId
    && left.requestUserOpenId === right.requestUserOpenId;
}

/**
 * One immutable authority tuple for the turn that currently owns the CLI.
 *
 * A same-principal steer may replace the turn envelope only when that input
 * actually crosses the CLI submission edge. A different principal stays
 * queued in this worker until the active authority reaches a terminal boundary.
 * Operations that change controller ownership may affect only the next reserve;
 * they must never rewrite an authority tuple that is already in flight. The
 * current codebase has no existing-session owner-change operation; any future
 * addition must preserve this invariant explicitly.
 */
export class ActiveTurnAuthority {
  private active?: ActiveTurnAuthoritySnapshot;

  snapshot(): ActiveTurnAuthoritySnapshot | undefined {
    if (!this.active) return undefined;
    return {
      ...this.active,
      ...(this.active.caller ? { caller: { ...this.active.caller } } : {}),
      ...(this.active.controller ? { controller: { ...this.active.controller } } : {}),
    };
  }

  identity(): TurnAuthorityIdentity {
    if (!this.active) return {};
    return {
      ...(this.active.caller ? { caller: this.active.caller } : {}),
      ...(this.active.controller ? { controller: this.active.controller } : {}),
      ...(this.active.turnId ? { turnId: this.active.turnId } : {}),
      ...(this.active.dispatchAttempt !== undefined
        ? { dispatchAttempt: this.active.dispatchAttempt }
        : {}),
    };
  }

  /** Reserve before an asynchronous startup/write preparation can yield. */
  reserve(identity: TurnAuthorityIdentity, nowMs = Date.now()): boolean {
    if (!identity.turnId) return false;
    if (this.active) {
      return this.matches(identity)
        || mayControlActiveTurn(this.active, identity);
    }
    this.active = Object.freeze({
      turnId: identity.turnId,
      ...(identity.dispatchAttempt !== undefined
        ? { dispatchAttempt: identity.dispatchAttempt }
        : {}),
      ...(identity.caller ? { caller: frozenCaller(identity.caller) } : {}),
      ...(identity.controller ? { controller: frozenCaller(identity.controller) } : {}),
      started: false,
      reservedAtMs: nowMs,
    });
    return true;
  }

  /** Mark the reserved tuple as having crossed the literal CLI submission edge. */
  markStarted(identity: TurnAuthorityIdentity): boolean {
    if (!this.active) return false;
    if (!this.matches(identity)) {
      if (!mayControlActiveTurn(this.active, identity)) return false;
      this.active = Object.freeze({
        turnId: identity.turnId,
        ...(identity.dispatchAttempt !== undefined
          ? { dispatchAttempt: identity.dispatchAttempt }
          : {}),
        ...(identity.caller ? { caller: frozenCaller(identity.caller) } : {}),
        ...(this.active.controller
          ? { controller: this.active.controller }
          : identity.controller
          ? { controller: frozenCaller(identity.controller) }
          : {}),
        started: true,
        reservedAtMs: Date.now(),
      });
      return true;
    }
    if (!this.active.started) this.active = Object.freeze({ ...this.active, started: true });
    return true;
  }

  blocks(identity: TurnAuthorityIdentity): boolean {
    return !!this.active
      && !this.matches(identity)
      && !mayControlActiveTurn(this.active, identity);
  }

  /**
   * Raw passthrough input carries no trusted caller. While a turn is active it
   * is an operation on that turn and must inherit its authority rather than
   * replacing a known caller with an unattributed tuple. At idle, the raw turn
   * becomes the authority owner in the same way as legacy caller-less input.
   */
  inheritOrStartControl(
    turnId: string | undefined,
    nowMs = Date.now(),
    controller?: TrustedCaller,
  ): boolean {
    if (this.active || !turnId) return true;
    const identity = { turnId, ...(controller ? { controller } : {}) };
    return this.reserve(identity, nowMs) && this.markStarted(identity);
  }

  matches(identity: TurnAuthorityIdentity): boolean {
    return !!this.active
      && !!identity.turnId
      && this.active.turnId === identity.turnId
      && this.active.dispatchAttempt === identity.dispatchAttempt;
  }

  /** Release only for the exact active tuple; stale terminals are harmless. */
  releaseExact(identity: TurnAuthorityIdentity): ActiveTurnAuthoritySnapshot | undefined {
    if (!this.matches(identity)) return undefined;
    return this.clear();
  }

  clear(): ActiveTurnAuthoritySnapshot | undefined {
    const prior = this.active;
    this.active = undefined;
    return prior;
  }
}
