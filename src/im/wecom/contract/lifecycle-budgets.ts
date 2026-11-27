/**
 * Time limits of `botmux wecom start|stop|restart` (cli/wecom/fleet-lifecycle*.ts).
 *
 * They are part of the command's contract with the Dashboard, which runs it for
 * every connection action and must not give up on it before the command gives
 * up itself (dashboard/wecom/lifecycle-cli.ts): a command killed mid-way can
 * leave an op in the queue that the supervisor still carries out. Constants
 * only; the member waits they build on are the fleet's (core/fleet-runtime.ts),
 * which both processes load anyway.
 */
import { FLEET_MEMBER_START_WAIT_MS, FLEET_MEMBER_STOP_WAIT_MS } from '../../../core/fleet-runtime.js';

/**
 * How long a freshly started gateway is watched before `start` / `restart`
 * report success. The supervisor answers as soon as the gateway process is
 * running; a gateway that cannot use its configuration or credentials exits
 * (with the no-restart code) about a second later, and the person — or the
 * Dashboard — should hear about it from this command rather than find the
 * member errored afterwards. Longer failures (the platform rejecting the bot
 * over the network) show up in `botmux status` and the Dashboard.
 */
export const WECOM_START_SETTLE_MS = 2_500;

/**
 * How long `botmux wecom …` waits for the fleet mutation lock, each time it
 * needs it. Another `botmux wecom` command holds it only for a moment now (to
 * record intent and hand over an op); this covers a Feishu fleet operation in
 * progress — a whole `botmux restart` waits for the old supervisor, which may
 * be stopping a gateway. A longer holder ends this with `fleet_busy`.
 */
export const WECOM_LIFECYCLE_LOCK_WAIT_MS =
  FLEET_MEMBER_STOP_WAIT_MS + FLEET_MEMBER_START_WAIT_MS + WECOM_START_SETTLE_MS + 5_000;

/**
 * Upper bound of one whole `botmux wecom …` command: waiting for the lock, a
 * stop's wait, a start's wait and the settle window. A restart takes the lock
 * twice and a start whose gateway is still shutting down waits for it first;
 * every one of those waits is cut to what is left of this bound. What can still
 * run past it: the settle window after a start the supervisor confirmed, which
 * is always watched in full (WECOM_START_SETTLE_MS), and a few seconds of
 * file-lock and polling slack.
 */
export const WECOM_LIFECYCLE_MAX_MS =
  WECOM_LIFECYCLE_LOCK_WAIT_MS + FLEET_MEMBER_STOP_WAIT_MS + FLEET_MEMBER_START_WAIT_MS + WECOM_START_SETTLE_MS;
