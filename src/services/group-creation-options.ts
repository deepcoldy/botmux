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

interface FlagSpec {
  key: OutputKey;
  isOptOut: boolean;
  apply(bag: Record<string, unknown>, value: string): void;
  clear(bag: Record<string, unknown>): void;
}

const FLAG_SPECS: Record<string, FlagSpec> = {
  'agents': {
    key: 'agents', isOptOut: false,
    apply(bag, value) {
      const refs = value.split(',').map(x => x.trim());
      if (refs.some(x => !x)) throw new Error('--agents requires comma-separated names or app IDs');
      bag.agents = refs;
    },
    clear(bag) { bag.agents = []; },
  },
  'no-agents': {
    key: 'agents', isOptOut: true,
    apply() { /* opt-out does not take a value */ },
    clear(bag) { bag.agents = []; },
  },
  'tag': {
    key: 'tag', isOptOut: false,
    apply(bag, value) { bag.tag = value; },
    clear(bag) { delete bag.tag; },
  },
  'no-tag': {
    key: 'tag', isOptOut: true,
    apply() { /* opt-out does not take a value */ },
    // Explicit opt-out: drop any inherited default outright instead of leaving an empty-string
    // tombstone that the business layer would have to interpret with truthy checks.
    clear(bag) { delete bag.tag; },
  },
  'avatar': {
    key: 'avatar', isOptOut: false,
    apply(bag, value) { bag.avatar = value; },
    clear() { /* avatar has no opt-out; defaults handle `off`. */ },
  },
  'role-profile': {
    key: 'role-profile', isOptOut: false,
    apply(bag, value) { bag.roleProfileId = value; },
    clear() { /* role-profile has no opt-out form. */ },
  },
};

/**
 * Single-pass, table-driven parser for `/g` arguments.
 *
 * Design:
 *  - Only flags listed in `FLAG_SPECS` are consumed. Unknown `--word` tokens are
 *    kept verbatim as group-name content so pre-existing user invocations keep
 *    working after this surface grows new options.
 *  - A bare `--` ends option processing. Everything after it, including known
 *    flag words like `--tag`, becomes group-name content.
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
  // Match three forms at a word boundary: `--flag`, `--flag=value`, bare `--` sentinel.
  // Unknown or malformed flags fall through and remain in the name body.
  const scanner = /(^|\s)(--[\w-]*)(=("[^"]*"|'[^']*'|[^\s]*))?/g;

  let m: RegExpExecArray | null;
  while ((m = scanner.exec(raw)) !== null) {
    const lead = m[1] ?? '';
    const flagToken = m[2];
    const eqPart = m[3];
    const eqValue = m[4];
    const flagStart = m.index + lead.length;
    const matchEnd = m.index + m[0].length;

    if (flagToken === '--') {
      // End-of-options sentinel. Strip the sentinel and the preceding whitespace
      // so a single-space normal case stays single-space.
      removals.push([m.index, matchEnd]);
      break;
    }

    const name = flagToken.slice(2);
    const spec = FLAG_SPECS[name];
    if (!spec) continue; // unknown flag → preserved as group-name content

    if (seen.has(spec.key)) throw new Error(`Duplicate option: --${name}`);
    seen.add(spec.key);

    if (spec.isOptOut) {
      if (eqPart !== undefined) throw new Error(`--${name} takes no value`);
      spec.clear(bag);
      // Include preceding whitespace in the removal so `A --no-tag B` collapses
      // to `A B` on the first-line path.
      removals.push([m.index, matchEnd]);
      continue;
    }

    let value: string | undefined = eqValue;
    let valueEnd = matchEnd;
    if (value === undefined) {
      // Space-form value: `--flag VALUE`. The next whitespace-delimited token
      // must exist and must not itself be a `--` flag — missing values stay
      // strict errors even with the forgiving unknown-flag rule.
      const after = raw.slice(matchEnd);
      const vm = after.match(/^([ \t]+)("[^"]*"|'[^']*'|(?!--)\S+)/);
      if (!vm) throw new Error(`Missing value for --${name}`);
      value = vm[2];
      valueEnd = matchEnd + vm[0].length;
    }
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
