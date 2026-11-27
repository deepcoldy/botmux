/**
 * HTTP contract between a native IM gateway (src/im/wecom/gateway) and the
 * dedicated core-only daemon it drives: the paths it requests, the header that
 * pins them to one core boot, and the request / response shapes. Declared once
 * here so the core's IPC server and the gateway's client share it; core never
 * imports the gateway (test/wecom-import-boundaries.test.ts).
 *
 * Two kinds of route:
 *  - routes introduced for the gateway (asks, progress, reminder state, source
 *    identity, core profile): the IPC server registers them from
 *    NATIVE_GATEWAY_ROUTE_PATTERNS;
 *  - general daemon routes the gateway also uses (trigger, trigger-result,
 *    interrupt, slash, the session host actions): the Feishu Dashboard and CLI
 *    call them too, so their registrations stay where they are and only the
 *    paths the gateway builds live here.
 * test/native-gateway-contract-routes.test.ts proves every path built here
 * reaches a route the IPC server registered.
 */
import type { PendingAsk } from './ask-types.js';
import type { CoreOnlyProgress } from './core-only-progress.js';
import type { CoreOnlyReminderState } from './core-only-reminder-state.js';

/**
 * Pins a request to one boot of a core-only service: a gateway (or its
 * Dashboard) sends the boot id it verified, so a restarted core, or a different
 * daemon now owning the port, can never act on a stale session id. Requests
 * without it pass unchanged.
 */
export const EXPECTED_CORE_BOOT_HEADER = 'x-botmux-expected-core-boot';

/**
 * Environment-name prefixes owned by native gateway processes (their
 * credentials and settings). A gateway removes them from the environment of
 * the core it launches, and a core bot profile may neither set nor unset them
 * (core/core-only-bot-profile.ts), so nothing of the gateway's own namespace
 * reaches the core's sessions through configuration.
 */
export const NATIVE_GATEWAY_RESERVED_ENV_PREFIXES = ['WECOM_'] as const;

/** Whether `key` belongs to a native gateway's own environment namespace. */
export function isNativeGatewayReservedEnvKey(key: string): boolean {
  return NATIVE_GATEWAY_RESERVED_ENV_PREFIXES.some(prefix => key.startsWith(prefix));
}

/** Route patterns (ipcRoute syntax) of the core routes introduced for a native gateway. */
export const NATIVE_GATEWAY_ROUTE_PATTERNS = {
  /** GET: the asks of one live turn (`?triggerId=`). POST: one gateway callback. */
  asks: '/api/sessions/:sessionId/native-gateway-asks',
  /** GET: exact-turn progress (`?triggerId=`). */
  progress: '/api/sessions/:sessionId/native-gateway-progress',
  /** GET: exact-turn recipient reminder state (`?triggerId=`). */
  reminderState: '/api/sessions/:sessionId/native-gateway-reminder-state',
  /** GET: the core's boot and process identity (`?sessionId=` adds that session's terminal). */
  sourceIdentity: '/api/core/source-identity',
  /** POST NativeGatewayCoreProfileRequest: the core settings new sessions use. */
  coreProfile: '/api/native-gateway/core-profile',
} as const;

/**
 * The routes only the gateway calls (the Dashboard proves a core through
 * `sourceIdentity`, so that one is not among them). A native gateway core that
 * received its gateway's credential (core/native-gateway-credential.ts) admits
 * these with that credential alone.
 */
export const NATIVE_GATEWAY_EXCLUSIVE_ROUTE_PATTERNS: readonly string[] = [
  NATIVE_GATEWAY_ROUTE_PATTERNS.asks,
  NATIVE_GATEWAY_ROUTE_PATTERNS.progress,
  NATIVE_GATEWAY_ROUTE_PATTERNS.reminderState,
  NATIVE_GATEWAY_ROUTE_PATTERNS.coreProfile,
  // The general exact-turn interrupt (nativeGatewayInterruptPath): the
  // Dashboard stops a turn of this core through the gateway, never directly.
  '/api/sessions/:sessionId/turns/:triggerId/interrupt',
];

/**
 * The environment keys a core-only service synthesizes its bot's settings from
 * (bot-registry), and the only ones a core profile request may carry. The
 * first four are always sent; a request without BOTMUX_CORE_MODEL clears the
 * model, exactly as a core started without it.
 */
export const NATIVE_GATEWAY_CORE_PROFILE_ENV_KEYS = [
  'BOTMUX_CORE_CLI',
  'BOTMUX_CORE_BACKEND',
  'BOTMUX_CORE_WORKING_DIR',
  'BOTMUX_CORE_BOT_CONFIG',
  'BOTMUX_CORE_MODEL',
] as const;

export type NativeGatewayCoreProfileEnvKey = typeof NATIVE_GATEWAY_CORE_PROFILE_ENV_KEYS[number];

/** The core settings as the environment a core is started with carries them. */
export type NativeGatewayCoreProfile = Partial<Record<NativeGatewayCoreProfileEnvKey, string>>;

/** POST core profile: replace the settings new sessions use (sessions already running keep theirs). */
export interface NativeGatewayCoreProfileRequest {
  env: NativeGatewayCoreProfile;
}

/** POST core profile: 200 body. `changed` is false when the core already ran these settings. */
export interface NativeGatewayCoreProfileResponse {
  ok: true;
  changed: boolean;
}

/** General daemon route the gateway dispatches every turn through. */
export const NATIVE_GATEWAY_TRIGGER_PATH = '/api/trigger';

function sessionPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}`;
}

function triggerQuery(triggerId: string): string {
  return `?triggerId=${encodeURIComponent(triggerId)}`;
}

function sessionRoute(pattern: string, sessionId: string): string {
  return pattern.replace(':sessionId', () => encodeURIComponent(sessionId));
}

/** GET the final result of one dispatched turn. */
export function nativeGatewayTriggerResultPath(sessionId: string, triggerId: string): string {
  return `${sessionPath(sessionId)}/trigger-result${triggerQuery(triggerId)}`;
}

/** POST (body `{}`): stop exactly this turn. */
export function nativeGatewayInterruptPath(sessionId: string, triggerId: string): string {
  return `${sessionPath(sessionId)}/turns/${encodeURIComponent(triggerId)}/interrupt`;
}

/** POST `{ command }`: run a slash command in the session. */
export function nativeGatewaySlashPath(sessionId: string): string {
  return `${sessionPath(sessionId)}/slash`;
}

/** Session host actions the gateway requests (POST, body `{}`), by route segment. */
export type NativeGatewaySessionAction = 'close' | 'prune' | 'restart' | 'wake' | 'suspend';

/**
 * POST (body `{}`): one session host action. A `close` response can report a
 * residual (`outcome: 'closed_with_residual'`); decode it with
 * parseCloseResidual (test/close-consumer-matrix.test.ts).
 */
export function nativeGatewaySessionActionPath(sessionId: string, action: NativeGatewaySessionAction): string {
  return `${sessionPath(sessionId)}/${action}`;
}

/** GET the asks of one live turn. */
export function nativeGatewayAsksPath(sessionId: string, triggerId: string): string {
  return `${sessionRoute(NATIVE_GATEWAY_ROUTE_PATTERNS.asks, sessionId)}${triggerQuery(triggerId)}`;
}

/** POST one gateway callback for an ask (NativeGatewayAskCallback). */
export function nativeGatewayAskCallbackPath(sessionId: string): string {
  return sessionRoute(NATIVE_GATEWAY_ROUTE_PATTERNS.asks, sessionId);
}

/** GET exact-turn progress. */
export function nativeGatewayProgressPath(sessionId: string, triggerId: string): string {
  return `${sessionRoute(NATIVE_GATEWAY_ROUTE_PATTERNS.progress, sessionId)}${triggerQuery(triggerId)}`;
}

/** GET exact-turn recipient reminder state. */
export function nativeGatewayReminderStatePath(sessionId: string, triggerId: string): string {
  return `${sessionRoute(NATIVE_GATEWAY_ROUTE_PATTERNS.reminderState, sessionId)}${triggerQuery(triggerId)}`;
}

/** POST NativeGatewayCoreProfileRequest. */
export function nativeGatewayCoreProfilePath(): string {
  return NATIVE_GATEWAY_ROUTE_PATTERNS.coreProfile;
}

/** GET the core's identity, optionally with one session's live terminal. */
export function nativeGatewaySourceIdentityPath(sessionId?: string): string {
  const query = sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`;
  return `${NATIVE_GATEWAY_ROUTE_PATTERNS.sourceIdentity}${query}`;
}

/** The exact turn execution a native gateway acts for: one HTTP turn of one session. */
export interface NativeGatewayAskOrigin {
  sessionId: string;
  turnId: string;
  workerGeneration: number;
  dispatchAttempt?: number;
}

/** One unsettled ask the gateway may show for that execution. */
export interface NativeGatewayAskSnapshot {
  ask: PendingAsk;
  origin: NativeGatewayAskOrigin;
}

/** GET asks: 200 body. Empty when the turn is not the session's live execution. */
export interface NativeGatewayAsksResponse {
  ok: true;
  asks: NativeGatewayAskSnapshot[];
}

/** What a person can do to an ask through the gateway. */
export type NativeGatewayAnswerAction = 'toggle' | 'submit' | 'text';

/** POST asks: one gateway callback, for exactly the execution in `origin`.
 *  A type alias (not an interface) so it stays assignable to the
 *  `Record<string, unknown>` the server validates it as. */
export type NativeGatewayAskCallback = {
  origin: NativeGatewayAskOrigin;
  askId: string;
  nonce: string;
  /** `delivered` confirms the card was shown; the rest answer the ask. */
  action: NativeGatewayAnswerAction | 'delivered';
  /** `delivered`: the gateway's id for the shown card. */
  messageId?: string;
  /** Answers: the platform user id of the person answering. */
  by?: string;
  /** `toggle`: which option of which question. */
  questionIndex?: number;
  key?: string;
  /** `text`: the reply (JSON for a form ask). */
  text?: string;
  /** `submit`: confirm an empty answer. */
  confirmEmpty?: boolean;
};

/**
 * POST asks: 200 body. `outcome` is the broker's click outcome, or `stale`,
 * `already_settled` (a repeat of an answer already given) or `unauthorized`.
 */
export interface NativeGatewayAskCallbackResponse {
  ok: true;
  outcome: string;
}

/**
 * GET progress: 200 body. `progress` is null unless the turn is the live one.
 * `progress.usage`, when present, is copied from the daemon's card usage
 * snapshot (see CoreOnlyProgressUsage for its shape).
 */
export interface NativeGatewayProgressResponse {
  ok: true;
  progress: CoreOnlyProgress | null;
}

/** GET reminder state: 200 body. `reminder` is null unless the turn is the latest one. */
export interface NativeGatewayReminderStateResponse {
  ok: true;
  reminder: CoreOnlyReminderState | null;
}

/** GET source identity: 200 body (a core-only service with an apiOnly bot only). */
export interface NativeGatewaySourceIdentity {
  ok: true;
  coreOnly: true;
  coreBotId: string;
  bootInstanceId: string;
  pid: number;
  processStart: string | undefined;
  /** Present for `?sessionId=` when that session of this bot has a live worker. */
  terminal?: {
    sessionId: string;
    workerPid: number;
    workerProcessStart: string | undefined;
    proxyPort: number;
  };
}
