import type { WSClient } from '@larksuiteoapi/node-sdk';
import {
  addReaction as addLarkReaction,
  downloadMessageResource,
  removeReaction as removeLarkReaction,
  replyMessage as replyLarkMessage,
  sendMessage as sendLarkMessage,
  sendUserMessage,
  updateMessage as updateLarkMessage,
} from './client.js';
import {
  decideRouting,
  startLarkEventDispatcher,
  stopLarkEventDispatcher,
  type EventHandlers,
} from './event-dispatcher.js';
import {
  learnFromMentions,
  resolveSender,
  type ResolvedSender,
} from './identity-cache.js';
import { normalizeBrand, type Brand } from './lark-hosts.js';
import {
  createPlatformCapabilities,
  PlatformInstanceMismatchError,
  samePlatformInstance,
  type PlatformAttachment,
  type PlatformCapabilities,
  type PlatformConversationRef,
  type PlatformInstanceRef,
  type PlatformMention,
  type PlatformMessageRef,
  type PlatformSender,
} from '../platform.js';
import type {
  PlatformAttachmentResource,
  PlatformAttachmentsPort,
  PlatformCard,
  PlatformCardsPort,
  PlatformConversationPort,
  PlatformDirectMessageOptions,
  PlatformDirectMessagesPort,
  PlatformIdentityPort,
  PlatformInboundConversation,
  PlatformMessagingPort,
  PlatformReactionsPort,
  PlatformReplyOptions,
  PlatformRuntime,
  PlatformSendOptions,
} from '../ports.js';

export const LARK_PLATFORM_CAPABILITIES: PlatformCapabilities = createPlatformCapabilities({
  messaging: true,
  cards: true,
  streamUpdates: true,
  reactions: true,
  attachments: true,
  identity: true,
  conversation: true,
  directMessages: true,
  threads: true,
  mentions: true,
});

export interface LarkPlatformExtension {
  /** Raw/high-level Lark callbacks (cards, docs, VC, and Lark routing hooks). */
  readonly eventHandlers: EventHandlers;
  readonly brand: Brand;
}

export interface LarkPlatformRuntimeDeps {
  startEventDispatcher: typeof startLarkEventDispatcher;
  stopEventDispatcher: typeof stopLarkEventDispatcher;
  sendMessage: typeof sendLarkMessage;
  replyMessage: typeof replyLarkMessage;
  sendUserMessage: typeof sendUserMessage;
  updateMessage: typeof updateLarkMessage;
  addReaction: typeof addLarkReaction;
  removeReaction: typeof removeLarkReaction;
  downloadMessageResource: typeof downloadMessageResource;
  resolveSender: typeof resolveSender;
  learnFromMentions: typeof learnFromMentions;
  decideRouting: typeof decideRouting;
}

const DEFAULT_DEPS: LarkPlatformRuntimeDeps = {
  startEventDispatcher: startLarkEventDispatcher,
  stopEventDispatcher: stopLarkEventDispatcher,
  sendMessage: sendLarkMessage,
  replyMessage: replyLarkMessage,
  sendUserMessage,
  updateMessage: updateLarkMessage,
  addReaction: addLarkReaction,
  removeReaction: removeLarkReaction,
  downloadMessageResource,
  resolveSender,
  learnFromMentions,
  decideRouting,
};

export interface LarkPlatformRuntimeOptions {
  larkAppId: string;
  larkAppSecret: string;
  brand?: Brand;
  eventHandlers: EventHandlers;
  /** Dependency seam for compatibility-contract tests. */
  deps?: Partial<LarkPlatformRuntimeDeps>;
}

export class LarkPlatformInstanceMismatchError extends PlatformInstanceMismatchError {
  constructor(
    expected: PlatformInstanceRef,
    received: PlatformInstanceRef,
  ) {
    super(expected, received);
    this.name = 'LarkPlatformInstanceMismatchError';
  }
}

/** Serialize an adapter-owned card payload without double-encoding raw JSON. */
function serializeLarkCard(card: PlatformCard): string {
  if (typeof card.payload === 'string') return card.payload;
  const serialized = JSON.stringify(card.payload);
  if (serialized === undefined) {
    throw new TypeError('Lark card payload is not JSON-serializable');
  }
  return serialized;
}

function mutableContext(options?: PlatformSendOptions): Record<string, unknown> | undefined {
  return options?.context as Record<string, unknown> | undefined;
}

