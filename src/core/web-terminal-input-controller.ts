import { WebTerminalInputClassifier, type WebTerminalInputClassification } from './web-terminal-input.js';

export interface WebTerminalInputControllerDependencies<Target> {
  /** Undefined means closed/readonly/fork-held/unbound; no parsing or effects. */
  capture(): Target | undefined;
  /** Must include WS write auth/open, target backend/transport and runtime epochs. */
  isCurrent(target: Target): boolean;
  /** Run under the captured runtime, including timer and promise continuations. */
  runInTarget?<T>(target: Target, run: () => T): T;
  write(target: Target, data: string, owner: symbol): void | boolean | 'queued';
  beforeUserInput(target: Target): Promise<boolean>;
  cancelEffort?(target: Target): Promise<void>;
  onUserInput?(target: Target, data: string, maySubmit: boolean): void;
  audit?(target: Target, input: WebTerminalInputClassification): void;
  /** Metadata only. false may clear an old target's lease but must not write to it. */
  onPendingChange?(target: Target, pending: boolean): void;
  onOverflow?(target: Target): void;
  /** Some paste bytes reached the writer but their completion is unproven. */
  onTransportUncertain?(target: Target): void;
  /** Connections sharing one physical CLI must share its writer state. */
  wireState?(target: Target): WebTerminalInputWireState;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
}

export type WebTerminalInputOutcome = 'forwarded' | 'pending' | 'refused' | 'failed';

export class WebTerminalInputWireState {
  readonly writer = new WebTerminalInputClassifier({ keepPastePrefixes: true });
  readonly acceptedWriter = new WebTerminalInputClassifier({ keepPastePrefixes: true });
  tail: Promise<unknown> = Promise.resolve();
  pendingUsers = 0;
  private physicalOwner: symbol | undefined;
  private unwritten: Array<{ data: string; owner: symbol; at: number }> = [];
  lastWriter: symbol | undefined;
  dirty = false;
  private completed: Promise<boolean> | undefined;
  private complete: ((ok: boolean) => void) | undefined;
  private acceptedCompleted: Promise<boolean> | undefined;
  private acceptedComplete: ((ok: boolean) => void) | undefined;
  get physicalPastePending(): boolean { return this.writer.inPaste || this.writer.pastePrefixPending; }
  get inPaste(): boolean {
    return this.physicalPastePending || this.acceptedWriter.inPaste || this.acceptedWriter.pastePrefixPending;
  }
  get outstanding(): boolean { return this.unwritten.length > 0; }
  get owner(): symbol | undefined {
    return this.physicalOwner ?? this.unwritten[0]?.owner;
  }
  get pending(): boolean {
    this.writer.expire();
    this.acceptedWriter.expire();
    return this.writer.pending || this.acceptedWriter.pending || this.outstanding;
  }

  waitForPasteEnd(): Promise<boolean> {
    if (this.dirty) return Promise.resolve(false);
    if (!this.inPaste && !this.outstanding) return Promise.resolve(true);
    this.completed ??= new Promise(resolve => { this.complete = resolve; });
    return this.completed;
  }
  /** A reply on the same pre-attach queue can follow its accepted END. It
   * still stays outstanding until the physical writer acknowledges replay. */
  waitForAcceptedPasteEnd(): Promise<boolean> {
    if (this.dirty) return Promise.resolve(false);
    if (!this.acceptedWriter.inPaste && !this.acceptedWriter.pastePrefixPending) return Promise.resolve(true);
    this.acceptedCompleted ??= new Promise(resolve => { this.acceptedComplete = resolve; });
    return this.acceptedCompleted;
  }
  written(data: string, owner: symbol): void {
    const wasPaste = this.physicalPastePending;
    this.writer.push(data, { forceUser: true });
    this.lastWriter = owner;
    if (!wasPaste && this.physicalPastePending) this.physicalOwner = owner;
    if (!this.physicalPastePending) this.physicalOwner = undefined;
    const queued = this.unwritten[0];
    if (queued?.owner === owner && queued.data === data) this.unwritten.shift();
    this.rebuildAccepted();
    this.releaseWaiters();
  }
  accepted(data: string, owner: symbol): void {
    const at = Date.now();
    this.unwritten.push({ data, owner, at });
    this.acceptedWriter.push(data, { forceUser: true }, at);
    this.releaseAcceptedWaiters();
  }
  /** The connection dropped bytes that never reached the physical CLI. */
  discard(owner: symbol): void {
    this.unwritten = this.unwritten.filter(input => input.owner !== owner);
    this.rebuildAccepted();
    this.releaseAcceptedWaiters();
    this.releaseWaiters();
  }
  private rebuildAccepted(): void {
    this.acceptedWriter.copyFrom(this.writer);
    for (const input of this.unwritten) this.acceptedWriter.push(input.data, { forceUser: true }, input.at);
  }
  private releaseWaiters(): void {
    if (this.dirty || this.inPaste || this.outstanding) return;
    this.complete?.(true); this.complete = undefined; this.completed = undefined;
  }
  private releaseAcceptedWaiters(): void {
    if (this.dirty || this.acceptedWriter.inPaste || this.acceptedWriter.pastePrefixPending) return;
    this.acceptedComplete?.(true); this.acceptedComplete = undefined; this.acceptedCompleted = undefined;
  }
  fail(): void {
    this.dirty = true;
    this.complete?.(false); this.complete = undefined; this.completed = undefined;
    this.acceptedComplete?.(false); this.acceptedComplete = undefined; this.acceptedCompleted = undefined;
  }
}

