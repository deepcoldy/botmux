import { realpathSync } from 'node:fs';
import type { RemoteRunnerCommand, RemoteRunnerEvent, RemoteRunnerBackendState } from '../adapters/backend/remote-runner-protocol.js';
import { MAX_REMOTE_RUNNER_OUTBOUND_MESSAGE_BYTES } from '../adapters/backend/remote-runner-protocol.js';
import { ORCA_RUNNER_CAPABILITIES } from './orca-runner-capabilities.js';
import type { OrcaRuntime } from './orca-runtime-client.js';
import { OrcaManagedSession } from './orca-managed-session.js';
import { OrcaRunnerStore, orcaTurnOperationId, type OrcaRunnerState, type OrcaAgent, type OrcaPendingTurn } from './orca-runner-store.js';
import { orcaMessage, orcaMutation, requireOrcaMutation } from './orca-session-protocol.js';
import { OrcaTurnReader } from './orca-turn-reader.js';
import { OrcaTerminalSession } from './orca-terminal-session.js';
import type { OrcaSurface } from '../core/orca-support.js';

type EventPayload = RemoteRunnerEvent extends infer E ? E extends RemoteRunnerEvent ? Omit<E, 'protocol' | 'version'> : never : never;
type StartCommand = Extract<RemoteRunnerCommand, { type: 'start' | 'resume' }>;

export interface OrcaRunnerOptions {
  agent: OrcaAgent;
  surface?: OrcaSurface;
  profile: string;
  dataDir: string;
  runtime: OrcaRuntime;
  emit: (event: EventPayload) => void;
  pollMs?: number;
}

export class OrcaRunner {
  private store?: OrcaRunnerStore;
  private session?: OrcaManagedSession;
  private terminal?: OrcaTerminalSession;
  private state?: OrcaRunnerState;
  private polling?: Promise<void>;
  private detached = false;
  private disposed = false;
  private closing = false;
  private unlock?: () => void;
  private ownership?: Promise<void>;

  constructor(private readonly options: OrcaRunnerOptions) {}

  async handle(command: RemoteRunnerCommand): Promise<void> {
    try {
      switch (command.type) {
        case 'hello':
          this.emit({ type: 'hello', requestId: command.requestId, provider: 'orca',
            capabilities: [...ORCA_RUNNER_CAPABILITIES] });
          return;
        case 'start': case 'resume': await this.open(command); return;
        case 'turn': await this.turn(command); return;
        case 'outbound_message_result': this.deliveryResult(command); return;
        case 'cancel': await this.close(command.requestId); return;
        case 'detach':
          if (this.polling) await this.polling;
          this.detached = true;
          this.status(command.requestId, 'detached'); return;
        case 'reattach': this.detached = false; this.status(command.requestId, 'ready'); return;
        case 'status': this.status(command.requestId, this.detached ? 'detached' : this.polling ? 'busy' : 'ready'); return;
        default: throw new Error(`Unsupported Orca command: ${command.type}`);
      }
    } catch (error) {
      this.emit({ type: 'failure', requestId: command.requestId,
        ...('turnId' in command ? { turnId: command.turnId } : {}),
        code: 'orca_request_failed', message: error instanceof Error ? error.message : String(error),
        status: 'failed', retryable: false });
    }
  }

  private emit(event: EventPayload): void { if (!this.disposed) this.options.emit(event); }

  private backendState(pendingTurnId?: string): RemoteRunnerBackendState {
    const s = this.state!;
    return {
      version: 1, provider: 'orca', generation: s.generation,
      remoteSessionId: `${s.terminal?.handle ?? s.sessionId}:${s.generation}`,
      ...(s.sessionId ? { agentThreadId: s.sessionId } : {}),
      providerState: { botmuxSessionId: s.botmuxSessionId, cwd: s.cwd, profile: s.profile,
        agent: s.agent, surface: s.surface ?? 'chat', worktreeId: s.worktreeId!, pendingTurnId: pendingTurnId ?? null,
        ...(s.terminal ? { terminalHandle: s.terminal.handle } : {}),
        settledTurnId: s.pending && this.settled(s.pending) ? s.pending.turnId : null },
    };
  }