function toPlatformSender(sender: ResolvedSender): PlatformSender {
  return {
    id: sender.openId,
    type: sender.type,
    ...(sender.name ? { name: sender.name } : {}),
  };
}

/**
 * Lark façade for one configured app instance.
 *
 * Every port is a thin delegate to the existing production implementation so
 * its ordering, return values, and thrown error objects remain unchanged. Lark
 * card serialization and Lark-only event callbacks stay inside this adapter.
 */
export class LarkPlatformRuntime implements
  PlatformRuntime,
  PlatformMessagingPort,
  PlatformDirectMessagesPort,
  PlatformCardsPort,
  PlatformReactionsPort,
  PlatformAttachmentsPort,
  PlatformIdentityPort,
  PlatformConversationPort {
  readonly instance: PlatformInstanceRef;
  readonly capabilities = LARK_PLATFORM_CAPABILITIES;

  readonly messaging: PlatformMessagingPort = this;
  readonly directMessages: PlatformDirectMessagesPort = this;
  readonly cards: PlatformCardsPort = this;
  readonly reactions: PlatformReactionsPort = this;
  readonly attachments: PlatformAttachmentsPort = this;
  readonly identity: PlatformIdentityPort = this;
  readonly conversation: PlatformConversationPort = this;

  readonly extensions: { readonly lark: LarkPlatformExtension };

  private readonly larkAppSecret: string;
  private readonly deps: LarkPlatformRuntimeDeps;
  private dispatcher?: WSClient;
  private lifecycleTail: Promise<void> = Promise.resolve();

  constructor(options: LarkPlatformRuntimeOptions) {
    this.instance = { platform: 'lark', instanceId: options.larkAppId };
    this.larkAppSecret = options.larkAppSecret;
    this.deps = { ...DEFAULT_DEPS, ...options.deps };
    this.extensions = {
      lark: {
        eventHandlers: options.eventHandlers,
        brand: normalizeBrand(options.brand),
      },
    };
  }

  get isRunning(): boolean {
    return this.dispatcher !== undefined;
  }

  /** Serialize lifecycle transitions while allowing a failed transition to be retried. */
  private enqueueLifecycle(operation: () => void | Promise<void>): Promise<void> {
    const result = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = result.catch(() => { /* keep the queue usable after a failure */ });
    return result;
  }

  start(): Promise<void> {
    return this.enqueueLifecycle(() => {
      if (this.dispatcher) return;
      // Do not await or wrap the SDK's connection loop: the legacy start helper
      // returns its WSClient immediately and owns reconnect/revive behavior.
      this.dispatcher = this.deps.startEventDispatcher(
        this.instance.instanceId,
        this.larkAppSecret,
        this.extensions.lark.eventHandlers,
        this.extensions.lark.brand,
      );
    });
  }

  stop(): Promise<void> {
    return this.enqueueLifecycle(() => {
      if (!this.dispatcher) return;
      const dispatcher = this.dispatcher;
      // Retain the handle when stop throws so a caller can retry teardown.
      this.deps.stopEventDispatcher(dispatcher);
      this.dispatcher = undefined;
    });
  }

  async sendMessage(
    conversation: PlatformConversationRef,
    content: string,
    options?: PlatformSendOptions,
  ): Promise<PlatformMessageRef> {
    this.requireOwnInstance(conversation.instance);
    const messageId = await this.deps.sendMessage(
      this.instance.instanceId,
      conversation.chatId,
      content,
      options?.contentType ?? 'text',
      options?.idempotencyKey,
      mutableContext(options),
    );
    return { instance: this.instance, messageId, conversation };
  }

  async replyMessage(
    target: PlatformMessageRef,
    content: string,
    options?: PlatformReplyOptions,
  ): Promise<PlatformMessageRef> {
    this.requireOwnInstance(target.instance);
    const messageId = await this.deps.replyMessage(
      this.instance.instanceId,
      target.messageId,
      content,
      options?.contentType ?? 'text',
      options?.inThread ?? false,
      options?.idempotencyKey,
      mutableContext(options),
    );
    return {
      instance: this.instance,
      messageId,
      ...(target.conversation ? { conversation: target.conversation } : {}),
    };
  }

  async sendDirectMessage(
    recipientId: string,
    content: string,
    options?: PlatformDirectMessageOptions,
  ): Promise<PlatformMessageRef> {
    const messageId = await this.deps.sendUserMessage(
      this.instance.instanceId,
      recipientId,
      content,
      options?.contentType ?? 'text',
    );
    return { instance: this.instance, messageId };
  }

  async sendCard(
    conversation: PlatformConversationRef,
    card: PlatformCard,
    options?: PlatformSendOptions,
  ): Promise<PlatformMessageRef> {
    this.requireOwnInstance(conversation.instance);
    const messageId = await this.deps.sendMessage(
      this.instance.instanceId,
      conversation.chatId,
      serializeLarkCard(card),
      'interactive',
      options?.idempotencyKey,
      mutableContext(options),
    );
    return { instance: this.instance, messageId, conversation };
  }

  async replyCard(
    target: PlatformMessageRef,
    card: PlatformCard,
    options?: PlatformReplyOptions,
  ): Promise<PlatformMessageRef> {
    this.requireOwnInstance(target.instance);
    const messageId = await this.deps.replyMessage(
      this.instance.instanceId,
      target.messageId,
      serializeLarkCard(card),
      'interactive',
      options?.inThread ?? false,
      options?.idempotencyKey,
      mutableContext(options),
    );
    return {
      instance: this.instance,
      messageId,
      ...(target.conversation ? { conversation: target.conversation } : {}),
    };
  }

  async updateCard(target: PlatformMessageRef, card: PlatformCard): Promise<void> {
    this.requireOwnInstance(target.instance);
    await this.deps.updateMessage(
      this.instance.instanceId,
      target.messageId,
      serializeLarkCard(card),
    );
  }

  async addReaction(target: PlatformMessageRef, reaction: string): Promise<string> {
    this.requireOwnInstance(target.instance);
    return this.deps.addReaction(this.instance.instanceId, target.messageId, reaction);
  }

  async removeReaction(target: PlatformMessageRef, reactionId: string): Promise<void> {
    this.requireOwnInstance(target.instance);
    await this.deps.removeReaction(this.instance.instanceId, target.messageId, reactionId);
  }

  async downloadAttachment(
    resource: PlatformAttachmentResource,
    destinationPath: string,
  ): Promise<PlatformAttachment> {
    this.requireOwnInstance(resource.sourceMessage.instance);
    await this.deps.downloadMessageResource(
      this.instance.instanceId,
      resource.sourceMessage.messageId,
      resource.resourceId,
      resource.type,
      destinationPath,
    );
    return { type: resource.type, path: destinationPath, name: resource.name };
  }

  async resolveSender(
    id: string,
    type: PlatformSender['type'],
    hint?: Pick<PlatformSender, 'name'>,
  ): Promise<PlatformSender> {
    if (!id.trim()) throw new TypeError('Platform sender id must not be empty');
    const sender = await this.deps.resolveSender(this.instance.instanceId, id, type, {
      type,
      ...hint,
    });
    // The existing resolver returns undefined only when id is absent. This port
    // requires a non-empty id and therefore preserves the resolved value shape.
    return sender ? toPlatformSender(sender) : { id, type, ...hint };
  }

  learnMentions(mentions: readonly PlatformMention[]): void {
    this.deps.learnFromMentions(
      this.instance.instanceId,
      mentions.map(mention => ({
        name: mention.name,
        openId: mention.identity
          && (mention.identity.idType === undefined || mention.identity.idType === 'open_id')
          ? mention.identity.id
          : undefined,
      })),
    );
  }

  async resolveInitialConversation(input: PlatformInboundConversation): Promise<PlatformConversationRef> {
    this.requireOwnInstance(input.instance);
    const routing = await this.deps.decideRouting(this.instance.instanceId, {
      message_id: input.messageId,
      chat_id: input.chatId,
      chat_type: input.conversationType === 'direct' ? 'p2p' : 'group',
      root_id: input.rootMessageId,
      thread_id: input.threadId,
    });
    return {
      instance: this.instance,
      chatId: input.chatId,
      conversationType: input.conversationType,
      scope: routing.scope,
      anchorId: routing.anchor,
      ...(routing.scope === 'thread' ? { threadRootId: routing.anchor } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    };
  }

  private requireOwnInstance(received: PlatformInstanceRef): void {
    if (!samePlatformInstance(this.instance, received)) {
      throw new LarkPlatformInstanceMismatchError(this.instance, received);
    }
  }
}
