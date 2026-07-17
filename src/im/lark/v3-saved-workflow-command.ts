/** Lightweight IM parser for the Saved Workflow portion of `/workflow`. */

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_PARAM_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

const AD_HOC_RUN_ESCAPE_HINT =
  '如果你是想发起一个以“run”开头的即兴目标，请用 `/workflow new run ...`。';

export type V3SavedWorkflowCommand =
  | {
      kind: 'save';
      source: 'last' | string;
      displayName?: string;
      global: boolean;
      acknowledgeUnsafeLiterals: boolean;
      /** Ask the host to propose a parameterized definition before publishing. */
      distill: boolean;
    }
  | { kind: 'run'; ref: string; rawParams: Record<string, string> }
  | { kind: 'cancel'; runId: string }
  | { kind: 'list' }
  | { kind: 'show'; ref: string }
  | { kind: 'invalid'; error: string };

/**
 * Return null for ordinary ad-hoc goals and non-workflow messages. The daemon
 * invokes this before the grill parser, so reserved verbs can never become an
 * accidental natural-language DAG goal.
 */
export function parseV3SavedWorkflowCommand(content: string): V3SavedWorkflowCommand | null {
  const match = /^\/workflow(?:\s+([\s\S]*))?$/.exec(content.trim());
  if (!match) return null;
  const tail = (match[1] ?? '').trim();
  if (!tail) return null;
  const tokens = tail.split(/\s+/);
  const sub = tokens[0]!.toLowerCase();
  if (!['save', 'run', 'cancel', 'list', 'show', 'resume'].includes(sub)) return null;

  if (sub === 'resume') {
    return {
      kind: 'invalid',
      error: 'v2 workflow resume 已下线；历史 run 已不可变，只能查看离线静态归档。v3 blocked run 请使用 `/workflow retry <runId>`。',
    };
  }

  if (sub === 'cancel') {
    if (tokens.length !== 2) {
      return { kind: 'invalid', error: '用法：/workflow cancel <runId>' };
    }
    const runId = tokens[1]!;
    if (!SAFE_RUN_ID.test(runId)) {
      return { kind: 'invalid', error: 'cancel 的 runId 非法' };
    }
    return { kind: 'cancel', runId };
  }

  if (sub === 'list') {
    return tokens.length === 1 ? { kind: 'list' } : { kind: 'invalid', error: '/workflow list 不接受其它参数' };
  }
  if (sub === 'show') {
    const ref = tokens.slice(1).join(' ').trim();
    if (!ref) return { kind: 'invalid', error: '用法：/workflow show <名称或 workflowId>' };
    return { kind: 'show', ref };
  }
  if (sub === 'save') {
    const firstSaveArg = tokens[1];
    // Flags do not force callers to spell the optional `last` source:
    // `/workflow save --ack-unsafe` retries the latest owned run.
    const source = firstSaveArg && !firstSaveArg.startsWith('--') ? firstSaveArg : 'last';
    if (source !== 'last' && !SAFE_RUN_ID.test(source)) {
      return { kind: 'invalid', error: 'save 的 runId 非法' };
    }
    const rest = tokens.slice(source === 'last' && firstSaveArg?.startsWith('--') ? 1 : 2);
    const supportedFlags = new Set(['--global', '--ack-unsafe', '--distill']);
    const malformedDistill = rest.find((token) =>
      token === '--distil' || token.startsWith('--distill='));
    if (malformedDistill) {
      return { kind: 'invalid', error: `save 不支持参数：${malformedDistill}` };
    }
    const global = rest.includes('--global');
    const acknowledgeUnsafeLiterals = rest.includes('--ack-unsafe');
    const distill = rest.includes('--distill');
    // Exact-save historically allowed tokens beginning with `--` in a
    // multi-word display name. Preserve that surface. Once `--distill` opts
    // into the stricter model-backed path, however, every flag must be known
    // so a typo can never silently alter the requested operation.
    const unknownFlag = rest.find((token) => token.startsWith('--') && !supportedFlags.has(token));
    if (distill && unknownFlag) {
      return { kind: 'invalid', error: `save 不支持参数：${unknownFlag}` };
    }
    const nameTokens = rest.filter((token) => !supportedFlags.has(token));
    const displayName = nameTokens.join(' ').trim();
    if (distill && !displayName) {
      return {
        kind: 'invalid',
        error: '参数蒸馏必须显式指定名称：/workflow save [last|runId] <名称> --distill',
      };
    }
    if (distill && global) {
      return { kind: 'invalid', error: '参数蒸馏 P0 只支持保存到本群，不能同时使用 --global' };
    }
    if (distill && acknowledgeUnsafeLiterals) {
      return { kind: 'invalid', error: '参数蒸馏不接受 --ack-unsafe；疑似敏感内容会直接拒绝固化' };
    }
    return {
      kind: 'save',
      source,
      ...(displayName ? { displayName } : {}),
      global,
      acknowledgeUnsafeLiterals,
      distill,
    };
  }

  const runTokens = tokenizeWorkflowRunTail(tail.slice(tokens[0]!.length).trim());
  if (!runTokens) {
    return { kind: 'invalid', error: 'run 参数引号未闭合；多词值请写成 key="multi word"' };
  }
  const firstParamIndex = runTokens.findIndex((token) => token.includes('='));
  const refTokens = firstParamIndex === -1 ? runTokens : runTokens.slice(0, firstParamIndex);
  const ref = refTokens.join(' ').trim();
  if (!ref) {
    return {
      kind: 'invalid',
      error: `用法：/workflow run <名称或 workflowId> [key=value ...]。${AD_HOC_RUN_ESCAPE_HINT}`,
    };
  }
  const rawParams = Object.create(null) as Record<string, string>;
  const paramTokens = firstParamIndex === -1 ? [] : runTokens.slice(firstParamIndex);
  for (const token of paramTokens) {
    const eq = token.indexOf('=');
    if (eq <= 0) {
      return {
        kind: 'invalid',
        error: `参数必须是 key=value：${token}。${AD_HOC_RUN_ESCAPE_HINT}`,
      };
    }
    const key = token.slice(0, eq);
    if (!SAFE_PARAM_NAME.test(key) || FORBIDDEN_PARAM_NAMES.has(key)) {
      return { kind: 'invalid', error: `参数名非法：${key}` };
    }
    if (Object.prototype.hasOwnProperty.call(rawParams, key)) {
      return { kind: 'invalid', error: `参数重复：${key}` };
    }
    rawParams[key] = token.slice(eq + 1);
  }
  return { kind: 'run', ref, rawParams };
}

