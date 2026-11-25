import { botsInfoObjectEntries, isBotsInfoNameEntry } from './bots-info-shape.js';

export type GroupAvatarMode = 'name' | 'logo' | 'off';

/** Opt-in team defaults for /g; mentions retain creator election and invitations. */
export interface GroupCreationDefaults {
  agents?: string[];
  tag?: string;
  /** `name` renders the group name; `logo` reuses the session-group logo gradient. */
  avatar?: GroupAvatarMode;
  /** Opt-in task mode: when `true`, `/g <text>` names the chat from the text
   *  and this bot starts a session on it there. Absent / `false` keeps the
   *  released behavior — `/g <text>` only names a plain group. `--start` /
   *  `--no-start` override it for one command. */
  autoStart?: boolean;
  /** Opt-in form card mode: when `true`, a bare `/g` (no name, dir, branch, or
   *  task) opens an interactive form card to pick a directory, branch and
   *  optional group name. Absent / `false` keeps the released bare `/g`
   *  immediate-creation behavior. `--card` / `--no-card` override it per call. */
  card?: boolean;
}

const AVATAR_MODES: readonly GroupAvatarMode[] = ['name', 'logo', 'off'];

export function parseGroupCreationDefaults(value: unknown): GroupCreationDefaults {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('groupCreation must be an object');
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!['agents', 'tag', 'avatar', 'autoStart', 'card'].includes(key)) throw new Error(`Unknown groupCreation option: ${key}`);
  }
  const out: GroupCreationDefaults = {};
  if (v.agents !== undefined) {
    if (!Array.isArray(v.agents) || v.agents.some(x => typeof x !== 'string' || !x.trim())) throw new Error('agents must be a list of names or app IDs');
    out.agents = [...new Set((v.agents as string[]).map(x => x.trim()))];
  }
  if (v.tag !== undefined) {
    if (typeof v.tag !== 'string' || [...v.tag.trim()].length > 60) throw new Error('tag must be at most 60 characters');
    // Whitespace-only tags are normalized to absent so the business layer does not have to
    // juggle string truthy/falsy semantics to decide whether the user actually opted in.
    const trimmed = v.tag.trim();
    if (trimmed) out.tag = trimmed;
  }
  if (v.avatar !== undefined) {
    if (!AVATAR_MODES.includes(v.avatar as GroupAvatarMode)) throw new Error('avatar must be name, logo or off');
    out.avatar = v.avatar as GroupAvatarMode;
  }
  if (v.autoStart !== undefined) {
    if (typeof v.autoStart !== 'boolean') throw new Error('autoStart must be true or false');
    out.autoStart = v.autoStart;
  }
  if (v.card !== undefined) {
    if (typeof v.card !== 'boolean') throw new Error('card must be true or false');
    out.card = v.card;
  }
  return out;
}

export interface GroupCreationArgs extends GroupCreationDefaults {
  name: string;
  /** Every line left after removing the options: the task when `autoStart` is true. */
  body: string;
  roleProfileId?: string;
  workingDir?: string;
  branch?: string;
  /** True only when `--card` was explicitly passed on this command. */
  cardExplicit?: boolean;
}

type OutputKey = 'agents' | 'tag' | 'avatar' | 'role-profile' | 'start' | 'dir' | 'branch' | 'card';

/** Discriminated union — value flags only declare `apply`, opt-out flags only
 *  declare `clear`, opt-in switches only declare `set`. Keeps every spec
 *  truthful about what it supports. */
type FlagSpec =
  | { kind: 'value'; key: OutputKey; apply(bag: Record<string, unknown>, value: string): void }
  | { kind: 'optOut'; key: OutputKey; clear(bag: Record<string, unknown>): void }
  | { kind: 'optIn'; key: OutputKey; set(bag: Record<string, unknown>): void };

