/**
 * Heartbeat staleness window: how long a daemon may go without refreshing its
 * `dashboard-daemons/<app>.json` descriptor before every other process treats
 * it as gone. Shared by daemon discovery, the dashboard registry and the
 * session-store occupancy lease TTL, so every "is that daemon still there"
 * signal lapses on one schedule. Kept in its own module so tests that mock
 * discovery do not have to re-export it.
 */
export const DAEMON_HEARTBEAT_STALE_MS = 90_000;
