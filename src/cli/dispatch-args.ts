/** Strict, side-effect-free argv parsing for `botmux dispatch`. */

export interface DispatchArgs {
  help: boolean;
  sessionId?: string;
  title?: string;
  brief?: string;
  briefFile?: string;
  chatId?: string;
  repo?: string;
  into?: string;
  standby: boolean;
  steer: boolean;
  bots: string[];
  botApps: string[];
}

export type DispatchArgsErrorCode =
  | 'UNKNOWN_OPTION'
  | 'UNEXPECTED_ARGUMENT'
  | 'OPTION_VALUE_REQUIRED';

export type DispatchArgsResult =
  | { ok: true; value: DispatchArgs }
  | { ok: false; errorCode: DispatchArgsErrorCode; error: string; option?: string };

const VALUE_FLAGS = new Map<string, keyof Pick<DispatchArgs,
  'sessionId' | 'title' | 'brief' | 'briefFile' | 'chatId' | 'repo' | 'into'
>>([
  ['--session-id', 'sessionId'],
  ['--title', 'title'],
  ['--brief', 'brief'],
  ['--brief-file', 'briefFile'],
  ['--chat-id', 'chatId'],
  ['--repo', 'repo'],
  ['--into', 'into'],
]);

const REPEATABLE_VALUE_FLAGS = new Map<string, 'bots' | 'botApps'>([
  ['--bot', 'bots'],
  ['--bot-app', 'botApps'],
]);

const BOOLEAN_FLAGS = new Map<string, 'standby' | 'steer' | 'help'>([
  ['--standby', 'standby'],
  ['--steer', 'steer'],
  ['--help', 'help'],
  ['-h', 'help'],
]);

function fail(
  errorCode: DispatchArgsErrorCode,
  error: string,
  option?: string,
): DispatchArgsResult {
  return { ok: false, errorCode, error, ...(option ? { option } : {}) };
}

/**
 * Outside the legacy help short-circuit, parse every token exactly once.
 * Historically cmdDispatch pulled out known options and silently ignored the
 * rest. That is unsafe for launch controls: an older binary could ignore a
 * model flag and dispatch with its default.
 */
export function parseDispatchArgs(args: readonly string[]): DispatchArgsResult {
  const value: DispatchArgs = {
    help: false,
    standby: false,
    steer: false,
    bots: [],
    botApps: [],
  };

  // Preserve the historical help short-circuit exactly: help has always been
  // safe to invoke alongside incomplete or future arguments because cmdDispatch
  // returned before inspecting anything else.
  if (args.includes('--help') || args.includes('-h')) {
    value.help = true;
    return { ok: true, value };
  }

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    const equals = token.indexOf('=');
    const flag = equals >= 0 ? token.slice(0, equals) : token;

    const singletonKey = VALUE_FLAGS.get(flag);
    const repeatableKey = REPEATABLE_VALUE_FLAGS.get(flag);
    if (singletonKey || repeatableKey) {
      const optionValue = equals >= 0 ? token.slice(equals + 1) : args[index + 1];
      // Preserve argValue's historical treatment of dash-prefixed values. A
      // quoted Markdown list (`--brief '- item'`) and values such as `-x` are
      // data, not proof that this option was omitted.
      if (optionValue === undefined) {
        return fail('OPTION_VALUE_REQUIRED', `${flag} requires a value`, flag);
      }
      if (equals < 0) index += 1;
      if (singletonKey) {
        // argValue historically returned the first occurrence. Keep that
        // precedence while still consuming and validating every token.
        if (value[singletonKey] === undefined) value[singletonKey] = optionValue;
      } else {
        value[repeatableKey!].push(optionValue);
      }
      continue;
    }

    const booleanKey = BOOLEAN_FLAGS.get(flag);
    if (booleanKey && equals < 0) {
      value[booleanKey] = true;
      continue;
    }

    if (token.startsWith('-')) {
      return fail('UNKNOWN_OPTION', `unknown option: ${flag}`, flag);
    }
    return fail('UNEXPECTED_ARGUMENT', `unexpected positional argument: ${token}`);
  }

  return { ok: true, value };
}
