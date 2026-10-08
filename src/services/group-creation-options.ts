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
    out.tag = v.tag.trim();
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

/** No shell evaluation. Quotes are only syntax for option values; names retain
 * their original punctuation/spacing and the historical first-line behavior. */
export function parseGroupCreationArgs(raw: string, defaults?: GroupCreationDefaults): GroupCreationArgs {
  const options: Record<string, unknown> = { ...defaults };
  let roleProfileId: string | undefined;
  const seen = new Set<string>();
  const optionPattern = /(?:^|\s)--([\w-]+)(?:=("[^"]*"|'[^']*'|[^\s]+)|(?:[ \t]+)("[^"]*"|'[^']*'|(?!--)[^\s]+))?/g;
  const name = raw.replace(optionPattern, (_match, flag: string, equalValue?: string, spacedValue?: string) => {
    const key = flag.startsWith('no-') ? flag.slice(3) : flag;
    if (!['agents', 'tag', 'avatar', 'role-profile'].includes(key) || (flag.startsWith('no-') && !['agents', 'tag'].includes(key))) throw new Error(`Unknown option: --${flag}`);
    if (seen.has(key)) throw new Error(`Duplicate option: --${key}`);
    seen.add(key);
    // Boolean opt-outs must not consume the following group-name word.
    if (flag.startsWith('no-')) {
      if (equalValue !== undefined) throw new Error(`--${flag} takes no value`);
      options[key] = key === 'agents' ? [] : '';
      return spacedValue === undefined ? ' ' : ` ${spacedValue}`;
    }
    let value = equalValue ?? spacedValue;
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${flag}`);
    if (value.startsWith('"') || value.startsWith("'")) {
      if (value.length < 2 || value.at(-1) !== value[0]) throw new Error(`Unclosed quote for --${flag}`);
      value = value.slice(1, -1);
    }
    if (!value.trim()) throw new Error(`Missing value for --${flag}`);
    if (key === 'role-profile') roleProfileId = value;
    else if (key === 'agents') {
      const refs = value.split(',').map(x => x.trim());
      if (refs.some(x => !x)) throw new Error('--agents requires comma-separated names or app IDs');
      options.agents = refs;
    } else options[key] = value;
    return ' ';
  }).split(/\r?\n/).map(x => x.trim()).find(Boolean) ?? '';
  return { ...parseGroupCreationDefaults(options), name, roleProfileId };
}

export function resolveGroupCreationAgents(refs: string[], bots: Array<{ larkAppId?: string; botName?: string | null }>): string[] {
  return [...new Set(refs.map(ref => {
    const exactId = bots.filter(b => b.larkAppId === ref);
    const matches = exactId.length ? exactId : bots.filter(b => b.botName?.toLowerCase() === ref.toLowerCase());
    const ids = [...new Set(matches.map(b => b.larkAppId).filter((id): id is string => !!id))];
    if (ids.length !== 1) throw new Error(ids.length ? `Ambiguous agent: ${ref}; use its app ID` : `Unknown agent: ${ref}`);
    return ids[0];
  }))];
}
