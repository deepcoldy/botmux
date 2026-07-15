import type {
  PlatformAttachment,
  PlatformCapability,
  PlatformCapabilityProvider,
  PlatformConversationRef,
  PlatformInstanceRef,
  PlatformMention,
  PlatformMessageRef,
  PlatformSender,
} from './platform.js';
import { requirePlatformCapability } from './platform.js';

export interface PlatformSendOptions {
  /** Adapter-native content type. Omitted means the platform's text default. */
  contentType?: string;
  /** Platform-native idempotency key, when supported by the adapter. */
  idempotencyKey?: string;
  /** Opaque context for local hooks/telemetry; never sent as message content. */
  context?: Readonly<Record<string, unknown>>;
}

export interface PlatformReplyOptions extends PlatformSendOptions {
  inThread?: boolean;
}

export interface PlatformMessagingPort {
  sendMessage(
    conversation: PlatformConversationRef,
    content: string,
    options?: PlatformSendOptions,
  ): Promise<PlatformMessageRef>;

  replyMessage(
    target: PlatformMessageRef,
    content: string,
    options?: PlatformReplyOptions,
  ): Promise<PlatformMessageRef>;
}

export interface PlatformDirectMessagesPort {
  sendDirectMessage(
    recipientId: string,
    content: string,
    options?: PlatformDirectMessageOptions,
  ): Promise<PlatformMessageRef>;
}

/** DM transports do not currently expose idempotency or hook context. Keeping
 * this narrower than PlatformSendOptions prevents adapters from silently
 * dropping those semantics. */
export interface PlatformDirectMessageOptions {
  contentType?: string;
}

/** Platform-native card payload. Rendering remains adapter-owned. */
export interface PlatformCard {
  payload: unknown;
}

export interface PlatformCardsPort {
  sendCard(
    conversation: PlatformConversationRef,
    card: PlatformCard,
    options?: PlatformSendOptions,
  ): Promise<PlatformMessageRef>;

  replyCard(
    target: PlatformMessageRef,
    card: PlatformCard,
    options?: PlatformReplyOptions,
  ): Promise<PlatformMessageRef>;

  updateCard(target: PlatformMessageRef, card: PlatformCard): Promise<void>;
}

export interface PlatformReactionsPort {
  addReaction(target: PlatformMessageRef, reaction: string): Promise<string>;
  removeReaction(target: PlatformMessageRef, reactionId: string): Promise<void>;
}

export interface PlatformAttachmentResource {
  sourceMessage: PlatformMessageRef;
  resourceId: string;
  type: PlatformAttachment['type'];
  name: string;
}

export interface PlatformAttachmentsPort {
  downloadAttachment(
    resource: PlatformAttachmentResource,
    destinationPath: string,
  ): Promise<PlatformAttachment>;
}

export interface PlatformIdentityPort {
  resolveSender(
    id: string,
    type: PlatformSender['type'],
    hint?: Pick<PlatformSender, 'name'>,
  ): Promise<PlatformSender>;

  learnMentions(mentions: readonly PlatformMention[]): void;
}

export interface PlatformConversationPort {
  /** Resolve the platform-native topology before higher-level policies such as
   * force-topic, aliases, and session ownership adjust the final route. */
  resolveInitialConversation(input: PlatformInboundConversation): Promise<PlatformConversationRef>;
}

export interface PlatformInboundConversation {
  instance: PlatformInstanceRef;
  chatId: string;
  messageId: string;
  conversationType: PlatformConversationRef['conversationType'];
  rootMessageId?: string;
  threadId?: string;
}

export interface PlatformPortMap {
  messaging: PlatformMessagingPort;
  directMessages: PlatformDirectMessagesPort;
  cards: PlatformCardsPort;
  reactions: PlatformReactionsPort;
  attachments: PlatformAttachmentsPort;
  identity: PlatformIdentityPort;
  conversation: PlatformConversationPort;
}

export type PlatformPortName = keyof PlatformPortMap;

/**
 * A running platform instance. Ports are optional and must agree with the
 * capability declaration; adapters must not install silent no-op ports.
 */
export interface PlatformRuntime extends PlatformCapabilityProvider, Partial<PlatformPortMap> {
  readonly instance: PlatformInstanceRef;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class PlatformPortUnavailableError extends Error {
  readonly code = 'platform_port_unavailable';

  constructor(
    readonly instance: PlatformInstanceRef,
    readonly port: PlatformPortName,
  ) {
    super(
      `Platform instance ${instance.platform}:${instance.instanceId} `
      + `declares capability ${port} but provides no ${port} port`,
    );
    this.name = 'PlatformPortUnavailableError';
  }
}

/**
 * Return an optional port or fail explicitly. A false capability produces
 * PlatformCapabilityUnavailableError; a declaration/port mismatch produces
 * PlatformPortUnavailableError.
 */
export function requirePlatformPort<K extends PlatformPortName>(
  runtime: PlatformRuntime,
  port: K,
): PlatformPortMap[K] {
  requirePlatformCapability(runtime, port as PlatformCapability);
  const value = runtime[port];
  if (!value) throw new PlatformPortUnavailableError(runtime.instance, port);
  // TypeScript cannot preserve the correlation between a generic key and an
  // indexed optional intersection here. The runtime check above establishes
  // that the selected member exists, and `PlatformRuntime` supplies its value
  // from the same `PlatformPortMap` key.
  return value as PlatformPortMap[K];
}
