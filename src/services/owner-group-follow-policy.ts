export type OwnerGroupFollowMatchField = 'name' | 'description' | 'any';
export type OwnerGroupFollowMatchOp = 'contains' | 'startsWith' | 'endsWith' | 'regex';

export interface OwnerGroupFollowRule {
  field: OwnerGroupFollowMatchField;
  op: OwnerGroupFollowMatchOp;
  pattern: string;
  caseSensitive?: boolean;
}

/** Per-bot opt-in to invite the bot to groups its configured owner newly joins. */
export interface OwnerGroupFollowConfig {
  enabled?: boolean;
  excludeChatIds?: string[];
  includeRules?: OwnerGroupFollowRule[];
  excludeRules?: OwnerGroupFollowRule[];
  pollIntervalSeconds?: number;
}

export interface OwnerGroupFollowChatMetadata {
  chatId?: string;
  name?: string;
  description?: string;
}

export interface OwnerGroupFollowMatchResult {
  matched: boolean;
  reason: 'all' | 'included_rule' | 'not_included' | 'excluded_rule' | 'excluded_chat_id';
  ruleIndex?: number;
  rule?: OwnerGroupFollowRule;
}

export const MAX_OWNER_GROUP_FOLLOW_RULES = 50;
export const MAX_OWNER_GROUP_FOLLOW_PATTERN_LENGTH = 200;

