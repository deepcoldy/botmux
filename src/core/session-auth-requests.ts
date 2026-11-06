/**
 * In-flight trigger-user authorization requests, keyed by the opaque requestId
 * minted on auth-request and polled through auth-status.
 *
 * Daemon memory only: a request dies with its TTL (registered by the caller)
 * or with the daemon. Split out of the IPC server so terminal identity garbage
 * collection can enumerate which turns still own a pending grant without
 * importing the whole dashboard server.
 */
import type { requestUserAuthorization } from '../utils/user-token.js';

/** Provider poll handle; the store never inspects it. */
export type SessionAuthPoll = Awaited<ReturnType<typeof requestUserAuthorization>>['poll'];

export interface SessionAuthRequest {
  sessionId: string;
  appId: string;
  /** Human who approved this grant, frozen at request creation. The live origin
   *  of a later auth-status call may already belong to another turn or another
   *  person; this frozen id is the only safe same-principal reference. */
  callerOpenId: string;
  /** Identity turn this grant will be written to. Frozen at request creation:
   *  even when the live turn rotates while the human is authorizing, the
   *  original turn's material must survive terminal GC until this settles. */
  identityTurnId: string;
  authorization: Awaited<ReturnType<typeof requestUserAuthorization>>;
  /** Creating-turn closure: true only while the exact originating turn is live. */
  isCurrent: () => boolean;
  /** Session/app liveness used to keep or retire the daemon-side background poll. */
  isValid: () => boolean;
  status: 'pending' | 'ready' | 'failed';
  expiresAt: number;
  poll: SessionAuthPoll;
  dispose: () => void;
}

export class SessionAuthRequestStore {
  private readonly byId = new Map<string, SessionAuthRequest>();

  set(requestId: string, request: SessionAuthRequest): void {
    this.byId.set(requestId, request);
  }

  get(requestId: string): SessionAuthRequest | undefined {
    return this.byId.get(requestId);
  }

  delete(requestId: string): void {
    this.byId.delete(requestId);
  }

  values(): IterableIterator<SessionAuthRequest> {
    return this.byId.values();
  }

  entries(): IterableIterator<[string, SessionAuthRequest]> {
    return this.byId.entries();
  }

  disposeAndClear(): void {
    for (const request of this.byId.values()) request.dispose();
    this.byId.clear();
  }

  /** Identity turns that pending grants in this session still target. */
  identityTurnsFor(sessionId: string): string[] {
    const turns: string[] = [];
    for (const request of this.byId.values()) {
      if (request.sessionId === sessionId) turns.push(request.identityTurnId);
    }
    return turns;
  }
}

/** Process-wide registry shared by the IPC route handlers and the terminal
 *  identity garbage collector. */
export const sessionAuthRequests = new SessionAuthRequestStore();
