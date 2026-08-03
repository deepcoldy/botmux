import type {
  CodexAppFinalMarker,
  CodexAppLifecycleCategory,
  CodexAppLifecycleEvent,
  CodexAppLifecycleOperation,
  CodexAppRunnerInput,
} from './codex-app-runner-protocol.js';
import type { CodexAppTurnInput } from '../types.js';

type JsonObject = Record<string, unknown>;

export class CodexAppRpcResponseError extends Error {
  readonly code?: number;
  readonly data?: unknown;

  constructor(readonly method: string, error: unknown) {
    const payload = isRecord(error) ? error : {};
    const detail = typeof payload.message === 'string'
      ? payload.message
      : JSON.stringify(error);
    super(`${method}: ${detail}`);
    this.name = 'CodexAppRpcResponseError';
    this.code = typeof payload.code === 'number' ? payload.code : undefined;
    this.data = payload.data;
  }
}

export class CodexAppTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexAppTransportError';
  }
}

export interface CodexAppPreparedInput {
  input: Array<Record<string, unknown>>;
  additionalContext?: CodexAppTurnInput['additionalContext'];
  clientUserMessageId?: string;
  visibleText: string;
  structured: boolean;
  skippedImages?: string[];
}

export interface CodexAppTurnControllerDeps {
  cwd: string;
  ensureThread(): Promise<string>;
  request(method: string, params: unknown): Promise<unknown>;
  prepareInput(input: CodexAppRunnerInput, structuredDisabled: boolean): CodexAppPreparedInput;
  isStartCapabilityError?(error: unknown): boolean;
  onTurnInput?(input: CodexAppRunnerInput, prepared: CodexAppPreparedInput): void;
  onOutput?(text: string): void;
  onDiagnostic?(message: string): void;
  onLifecycle?(event: CodexAppLifecycleEvent): void;
  onFinal(marker: CodexAppFinalMarker & { appTurnId: string }): void;
  onPrompt?(): void;
  now?(): number;
}

type TurnPhase = 'starting' | 'active' | 'closing';

