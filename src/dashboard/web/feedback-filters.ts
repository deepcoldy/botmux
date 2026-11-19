export type FeedbackDateRange = { fromDate: string; toDate: string };
export type FeedbackPageFilters = FeedbackDateRange & { botAppId: string };

function dateInputValue(date: Date): string {
  return `${date.getFullYear().toString().padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Calendar days in the browser's local time zone, including today. */
export function feedbackDateRange(days: 1 | 7 | 30, now = new Date()): FeedbackDateRange {
  const from = new Date(now);
  from.setDate(from.getDate() - days + 1);
  return { fromDate: dateInputValue(from), toDate: dateInputValue(now) };
}

function localDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('feedback.invalidRange');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setFullYear(year!, month! - 1, day!);
  date.setHours(0, 0, 0, 0);
  if (dateInputValue(date) !== value) throw new Error('feedback.invalidRange');
  return date;
}

export function feedbackAnalyticsQuery(filters: FeedbackPageFilters): URLSearchParams {
  const from = localDate(filters.fromDate);
  const to = localDate(filters.toDate);
  // The API uses [from, to); advancing the calendar date includes the entire
  // selected end day and respects 23/25-hour days at DST transitions.
  to.setDate(to.getDate() + 1);
  if (from >= to) throw new Error('feedback.invalidRange');
  if (to.getTime() - from.getTime() > 366 * 86400000) throw new Error('feedback.rangeTooLarge');
  const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  if (filters.botAppId) query.set('bot', filters.botAppId);
  return query;
}
