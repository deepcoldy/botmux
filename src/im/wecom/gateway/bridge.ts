/**
 * The WeCom bridge: owns the persisted state document of one `botmux wecom`
 * connection and turns platform events into core turns and replies.
 *
 * The class holds the state, the constructor loads and normalises state.json, and the
 * methods forward to the modules under ./bridge/, which run with `this` bound to the
 * bridge. ./bridge/types.ts holds the transport / core ports and the state shape.
 */
import { existsSync } from 'node:fs';
import { AsyncSerialQueue } from '../../../utils/async-serial-queue.js';
import type { TerminalMintClient } from './bridge/terminal-mint.js';
import type { requestNativePeer, NativePeerRequest } from './native-peers.js';
import type { WecomPeerOperation } from '../config/peer-trust.js';
import type { WecomRepository } from './native-repos.js';
import { emptyNativeCoreState } from './native-core.js';
import { wecomRouteForMessage } from '../config/session-mode.js';
import type { TriggerResponse } from '../../../services/trigger-types.js';
import { WecomReminderController } from './reminders.js';
import type { WecomInboundMessage, WecomTemplateCard, WecomCardEvent } from '../protocol/types.js';
import type { WecomAdmissionEvent, WecomAdmissionOutcome } from '../contract/dashboard-dto.js';
import type { WecomTerminalAuthorization } from '../contract/gateway-control.js';
import type { WecomStateWriteFailure } from '../contract/state-write-failure.js';
import type {
  State,
  WecomBridgePolicy,
  BridgeTransport,
  WecomCore,
  Task,
  WecomSessionOperation,
  WecomSessionActionResult,
  WecomControlResult,
} from './bridge/types.js';
import * as stateStore from './bridge/state-store.js';
import * as access from './bridge/access.js';
import * as addressing from './bridge/addressing.js';
import * as outbound from './bridge/outbound.js';
import * as peer from './bridge/peer.js';
import * as cardEvents from './bridge/card-events.js';
import * as sessionControl from './bridge/session-control.js';
import * as inbound from './bridge/inbound.js';
import * as results from './bridge/results.js';
import * as tickLoop from './bridge/tick.js';

export type {
  BridgeTransport,
  WecomCore,
  WecomSessionOperation,
  WecomSessionActionResult,
  WecomControlResult,
  WecomBridgePolicy,
} from './bridge/types.js';

export class WecomBridge {
  state: State;
  readonly reminders: WecomReminderController;
  /** Per route, the repositories its latest bare `/repo` listed: what `/repo <n>` picks from. Memory only. */
  readonly repoListings = new Map<string, WecomRepository[]>();
  poisoned = false;
  halted = false;
  /** The lane network-bound work runs on, one task at a time (bridge/state-store.ts enqueue). */
  readonly serial = new AsyncSerialQueue();
  /** A failed CLI-ask dispatch was logged and no tick has dispatched asks cleanly since (set in bridge/running-turn.ts, reset in bridge/tick.ts). Memory only. */
  asksFailureLogged = false;
  /** The text of the last successful write of state.json; unset until this bridge first wrote (bridge/state-store.ts). Memory only. */
  savedState: string | undefined = undefined;
  /** When this bridge last pruned its state (bridge/prune.ts); unset until the first prune. Memory only. */
  lastPruneAt: number | undefined = undefined;