interface ActiveTurn {
  phase: TurnPhase;
  threadId?: string;
  appTurnId?: string;
  replyTurnId?: string;
  startedAtMs: number;
  finalText: string;
  allAgentText: string;
  itemText: Map<string, string>;
  completionSeen: boolean;
  serverStarted: boolean;
  steeringClosed: boolean;
  steerInFlight?: CodexAppRunnerInput;
  turnStartedEmitted: boolean;
  completionRaceEmitted: boolean;
  finalEmitted: boolean;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function turnIdFromParams(params: JsonObject): string | undefined {
  const turn = isRecord(params.turn) ? params.turn : undefined;
  return stringField(turn?.id) ?? stringField(params.turnId);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isDefiniteSteerRejection(error: CodexAppRpcResponseError): boolean {
  // JSON-RPC parse/method/params errors prove the operation was not accepted.
  if (error.code === -32600 || error.code === -32601 || error.code === -32602) return true;
  let dataText = '';
  try { dataText = JSON.stringify(error.data ?? '').toLowerCase(); } catch { /* untrusted data */ }
  const detail = `${error.message} ${dataText}`.toLowerCase();
  return detail.includes('no active turn to steer')
    || detail.includes('activeturnnotsteerable')
    || detail.includes('active turn not steerable')
    || detail.includes('expectedturnid')
    || detail.includes('expected turn id')
    || detail.includes('cannot steer a review turn')
    || detail.includes('cannot steer a compact turn')
    || detail.includes('input must not be empty');
}

const CLOSED_TURN_LIMIT = 64;

export class CodexAppTurnController {
  private readonly queue: CodexAppRunnerInput[] = [];
  private readonly closedTurnIds = new Set<string>();
  private active: ActiveTurn | null = null;
  private fatal = false;
  private structuredDisabled = false;
  private failureSequence = 0;
  private driving = false;
  private driveAgain = false;

  constructor(private readonly deps: CodexAppTurnControllerDeps) {}

  enqueue(input: CodexAppRunnerInput): void {
    if (this.fatal) {
      this.emitStandaloneFailure(input, 'Codex App runner is unavailable.');
      return;
    }
    this.queue.push(input);
    this.emitLifecycle({
      kind: 'input_queued',
      atMs: this.now(),
      queueLength: this.queue.length,
      ...(input.replyTurnId ? { replyTurnId: input.replyTurnId } : {}),
    });
    this.drive();
  }

  handleNotification(message: unknown): void {
    if (!isRecord(message) || typeof message.method !== 'string' || !isRecord(message.params)) return;
    const turn = this.active;
    if (!turn) return;

    const params = message.params;
    const notificationThreadId = stringField(params.threadId);
    if (turn.threadId && notificationThreadId && notificationThreadId !== turn.threadId) return;

    const notificationTurnId = turnIdFromParams(params);
    if (notificationTurnId && this.closedTurnIds.has(notificationTurnId)) return;
    if (turn.appTurnId && notificationTurnId && notificationTurnId !== turn.appTurnId) return;

    if (message.method === 'turn/started') {
      turn.serverStarted = true;
      if (notificationTurnId && !this.adoptAppTurnId(turn, notificationTurnId)) return;
      if (!turn.completionSeen) turn.phase = 'active';
      this.drive();
      return;
    }

    if (message.method === 'item/started') {
      const item = isRecord(params.item) ? params.item : undefined;
      if (item?.type === 'commandExecution') {
        this.deps.onOutput?.(`\n$ ${String(item.command ?? '')}\n`);
      } else if (item?.type === 'fileChange') {
        this.deps.onOutput?.('\n[files changed]\n');
      }
      return;
    }

    if (message.method === 'item/agentMessage/delta') {
      const delta = String(params.delta ?? '');
      const itemId = String(params.itemId ?? '');
      turn.itemText.set(itemId, (turn.itemText.get(itemId) ?? '') + delta);
      turn.allAgentText += delta;
      this.deps.onOutput?.(delta);
      return;
    }

    if (message.method === 'item/commandExecution/outputDelta' || message.method === 'item/fileChange/outputDelta') {
      this.deps.onOutput?.(String(params.delta ?? ''));
      return;
    }

    if (message.method === 'item/completed') {
      const item = isRecord(params.item) ? params.item : undefined;
      if (item?.type === 'agentMessage') {
        const text = typeof item.text === 'string' ? item.text : '';
        if (item.phase === 'final_answer') turn.finalText = text;
        else if (!turn.itemText.has(String(item.id ?? '')) && text) turn.allAgentText += text;
      }
      return;
    }

    if (message.method === 'turn/completed') {
      if (notificationTurnId && !this.adoptAppTurnId(turn, notificationTurnId)) return;
      const completed = isRecord(params.turn) ? params.turn : undefined;
      const completedError = isRecord(completed?.error) ? completed.error : undefined;
      if (typeof completedError?.message === 'string' && !turn.finalText) {
        turn.finalText = `Codex App turn failed: ${completedError.message}`;
      }
      if (turn.steerInFlight && turn.appTurnId && !turn.completionRaceEmitted) {
        turn.completionRaceEmitted = true;
        this.emitLifecycle({
          kind: 'completion_race',
          atMs: this.now(),
          appTurnId: turn.appTurnId,
          replyTurnId: turn.steerInFlight.replyTurnId,
          queueLength: this.queue.length,
          category: 'steer_in_flight',
        });
      }
      turn.completionSeen = true;
      turn.phase = 'closing';
      this.drive();
    }
  }

  handleFatal(
    error: unknown,
    category: Extract<CodexAppLifecycleCategory, 'transport' | 'rpc' | 'protocol' | 'runtime'>
      = this.errorCategory(error),
  ): void {
    if (this.fatal) return;
    this.fatal = true;
    const message = `Codex App runner error: ${errorMessage(error)}`;
    const active = this.active;
    const replyTurnId = active?.steerInFlight?.replyTurnId ?? active?.replyTurnId;
    this.emitLifecycle({
      kind: 'fatal',
      atMs: this.now(),
      operation: this.activeOperation(active),
      category,
      ...(active?.appTurnId ? { appTurnId: active.appTurnId } : {}),
      ...(replyTurnId ? { replyTurnId } : {}),
      queueLength: this.queue.length,
    });
    this.active = null;
    if (active && !active.finalEmitted) {
      if (active.steerInFlight && this.queue[0] === active.steerInFlight) {
        this.queue.shift();
      }
      this.emitFailure(active, replyTurnId, message);
    }
    for (const input of this.queue.splice(0)) this.emitStandaloneFailure(input, message);
  }

  private drive(): void {
    if (this.driving) {
      this.driveAgain = true;
      return;
    }
    this.driving = true;
    try {
      do {
        this.driveAgain = false;
        if (this.fatal) return;
        const turn = this.active;
        if (!turn) {
          const next = this.queue.shift();
          if (!next) return;
          this.startTurn(next);
          return;
        }
        if (turn.completionSeen && !turn.steerInFlight) {
          this.finalizeTurn(turn);
          continue;
        }
        if (
          turn.phase === 'active'
          && turn.appTurnId
          && !turn.steeringClosed
          && !turn.steerInFlight
          && this.queue.length > 0
        ) {
          this.steerQueueHead(turn);
        }
        return;
      } while (this.driveAgain);
    } finally {
      this.driving = false;
      if (this.driveAgain) this.drive();
    }
  }

  private startTurn(input: CodexAppRunnerInput): void {
    const turn: ActiveTurn = {
      phase: 'starting',
      replyTurnId: input.replyTurnId,
      startedAtMs: this.now(),
      finalText: '',
      allAgentText: '',
      itemText: new Map(),
      completionSeen: false,
      serverStarted: false,
      steeringClosed: false,
      turnStartedEmitted: false,
      completionRaceEmitted: false,
      finalEmitted: false,
    };
    this.active = turn;
    this.emitLifecycle({
      kind: 'turn_start_attempt',
      atMs: this.now(),
      queueLength: this.queue.length,
      ...(input.replyTurnId ? { replyTurnId: input.replyTurnId } : {}),
    });
    void this.beginTurnStart(turn, input);
  }

  private async beginTurnStart(turn: ActiveTurn, input: CodexAppRunnerInput): Promise<void> {
    try {
      const threadId = await this.deps.ensureThread();
      if (this.active !== turn || this.fatal) return;
      turn.threadId = threadId;
      let prepared = this.deps.prepareInput(input, this.structuredDisabled);
      this.reportPreparedInput(prepared);
      this.deps.onTurnInput?.(input, prepared);

      let result: unknown;
      try {
        result = await this.deps.request('turn/start', this.turnStartParams(threadId, prepared));
      } catch (error) {
        if (
          prepared.structured
          && !turn.serverStarted
          && this.deps.isStartCapabilityError?.(error)
        ) {
          this.structuredDisabled = true;
          this.deps.onDiagnostic?.(
            '[codex-app] structured input unsupported; retrying this turn with the legacy prompt',
          );
          prepared = this.deps.prepareInput(input, true);
          result = await this.deps.request('turn/start', this.turnStartParams(threadId, prepared));
        } else {
          throw error;
        }
      }

      if (this.active !== turn || this.fatal) return;
      const resultTurn = isRecord(result) && isRecord(result.turn) ? result.turn : undefined;
      const resultTurnId = stringField(resultTurn?.id);
      if (resultTurnId && !this.adoptAppTurnId(turn, resultTurnId)) return;
      if (!turn.appTurnId) {
        this.emitUnknownOutcome(turn, 'turn/start', 'protocol', input.replyTurnId);
        this.handleFatal(new CodexAppTransportError(
          'turn/start returned no app-server turn id.',
        ), 'protocol');
        return;
      }
      if (!turn.completionSeen) turn.phase = 'active';
      this.drive();
    } catch (error) {
      if (this.active !== turn || this.fatal) return;
      if (error instanceof CodexAppTransportError || turn.serverStarted) {
        this.emitUnknownOutcome(
          turn,
          'turn/start',
          error instanceof CodexAppRpcResponseError ? 'rpc' : 'transport',
          input.replyTurnId,
        );
        this.handleFatal(error);
        return;
      }
      this.active = null;
      this.emitFailure(
        turn,
        turn.replyTurnId,
        `Codex App runner error: ${errorMessage(error)}`,
      );
      this.afterTurn();
    }
  }

  private steerQueueHead(turn: ActiveTurn): void {
    const input = this.queue[0];
    if (!input || !turn.threadId || !turn.appTurnId) return;
    turn.steerInFlight = input;
    void this.performSteer(turn, input);
  }

  private async performSteer(turn: ActiveTurn, input: CodexAppRunnerInput): Promise<void> {
    const expectedTurnId = turn.appTurnId!;
    try {
      const prepared = this.deps.prepareInput(input, this.structuredDisabled);
      this.reportPreparedInput(prepared);
      this.emitLifecycle({
        kind: 'steer_attempt',
        atMs: this.now(),
        appTurnId: expectedTurnId,
        ...(input.replyTurnId ? { replyTurnId: input.replyTurnId } : {}),
        queueLength: this.queue.length,
      });
      const result = await this.deps.request('turn/steer', {
        threadId: turn.threadId,
        input: prepared.input,
        expectedTurnId,
        ...(prepared.clientUserMessageId
          ? { clientUserMessageId: prepared.clientUserMessageId }
          : {}),
        ...(prepared.additionalContext
          ? { additionalContext: prepared.additionalContext }
          : {}),
      });
      if (this.active !== turn || this.fatal) return;
      const responseTurnId = isRecord(result) ? stringField(result.turnId) : undefined;
      if (responseTurnId !== expectedTurnId) {
        this.emitUnknownOutcome(turn, 'turn/steer', 'protocol', input.replyTurnId);
        this.handleFatal(new CodexAppTransportError(
          'turn/steer returned an unexpected turn id.',
        ), 'protocol');
        return;
      }
      if (this.queue[0] === input) this.queue.shift();
      turn.replyTurnId = input.replyTurnId ?? turn.replyTurnId;
      this.deps.onTurnInput?.(input, prepared);
      this.emitLifecycle({
        kind: 'steer_accepted',
        atMs: this.now(),
        appTurnId: expectedTurnId,
        ...(input.replyTurnId ? { replyTurnId: input.replyTurnId } : {}),
        queueLength: this.queue.length,
      });
    } catch (error) {
      if (this.active !== turn || this.fatal) return;
      if (
        error instanceof CodexAppRpcResponseError
        && isDefiniteSteerRejection(error)
      ) {
        turn.steeringClosed = true;
        this.emitLifecycle({
          kind: 'steer_rejected_fallback',
          atMs: this.now(),
          appTurnId: expectedTurnId,
          ...(input.replyTurnId ? { replyTurnId: input.replyTurnId } : {}),
          queueLength: this.queue.length,
          category: 'definite_rejection',
        });
        this.deps.onDiagnostic?.('[codex-app] steer rejected; queued for the next turn');
        return;
      }

      this.emitUnknownOutcome(
        turn,
        'turn/steer',
        error instanceof CodexAppRpcResponseError ? 'rpc' : 'transport',
        input.replyTurnId,
      );
      this.handleFatal(new CodexAppTransportError(
        `steer result unknown (${errorMessage(error)})`,
      ));
    } finally {
      if (this.active === turn) {
        turn.steerInFlight = undefined;
        this.drive();
      }
    }
  }

  private turnStartParams(threadId: string, prepared: CodexAppPreparedInput): Record<string, unknown> {
    return {
      threadId,
      input: prepared.input,
      ...(prepared.clientUserMessageId
        ? { clientUserMessageId: prepared.clientUserMessageId }
        : {}),
      ...(prepared.additionalContext
        ? { additionalContext: prepared.additionalContext }
        : {}),
      cwd: this.deps.cwd,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    };
  }

  private reportPreparedInput(prepared: CodexAppPreparedInput): void {
    for (const path of prepared.skippedImages ?? []) {
      this.deps.onDiagnostic?.(`[codex-app] skipped unreadable local image: ${path}`);
    }
  }

  private adoptAppTurnId(turn: ActiveTurn, appTurnId: string): boolean {
    if (!turn.appTurnId) {
      turn.appTurnId = appTurnId;
      this.emitTurnStarted(turn);
      return true;
    }
    if (turn.appTurnId === appTurnId) {
      this.emitTurnStarted(turn);
      return true;
    }
    this.handleFatal(new CodexAppTransportError(
      'app-server turn id changed unexpectedly.',
    ), 'protocol');
    return false;
  }

  private emitTurnStarted(turn: ActiveTurn): void {
    if (turn.turnStartedEmitted || !turn.appTurnId) return;
    turn.turnStartedEmitted = true;
    this.emitLifecycle({
      kind: 'turn_started',
      atMs: this.now(),
      appTurnId: turn.appTurnId,
      ...(turn.replyTurnId ? { replyTurnId: turn.replyTurnId } : {}),
      queueLength: this.queue.length,
    });
  }

  private emitUnknownOutcome(
    turn: ActiveTurn,
    operation: 'turn/start' | 'turn/steer',
    category: 'transport' | 'rpc' | 'protocol',
    replyTurnId: string | undefined,
  ): void {
    this.emitLifecycle({
      kind: 'unknown_outcome',
      atMs: this.now(),
      operation,
      category,
      ...(turn.appTurnId ? { appTurnId: turn.appTurnId } : {}),
      ...(replyTurnId ? { replyTurnId } : {}),
      queueLength: this.queue.length,
    });
  }

  private finalizeTurn(turn: ActiveTurn): void {
    if (this.active !== turn || turn.finalEmitted) return;
    turn.finalEmitted = true;
    const completedAtMs = this.now();
    const appTurnId = turn.appTurnId ?? this.nextFailureId(completedAtMs);
    this.rememberClosedTurn(appTurnId);
    const content = (turn.finalText || turn.allAgentText).trim();
    if (content) {
      this.deps.onFinal({
        appTurnId,
        replyTurnId: turn.replyTurnId,
        content,
        startedAtMs: turn.startedAtMs,
        completedAtMs,
      });
    }
    this.active = null;
    this.afterTurn();
  }

  private emitFailure(turn: ActiveTurn, replyTurnId: string | undefined, content: string): void {
    if (turn.finalEmitted) return;
    turn.finalEmitted = true;
    const completedAtMs = this.now();
    const appTurnId = turn.appTurnId ?? this.nextFailureId(completedAtMs);
    this.rememberClosedTurn(appTurnId);
    this.deps.onDiagnostic?.(content);
    this.deps.onFinal({
      appTurnId,
      replyTurnId,
      content,
      startedAtMs: turn.startedAtMs,
      completedAtMs,
    });
  }

  private emitStandaloneFailure(input: CodexAppRunnerInput, content: string): void {
    const now = this.now();
    this.deps.onDiagnostic?.(content);
    this.deps.onFinal({
      appTurnId: this.nextFailureId(now),
      replyTurnId: input.replyTurnId,
      content,
      startedAtMs: now,
      completedAtMs: now,
    });
  }

  private afterTurn(): void {
    if (this.queue.length === 0) this.deps.onPrompt?.();
    this.drive();
  }

  private rememberClosedTurn(turnId: string): void {
    this.closedTurnIds.add(turnId);
    if (this.closedTurnIds.size <= CLOSED_TURN_LIMIT) return;
    const oldest = this.closedTurnIds.values().next().value;
    if (typeof oldest === 'string') this.closedTurnIds.delete(oldest);
  }

  private nextFailureId(now: number): string {
    return `codex-app-error-${now}-${++this.failureSequence}`;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private emitLifecycle(event: CodexAppLifecycleEvent): void {
    this.deps.onLifecycle?.(event);
  }

  private activeOperation(active: ActiveTurn | null): CodexAppLifecycleOperation {
    if (active?.steerInFlight) return 'turn/steer';
    if (active?.phase === 'starting') return 'turn/start';
    return 'runner';
  }

  private errorCategory(
    error: unknown,
  ): Extract<CodexAppLifecycleCategory, 'transport' | 'rpc' | 'protocol' | 'runtime'> {
    if (error instanceof CodexAppTransportError) return 'transport';
    if (error instanceof CodexAppRpcResponseError) return 'rpc';
    return 'runtime';
  }
}
