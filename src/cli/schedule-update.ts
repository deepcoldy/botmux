import { readFileSync } from 'node:fs';

export const SCHEDULE_UPDATE_USAGE = 'botmux schedule update <id> (--prompt TEXT | --prompt-file FILE) [--lark-app-id APP]';

/** Parse before any mutation; preserve prompt bytes, including trailing newlines. */
export function readSchedulePromptUpdate(args: readonly string[]): string {
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
    if (!['--prompt', '--prompt-file', '--lark-app-id'].includes(flag)) {
      throw new Error(`unknown schedule update option: ${flag}`);
    }
    if (values.has(flag)) throw new Error(`duplicate option: ${flag}`);
    const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
    if (value === undefined || value.length === 0) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
  }
  if (!id || Number(values.has('--prompt')) + Number(values.has('--prompt-file')) !== 1) {
    throw new Error(`用法: ${SCHEDULE_UPDATE_USAGE}`);
  }
  const prompt = values.has('--prompt-file')
    ? readFileSync(values.get('--prompt-file')!, 'utf8')
    : values.get('--prompt')!;
  if (!prompt.trim()) throw new Error('prompt must not be empty');
  return prompt;
}
