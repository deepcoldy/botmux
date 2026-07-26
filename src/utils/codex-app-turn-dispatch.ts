/**
 * Worker-owned attribution for Codex App's serial runner queue.
 *
 * The runner can echo a stable clientUserMessageId, but it must never choose
 * the daemon delivery attempt.  A worker may also finish writing turn N+1
 * before turn N's final transaction arrives, so the mutable "current turn"
 * globals are not an attribution boundary.  Reserve one immutable entry per
 * control-line write and settle final transactions strictly from the head.
 */

export interface CodexAppTurnDispatchReservation {
  handle: number;
  dispatchId?: string;
  turnId: string;
  replyTurnId?: string;
  dispatchAttempt?: number;
  recovered?: boolean;
}

export type CodexAppTurnDispatchSettlement =
  | {
      ok: true;
      handle: number;
      dispatchId?: string;
      turnId: string;
      replyTurnId?: string;
      dispatchAttempt?: number;
      nativeTurnId?: string;
      remaining: number;
    }
  | {
      ok: false;
      reason: 'no_pending_turn' | 'turn_mismatch' | 'dispatch_attempt_mismatch';
      markerTurnId?: string;
      expectedTurnId?: string;
      markerDispatchAttempt?: unknown;
      expectedDispatchAttempt?: number;
    };

export class CodexAppTurnDispatchQueue {
  private readonly queue: CodexAppTurnDispatchReservation[] = [];
  private nextHandle = 1;

  reserve(
    turnId: string,
    dispatchAttempt?: number,
    dispatchId?: string,
    recovered = false,
    replyTurnId?: string,
  ): CodexAppTurnDispatchReservation {
    if (!turnId) throw new Error('Codex App dispatch turn id must be non-empty');
    const reservation = {
      handle: this.nextHandle++,
      ...(dispatchId ? { dispatchId } : {}),
      turnId,
      ...(replyTurnId ? { replyTurnId } : {}),
      ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
      ...(recovered ? { recovered: true } : {}),
    };
    this.queue.push(reservation);
    return { ...reservation };
  }

  /**
   * A replacement worker cannot recover the old in-memory queue.  It may
   * recover exactly the daemon-frozen active identity supplied in `init`, and
   * only while no locally submitted entry exists.  A runner marker still has
   * to assert equality before this entry can settle.
   */
  recoverWarmReattach(
    turnId: string | undefined,
    dispatchAttempt?: number,
    dispatchId?: string,
    replyTurnId?: string,
  ): CodexAppTurnDispatchReservation | undefined {
    if (!turnId || this.queue.length > 0) return undefined;
    return this.reserve(turnId, dispatchAttempt, dispatchId, true, replyTurnId);
  }

  restore(entries: ReadonlyArray<{
    dispatchId: string;
    turnId: string;
    dispatchAttempt?: number;
    replyTurnId?: string;
  }>): void {
    if (this.queue.length > 0) throw new Error('Codex App dispatch queue is already populated');
    for (const entry of entries) {
      this.reserve(entry.turnId, entry.dispatchAttempt, entry.dispatchId, true, entry.replyTurnId);
    }
  }

  recoveredPrefix(): CodexAppTurnDispatchReservation[] {
    const prefix: CodexAppTurnDispatchReservation[] = [];
    for (const entry of this.queue) {
      if (!entry.recovered) break;
      prefix.push({ ...entry });
    }
    return prefix;
  }

  /** Remove the exact write that threw or reported submitted=false. */
  cancelExact(handle: number): boolean {
    const index = this.queue.findIndex(entry => entry.handle === handle);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    return true;
  }

  markRecovered(handle: number): boolean {
    const entry = this.queue.find(candidate => candidate.handle === handle);
    if (!entry) return false;
    entry.recovered = true;
    return true;
  }

  findExact(
    turnId: string,
    dispatchAttempt?: number,
  ): CodexAppTurnDispatchReservation | undefined {
    const entry = this.queue.find(candidate => candidate.turnId === turnId
      && candidate.dispatchAttempt === dispatchAttempt);
    return entry ? { ...entry } : undefined;
  }

  /**
   * Validate and consume one complete final transaction.  The head remains in
   * place on every rejection, so a stale/mismatched marker cannot steal the
   * next turn or advance the FIFO.
   */
  settleFinal(payload: {
    turnId?: unknown;
    nativeTurnId?: unknown;
    dispatchAttempt?: unknown;
  }, consume = true): CodexAppTurnDispatchSettlement {
    const head = this.queue[0];
    if (!head) return { ok: false, reason: 'no_pending_turn' };

    const markerTurnId = typeof payload.turnId === 'string' && payload.turnId.length > 0
      ? payload.turnId
      : undefined;
    if (markerTurnId && markerTurnId !== head.turnId) {
      return {
        ok: false,
        reason: 'turn_mismatch',
        markerTurnId,
        expectedTurnId: head.turnId,
      };
    }

    // Attempt identity is worker-owned.  A runner may redundantly assert it,
    // but an assertion of any other value (including a malformed one) is a
    // rejection and can never select another queue entry.
    if (payload.dispatchAttempt !== undefined
        && payload.dispatchAttempt !== head.dispatchAttempt) {
      return {
        ok: false,
        reason: 'dispatch_attempt_mismatch',
        markerDispatchAttempt: payload.dispatchAttempt,
        ...(head.dispatchAttempt !== undefined
          ? { expectedDispatchAttempt: head.dispatchAttempt }
          : {}),
      };
    }

    const nativeTurnId = typeof payload.nativeTurnId === 'string' && payload.nativeTurnId.length > 0
      ? payload.nativeTurnId
      : undefined;
    if (consume) this.queue.shift();
    return {
      ok: true,
      handle: head.handle,
      ...(head.dispatchId ? { dispatchId: head.dispatchId } : {}),
      turnId: head.turnId,
      ...(head.replyTurnId ? { replyTurnId: head.replyTurnId } : {}),
      ...(head.dispatchAttempt !== undefined
        ? { dispatchAttempt: head.dispatchAttempt }
        : {}),
      ...(nativeTurnId ? { nativeTurnId } : {}),
      remaining: this.queue.length - (consume ? 0 : 1),
    };
  }

  commitExactHead(handle: number): boolean {
    if (this.queue[0]?.handle !== handle) return false;
    this.queue.shift();
    return true;
  }

  size(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue.length = 0;
  }
}
