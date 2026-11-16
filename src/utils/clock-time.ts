/** HH:MM on a 24-hour clock in the daemon process's time zone — the same
 *  reading the failure cards already use for their timestamps. Shared by card
 *  rendering and plain-text notices so the two never disagree. */
export function formatClockTime(ms: number, locale?: 'zh' | 'en'): string {
  return new Date(ms).toLocaleTimeString(locale === 'en' ? 'en-US' : 'zh-CN', {
    hour12: false, hour: '2-digit', minute: '2-digit',
  });
}
