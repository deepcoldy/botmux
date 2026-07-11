/**
 * Platform-neutral identity and conversation models.
 *
 * Platform-specific identifiers are intentionally opaque here. In particular,
 * Lark open_id / user_id / union_id names belong in the Lark adapter, not in
 * core session state.
 */

/** Platforms with a runtime implementation registered in this release. */
export const PLATFORM_IDS = ['lark'] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];

/** Opaque identity shape used when reading descriptors from future platforms. */
export interface PlatformInstanceIdentity {
  platform: string;
  instanceId: string;
}

/** One configured account/application of a platform. */
export interface PlatformInstanceRef extends PlatformInstanceIdentity {
  platform: PlatformId;
}

export type PlatformConversationScope = 'chat' | 'thread';
export type PlatformConversationType = 'group' | 'direct';

/**
 * A conversation plus the routing anchor used to look up its session.
 *
 * `anchorId` is the chat id for chat-scoped conversations and the thread root
 * (or the message that will seed a new thread) for thread-scoped ones.
 * `threadRootId` is the stable routing root when one exists. `threadId` is an
 * optional distinct native thread identifier; platforms such as Lark may route
 * by the root message even when no separate thread id is available.
 */
export interface PlatformConversationRef {
  instance: PlatformInstanceRef;
  chatId: string;
  conversationType: PlatformConversationType;
  scope: PlatformConversationScope;
  anchorId: string;
  threadRootId?: string;
  threadId?: string;
}

/** A message address returned by a messaging or cards port. */
export interface PlatformMessageRef {
  instance: PlatformInstanceRef;
  messageId: string;
  conversation?: PlatformConversationRef;
}

/** Downloaded attachment passed to a CLI prompt. */
export interface PlatformAttachment {
  type: 'image' | 'file';
  path: string;
  name: string;
}

/** Opaque platform identities attached to a mention. */
export interface PlatformMentionIdentity {
  /** Primary identifier in the current platform-instance namespace. */
  id: string;
  /** Optional second platform-local identifier. */
  secondaryId?: string;
  /** Optional tenant/platform-stable identifier. */
  stableId?: string;
  /** Native identifier kind, retained without giving it platform semantics. */
  idType?: string;
}

export interface PlatformMention {
  /** Token embedded in the original message text. */
  token: string;
  name: string;
  identity?: PlatformMentionIdentity;
}

export interface PlatformSender {
  id: string;
  type: 'user' | 'bot';
  name?: string;
}

/**
 * Capabilities are declarations of platform support, not per-bot policy.
 * For example, disabling streaming cards in configuration does not make the
 * Lark runtime incapable of cards or stream updates.
 */
export const PLATFORM_CAPABILITIES = [
  'messaging',
  'cards',
  'streamUpdates',
  'reactions',
  'attachments',
  'identity',
  'conversation',
  'directMessages',
  'threads',
  'mentions',
] as const;

export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

export type PlatformCapabilities = Readonly<Record<PlatformCapability, boolean>>;

const EMPTY_CAPABILITIES: PlatformCapabilities = {
  messaging: false,
  cards: false,
  streamUpdates: false,
  reactions: false,
  attachments: false,
  identity: false,
  conversation: false,
  directMessages: false,
  threads: false,
  mentions: false,
};

/** Build a complete, serializable capability declaration. */
export function createPlatformCapabilities(
  supported: Partial<PlatformCapabilities> = {},
): PlatformCapabilities {
  return Object.freeze({ ...EMPTY_CAPABILITIES, ...supported });
}

export interface PlatformCapabilityProvider {
  instance: PlatformInstanceRef;
  capabilities: PlatformCapabilities;
}

export class PlatformCapabilityUnavailableError extends Error {
  readonly code = 'platform_capability_unavailable';

