/** Strict parser for the script-facing `botmux grant chat` command. */

export type ExactChatGrantCliOperation = 'grant' | 'revoke' | 'readback';

export interface ExactChatGrantCliArgs {
  operation: ExactChatGrantCliOperation;
  receiverRef: string;
  chatId: string;
  subjectOpenIds: string[];
  subjectLarkAppIds: string[];
}

export type ExactChatGrantCliParseResult =
  | { ok: true; value: ExactChatGrantCliArgs }
  | { ok: false; error: string };

type FlagName = '--bot' | '--chat-id' | '--subject-open-id' | '--subject-bot';

/**
 * Parse a value-bearing flag without the permissive `argValues` behavior where
 * `--subject-open-id --chat-id ...` accidentally consumes `--chat-id` as the
 * open_id. A value beginning with `-` is invalid for all value flags here.
 */
function takeFlagValue(
  args: string[],
  index: number,
  flag: FlagName,
): { ok: true; value: string; consumed: number } | { ok: false; error: string } {
  const token = args[index];
  if (token === flag) {
    const value = args[index + 1];
    if (value === undefined || value === '' || value.startsWith('-')) {
      return { ok: false, error: `${flag} 缺少值` };
    }
    return { ok: true, value, consumed: 2 };
  }
  if (token.startsWith(`${flag}=`)) {
    const value = token.slice(flag.length + 1);
    if (!value || value.startsWith('-')) return { ok: false, error: `${flag} 缺少值` };
    return { ok: true, value, consumed: 1 };
  }
  return { ok: false, error: `internal parser mismatch for ${flag}` };
}

export function parseExactChatGrantCliArgs(args: string[]): ExactChatGrantCliParseResult {
  if (args[0] !== 'chat') {
    return { ok: false, error: '用法: botmux grant chat [revoke|readback] --bot <receiver> --chat-id <oc_...> (--subject-open-id <ou_...> | --subject-bot <larkAppId>)' };
  }

  let operation: ExactChatGrantCliOperation = 'grant';
  let index = 1;
  if (args[index] === 'revoke') {
    operation = 'revoke';
    index++;
  } else if (args[index] === 'readback' || args[index] === 'status') {
    operation = 'readback';
    index++;
  }

  const botValues: string[] = [];
  const chatValues: string[] = [];
  const subjectOpenIds: string[] = [];
  const subjectLarkAppIds: string[] = [];

  while (index < args.length) {
    const token = args[index];
    const flag: FlagName | undefined = token === '--bot' || token.startsWith('--bot=')
      ? '--bot'
      : token === '--chat-id' || token.startsWith('--chat-id=')
        ? '--chat-id'
        : token === '--subject-open-id' || token.startsWith('--subject-open-id=')
          ? '--subject-open-id'
          : token === '--subject-bot' || token.startsWith('--subject-bot=')
            ? '--subject-bot'
          : undefined;
    if (!flag) return { ok: false, error: `未知参数: ${token}` };

    const parsed = takeFlagValue(args, index, flag);
    if (!parsed.ok) return parsed;
    if (flag === '--bot') botValues.push(parsed.value.trim());
    else if (flag === '--chat-id') chatValues.push(parsed.value.trim());
    else if (flag === '--subject-open-id') subjectOpenIds.push(parsed.value.trim());
    else subjectLarkAppIds.push(parsed.value.trim());
    index += parsed.consumed;
  }

  if (botValues.length !== 1 || !botValues[0]) {
    return { ok: false, error: '必须且只能传一个 --bot <receiver>' };
  }
  if (chatValues.length !== 1 || !chatValues[0]) {
    return { ok: false, error: '必须且只能传一个 --chat-id <oc_...>' };
  }
  if (subjectOpenIds.length > 0 && subjectLarkAppIds.length > 0) {
    return { ok: false, error: '--subject-open-id 与 --subject-bot 严格二选一，不能混用' };
  }
  if (subjectOpenIds.length === 0 && subjectLarkAppIds.length === 0) {
    return { ok: false, error: '至少传一个 --subject-open-id <ou_...> 或 --subject-bot <larkAppId>' };
  }
  if (subjectOpenIds.some(value => !value) || subjectLarkAppIds.some(value => !value)) {
    return { ok: false, error: 'subject 不能为空' };
  }
  if (subjectLarkAppIds.length > 0 && operation !== 'grant') {
    return { ok: false, error: '--subject-bot 仅支持 grant；revoke/readback 必须使用 --subject-open-id' };
  }

  return {
    ok: true,
    value: {
      operation,
      receiverRef: botValues[0],
      chatId: chatValues[0],
      subjectOpenIds,
      subjectLarkAppIds,
    },
  };
}