// Scan classes, escapes and group prefixes as units. The native parser checks syntax.
const regexTokens = /\[(?:\\.|[^\\\]])*\]|\\(?:\d+|k<|x[\da-fA-F]{2}|u[\da-fA-F]{4}|.)|\(\?(?:[:=!]|<[=!]|<[^>]+>|[ims-]+:)|\{\d+(?:,\d*)?\}|./gs;

function classCodeUnit(token: string | undefined): number {
  if (!token) return NaN;
  if (token.length === 1) return token.charCodeAt(0);
  const hex = /^\\[xu]([\da-fA-F]+)$/.exec(token);
  return hex ? Number.parseInt(hex[1]!, 16) : NaN;
}

function isWideRegexAtom(token: string): boolean {
  if (token === '.' || /^\\[wSDW]$/.test(token) || token.startsWith('[^')) return true;
  if (!token.startsWith('[')) return false;
  const members = token.slice(1, -1).match(regexTokens) ?? [];
  return members.some((member, index) => /^\\[wSDW]$/.test(member)
    || (member === '-' && classCodeUnit(members[index + 1]) - classCodeUnit(members[index - 1]) >= 10));
}

interface RegexGroup {
  choices: boolean;
  wide: boolean;
  adjacentVariableWidths: number;
}

/** Reject obvious backtracking risks before testing a pattern. */
function isSafeRegex(pattern: string): boolean {
  const groups: RegexGroup[] = [{ choices: false, wide: false, adjacentVariableWidths: 0 }];
  let wideVariableWidths = 0;
  let totalVariableWidths = 0;
  let atom: { wide: boolean; choices: boolean } | undefined;
  for (const [token] of pattern.matchAll(regexTokens)) {
    if (/^\\(?:[1-9]|k<)/.test(token)) return false;
    const group = groups[groups.length - 1]!;
    const quantifier = /^(?:[+*?]|\{(\d+)(?:(,)(\d*))?\})$/.exec(token);
    if (quantifier) {
      // A second '?' is the lazy suffix of the preceding quantifier.
      if (!atom) continue;
      const min = token === '+' ? 1 : Number(quantifier[1] ?? 0);
      const max = token === '?' ? 1 : token === '+' || token === '*' ? Infinity
        : quantifier[2] ? Number(quantifier[3] || Infinity) : min;
      if (atom.choices && max > 1) return false;
      if (min < max) {
        group.choices = true;
        if (++group.adjacentVariableWidths >= 3 || ++totalVariableWidths > 8) return false;
        if (atom.wide && ++wideVariableWidths >= 3) return false;
      } else {
        group.adjacentVariableWidths = 0;
      }
      atom = undefined;
      continue;
    }
    // A fixed-width atom separates adjacent variable-width segments. Track
    // adjacency inside each group without clearing the parent group's count.
    if (atom) group.adjacentVariableWidths = 0;
    atom = undefined;
    if (token.startsWith('(')) {
      groups.push({ choices: false, wide: false, adjacentVariableWidths: 0 });
    } else if (token === ')' && groups.length > 1) {
      atom = groups.pop()!;
      const outer = groups[groups.length - 1]!;
      outer.choices ||= atom.choices;
      outer.wide ||= atom.wide;
    } else if (token === '|') {
      group.choices = true;
      group.adjacentVariableWidths = 0;
      if (groups.length === 1) {
        wideVariableWidths = 0;
        totalVariableWidths = 0;
      }
    } else {
      atom = { wide: isWideRegexAtom(token), choices: false };
      group.wide ||= atom.wide;
    }
  }
  return true;
}

function regexFlags(rule: OwnerGroupFollowRule): string {
  return rule.caseSensitive ? '' : 'i';
}

function compileRegex(pattern: string, flags: string): RegExp {
  try { return new RegExp(pattern, flags); }
  catch (error) {
    // Older engines lack inline modifiers. With global i, an i-only group is
    // redundant. Any other modifier stays in the pattern for the native parser.
    if (flags !== 'i') throw error;
    const portable = pattern.replace(regexTokens, token => token === '(?i:' ? '(?:' : token);
    if (portable === pattern) throw error;
    return new RegExp(portable, flags);
  }
}

type CheckedRegex = RegExp | 'invalidRegex' | 'unsafeRegex';
const checkedRegexes = new WeakMap<OwnerGroupFollowRule, { pattern: string; flags: string; result: CheckedRegex }>();

function checkedRegex(rule: OwnerGroupFollowRule): CheckedRegex {
  const { pattern } = rule;
  const flags = regexFlags(rule);
  const cached = checkedRegexes.get(rule);
  if (cached?.pattern === pattern && cached.flags === flags) return cached.result;
  let result: CheckedRegex;
  try {
    const regex = compileRegex(pattern, flags);
    result = isSafeRegex(pattern) ? regex : 'unsafeRegex';
  } catch { result = 'invalidRegex'; }
  checkedRegexes.set(rule, { pattern, flags, result });
  return result;
}

const ruleErrors = {
  shape: 'rule must be a plain object',
  unknownField: 'rule has an unknown property',
  field: 'rule field must be name, description or any',
  op: 'rule op must be contains, startsWith, endsWith or regex',
  empty: 'rule pattern must be a non-empty string',
  tooLong: `rule pattern must be at most ${MAX_OWNER_GROUP_FOLLOW_PATTERN_LENGTH} characters`,
  caseSensitive: 'rule caseSensitive must be boolean',
  invalidRegex: 'rule pattern is not a valid regular expression',
  unsafeRegex: 'rule pattern is an unsafe regular expression',
};

export function validateOwnerGroupFollowRule(raw: unknown): keyof typeof ruleErrors | undefined {
  if (raw === null || typeof raw !== 'object') return 'shape';
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) return 'shape';
  const rule = raw as OwnerGroupFollowRule;
  if (Object.keys(rule).some(key => !['field', 'op', 'pattern', 'caseSensitive'].includes(key))) return 'unknownField';
  if (!['name', 'description', 'any'].includes(rule.field)) return 'field';
  if (!['contains', 'startsWith', 'endsWith', 'regex'].includes(rule.op)) return 'op';
  if (typeof rule.pattern !== 'string' || !rule.pattern.trim()) return 'empty';
  if (rule.pattern.length > MAX_OWNER_GROUP_FOLLOW_PATTERN_LENGTH) return 'tooLong';
  if (rule.caseSensitive !== undefined && typeof rule.caseSensitive !== 'boolean') return 'caseSensitive';
  if (rule.op === 'regex') {
    const regex = checkedRegex(rule);
    if (typeof regex === 'string') return regex;
  }
}

function normalizeRules(raw: unknown, list: 'includeRules' | 'excludeRules'): OwnerGroupFollowRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_OWNER_GROUP_FOLLOW_RULES) {
    throw new Error(`${list} must be an array of at most ${MAX_OWNER_GROUP_FOLLOW_RULES} rules`);
  }
  const rules = new Map<string, OwnerGroupFollowRule>();
  for (const [index, value] of raw.entries()) {
    const error = validateOwnerGroupFollowRule(value);
    if (error) throw new Error(`${list}[${index}]: ${ruleErrors[error]}`);
    const { field, op, pattern, caseSensitive } = value as OwnerGroupFollowRule;
    const key = JSON.stringify([field, op, pattern, Boolean(caseSensitive)]);
    if (!rules.has(key)) rules.set(key, { field, op, pattern, ...(caseSensitive ? { caseSensitive } : {}) });
  }
  return [...rules.values()];
}