  constructor(
    readonly instance: PlatformInstanceRef,
    readonly capability: PlatformCapability,
  ) {
    super(
      `Platform instance ${instance.platform}:${instance.instanceId} `
      + `does not support capability ${capability}`,
    );
    this.name = 'PlatformCapabilityUnavailableError';
  }
}

/**
 * Require a declared capability before entering a capability-specific path.
 * Unsupported operations fail explicitly rather than silently using a no-op.
 */
export function requirePlatformCapability(
  provider: PlatformCapabilityProvider,
  capability: PlatformCapability,
): void {
  if (!provider.capabilities[capability]) {
    throw new PlatformCapabilityUnavailableError(provider.instance, capability);
  }
}

/** Read the routing anchor without re-deriving platform-specific topology. */
export function conversationRoutingAnchor(conversation: PlatformConversationRef): string {
  return conversation.anchorId;
}

/** Stable in-memory identity for a configured platform instance. */
export function platformInstanceKey(instance: PlatformInstanceIdentity): string {
  return JSON.stringify([instance.platform, instance.instanceId]);
}

/** Derive identity from new generic fields or legacy Lark fields without
 * mutating the source object. Explicit generic fields win; missing platform
 * defaults to Lark for zero-migration compatibility. */
export function derivePlatformInstanceIdentity(
  value: unknown,
  fallbackLarkInstanceId?: string,
): PlatformInstanceIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const platform = typeof record.platform === 'string' && record.platform.trim()
    ? record.platform.trim()
    : 'lark';
  const explicitInstanceId = typeof record.instanceId === 'string' && record.instanceId.trim()
    ? record.instanceId.trim()
    : undefined;
  const legacyLarkAppId = typeof record.larkAppId === 'string' && record.larkAppId.trim()
    ? record.larkAppId.trim()
    : undefined;
  if (platform === 'lark' && explicitInstanceId && legacyLarkAppId
    && explicitInstanceId !== legacyLarkAppId) return null;
  const instanceId = explicitInstanceId
    ?? (platform === 'lark' ? legacyLarkAppId ?? fallbackLarkInstanceId?.trim() : undefined);
  return instanceId ? { platform, instanceId } : null;
}

/** Shape accepted by cross-platform guards, including future platform ids. */
export interface PlatformRefLike {
  platform: string;
}

export function samePlatform(a: PlatformRefLike, b: PlatformRefLike): boolean {
  return a.platform === b.platform;
}

export function samePlatformInstance(a: PlatformInstanceIdentity, b: PlatformInstanceIdentity): boolean {
  return samePlatform(a, b) && a.instanceId === b.instanceId;
}

export class PlatformInstanceMismatchError extends Error {
  readonly code = 'platform_instance_mismatch';

  constructor(
    readonly expected: PlatformInstanceIdentity,
    readonly received: PlatformInstanceIdentity,
  ) {
    super(
      `Platform runtime ${expected.platform}:${expected.instanceId} cannot operate on `
      + `${received.platform}:${received.instanceId}`,
    );
    this.name = 'PlatformInstanceMismatchError';
  }
}

export function requireSamePlatformInstance(
  expected: PlatformInstanceIdentity,
  received: PlatformInstanceIdentity,
): void {
  if (!samePlatformInstance(expected, received)) {
    throw new PlatformInstanceMismatchError(expected, received);
  }
}

export class CrossPlatformOperationError extends Error {
  readonly code = 'unsupported_cross_platform';

  constructor(
    readonly sourcePlatform: string,
    readonly targetPlatform: string,
  ) {
    super(`Cross-platform operation is unsupported: ${sourcePlatform} -> ${targetPlatform}`);
    this.name = 'CrossPlatformOperationError';
  }
}

/** Guard A2A/relay-style operations that must stay inside one platform. */
export function requireSamePlatform(source: PlatformRefLike, target: PlatformRefLike): void {
  if (!samePlatform(source, target)) {
    throw new CrossPlatformOperationError(source.platform, target.platform);
  }
}