/**
 * No global queue. Pure replies bypass user cancellation waits. Only admitted
 * user batches serialize locally, with bounded retained bytes/messages.
 * This is the production side-effect seam, not merely a classifier label.
 */
export class WebTerminalInputController<Target> {
  private readonly classifier: WebTerminalInputClassifier;
  private wire = new WebTerminalInputWireState();
  private readonly identity = Symbol('web-input-writer');
  private wireDirty = false;
  private dirtyTarget: Target | undefined;
  private protocolCount = 0;
  private protocolBytes = 0;
  private target: Target | undefined;
  private epoch = 0;
  private disposed = false;
  private held = false;
  private userCount = 0;
  private userBytes = 0;
  private timer: unknown;
  private timerToken: object | undefined;
  private readonly waits = new Set<(ok: boolean) => void>();
  private readonly maxUserBytes: number;
  private readonly maxUserMessages: number;

  constructor(private readonly deps: WebTerminalInputControllerDependencies<Target>,
    options: { carryMs?: number; maxCarry?: number; maxUserBytes?: number; maxUserMessages?: number } = {}) {
    this.classifier = new WebTerminalInputClassifier(options);
    this.maxUserBytes = options.maxUserBytes ?? 256 * 1024;
    this.maxUserMessages = options.maxUserMessages ?? 128;
    if (!Number.isSafeInteger(this.maxUserBytes) || this.maxUserBytes < 1
      || !Number.isSafeInteger(this.maxUserMessages) || this.maxUserMessages < 1) throw new RangeError('invalid web input queue limits');
    if (!!deps.setTimer !== !!deps.clearTimer) throw new Error('web input timer pair required');
  }

  get pending(): boolean {
    if (this.wire.dirty) {
      const target = this.dirtyTarget ?? this.target;
      return target !== undefined && this.deps.isCurrent(target);
    }
    if (this.target !== undefined && !this.deps.isCurrent(this.target)) this.reset();
    if (this.wireDirty) return this.dirtyTarget !== undefined && this.deps.isCurrent(this.dirtyTarget);
    return this.held || (!!this.target && this.deps.isCurrent(this.target) && this.wire.inPaste);
  }

  accept(data: string, options: { forceUser?: unknown } = {}): Promise<WebTerminalInputOutcome> {
    const captured = this.deps.capture();
    if (captured === undefined || !this.deps.isCurrent(captured)) {
      this.reset(); return Promise.resolve('refused');
    }
    const offeredWire = this.deps.wireState?.(captured);
    if (this.target !== undefined && !this.deps.isCurrent(this.target)) this.reset();
    if (this.disposed) {
      // Only an authoritative NEW physical wire can recover uncertain state.
      // Re-granting the same socket/binding on the old wire is not recovery.
      if (!this.wireDirty || !offeredWire || offeredWire === this.wire || offeredWire.dirty
        || !this.deps.isCurrent(captured)) return Promise.resolve('refused');
      this.wire = offeredWire; this.wireDirty = false; this.dirtyTarget = undefined;
      this.disposed = false; this.target = undefined;
    }
    if (this.target === undefined) {
      this.target = captured;
      this.wire = offeredWire ?? this.wire;
    }
    if (this.wire.dirty) return Promise.resolve('refused');
    const target = this.target;
    return this.inTarget(target, () => {
      const input = this.classifier.push(data, options, this.now());
      const result = this.consume(target, input);
      this.syncHold(); this.armTimer(target);
      return result;
    });
  }

