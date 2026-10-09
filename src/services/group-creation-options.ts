/** Opt-in team defaults for /g; mentions retain creator election and invitations. */
export interface GroupCreationDefaults {
  agents?: string[];
  tag?: string;
  avatar?: 'name' | 'off';
}

export function parseGroupCreationDefaults(value: unknown): GroupCreationDefaults {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('groupCreation must be an object');
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!['agents', 'tag', 'avatar'].includes(key)) throw new Error(`Unknown groupCreation option: ${key}`);
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
    if (v.avatar !== 'name' && v.avatar !== 'off') throw new Error('avatar must be name or off');
    out.avatar = v.avatar;
  }
  return out;
}

export interface GroupCreationArgs extends GroupCreationDefaults {
  name: string;
  roleProfileId?: string;
}

type OutputKey = 'agents' | 'tag' | 'avatar' | 'role-profile';

/** Discriminated union — value flags only declare `apply`, opt-out flags only
 *  declare `clear`. Keeps every spec truthful about what it supports. */
type FlagSpec =
  | { kind: 'value'; key: OutputKey; apply(bag: Record<string, unknown>, value: string): void }
  | { kind: 'optOut'; key: OutputKey; clear(bag: Record<string, unknown>): void };

const FLAG_SPECS: Record<string, FlagSpec> = {
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
 */
export function parseGroupCreationArgs(raw: string, defaults?: GroupCreationDefaults): GroupCreationArgs {
  // `parseGroupCreationDefaults` already normalizes blank defaults to absent,
  // but we may have been handed a raw object from a legacy call site; mirror
  // that normalization locally so defaults can be mutated by opt-outs.
  const bag: Record<string, unknown> = { ...defaults };
  if (typeof bag.tag === 'string' && !bag.tag.trim()) delete bag.tag;

  const seen = new Set<OutputKey>();
  const removals: Array<[number, number]> = [];
  // Only locate the `--` + name token; value scanning is done manually below so
  // that each form can enforce its own trailing-boundary rule.
  const scanner = /(^|\s)--([\w-]*)/g;
  const isBoundary = (ch: string) => ch === '' || /\s/.test(ch);

  let m: RegExpExecArray | null;
  while ((m = scanner.exec(raw)) !== null) {
    const lead = m[1] ?? '';
    const name = m[2];
    const flagStart = m.index + lead.length;
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

    if (spec.kind === 'optOut') {
      if (next === '=') throw new Error(`--${name} takes no value`);
      spec.clear(bag);
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
  body += raw.slice(cursor);
  const firstLine = body.split(/\r?\n/).map(x => x.trim()).find(Boolean) ?? '';

  const roleProfileId = typeof bag.roleProfileId === 'string' ? bag.roleProfileId : undefined;
  delete bag.roleProfileId;
  return { ...parseGroupCreationDefaults(bag), name: firstLine, roleProfileId };
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
