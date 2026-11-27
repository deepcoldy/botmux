/**
 * How a gateway run (`botmux wecom`) reports why it ended.
 *
 * Run from a terminal or by the Dashboard, the exit codes are the ones the
 * gateway has always used. Run as a fleet member — the supervisor sets
 * WECOM_FLEET_MEMBER_ENV — the failures that retrying cannot fix exit with
 * WECOM_GATEWAY_NO_RESTART_EXIT_CODE so the supervisor parks the member
 * instead of restarting it into the same failure (or, for `replaced`, into a
 * tug of war with the other client of the same BotID).
 */
import { WECOM_FLEET_MEMBER_ENV, WECOM_GATEWAY_NO_RESTART_EXIT_CODE } from '../contract/fleet-member.js';

export type WecomGatewayExitReason =
  /** SIGTERM / SIGINT: the stop was requested. */
  | 'stopped'
  /** Malformed command line. */
  | 'usage'
  /** The configuration file does not exist. */
  | 'not_configured'
  /** Unreadable or invalid configuration, or an unreadable credential file. */
  | 'invalid_configuration'
  /** The configuration names a credential environment variable that is unset or empty here. */
  | 'credential_env_missing'
  /** The platform handed this BotID's connection to another client. */
  | 'replaced'
  /** The platform rejected the subscription (transport reports `authentication_failed`). */
  | 'authentication_failed'
  /** The bot's instance lock stayed held by a live instance outside the fleet. */
  | 'instance_busy'
  /** Everything else — network, core start or exit, disk — is worth retrying. */
  | 'failed';

const LEGACY_EXIT_CODES: Record<WecomGatewayExitReason, number> = {
  stopped: 0,
  usage: 2,
  not_configured: 2,
  invalid_configuration: 1,
  credential_env_missing: 1,
  replaced: 1,
  authentication_failed: 1,
  instance_busy: 1,
  failed: 1,
};

/**
 * The reasons retrying cannot fix. A supervised gateway exits with the
 * no-restart code for exactly these, and first records the reason as its
 * connection's desired `stopped` state (desired-stop.ts) — so this list and the
 * desired-state file's WECOM_DESIRED_STOP_REASONS must stay the same set: the
 * recorder's parameter type enforces one direction, a test the other.
 */
export const WECOM_GATEWAY_NOT_RETRYABLE_REASONS = [
  'not_configured',
  'invalid_configuration',
  'credential_env_missing',
  'replaced',
  'authentication_failed',
  'instance_busy',
] as const satisfies readonly WecomGatewayExitReason[];

export type WecomGatewayNotRetryableReason = typeof WECOM_GATEWAY_NOT_RETRYABLE_REASONS[number];

export function isWecomGatewayNotRetryable(reason: WecomGatewayExitReason): reason is WecomGatewayNotRetryableReason {
  return (WECOM_GATEWAY_NOT_RETRYABLE_REASONS as readonly WecomGatewayExitReason[]).includes(reason);
}

export function wecomGatewayExitCode(reason: WecomGatewayExitReason, supervised: boolean): number {
  if (supervised && isWecomGatewayNotRetryable(reason)) {
    return WECOM_GATEWAY_NO_RESTART_EXIT_CODE;
  }
  return LEGACY_EXIT_CODES[reason];
}

/**
 * Whether this gateway runs as a fleet member. The marker is removed from the
 * environment it is read from, so neither the core nor any CLI session below
 * it inherits it.
 */
export function takeWecomFleetMemberMarker(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[WECOM_FLEET_MEMBER_ENV];
  delete env[WECOM_FLEET_MEMBER_ENV];
  return typeof value === 'string' && value.length > 0;
}
