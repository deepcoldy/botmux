/**
 * Types of the WeCom bridge: its transport and core ports, the persisted task and
 * state document (state.json; the Dashboard reads the same shape), host control
 * results and the live policy snapshot.
 */
import type { NativeAskState } from '../native-ask.js';
import type { NativeGatewayAskSnapshot, NativeGatewayAskCallback } from '../../../../core/native-gateway-contract.js';
import type { NativeFeedbackState } from '../native-feedback.js';
import type { WecomPlatformState } from '../native-platform.js';
import type { WecomNativePlatformConfig } from '../../config/native-platform-config.js';
import type { NativeCoreState } from '../native-core.js';
import type { WecomNativeCoreConfig } from '../../config/native-core-config.js';
import type { WecomSessionMode } from '../../config/session-mode.js';
import type { CommandTriggerConfig } from '../../../../bot-registry.js';
import type { TriggerRequest, TriggerResponse } from '../../../../services/trigger-types.js';
import type { WecomProgress } from '../presentation.js';
import type { LongReminderCycle, WecomReminderState } from '../reminders.js';
import type { CoreOnlyReminderState } from '../../../../core/core-only-reminder-state.js';
import type { WecomMessageConfig } from '../../config/message-config.js';
import type { FeedbackPolicy } from '../../../../services/feedback-policy.js';
import type { WecomInboundMessage, WecomTemplateCard, WecomCardEvent } from '../../protocol/types.js';
import type { WecomSessionOperation } from '../../contract/gateway-control.js';

// Session control operations and their result are wire types of the gateway
// control server; the contract owns them.
export type { WecomSessionOperation, WecomControlResult } from '../../contract/gateway-control.js';

export interface BridgeTransport {
  reply(message: WecomInboundMessage, text: string, options?: { streamId?: string; finish?: boolean }): Promise<void>;
  send(conversationId: string, text: string): Promise<void>;
  sendCard?(conversationId: string, card: WecomTemplateCard): Promise<void>;
  updateCard?(event: WecomCardEvent, card: WecomTemplateCard): Promise<void>;
}

export interface WecomCore {
  asks?(sessionId: string, triggerId: string): Promise<NativeGatewayAskSnapshot[]>;
  answerAsk?(sessionId: string, body: NativeGatewayAskCallback): Promise<{ outcome: string }>;
  trigger(request: TriggerRequest): Promise<TriggerResponse>;
  result(sessionId: string, triggerId: string): Promise<TriggerResponse>;
  interrupt(sessionId: string, triggerId: string): Promise<void>;
  slash?(sessionId: string, command: string): Promise<void>;
  progress?(sessionId: string, triggerId: string): Promise<WecomProgress | undefined>;
  reminderState?(sessionId: string, triggerId: string): Promise<CoreOnlyReminderState | undefined>;
  close?(sessionId: string): Promise<{ ok: boolean }>;
}