  dispose(): void {
    if (this.wire.physicalPastePending && this.wire.owner === this.identity && this.target !== undefined) this.markUncertain(this.target);
    this.disposed = true; this.reset();
  }

  private markUncertain(target: Target): void {
    if (this.wireDirty) return;
    this.wireDirty = true; this.dirtyTarget = target; this.disposed = true;
    this.wire.fail();
    this.deps.onTransportUncertain?.(target);
  }

  private protocol(target: Target, input: WebTerminalInputClassification): Promise<WebTerminalInputOutcome> {
    const epoch = this.epoch;
    const run = (): WebTerminalInputOutcome => {
      if (this.disposed || this.wire.dirty || epoch !== this.epoch || !this.deps.isCurrent(target)) return 'refused';
      const followsOwnQueuedEnd = this.wire.outstanding && this.wire.owner === this.identity
        && !this.wire.acceptedWriter.inPaste && !this.wire.acceptedWriter.pastePrefixPending;
      if (this.wire.inPaste && !followsOwnQueuedEnd) {
        this.markUncertain(target); this.reset(); return 'refused';
      }
      try {
        this.deps.audit?.(target, input);
        if (!this.deps.isCurrent(target) || this.disposed) return 'refused';
        const written = this.deps.write(target, input.data, this.identity);
        if (written === false) return 'refused';
        this.wire.accepted(input.data, this.identity);
        // Track bytes actually accepted by the writer, independently of the
        // receive-side parser. Its prefix clock does not expire between writes.
        if (written !== 'queued') this.wire.written(input.data, this.identity);
        return 'forwarded';
      } catch { return 'failed'; }
    };
    const wire = this.wire;
    const followsOwnQueuedEnd = wire.outstanding && wire.owner === this.identity
      && !wire.acceptedWriter.inPaste && !wire.acceptedWriter.pastePrefixPending;
    if (followsOwnQueuedEnd || !(wire.inPaste || wire.outstanding || (wire.pending && wire.pendingUsers > 0))) {
      return Promise.resolve(this.inTarget(target, run));
    }
    const bytes = Buffer.byteLength(input.data, 'utf8');
    if (this.protocolCount + this.userCount + 1 > this.maxUserMessages
      || this.protocolBytes + this.userBytes + bytes > this.maxUserBytes) {
      this.dispose(); this.deps.onOverflow?.(target); return Promise.resolve('refused');
    }
    this.protocolCount++; this.protocolBytes += bytes; this.syncHold();
    // Only replies which would cross an unfinished writer sequence wait.
    // Ordinary replies still bypass cancellation; this path does not cancel.
    const wait = wire.outstanding && wire.owner === this.identity
      ? wire.waitForAcceptedPasteEnd()
      : wire.inPaste || wire.outstanding ? wire.waitForPasteEnd() : wire.tail.then(() => true, () => true);
    const result = this.waitForWire(wait).then(ok => ok ? this.inTarget(target, run) : 'refused' as const)
      .finally(() => {
        if (epoch === this.epoch) {
          this.protocolCount--; this.protocolBytes -= bytes; this.syncHold();
        }
      });
    return result;
  }

