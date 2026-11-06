import { readFileSync } from 'node:fs';
import { normalizeCalendarBinding, normalizeCalendarDayType } from '../services/work-calendar.js';

export const SCHEDULE_UPDATE_USAGE = [
  'botmux schedule update <id> [--schedule 频率] [--prompt TEXT | --prompt-file FILE] [--calendar NAME | --calendar none] [--calendar-day-type workday|restday] [--lark-app-id APP]',
  '',
  '原地修改定时任务：任务 ID、静默、执行位置、前置条件、日历规则、创建人身份和执行记录都保留；不补跑，也不立即触发。',
  '可改的字段（至少一项，可组合）:',
  '  --schedule <频率>           执行频率，写法同 schedule add："每日17:50" / "every 4h" / "0 */4 * * *" / "30m"',
  '                              改后按新频率从现在起重新计算下次执行时间',
  '  --prompt <文本>             新的完整提示词',
  '  --prompt-file <文件>        从 UTF-8 文件读取新的完整提示词（与 --prompt 二选一）',
  '  --calendar <名称|none>      改绑工作日历；none 解绑',
  '  --calendar-day-type <类型>  workday 仅工作日 / restday 仅休息日',
  '其他:',
  '  --lark-app-id <APP>         指定任务所属的 Bot（默认取当前会话的 Bot）',
  '示例:',
  '  botmux schedule update a1b2c3d4 --schedule "every 4h"',
  '  botmux schedule update a1b2c3d4 --schedule "0 9 * * 1-5" --prompt-file prompt.md',
].join('\n');

export const SCHEDULE_EXPRESSION_EXAMPLES = '"每日17:50" / "每周一10:00" / "every 2h" / "30m" / "0 */4 * * *"';

/** `--help` / `-h` in flag position: the caller prints the usage and exits 0. */
export class ScheduleUpdateHelpRequested extends Error {
  constructor() { super(SCHEDULE_UPDATE_USAGE); }
}

/** Bad arguments: the caller prints the message plus the usage, never a stack. */
export class ScheduleUpdateUsageError extends Error {}

export interface ScheduleUpdateInput {
  prompt?: string;
  schedule?: string;
  calendar?: string | null;
  calendarDayType?: 'workday' | 'restday';
}

const UPDATE_FLAGS = ['--schedule', '--prompt', '--prompt-file', '--lark-app-id', '--calendar', '--calendar-day-type'];

/**
 * Parse before any mutation; preserve prompt bytes, including trailing newlines.
 * `validateSchedule` is the same parser `schedule add` uses; it throws on an
 * expression it cannot read, and that is reported here, before contacting the
 * daemon (which parses it again when it commits).
 */
export function readScheduleUpdate(
  args: readonly string[],
  options: { validateSchedule?: (raw: string) => unknown } = {},
): ScheduleUpdateInput {
  let id: string | undefined;
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') throw new ScheduleUpdateHelpRequested();
    if (!arg.startsWith('--')) {
      if (id !== undefined) throw new ScheduleUpdateUsageError(`多余的参数: ${arg}`);
      id = arg;
      continue;
    }
    const equals = arg.indexOf('=');
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (!UPDATE_FLAGS.includes(flag)) throw new ScheduleUpdateUsageError(`不认识的参数: ${flag}`);
    if (values.has(flag)) throw new ScheduleUpdateUsageError(`参数重复（duplicate）: ${flag}`);
    const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
    if (value === undefined || value.length === 0) throw new ScheduleUpdateUsageError(`${flag} 需要一个值`);
    values.set(flag, value);
  }
  if (!id) throw new ScheduleUpdateUsageError('缺少任务 id');
  if (values.has('--prompt') && values.has('--prompt-file')) {
    throw new ScheduleUpdateUsageError('--prompt 和 --prompt-file 只能二选一');
  }
  if (!['--schedule', '--prompt', '--prompt-file', '--calendar', '--calendar-day-type'].some(flag => values.has(flag))) {
    throw new ScheduleUpdateUsageError('没有要修改的字段');
  }
  const schedule = values.get('--schedule')?.trim();
  if (values.has('--schedule')) {
    if (!schedule) throw new ScheduleUpdateUsageError('--schedule 需要一个值');
    try { options.validateSchedule?.(schedule); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ScheduleUpdateUsageError(`无法解析频率 "${schedule}": ${reason}\n可用写法与 schedule add 相同，例如 ${SCHEDULE_EXPRESSION_EXAMPLES}`);
    }
  }
  const prompt = values.has('--prompt-file')
    ? readPromptFile(values.get('--prompt-file')!)
    : values.get('--prompt');
  if (prompt !== undefined && !prompt.trim()) throw new ScheduleUpdateUsageError('提示词不能为空（prompt must not be empty）');
  const calendar = values.get('--calendar');
  let calendarDayType: 'workday' | 'restday' | undefined;
  let calendarBinding: string | null | undefined;
  try {
    if (values.has('--calendar-day-type')) calendarDayType = normalizeCalendarDayType(values.get('--calendar-day-type'));
    if (calendar !== undefined) calendarBinding = calendar === 'none' ? null : normalizeCalendarBinding(calendar);
  } catch (error) {
    throw new ScheduleUpdateUsageError(error instanceof Error ? error.message : String(error));
  }
  return {
    ...(schedule ? { schedule } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(calendarBinding !== undefined ? { calendar: calendarBinding } : {}),
    ...(calendarDayType ? { calendarDayType } : {}),
  };
}

function readPromptFile(path: string): string {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    throw new ScheduleUpdateUsageError(`无法读取 --prompt-file ${path}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
}
