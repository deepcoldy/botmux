export interface WorkCalendarOption {
  id: string;
  kind: 'builtin' | 'local';
  displayNames?: Partial<Record<'zh' | 'en', string>>;
  timeZone?: string;
  coverage?: { start: string; end: string };
  error?: string;
}

export async function fetchWorkCalendars(larkAppId: string, signal?: AbortSignal): Promise<{
  calendars: WorkCalendarOption[]; localError?: string;
}> {
  const response = await fetch(`/api/schedules/calendars?larkAppId=${encodeURIComponent(larkAppId)}`, { signal });
  if (!response.ok) throw new Error('calendar_catalog_failed');
  const body = await response.json();
  if (!Array.isArray(body.calendars)) throw new Error('invalid_calendar_catalog');
  return body;
}
