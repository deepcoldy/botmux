export interface UsagePageFilters { fromDate: string; toDate: string; bot: string; model: string }
export type UsagePreset = 'today' | '7d' | '30d' | 'week' | 'month';

function dateValue(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function usageDateRange(preset: UsagePreset, now = new Date()): Pick<UsagePageFilters, 'fromDate' | 'toDate'> {
  const start = new Date(now);
  if (preset === '7d' || preset === '30d') start.setDate(start.getDate() - (preset === '7d' ? 6 : 29));
  else if (preset === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  else if (preset === 'month') start.setDate(1);
  return { fromDate: dateValue(start), toDate: dateValue(now) };
}

function localDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('usage.invalidRange');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setFullYear(year!, month! - 1, day!); date.setHours(0, 0, 0, 0);
  if (dateValue(date) !== value) throw new Error('usage.invalidRange');
  return date;
}

export function usageAnalyticsQuery(filters: UsagePageFilters, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): URLSearchParams {
  const from = localDate(filters.fromDate), to = localDate(filters.toDate);
  to.setDate(to.getDate() + 1);
  if (from >= to) throw new Error('usage.invalidRange');
  // Count civil days, not elapsed hours, so DST doesn't reject a valid range.
  const day = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  if (day(to) - day(from) > 366 * 86400000) throw new Error('usage.rangeTooLarge');
  const result = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), timeZone });
  if (filters.bot) result.set('bot', filters.bot);
  if (filters.model) result.set('model', filters.model);
  return result;
}