  private consume(target: Target, input: WebTerminalInputClassification): Promise<WebTerminalInputOutcome> {
    if (!this.deps.isCurrent(target) || this.disposed) return Promise.resolve('refused');
    if (!input.data) return Promise.resolve(input.pending ? 'pending' : 'forwarded');
    if (!input.hasUser) {
      return this.protocol(target, input);
    }
    const bytes = Buffer.byteLength(input.data, 'utf8');
    if (this.userCount + this.protocolCount + 1 > this.maxUserMessages
      || this.userBytes + this.protocolBytes + bytes > this.maxUserBytes) {
      this.dispose(); this.deps.onOverflow?.(target);
      return Promise.resolve('refused');
    }
    const epoch = this.epoch;
    const wire = this.wire;
    wire.pendingUsers++;
    this.userCount++; this.userBytes += bytes; this.syncHold();
    const owns = () => !this.disposed && !wire.dirty && epoch === this.epoch && this.deps.isCurrent(target);
    const run = () => this.inTarget(target, async (): Promise<WebTerminalInputOutcome> => {
      let attemptedWrite = false;
      const refuse = (uncertainWrite = false) => {
        if (epoch !== this.epoch) return;
        if ((wire.physicalPastePending && wire.owner === this.identity)
          || (uncertainWrite && attemptedWrite && input.pasteRelated)) this.markUncertain(target);
        this.reset();
      };
      try {
        if (!owns()) { refuse(); return 'refused'; }
        // Another connection must not inject a user batch into the paste
        // currently owned by this wire's writer.
        if (wire.physicalPastePending && wire.owner !== this.identity) { this.reset(); return 'refused'; }
        // Accepted pre-attach data owns its ordering barrier until replay or
        // explicit discard, even if a complete paste has already been parsed.
        if (wire.outstanding && wire.owner !== this.identity) {
          // Never hold the user tail while waiting for a different owner:
          // that owner may still need the tail to accept its paste END.
          refuse(); return 'refused';
        }
        if (!await this.deps.beforeUserInput(target)) {
          refuse();
          return 'refused';
        }
        if (!owns()) { refuse(); return 'refused'; }
        if (this.deps.cancelEffort) {
          await this.deps.cancelEffort(target);
          if (!owns()) { refuse(); return 'refused'; }
        }
        this.deps.audit?.(target, input);
        if (!owns()) { refuse(); return 'refused'; }
        this.deps.onUserInput?.(target, input.data, input.maySubmit);
        if (!owns()) { refuse(); return 'refused'; }
        attemptedWrite = true;
        const written = this.deps.write(target, input.data, this.identity);
        if (written === false) {
          refuse();
          return 'refused';
        }
        wire.accepted(input.data, this.identity);
        if (written !== 'queued') wire.written(input.data, this.identity);
        return 'forwarded';
      } catch {
        refuse(true);
        return 'failed';
      }
      finally {
        wire.pendingUsers--;
        if (epoch === this.epoch) {
          this.userCount--; this.userBytes -= bytes; this.syncHold();
        }
      }
    });
    const enqueue = () => {
      const result = wire.tail.then(run, run);
      wire.tail = result;
      return result;
    };
    if (wire.outstanding && wire.owner !== this.identity) {
      return this.waitForWire(wire.waitForPasteEnd()).then(ok => ok ? enqueue() : run());
    }
    return enqueue();
  }

  private waitForWire(wait: Promise<boolean>): Promise<boolean> {
    return new Promise(resolve => {
      const finish = (ok: boolean) => { this.waits.delete(finish); resolve(ok); };
      this.waits.add(finish);
      void wait.then(finish, () => finish(false));
    });
  }
  private inTarget<T>(target: Target, run: () => T): T { return this.deps.runInTarget ? this.deps.runInTarget(target, run) : run(); }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private syncHold(): void {
    const hold = this.classifier.pending || this.userCount > 0 || this.protocolCount > 0
      || (!!this.target && this.wire.dirty && this.deps.isCurrent(this.target));
    if (hold === this.held) return;
    this.held = hold;
    if (this.target !== undefined) this.deps.onPendingChange?.(this.target, hold);
  }
  private clearTimer(): void {
    this.timerToken = undefined;
    if (this.timer === undefined) return;
    if (this.deps.clearTimer) this.deps.clearTimer(this.timer);
    else clearTimeout(this.timer as ReturnType<typeof setTimeout>);
    this.timer = undefined;
  }
  private armTimer(target: Target): void {
    this.clearTimer();
    const deadline = this.classifier.deadline;
    if (deadline === undefined) return;
    const epoch = this.epoch;
    const token = {};
    this.timerToken = token;
    const tick = () => {
      if (this.timerToken !== token) return;
      this.timerToken = undefined;
      this.timer = undefined;
      if (epoch !== this.epoch || this.disposed) return;
      if (!this.deps.isCurrent(target)) { this.reset(); return; }
      this.inTarget(target, () => {
        const input = this.classifier.expire(this.now());
        void this.consume(target, input);
        this.syncHold(); this.armTimer(target);
      });
    };
    const ms = Math.max(0, deadline - this.now());
    if (this.deps.setTimer) this.timer = this.deps.setTimer(tick, ms);
    else { const timer = setTimeout(tick, ms); timer.unref?.(); this.timer = timer; }
  }
  private reset(): void {
    const target = this.target, wasHeld = this.held;
    if (!this.wireDirty && target !== undefined && this.wire.physicalPastePending
      && this.wire.owner === this.identity) this.markUncertain(target);
    this.wire.discard(this.identity);
    this.clearTimer(); this.epoch++;
    this.classifier.reset(); this.userCount = 0; this.userBytes = 0;
    this.protocolCount = 0; this.protocolBytes = 0;
    this.held = false; this.target = undefined;
    for (const finish of this.waits) finish(false);
    if (wasHeld && target !== undefined
      && (!this.wireDirty || !this.deps.isCurrent(target))) this.deps.onPendingChange?.(target, false);
  }
}