const FLAG_SPECS: Record<string, FlagSpec> = {
  'dir': { kind: 'value', key: 'dir', apply(bag, value) { bag.workingDir = value; } },
  'branch': { kind: 'value', key: 'branch', apply(bag, value) { bag.branch = value; } },
  'agents': {
    kind: 'value', key: 'agents',
    apply(bag, value) {
      const refs = value.split(',').map(x => x.trim());
      if (refs.some(x => !x)) throw new Error('--agents requires comma-separated names or app IDs');
      bag.agents = refs;
    },
  },
  'no-agents': { kind: 'optOut', key: 'agents', clear(bag) { bag.agents = []; } },
  'tag': { kind: 'value', key: 'tag', apply(bag, value) { bag.tag = value; } },
  // Explicit opt-out drops the inherited default instead of leaving an empty-string tombstone
  // that the business layer would have to interpret with truthy checks.
  'no-tag': { kind: 'optOut', key: 'tag', clear(bag) { delete bag.tag; } },
  'avatar': { kind: 'value', key: 'avatar', apply(bag, value) { bag.avatar = value; } },
  'role-profile': {
    kind: 'value', key: 'role-profile',
    apply(bag, value) { bag.roleProfileId = value; },
  },
  // Same key: `--start --no-start` in one command is a duplicate, not a race.
  'start': { kind: 'optIn', key: 'start', set(bag) { bag.autoStart = true; } },
  'no-start': { kind: 'optOut', key: 'start', clear(bag) { bag.autoStart = false; } },
  // Same key: `--card --no-card` in one command is a duplicate, not a race.
  'card': { kind: 'optIn', key: 'card', set(bag) { bag.card = true; bag.cardExplicit = true; } },
  'no-card': { kind: 'optOut', key: 'card', clear(bag) { bag.card = false; delete bag.cardExplicit; } },
};

/**
 * Single-pass, table-driven parser for `/g` arguments.
 *
 * Boundary contract:
 *  - A `--token` is recognized as a known flag ONLY when (a) `token` matches a
 *    FLAG_SPECS key exactly and (b) the character immediately after the token
 *    is `=`, whitespace, or end-of-input. `--tag.foo`, `--avatar:off`, etc. are
 *    treated as unknown content and preserved verbatim in the group name.
 *  - Bare `--` is the end-of-options sentinel only when it is followed by
 *    whitespace or EOF. `--=foo` keeps `--=foo` in the group name.
 *  - Known-flag values (both `--flag=VALUE` and `--flag VALUE`) must end on
 *    whitespace or EOF. `--tag="A"suffix` is a malformed value and raises;
 *    the parser never partially consumes a token into tag + stray body.
 *  - Known flags still enforce the strict error contract: missing value,
 *    invalid value, and duplicate occurrences all raise.
 *  - No shell evaluation. Quotes are only syntax for option values; the group
 *    name retains its original punctuation and spacing on the first non-empty
 *    line, matching the historical behavior.
 *  - Options are read from the first non-empty line only. Later lines are task
 *    text and stay verbatim: a pasted `docker build --tag x` or
 *    `git checkout -- file` must neither become an option nor lose its flags.
 */