export function normalizeOwnerGroupFollowConfig(raw: unknown): OwnerGroupFollowConfig | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('ownerGroupFollow must be an object');
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!['enabled', 'excludeChatIds', 'includeRules', 'excludeRules', 'pollIntervalSeconds'].includes(key)) throw new Error(`unknown ownerGroupFollow field: ${key}`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('enabled must be boolean');
  if (value.pollIntervalSeconds !== undefined && (!Number.isInteger(value.pollIntervalSeconds)
      || Number(value.pollIntervalSeconds) < 30 || Number(value.pollIntervalSeconds) > 3600)) {
    throw new Error('pollIntervalSeconds must be an integer between 30 and 3600');
  }
  if (value.excludeChatIds !== undefined && (!Array.isArray(value.excludeChatIds)
      || value.excludeChatIds.length > 1000
      || value.excludeChatIds.some(id => typeof id !== 'string' || !/^oc_[A-Za-z0-9_-]+$/.test(id)))) {
    throw new Error('excludeChatIds must contain group chat IDs');
  }
  const excludeChatIds = [...new Set(value.excludeChatIds as string[] | undefined ?? [])];
  const includeRules = normalizeRules(value.includeRules, 'includeRules');
  const excludeRules = normalizeRules(value.excludeRules, 'excludeRules');
  const result: OwnerGroupFollowConfig = {
    ...(value.enabled === true ? { enabled: true } : {}),
    ...(excludeChatIds.length ? { excludeChatIds } : {}),
    ...(includeRules.length ? { includeRules } : {}),
    ...(excludeRules.length ? { excludeRules } : {}),
    ...(value.pollIntervalSeconds !== undefined && value.pollIntervalSeconds !== 60
      ? { pollIntervalSeconds: Number(value.pollIntervalSeconds) } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

export function matchesOwnerGroupFollowRule(rule: OwnerGroupFollowRule, chat: OwnerGroupFollowChatMetadata): boolean {
  if (typeof rule.pattern !== 'string' || !rule.pattern.trim()) return false;
  const name = typeof chat.name === 'string' ? chat.name : '';
  const description = typeof chat.description === 'string' ? chat.description : '';
  const targets = rule.field === 'any' ? [name, description] : [rule.field === 'name' ? name : description];
  if (rule.op === 'regex') {
    if (rule.pattern.length > MAX_OWNER_GROUP_FOLLOW_PATTERN_LENGTH) return false;
    const regex = checkedRegex(rule);
    return typeof regex !== 'string' && targets.some(target => regex.test(target));
  }
  const pattern = rule.caseSensitive ? rule.pattern : rule.pattern.toLowerCase();
  return targets.some(value => {
    const target = rule.caseSensitive ? value : value.toLowerCase();
    switch (rule.op) {
      case 'contains': return target.includes(pattern);
      case 'startsWith': return target.startsWith(pattern);
      case 'endsWith': return target.endsWith(pattern);
    }
  });
}

export function evaluateOwnerGroupFollowFilter(
  config: OwnerGroupFollowConfig | undefined, chat: OwnerGroupFollowChatMetadata,
): OwnerGroupFollowMatchResult {
  if (chat.chatId && config?.excludeChatIds?.includes(chat.chatId)) return { matched: false, reason: 'excluded_chat_id' };
  for (const [ruleIndex, rule] of (config?.excludeRules ?? []).entries()) {
    if (matchesOwnerGroupFollowRule(rule, chat)) return { matched: false, reason: 'excluded_rule', ruleIndex, rule };
  }
  if (config?.includeRules?.length) {
    for (const [ruleIndex, rule] of config.includeRules.entries()) {
      if (matchesOwnerGroupFollowRule(rule, chat)) return { matched: true, reason: 'included_rule', ruleIndex, rule };
    }
    return { matched: false, reason: 'not_included' };
  }
  return { matched: true, reason: 'all' };
}

const changeHandlers = new Map<string, () => void>();
export function registerOwnerGroupFollowChangeHandler(appId: string, handler: () => void): () => void {
  changeHandlers.set(appId, handler);
  return () => { if (changeHandlers.get(appId) === handler) changeHandlers.delete(appId); };
}
export function notifyOwnerGroupFollowChanged(appId: string): void {
  changeHandlers.get(appId)?.();
}
