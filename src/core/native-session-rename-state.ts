/**
 * Stateful side of Botmux → native CLI session-title synchronization.
 *
 * `desiredTitle` is durable state restored from the persisted Botmux session:
 * sending one `/rename` command must not forget the title, because `/clear` /
 * `/new` (or an independently observed native session-id rotation) can move
 * the same Botmux session onto a fresh native session later. `pendingTitle`
 * and `inFlightTitle` only describe delivery of that desired state.
 */
export type NativeSessionIdObservation = {
  kind: 'unchanged' | 'baseline' | 'rotation';
  queuedTitleReapply: boolean;
};

export class NativeSessionRenameState {
  private desiredTitle: string | null = null;
  private pendingTitle: string | null = null;
  private inFlightTitle: string | null = null;
  private observedCliSessionId: string | undefined;
  /** Set synchronously before a known rotation command enters the serialized
   * text→Enter window, closing the 200ms race where a second raw IPC could
   * otherwise pass the gate and follow it straight into the rotation UI. */
  private rotationCommandWriteReserved = false;
  /** Delays the administrative /rename until the CLI has rendered the prompt
   * belonging to the rotated native session. This is deliberately separate
   * from id-confirmation dedup: either signal can arrive first. */
  private awaitingFreshPromptAfterRotation = false;
  /** Only an adapter-declared command that Botmux itself submitted owns the
   * composer and must block later input. An independently observed id change
   * still delays /rename until a fresh prompt, but ordinary type-ahead input is
   * allowed to create the next authoritative idle signal instead of deadlocking
   * behind a late filesystem observer. */
  private rotationCommandBlocksInput = false;

  get hasPending(): boolean {
    return this.pendingTitle !== null;
  }

  get hasDesiredTitle(): boolean {
    return this.desiredTitle !== null;
  }

  get isInFlight(): boolean {
    return this.inFlightTitle !== null;
  }

  get requiresFreshPrompt(): boolean {
    return this.awaitingFreshPromptAfterRotation;
  }

  get blocksInput(): boolean {
    return this.rotationCommandWriteReserved || this.rotationCommandBlocksInput;
  }

  /** Latest-wins canonical title request from the daemon. */
  request(title: string): void {
    this.desiredTitle = title;
    this.pendingTitle = title;
  }

  /** Restore durable desired state after a worker/daemon restart. Delivery is
   * intentionally at-least-once: persistence cannot know whether the prior
   * worker reached the native prompt before it stopped, and `/rename` is
   * idempotent, so queueing is safer than permanently missing an offline or
   * interrupted rename. */
  restoreDesired(title: string): void {
    this.request(title);
  }

  /** A same-process CLI respawn does not receive another init IPC. Re-queue the
   * durable title so restart/crash recovery cannot lose native synchronization. */
  queueDesiredForSpawn(): boolean {
    return this.queueDesiredTitle();
  }

  /** Move one queued title into the worker's text → Enter delivery window. */
  takeForSend(): string | null {
    if (
      this.blocksInput
      || this.awaitingFreshPromptAfterRotation
      || this.inFlightTitle !== null
      || this.pendingTitle === null
    ) return null;
    const title = this.pendingTitle;
    this.pendingTitle = null;
    this.inFlightTitle = title;
    return title;
  }

  /** The native rename UI returned to a positively proven empty prompt. */
  settle(): void {
    this.inFlightTitle = null;
  }

  /** Defensive capability mismatch: stop retrying a command this CLI cannot run. */
  discardUnsupported(): void {
    this.desiredTitle = null;
    this.pendingTitle = null;
    this.inFlightTitle = null;
    this.rotationCommandWriteReserved = false;
    this.awaitingFreshPromptAfterRotation = false;
    this.rotationCommandBlocksInput = false;
  }

  /** Recognize a rotation before writing it, without mutating synchronization
   * state. The worker commits it only after Enter lands successfully. */
  isRotationCommand(
    content: string,
    rotationCommands?: readonly string[],
  ): boolean {
    if (!rotationCommands || rotationCommands.length === 0) return false;
    const token = /^\s*(\/[a-z0-9][a-z0-9:_-]*)(?:\s|$)/i.exec(content)?.[1]?.toLowerCase();
    return !!token && rotationCommands.some(command => command.toLowerCase() === token);
  }

  /** Reserve the prompt before the async text→Enter write begins. */
  beginRotationCommandWrite(): void {
    this.rotationCommandWriteReserved = true;
  }

  /** A recognized rotation command was actually submitted. Queue the durable
   * desired title again and hold all input until the new prompt appears. */
  commitRotationCommand(): boolean {
    this.rotationCommandWriteReserved = false;
    const queued = this.queueDesiredTitle();
    // With no canonical title there is nothing to synchronize. Preserve the
    // historical raw passthrough semantics instead of holding every later
    // input behind a prompt that an adopted/static pane may never redraw to
    // this observer. A rename arriving during the write is already visible to
    // queueDesiredTitle() because request() runs synchronously.
    this.awaitingFreshPromptAfterRotation = queued;
    this.rotationCommandBlocksInput = queued;
    return queued;
  }

  /** The reserved command failed before a successful Enter. */
  cancelRotationCommandWrite(): void {
    this.rotationCommandWriteReserved = false;
  }

  /** The CLI has rendered a prompt after the latest rotation signal. */
  noteFreshPrompt(): void {
    this.awaitingFreshPromptAfterRotation = false;
    this.rotationCommandBlocksInput = false;
  }

  /**
   * Record the authoritative native session id. The first id establishes a
   * baseline. A desired title may already be queued (worker restore or a rename
   * before PID/session discovery), so the first id can idempotently re-queue it,
   * but it is not itself evidence of a rotation and must not arm the fresh-prompt
   * gate. A later different id is authoritative rotation evidence and arms a
   * fresh-prompt gate. The worker coalesces an early id signal with an already
   * active adapter-declared /clear or /new proof; a late signal may cause one
   * harmless idempotent title replay. Repeated observations are no-ops.
   */
  observeCliSessionId(cliSessionId: string): NativeSessionIdObservation {
    if (!cliSessionId) return { kind: 'unchanged', queuedTitleReapply: false };
    const previous = this.observedCliSessionId;
    if (previous === cliSessionId) return { kind: 'unchanged', queuedTitleReapply: false };
    this.observedCliSessionId = cliSessionId;

    if (!previous) {
      return { kind: 'baseline', queuedTitleReapply: this.queueDesiredTitle() };
    }

    const queued = this.queueDesiredTitle();
    if (queued) this.awaitingFreshPromptAfterRotation = true;
    return { kind: 'rotation', queuedTitleReapply: queued };
  }

  private queueDesiredTitle(): boolean {
    if (this.desiredTitle === null) return false;
    this.pendingTitle = this.desiredTitle;
    return true;
  }
}