export function parseGroupCreationArgs(rawArgs: string, defaults?: GroupCreationDefaults): GroupCreationArgs {
  // `parseGroupCreationDefaults` already normalizes blank defaults to absent,
  // but we may have been handed a raw object from a legacy call site; mirror
  // that normalization locally so defaults can be mutated by opt-outs.
  const bag: Record<string, unknown> = { ...defaults };
  if (typeof bag.tag === 'string' && !bag.tag.trim()) delete bag.tag;

  const firstContent = rawArgs.search(/\S/);
  const optionsEnd = firstContent < 0 ? -1 : rawArgs.indexOf('\n', firstContent);
  const raw = optionsEnd < 0 ? rawArgs : rawArgs.slice(0, optionsEnd);
  const taskTail = optionsEnd < 0 ? '' : rawArgs.slice(optionsEnd);

  const seen = new Set<OutputKey>();
  const removals: Array<[number, number]> = [];
  // Only locate the `--` + name token; value scanning is done manually below so
  // that each form can enforce its own trailing-boundary rule.
  const scanner = /(^|\s)--([\w-]*)/g;
  const isBoundary = (ch: string) => ch === '' || /\s/.test(ch);

  let m: RegExpExecArray | null;
  while ((m = scanner.exec(raw)) !== null) {
    const name = m[2];
    const nameEnd = scanner.lastIndex;
    const next = raw.charAt(nameEnd);

    if (name === '') {
      // Bare `--` sentinel only; `--=foo` and `--abc?` are preserved verbatim.
      if (!isBoundary(next)) continue;
      removals.push([m.index, nameEnd]);
      break;
    }

    const spec = FLAG_SPECS[name];
    // Unknown tokens, or known names fused into a longer unknown token
    // (e.g. `--tag.foo` → scanner matches `--tag`, next='.'), stay in the body.
    if (!spec || !(isBoundary(next) || next === '=')) continue;

    if (seen.has(spec.key)) throw new Error(`Duplicate option: --${name}`);
    seen.add(spec.key);

    if (spec.kind === 'optOut' || spec.kind === 'optIn') {
      if (next === '=') throw new Error(`--${name} takes no value`);
      if (spec.kind === 'optOut') spec.clear(bag);
      else spec.set(bag);
      removals.push([m.index, nameEnd]);
      continue;
    }

    // Value flag — collect raw value, then enforce the trailing boundary.
    let rawValue: string;
    let valueEnd: number;
    if (next === '=') {
      const after = raw.slice(nameEnd + 1);
      const vm = after.match(/^("[^"]*"|'[^']*'|\S*)/);
      rawValue = vm?.[1] ?? '';
      valueEnd = nameEnd + 1 + rawValue.length;
    } else {
      // Space-form: consume one whitespace-delimited token, which must not
      // itself be a `--` flag or we treat it as a missing value.
      const after = raw.slice(nameEnd);
      const vm = after.match(/^([ \t]+)("[^"]*"|'[^']*'|(?!--)\S+)/);
      if (!vm) throw new Error(`Missing value for --${name}`);
      rawValue = vm[2];
      valueEnd = nameEnd + vm[0].length;
    }
    if (!isBoundary(raw.charAt(valueEnd))) throw new Error(`Malformed value for --${name}`);

    let value = rawValue;
    if (value.startsWith('"') || value.startsWith("'")) {
      if (value.length < 2 || value.at(-1) !== value[0]) throw new Error(`Unclosed quote for --${name}`);
      value = value.slice(1, -1);
    }
    if (!value.trim()) throw new Error(`Missing value for --${name}`);
    spec.apply(bag, value);
    removals.push([m.index, valueEnd]);
    scanner.lastIndex = valueEnd;
  }

  // Rebuild the group-name body by stripping only the spans we actually consumed.
  removals.sort((a, b) => a[0] - b[0]);
  let body = '';
  let cursor = 0;
  for (const [s, e] of removals) {
    body += raw.slice(cursor, s);
    cursor = e;
  }
  body += raw.slice(cursor) + taskTail;
  const firstLine = body.split(/\r?\n/).map(x => x.trim()).find(Boolean) ?? '';

  const roleProfileId = typeof bag.roleProfileId === 'string' ? bag.roleProfileId : undefined;
  const workingDir = typeof bag.workingDir === 'string' ? bag.workingDir : undefined;
  const branch = typeof bag.branch === 'string' ? bag.branch : undefined;
  const cardExplicit = bag.cardExplicit === true;
  delete bag.roleProfileId;
  delete bag.workingDir;
  delete bag.branch;
  delete bag.cardExplicit;
  const parsed = parseGroupCreationDefaults(bag);
  return {
    ...parsed,
    name: firstLine,
    body: body.trim(),
    roleProfileId,
    ...(workingDir ? { workingDir } : {}),
    ...(branch ? { branch } : {}),
    ...(cardExplicit ? { cardExplicit: true } : {}),
  };
}

/**
 * Decide whether `/g` opens the interactive creation card or creates a group
 * immediately.
 *
 * Backward-compatibility contract:
 *  - Without `groupCreation.card: true` and without `--card`, always `'direct'`
 *    (bare `/g` keeps its released immediate-creation + AI-title behavior).
 *  - Explicit `--card` opens the form card (prefilling any parsed name/dir/branch),
 *    unless a task would actually auto-start (`'conflict_with_start'`).
 *  - Opt-in `groupCreation.card: true` (without `--no-card`) opens the form card
 *    only when no name, dir, branch, or task was supplied on the command line.
 */
export function shouldOpenGroupCreateCard(
  args: Pick<GroupCreationArgs, 'card' | 'cardExplicit' | 'name' | 'workingDir' | 'branch'>,
  opts: { autoStart: boolean },
): 'card' | 'conflict_with_start' | 'direct' {
  if (args.cardExplicit) {
    return opts.autoStart ? 'conflict_with_start' : 'card';
  }
  if (args.card === true) {
    return (!args.name && !args.workingDir && !args.branch && !opts.autoStart) ? 'card' : 'direct';
  }
  return 'direct';
}

const GROUP_COMMAND_PREFIX = /^\/(?:group|g)(?=\s|$)/i;

/**
 * Whether a `/g` command text starts a task for a bot with these
 * `groupCreation` defaults: `--start` on its first line, or `autoStart: true`
 * without `--no-start`. Routing uses it to accept a multi-line `/g` only then;
 * any other multi-line `/g` stays discussion text for the CLI, as before task
 * mode existed. Unparseable options or defaults → false (legacy routing).
 */
export function groupCommandStartsTask(commandText: string, defaults: unknown): boolean {
  const text = commandText.trim();
  if (!GROUP_COMMAND_PREFIX.test(text)) return false;
  try {
    const base = defaults === undefined ? undefined : parseGroupCreationDefaults(defaults);
    return parseGroupCreationArgs(text.replace(GROUP_COMMAND_PREFIX, ''), base).autoStart === true;
  } catch {
    return false;
  }
}

export function isGroupCommandText(commandText: string): boolean {
  return GROUP_COMMAND_PREFIX.test(commandText.trim());
}

/** Shared name view of bots-info.json, including name-only rows. */
export function knownGroupBotNames(value: unknown): Set<string> {
  return new Set(botsInfoObjectEntries(value).filter(isBotsInfoNameEntry)
    .map(entry => entry.botName.toLowerCase()));
}

/** First-known-bot election input shared by routing and handleCommand. */
export function knownGroupBotMentions<T extends { name?: string }>(
  mentions: readonly T[],
  knownBotNames: ReadonlySet<string>,
): T[] {
  return mentions.filter(m => m.name && knownBotNames.has(m.name.toLowerCase()));
}

export interface GroupRoutingBotDefaults {
  botName: string;
  groupCreation?: unknown;
}

/**
 * Multi-line routing must be identical in every mentioned bot's daemon. When
 * bots are mentioned, use the FIRST known bot's shared defaults — never the
 * receiving daemon's own defaults. Ambiguous duplicate names fail closed for
 * implicit task mode (`every`), while an explicit --start remains available.
 */
export function groupCommandStartsTaskForRouting(input: {
  commandText: string;
  ownDefaults: unknown;
  mentions?: ReadonlyArray<{ name?: string }>;
  knownBots: readonly GroupRoutingBotDefaults[];
}): boolean {
  if (!isGroupCommandText(input.commandText)) return false;
  const knownBotsByName = new Map<string, GroupRoutingBotDefaults[]>();
  for (const bot of input.knownBots) {
    const name = bot.botName.toLowerCase();
    const entries = knownBotsByName.get(name) ?? [];
    entries.push(bot);
    knownBotsByName.set(name, entries);
  }
  const knownNames = new Set(knownBotsByName.keys());
  const mentions = input.mentions ?? [];
  // A degraded/empty registry cannot prove that a mention is human. Do not
  // fork on each daemon's own defaults; explicit --start still parses true.
  if (mentions.length > 0 && knownNames.size === 0) {
    return groupCommandStartsTask(input.commandText, undefined);
  }
  const botMentions = knownGroupBotMentions(mentions, knownNames);
  if (botMentions.length === 0) {
    return groupCommandStartsTask(input.commandText, input.ownDefaults);
  }
  const candidates = knownBotsByName.get(botMentions[0]!.name!.toLowerCase()) ?? [];
  if (candidates.length === 0) return groupCommandStartsTask(input.commandText, undefined);
  return candidates.every(candidate => groupCommandStartsTask(input.commandText, candidate.groupCreation));
}

/** What /g should do beyond creating the chat, derived from the parsed args. */
export interface GroupDecorations {
  /** Avatar to apply at creation; undefined = leave Feishu's default. */
  avatar?: 'name' | 'logo';
  /** Rename the chat from its first substantive message (session-group style). */
  autoTitle: boolean;
}

/**
 * /g chats get the session-group treatment by default: the logo-gradient
 * avatar, and — when unnamed — a placeholder AI-titled from the first
 * substantive message (an explicit name always wins). `--avatar name` is
 * re-rendered once that title lands; `--avatar off` keeps Feishu's default.
 */
export function resolveGroupDecorations(args: GroupCreationArgs): GroupDecorations {
  const avatar = args.avatar ?? 'logo';
  return {
    avatar: avatar === 'off' ? undefined : avatar,
    autoTitle: !args.name,
  };
}

const SLASH_GROUP_NAME_MAX_UTF16_LENGTH = 50;

/** Apply the machine-wide prefix used only by `/group` and `/g`, then keep the
 *  existing Lark headroom. The legacy limit is measured in UTF-16 code units;
 *  iterating by code point keeps that limit without slicing an emoji's
 *  surrogate pair. */
export function formatSlashGroupName(name: string, prefix = ''): string {
  const prefixed = prefix && !name.startsWith(prefix) ? `${prefix}${name}` : name;
  if (prefixed.length <= SLASH_GROUP_NAME_MAX_UTF16_LENGTH) return prefixed;

  let truncated = '';
  for (const character of prefixed) {
    if (truncated.length + character.length > SLASH_GROUP_NAME_MAX_UTF16_LENGTH) break;
    truncated += character;
  }
  return `${truncated}…`;
}

/** Config is authoritative for membership/transport; probe cache only supplies names. */
export function resolveGroupCreationAgents(
  refs: string[],
  configs: Array<{ larkAppId: string; displayName?: string; apiOnly?: boolean }>,
  botInfo: Array<{ larkAppId?: string; botName?: string | null }>,
): string[] {
  const bots = configs.filter(b => !b.apiOnly).map(b => ({
    larkAppId: b.larkAppId,
    botName: b.displayName ?? botInfo.find(info => info.larkAppId === b.larkAppId)?.botName,
  }));
  return [...new Set(refs.map(ref => {
    const exactId = bots.filter(b => b.larkAppId === ref);
    const matches = exactId.length ? exactId : bots.filter(b => b.botName?.toLowerCase() === ref.toLowerCase());
    const ids = [...new Set(matches.map(b => b.larkAppId).filter((id): id is string => !!id))];
    if (ids.length !== 1) throw new Error(ids.length ? `Ambiguous agent: ${ref}; use its app ID` : `Unknown agent: ${ref}`);
    return ids[0];
  }))];
}