  private status(requestId: string, status: 'ready' | 'busy' | 'closed' | 'detached'): void {
    const pending = this.state?.pending;
    this.emit({ type: 'status', requestId, status,
      ...(this.state?.sessionId || this.state?.terminal ? { state: this.backendState(pending && !this.settled(pending) ? pending.turnId : undefined) } : {}) });
  }

  private async acquire(sessionId: string): Promise<void> {
    if (this.store) throw new Error('Orca runner is already initialized');
    this.store = new OrcaRunnerStore(this.options.dataDir, sessionId);
    let acquired!: () => void;
    let failed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject; });
    this.ownership = this.store.own(() => new Promise<void>(resolve => {
      this.unlock = resolve;
      acquired();
      if (this.disposed) resolve();
    }));
    this.ownership.catch(failed);
    await ready;
    this.session = new OrcaManagedSession(this.options.runtime, this.store);
  }

  private async open(command: StartCommand): Promise<void> {
    await this.acquire(command.sessionId);
    if (this.disposed) return;
    const identity = { botmuxSessionId: command.sessionId, agent: this.options.agent,
      cwd: realpathSync(command.cwd), profile: realpathSync(this.options.profile), surface: this.options.surface ?? 'terminal' };
    if (command.type === 'resume' && command.state.provider !== 'orca') throw new Error('Cannot resume another provider');
    const state = this.store!.initialize(identity);
    this.state = state;
    if (state.surface === 'terminal') this.terminal = new OrcaTerminalSession(this.options.runtime, this.store!, this.options.pollMs);
    if (command.type === 'resume' && command.state.agentThreadId && command.state.agentThreadId !== state.sessionId) {
      throw new Error('Orca conversation identity differs from the Botmux record');
    }
    if (command.type === 'resume' && command.resumeMode !== 'rebuild' && command.state.generation !== state.generation) {
      throw new Error('Orca resource generation differs from the Botmux record');
    }
    const rebuild = command.type === 'resume' && command.resumeMode === 'rebuild';
    if (rebuild) {
      const retry = state.rebuiltFromGeneration === command.state.generation
        && state.generation === command.state.generation + 1;
      if (!state.closed && !retry) throw new Error('Cannot rebuild an Orca session whose close was not confirmed');
    } else if (state.closed) throw new Error('Orca session is closed; reopen it explicitly');
    await (this.terminal ?? this.session!).open(state, command);
    if (rebuild && state.closed) {
      state.rebuiltFromGeneration = command.state.generation;
      state.generation = command.state.generation + 1;
      state.closed = false;
      delete state.pending;
      this.store!.save(state);
    }
    // Only an exact terminal identity plus our durable delivery receipt permits cleanup.
    if (command.type === 'resume' && (state.pending?.delivery === 'delivered' || state.pending?.delivery === 'rejected')
        && command.state.providerState?.settledTurnId === state.pending.turnId) {
      delete state.pending;
      this.store!.save(state);
    }
    const pending = state.pending;
    if (pending && command.type !== 'resume') throw new Error('Pending Orca turn requires Botmux session recovery');
    this.emit({ type: 'ready', requestId: command.requestId, state: this.backendState(pending?.turnId),
      ...(pending ? { recoveredTurn: { turnId: pending.turnId, generation: state.generation,
        dispatchAttempt: pending.dispatchAttempt, startedAtMs: pending.startedAtMs } } : {}) });
    if (pending) this.watch(pending);
  }

  private async turn(command: Extract<RemoteRunnerCommand, { type: 'turn' }>): Promise<void> {
    if ((!this.state?.sessionId && !this.state?.terminal) || this.state.closed || this.detached || this.polling) throw new Error('Orca session is not ready');
    if (this.state.pending && !this.settled(this.state.pending)) throw new Error('Resolve the previous Orca turn before sending another');
    let pending: OrcaPendingTurn;
    const identity = { turnId: command.turnId, dispatchAttempt: command.dispatchAttempt, startedAtMs: Date.now() };
    if (this.terminal) {
      pending = { ...identity, ...await this.terminal.prepare(this.state, command.content) };
    } else {
      const page = await this.session!.history(this.state);
      if (page.working) throw new Error('This Orca conversation is busy; wait for its current turn');
      // The host serializes the final check with Send. If a desktop turn races our
      // idle probe, queue rather than steer into it. Old hosts reject this strict field.
      const request = orcaMutation('agentSession.send', this.state.sessionId!, page.fence!, {
        body: orcaMessage(command.content), delivery: 'queue-if-active',
      });
      pending = {
        ...identity, cursor: page.liveCursor || page.window.nextCursor, request,
      };
    }
    this.state.pending = pending;
    this.store!.save(this.state);
    this.status(command.requestId, 'busy');
    this.emit({ type: 'lineage_changed', state: this.backendState(pending.turnId) });
    this.watch(pending);
  }

  private watch(pending: OrcaPendingTurn): void {
    this.polling = this.runTurn(pending).catch(error => {
      this.emit({ type: 'failure', turnId: pending.turnId, code: 'orca_turn_unconfirmed',
        message: error instanceof Error ? error.message : String(error), status: 'ambiguous', retryable: false });
    }).finally(() => { this.polling = undefined; });
  }

  private async runTurn(pending: OrcaPendingTurn): Promise<void> {
    if (pending.completed) { this.finish(pending); return; }
    if (!('request' in pending)) {
      if (!this.terminal) throw new Error('Orca terminal turn cannot run in Chat mode');
      const completed = await this.terminal.run(this.state!, pending, {
        stopped: () => this.disposed || this.closing || !!this.state!.closed,
        progress: content => this.emit({ type: 'progress', turnId: pending.turnId, content }),
      });
      if (completed) { pending.completed = completed; this.store!.save(this.state!); this.finish(pending); }
      return;
    }
    // Replaying this exact operation also resolves a send whose response was lost; never mint a replacement ID.
    const sent = await this.options.runtime.call<{ ok: boolean; value?: { queued?: { messageId: string } }; refusal?: { code?: string; message?: string } }>('agentSession.send', pending.request);
    if (!sent.ok) {
      pending.completed = { content: '', failed: sent.refusal?.message || sent.refusal?.code || 'Orca refused this message' };
      this.store!.save(this.state!);
      this.finish(pending);
      return;
    }
    const reader = new OrcaTurnReader(pending.request.envelope.clientOperationId, !!sent.value?.queued);
    let cursor = pending.cursor;
    let lastProgress = '';
    while (!this.disposed && !this.closing && !this.state!.closed) {
      const page = await this.session!.history(this.state!, cursor);
      reader.apply(page);
      if (page.hasNewer && page.window.nextCursor.epoch === cursor.epoch
          && page.window.nextCursor.sequence <= cursor.sequence) throw new Error('Orca history cursor did not advance');
      cursor = page.window.nextCursor;
      const view = reader.view();
      if (view.uncertain && !page.hasNewer) throw new Error(view.uncertain);
      if (view.progress !== lastProgress) {
        const delta = view.progress.startsWith(lastProgress) ? view.progress.slice(lastProgress.length) : '\n' + view.progress;
        if (delta) this.emit({ type: 'progress', turnId: pending.turnId, content: delta });
        lastProgress = view.progress;
      }
      if (view.done && !page.hasNewer) {
        pending.completed = { content: view.text, ...(view.failed ? { failed: view.failed } : {}) };
        this.store!.save(this.state!);
        this.finish(pending);
        return;
      }
      if (!page.hasNewer) await new Promise(resolve => setTimeout(resolve, this.options.pollMs ?? 400));
    }
  }

  private settled(pending: OrcaPendingTurn): boolean {
    return !!pending.completed?.failed || pending.delivery === 'delivered' || pending.delivery === 'rejected';
  }

  private finish(pending: OrcaPendingTurn): void {
    if (pending.completed!.failed) {
      this.emit({ type: 'lineage_changed', state: this.backendState() });
      this.emit({ type: 'failure', turnId: pending.turnId, code: 'orca_turn_failed',
        message: pending.completed!.failed, status: 'failed', retryable: false });
    } else if (pending.delivery === 'delivered') {
      this.emit({ type: 'final', turnId: pending.turnId, content: '', state: this.backendState() });
    } else if (pending.delivery === 'rejected' || pending.delivery === 'unknown') {
      this.emit({ type: 'lineage_changed', state: this.backendState() });
      this.emit({ type: 'failure', turnId: pending.turnId, code: 'orca_reply_unconfirmed',
        message: `Orca completed this turn, but the Bot reply was ${pending.delivery}: ${pending.deliveryError || 'inspect the answer in Orca'}`,
        status: pending.delivery === 'rejected' ? 'failed' : 'ambiguous', retryable: false });
    } else if (pending.delivery) {
      throw new Error('Bot reply delivery is unconfirmed; inspect the answer in Orca. It will not be sent twice automatically');
    } else {
      pending.delivery = 'prepared';
      this.store!.save(this.state!);
      this.emit({ type: 'outbound_message', operationId: orcaTurnOperationId(pending),
        turnId: pending.turnId, generation: this.state!.generation,
        content: orcaReplyContent(pending.completed!.content),
        responseKind: 'final', mention: 'none' });
    }
  }

  private deliveryResult(command: Extract<RemoteRunnerCommand, { type: 'outbound_message_result' }>): void {
    const pending = this.state?.pending;
    if (!pending || command.turnId !== pending.turnId || command.generation !== this.state!.generation
        || command.operationId !== orcaTurnOperationId(pending) || pending.delivery !== 'prepared') {
      throw new Error('Orca delivery receipt does not match the pending reply');
    }
    pending.delivery = command.result.outcome;
    if (command.result.outcome !== 'delivered') {
      pending.deliveryError = `${command.result.code}: ${command.result.message}`;
    }
    this.store!.save(this.state!);
    this.finish(pending);
  }

  private async close(requestId: string): Promise<void> {
    if (!this.state?.sessionId && !this.state?.terminal) throw new Error('Orca session has not been created');
    this.closing = true;
    try {
      if (this.polling) await this.polling;
      if (this.terminal) {
        await this.terminal.close(this.state);
      } else {
        let page = await this.session!.history(this.state);
        requireOrcaMutation(await this.options.runtime.call('agentSession.cancel',
          orcaMutation('agentSession.cancel', this.state.sessionId!, page.fence!, {})));
        page = await this.session!.history(this.state);
        const messageId = this.state.pending ? orcaTurnOperationId(this.state.pending) : undefined;
        if (messageId && page.queuedMessages?.some(q => q.messageId === messageId)) {
          requireOrcaMutation(await this.options.runtime.call('agentSession.queuedMessageDelete',
            orcaMutation('agentSession.queuedMessageDelete', this.state.sessionId!, page.fence!, { messageId })));
        }
        await this.session!.close(this.state);
      }
      this.state.closed = true;
      delete this.state.pending;
      delete this.state.reopenOperationId;
      delete this.state.reopenArgs;
      this.store!.save(this.state);
      this.status(requestId, 'closed');
    } finally { this.closing = false; }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.polling) await this.polling;
    this.unlock?.();
    await this.ownership;
  }
}

/** Keep the full answer in Orca; never send an event the host must reject. */
export function orcaReplyContent(content: string): string {
  if (!content.trim()) return 'Orca completed this turn without a text reply.';
  if (Buffer.byteLength(content) <= MAX_REMOTE_RUNNER_OUTBOUND_MESSAGE_BYTES) return content;
  const note = '\n\n[Reply truncated. Open this conversation in Orca for the complete answer.]';
  // Leave room for a replacement character if the byte boundary splits a UTF-8 code point.
  return Buffer.from(content).subarray(0, MAX_REMOTE_RUNNER_OUTBOUND_MESSAGE_BYTES - Buffer.byteLength(note) - 3)
    .toString('utf8') + note;
}