  constructor(readonly options: {
    botId: string;
    connectionId?: string;
    allowedUsers: string[];
    policy?: () => WecomBridgePolicy;
    onAdmission?: (event: WecomAdmissionEvent) => void | Promise<void>;
    coreIdentity?: string;
    stateFile: string;
    transport: BridgeTransport;
    core: WecomCore;
    peerRequest?: typeof requestNativePeer;
    /** Tests only: the WeCom configuration root peers are looked up in (production: wecomRoot()). */
    peerRoot?: string;
    /** Diagnostic lines of the gateway log (production: stderr). */
    log?: (line: string) => void;
    /**
     * Hears the first failed write of state.json, once, after the bridge is
     * poisoned (bridge/state-store.ts save). Observation only: a throw or a
     * rejection is ignored.
     */
    onStateWriteFailure?: (failure: WecomStateWriteFailure) => void | Promise<void>;
    /** Tests only. Production signs a new client for every terminal link, at the
     *  Dashboard port `.dashboard-port` names at that moment (bridge/terminal-mint.ts). */
    terminalMintClient?: TerminalMintClient;
  }) {
    this.state = existsSync(options.stateFile)
      ? stateStore.readWecomStateFile(options.stateFile)
      : { version: 1, botId: options.botId, routes: {}, seen: {}, tasks: {} };
    if (options.connectionId) {
      if (this.state.connectionId && this.state.connectionId !== options.connectionId) {
        throw new Error('wecom_connection_identity_mismatch');
      }
      this.state.connectionId = options.connectionId;
    }
    this.state.seen ??= {};
    this.state.native ??= emptyNativeCoreState();
    if (typeof this.state.native !== 'object' || Array.isArray(this.state.native)) {
      throw new stateStore.WecomStateFileUnreadableError();
    }
    // A record missing some of its tables gets them empty; every other key it
    // carries, known or not, is kept as it is.
    const nativeDefaults = emptyNativeCoreState();
    for (const table of ['grants', 'requests', 'receipts', 'privateUsers', 'selectedRepos', 'actions'] as const) {
      (this.state.native as unknown as Record<string, unknown>)[table] ??= nativeDefaults[table];
    }
    this.state.native.epoch ??= nativeDefaults.epoch;
    for (const receipt of Object.values(this.state.native.peerReceipts ?? {})) {
      if (receipt.status === 'pending') {
        receipt.status = 'uncertain';
      }
    }
    for (const key of Object.keys(this.state.native.actions)) {
      if (this.state.native.actions[key] === 'pending') {
        this.state.native.actions[key] = 'uncertain';
      }
    }
    this.reminders = new WecomReminderController({
      state: this.state,
      tasks: () => Object.values(this.state.tasks),
      policy: () => {
        try {
          return this.policy();
        } catch {
          return {};
        }
      },
      allowed: user => this.allowed(user),
      current: task => {
        try {
          return !!task.sessionId
            && this.state.routes[task.route] === task.sessionId
            && !['pending', 'uncertain'].includes(this.state.sessionLocks?.[task.sessionId] ?? '')
            && wecomRouteForMessage(task.message, this.policy()) === task.route;
        } catch {
          return false;
        }
      },
      reminderState: options.core.reminderState
        ? (sid, trigger) => options.core.reminderState!(sid, trigger)
        : undefined,
      send: (recipient, text) => options.transport.send(recipient, text),
      sanitize: text => this.sanitize(text),
      save: () => this.save(),
      now: Date.now,
    });
    for (const intent of Object.values(this.state.controls ?? {})) {
      if (intent.status === 'pending') {
        intent.status = 'uncertain';
        if (intent.operation !== 'interrupt') {
          (this.state.sessionLocks ??= {})[intent.sessionId] = 'uncertain';
        }
      }
    }
    if (this.state.version !== 1 || this.state.botId !== options.botId || !this.state.routes || !this.state.tasks) {
      throw new Error('企微状态文件版本或机器人身份不匹配');
    }
    if (options.coreIdentity) {
      if ((this.state.coreIdentity && this.state.coreIdentity !== options.coreIdentity)
        || (!this.state.coreIdentity && Object.keys(this.state.tasks).length > 0)) {
        throw new Error('桥接状态不属于当前专用 core，请指定独立的新 stateDir；原状态保持不变');
      }
      this.state.coreIdentity = options.coreIdentity;
    }
    // Upgrade only from durable authenticated fresh-task admission, never the
    // latest speaker of a continued/shared session. First creator remains fixed.
    for (const task of Object.values(this.state.tasks)) {
      this.reminders.rememberOwner(task, !task.request.target.sessionId);
    }
  }

  // Gateway API (command.ts, gateway-control.ts).
  receive(message: WecomInboundMessage): Promise<void> {
    return inbound.receive.call(this, message);
  }

  tick(): Promise<void> {
    return tickLoop.tick.call(this);
  }

  receiveCardEvent(event: WecomCardEvent): Promise<void> {
    return cardEvents.receiveCardEvent.call(this, event);
  }

