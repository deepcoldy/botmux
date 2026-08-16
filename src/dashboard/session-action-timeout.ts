export type DashboardSessionAction = 'close' | 'locate' | 'resume' | 'restart' | 'start';

const DEFAULT_SESSION_ACTION_TIMEOUT_MS = 15_000;
// Riff close can spend up to 23s preparing remote cancellation before commit;
// a lost close ACK then has a separate 29s SIGKILL backstop. Keep the dashboard
// proxy above the full serialized bound so a legitimate close is never reported
// as a 504 while the daemon continues closing it in the background.
const CLOSE_SESSION_ACTION_TIMEOUT_MS = 60_000;

export function dashboardSessionActionTimeoutMs(action: DashboardSessionAction): number {
  return action === 'close'
    ? CLOSE_SESSION_ACTION_TIMEOUT_MS
    : DEFAULT_SESSION_ACTION_TIMEOUT_MS;
}