export interface Task {
  message: WecomInboundMessage;
  route: string;
  streamId: string;
  sessionId?: string;
  triggerId?: string;
  /** Frozen before dispatch: retries must never change fresh/continuation semantics. */
  request: TriggerRequest;
  /**
   * The quota-limit hand-over this task was moved to: the peer connection and
   * the turn it runs there. Peer trust is judged again at every step; a record
   * of an earlier version also carries `epoch` / `targetEpoch` and is treated
   * as authority changed (bridge/peer.ts).
   */
  peer?: { id: string; requestId: string; sessionId: string; triggerId: string; epoch?: unknown; targetEpoch?: unknown };
  fallbackIntent?: {
    id: string;
    peerId: string;
    status: 'pending' | 'accepted' | 'cancelled' | 'uncertain';
    limitKey: string;
  };
  dispatchAttempted?: boolean;
  stopRequested?: boolean;
  result?: string;
  /** The turn completed with no visible reply: the model decided nothing needed
   *  saying (the BOTMUX_NOTHING_TO_SEND sentinel settles as empty output). Set
   *  together with `result: ''` in one save; nothing is posted for it. */
  silent?: boolean;
  /** Attempts to close this task's open stream card without an answer (a
   *  silent turn). Bounded: stream
   *  frames update one message in place, so a repeat after a restart cannot add
   *  a second message, but a failing close is never retried for ever. */
  streamCloseAttempts?: number;
  /** What admission put in front of the requester before the answer
   *  (bridge/inbound.ts): a "正在处理…" stream card the answer finishes, or
   *  nothing. `private` (a separate private "正在处理…") was written by earlier
   *  versions only. Saved with the task in its admission save. Absent on tasks
   *  admitted by an earlier build. */
  admissionNotice?: 'stream' | 'private' | 'none';
  /** The platform acknowledged that admission notice. Saved right after it;
   *  only a confirmed notice is ever followed by a close. */
  admissionNoticeSent?: boolean;
  /** The platform acknowledged a progress frame on this task's stream (a frame
   *  that opens the stream card even when admission did not). Saved right
   *  after the acknowledgement. */
  streamFrameAcknowledged?: boolean;
  delivered?: boolean;
  revoked?: boolean;
  proactive?: boolean;
  nextPart?: number;
  createdAt?: number;
  completedAt?: number;
  usage?: TriggerResponse['usage'];
  model?: string;
  renderedResult?: string;
  renderedPrivacyKey?: string;
  progressText?: string;
  observedProgressSignature?: string;
  lastProgressAtMs?: number;
  progressGeneration?: number;
  noProgressNotified?: boolean;
  noProgressRetryAt?: number;
  runningCardAttempted?: boolean;
  finalCardAttempted?: boolean;
  controlsCardAttempted?: boolean;
  workingDirectory?: string;
  feedbackPolicy?: FeedbackPolicy;
  feedback?: Record<string, {
    key: string;
    semantic: string;
    reason?: string;
    comment?: string;
    at: number;
    revision: number;
    pending: boolean;
  }>;
  /** Card callbacks (by messageId) already acted on: a redelivered copy is ignored. */
  cardEvents?: Record<string, true>;
  /** Terminal-link callbacks (by messageId) whose mint the Dashboard rejected and
   *  whose clicker was told so; a redelivered copy that fails again stays quiet. */
  terminalMintRejections?: Record<string, true>;
  longReminder?: LongReminderCycle;
}

/**
 * What the core action of one host control reports (command.ts
 * requestWecomCoreSessionAction). `sessionGone`: the core answered definitely
 * that the session is no longer active, so the action did nothing; only
 * restart / resume / suspend report it.
 */
export interface WecomSessionActionResult {
  ok: boolean;
  sessionGone?: boolean;
}

export interface ControlIntent {
  sessionId: string;
  operation: WecomSessionOperation;
  /** `rejected`: the core definitely refused (the session is no longer active); see controlSession. */
  status: 'completed' | 'uncertain' | 'pending' | 'rejected';
  /** When the intent was recorded (epoch ms). Absent on intents of earlier
   *  versions until a prune stamps them (bridge/prune.ts). */
  at?: number;
}

export interface State  extends WecomReminderState, WecomPlatformState, NativeFeedbackState, NativeAskState {
  native?: NativeCoreState;
  sessionLocks?: Record<string, 'pending' | 'suspended' | 'uncertain'>;
  controls?: Record<string, ControlIntent>;
  version: 1;
  botId: string;
  connectionId?: string;
  coreIdentity?: string;
  routes: Record<string, string>;
  /** Inbound messages already handled, by the task key of their msgid: when
   *  (epoch ms). Earlier versions wrote `true`; a prune stamps those with its
   *  own time (bridge/prune.ts). Readers only test for presence. */
  seen: Record<string, true | number>;
  tasks: Record<string, Task>;
}

export interface WecomBridgePolicy  extends WecomMessageConfig, WecomNativeCoreConfig, WecomNativePlatformConfig {
  allowedUsers: string[];
  blockedUsers?: string[];
  role?: { content: string; injectMode: 'every' | 'once' };
  commandTriggers?: CommandTriggerConfig;
  sessionMode?: WecomSessionMode;
  sessionModeEpoch?: string;
  senderTag?: boolean;
  hideLocalAddresses?: boolean;
  workingDirectory?: string;
  customPassthroughCommands?: string[];
  model?: string;
  cli?: string;
}
