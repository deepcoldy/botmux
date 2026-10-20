import { readFileSync } from 'node:fs';
import { normalizeCalendarBinding, normalizeCalendarDayType } from '../services/work-calendar.js';

export const SCHEDULE_UPDATE_USAGE = 'botmux schedule update <id> [--prompt TEXT | --prompt-file FILE] [--calendar NAME | --calendar none] [--calendar-day-type workday|restday] [--lark-app-id APP]';

/** Parse before any mutation; preserve prompt bytes, including trailing newlines. */
export function readScheduleUpdate(args: readonly string[]): { prompt?: string; calendar?: string | null; calendarDayType?: 'workday' | 'restday' } {
  let id: string | undefined;
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      if (id !== undefined) throw new Error(`unexpected argument: ${arg}`);
      id = arg;
      continue;
    }
    const equals = arg.indexOf('=');
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (!['--prompt', '--prompt-file', '--lark-app-id', '--calendar', '--calendar-day-type'].includes(flag)) {
      throw new Error(`unknown schedule update option: ${flag}`);
    }
    if (values.has(flag)) throw new Error(`duplicate option: ${flag}`);
    const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
    if (value === undefined || value.length === 0) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
  }
  const promptCount = Number(values.has('--prompt')) + Number(values.has('--prompt-file'));
  if (!id || promptCount > 1 || (!promptCount && !values.has('--calendar') && !values.has('--calendar-day-type'))) {
    throw new Error(`用法: ${SCHEDULE_UPDATE_USAGE}`);
  }
  const prompt = values.has('--prompt-file')
    ? readFileSync(values.get('--prompt-file')!, 'utf8')
    : values.get('--prompt')!;
  if (prompt !== undefined && !prompt.trim()) throw new Error('prompt must not be empty');
  const calendar = values.get('--calendar');
  return { ...(values.has('--calendar-day-type') ? { calendarDayType: normalizeCalendarDayType(values.get('--calendar-day-type')) } : {}), ...(prompt !== undefined ? { prompt } : {}),
    ...(calendar !== undefined ? { calendar: calendar === 'none' ? null : normalizeCalendarBinding(calendar) } : {}) };
}

export function readSchedulePromptUpdate(args: readonly string[]): string {
  const update = readScheduleUpdate(args);
  if (update.prompt === undefined) throw new Error(`用法: ${SCHEDULE_UPDATE_USAGE}`);
  return update.prompt;
}