  controlSession(
    input: {
      sessionId: string;
      operation: WecomSessionOperation;
      requestId: string;
      expectedGeneration?: string;
      authorize?: () => boolean;
    },
    action: (sessionId: string, operation: WecomSessionOperation) => Promise<WecomSessionActionResult>,
  ): Promise<WecomControlResult> {
    return sessionControl.controlSession.call(this, input, action);
  }

  receivePeer(input: NativePeerRequest): Promise<Record<string, unknown>> {
    return peer.receivePeer.call(this, input);
  }

  terminalAuthorization(
    input: {
      identity: { provider: string; connectionId: string; botId: string; userId: string };
      sessionId: string;
      triggerId: string;
      permission: 'read' | 'write';
    },
  ): WecomTerminalAuthorization {
    return access.terminalAuthorization.call(this, input);
  }

  halt(): void {
    this.halted = true;
  }

  // Shared by the ./bridge/ modules through `this`; not used outside the gateway bridge.
  policy(): WecomBridgePolicy {
    return this.options.policy?.() ?? { allowedUsers: this.options.allowedUsers };
  }

  save(): void {
    return stateStore.save.call(this);
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    // Instantiated explicitly so Function.prototype.call keeps the type parameter.
    return (stateStore.enqueue<T>).call(this, fn);
  }

  capability(message: Pick<WecomInboundMessage, 'userId' | 'chatType' | 'conversationId'>, quota?: boolean) {
    return access.capability.call(this, message, quota);
  }

  taskAllowed(task: Task): boolean {
    return access.taskAllowed.call(this, task);
  }

  allowed(userId: string): boolean {
    return access.allowed.call(this, userId);
  }

  revoke(task: Task): void {
    return access.revoke.call(this, task);
  }

  recipient(task: Task): string {
    return addressing.recipient.call(this, task);
  }

  replyTask(task: Task, text: string, options?: { streamId?: string; finish?: boolean }): Promise<void> {
    return addressing.replyTask.call(this, task, text, options);
  }

  routeForMessage(message: WecomInboundMessage): string {
    return addressing.routeForMessage.call(this, message);
  }

  sanitize(text: string, policy?: WecomBridgePolicy): string {
    return outbound.sanitize.call(this, text, policy);
  }

  sanitizeCard(card: WecomTemplateCard): WecomTemplateCard {
    return outbound.sanitizeCard.call(this, card);
  }

  sendCard(recipient: string, card: WecomTemplateCard): Promise<void> {
    return outbound.sendCard.call(this, recipient, card);
  }

  updateCard(event: WecomCardEvent, card: WecomTemplateCard): Promise<void> {
    return outbound.updateCard.call(this, event, card);
  }

  peerAccepted(peerId: string, operation: WecomPeerOperation): boolean {
    return peer.peerAccepted.call(this, peerId, operation);
  }

  peerOnline(peerId: string): boolean {
    return peer.peerOnline.call(this, peerId);
  }

  localPeerIds(): string[] {
    return peer.localPeerIds.call(this);
  }

  sendPeer(peerId: string, body: NativePeerRequest): Promise<Record<string, unknown>> {
    return peer.sendPeer.call(this, peerId, body);
  }

  peerBody(
    peerId: string,
    message: WecomInboundMessage,
    operation: NativePeerRequest['operation'],
    requestId: string,
  ): NativePeerRequest {
    return peer.peerBody.call(this, peerId, message, operation, requestId);
  }

  peerCall(task: Task, operation: 'result' | 'interrupt'): Promise<TriggerResponse> {
    return peer.peerCall.call(this, task, operation);
  }

  admission(outcome: WecomAdmissionOutcome, message: WecomInboundMessage): void {
    return inbound.admission.call(this, outcome, message);
  }

  resultPrivacyKey(policy: WecomBridgePolicy): string {
    return results.resultPrivacyKey.call(this, policy);
  }

  renderTaskResult(task: Task, policy: WecomBridgePolicy): string {
    return results.renderTaskResult.call(this, task, policy);
  }

  auxiliaryCards(task: Task): Promise<void> {
    return results.auxiliaryCards.call(this, task);
  }
}
