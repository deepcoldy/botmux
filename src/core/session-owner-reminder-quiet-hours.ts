/** Daily interval in the daemon's local time, with an exclusive end. */
export interface SessionOwnerReminderQuietHours {
  enabled: boolean;
  start: string;
  end: string;
}

export const DEFAULT_OWNER_REMINDER_QUIET_HOURS: Readonly<SessionOwnerReminderQuietHours> = {
  enabled: false,
  start: '22:00',
  end: '09:00',
};

const LOCAL_TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;

/** Validates the complete quiet-hours setting from the dashboard or bots.json. */
export function normalizeOwnerReminderQuietHours(raw: unknown): SessionOwnerReminderQuietHours | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const { enabled, start, end } = raw as Record<string, unknown>;
  if (typeof enabled !== 'boolean'
    || typeof start !== 'string' || !LOCAL_TIME.test(start)
    || typeof end !== 'string' || !LOCAL_TIME.test(end)
    || start === end) return undefined;
  return { enabled, start, end };
}

/** Checks the wall clock when a reminder is about to be sent. */
export function isOwnerReminderQuietTime(quietHours: SessionOwnerReminderQuietHours | undefined, now: number): boolean {
  if (!quietHours?.enabled) return false;
  const date = new Date(now);
  const time = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  const { start, end } = quietHours;
  return start < end ? time >= start && time < end : time >= start || time < end;
}