/** Minimal IM quoting: preserve ordinary bytes, but let a value contain spaces
 * via `key="..."` or `key='...'`. This is intentionally not a shell parser and
 * never performs expansion or command substitution. */
function tokenizeWorkflowRunTail(value: string): string[] | undefined {
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (quote === '"' && char === '\\' && (value[i + 1] === '"' || value[i + 1] === '\\')) {
        token += value[++i]!;
      } else {
        token += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = '';
      }
    } else {
      token += char;
    }
  }
  if (quote) return undefined;
  if (token) tokens.push(token);
  return tokens;
}

export function v3SavedWorkflowUsage(): string {
  return [
    'Saved Workflow：',
    '/workflow save [last|runId] [名称] [--global（当前 Bot 全局）] [--ack-unsafe]',
    '/workflow save [last|runId] <名称> --distill（参数化后保存到本群）',
    '/workflow run <名称或 workflowId> [key=value ...]（多词值可用 key="multi word"）',
    '/workflow cancel <runId>',
    '/workflow list',
    '/workflow show <名称或 workflowId>',
    '若即兴目标本身以 run 开头，请使用 /workflow new run ...',
  ].join('\n');
}

/** Actionable hint shared by the IM execution adapter when a multi-word
 * `run ...` lookup fails and the user may have intended an ad-hoc goal. */
export function v3SavedWorkflowAdHocRunEscapeHint(): string {
  return AD_HOC_RUN_ESCAPE_HINT;
}
