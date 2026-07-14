import { isAbsolute } from 'node:path';

export interface ParsedSkillInstallSource {
  kind: 'local' | 'git' | 'github' | 'agentbuddy';
  value: string;
  github?: { owner: string; repo: string; path?: string; ref?: string };
  agentbuddy?: AgentbuddySource;
}

/** A skill (or collection) to fetch through the external `agentbuddy` CLI.
 *  `collection` is mutually exclusive with `group`/`skill`. No registry host or
 *  auth lives here — the daemon host's configured `agentbuddy` binary owns that,
 *  so the public source never carries an internal domain. */
export interface AgentbuddySource {
  /** agentbuddy protocol — `skill` (default) or `plugin`. */
  protocol?: 'skill' | 'plugin';
  collection?: string;
  group?: string;
  skill?: string;
  version?: string;
}

function parseMaybeUrl(raw: string): URL | null {
  try {
    return new URL(raw.replace(/^git\+/, ''));
  } catch {
    return null;
  }
}

export function redactGitUrlCredentials(raw: string): string {
  const url = parseMaybeUrl(raw);
  if (!url) return raw;
  if (!url.username && !url.password) return raw;
  url.username = url.username ? '***' : '';
  url.password = url.password ? '***' : '';
  const redacted = url.toString();
  return raw.startsWith('git+') ? `git+${redacted}` : redacted;
}

export function assertNoGitUrlCredentials(raw: string): void {
  const url = parseMaybeUrl(raw);
  if (!url) return;
  if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.username || url.password)) {
    throw new Error('git_url_credentials_not_allowed');
  }
}

/** Refuse git transports that execute commands. git's `ext::` (and other
 *  remote-helper) transports run an arbitrary shell command on clone, turning
 *  "install a skill" into RCE on the daemon host. Only the standard fetch
 *  transports are allowed; `file:`/bare local paths are permitted because they
 *  are equivalent to the already-supported local-directory install. `git` is
 *  also invoked with a matching `GIT_ALLOW_PROTOCOL` allowlist as
 *  defense-in-depth. scp-like `user@host:path` carries no URL scheme and is SSH. */
const ALLOWED_GIT_PROTOCOLS = new Set(['https:', 'http:', 'ssh:', 'git:', 'file:']);

function isScpLikeGitUrl(raw: string): boolean {
  return !raw.includes('://') && /^[A-Za-z0-9._-]+@[^/]+:/.test(raw);
}

export function assertAllowedGitProtocol(raw: string): void {
  if (isScpLikeGitUrl(raw)) return; // scp short form → SSH
  const url = parseMaybeUrl(raw);
  // No parseable scheme → git treats it as a local path (same trust as a local
  // directory install). A parseable scheme must be on the allowlist; `ext:` and
  // friends fall through to the throw.
  if (!url) return;
  if (!ALLOWED_GIT_PROTOCOLS.has(url.protocol)) {
    throw new Error('git_url_protocol_not_allowed');
  }
}

/** Refuse refs that could be mistaken for a `git checkout` option (leading `-`)
 *  or carry control characters. Real branch/tag/commit refs never start with a
 *  dash, so this is safe to reject outright. */
export function assertSafeGitRef(ref: string | undefined): void {
  if (ref === undefined) return;
  if (!ref || ref.startsWith('-') || /[\0\s]/.test(ref)) throw new Error('invalid_git_ref');
}

export function assertSafeGitSkillPath(path: string): void {
  if (!path || path.includes('\0')) throw new Error('invalid_git_skill_path');
  if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) throw new Error('invalid_git_skill_path');
  if (path.split(/[\\/]+/).filter(Boolean).includes('..')) throw new Error('invalid_git_skill_path');
}

function decodeUrlPart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new Error('invalid_github_skill_source');
  }
}

function hasRawPathTraversal(raw: string): boolean {
  return /(?:^|[\\/])(?:\.\.|%2e%2e)(?=$|[\\/#?])/i.test(raw);
}

function parseGitHubBrowserUrl(raw: string): ParsedSkillInstallSource | null {
  const url = parseMaybeUrl(raw);
  if (!url) return null;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null;
  if (hasRawPathTraversal(raw)) throw new Error('invalid_git_skill_path');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeUrlPart);
  if (parts.length < 2) throw new Error('invalid_github_skill_source');
  const [owner, repoWithSuffix] = parts;
  const repo = repoWithSuffix.endsWith('.git') ? repoWithSuffix.slice(0, -'.git'.length) : repoWithSuffix;
  if (!owner || !repo) throw new Error('invalid_github_skill_source');
  let ref: string | undefined;
  let path: string | undefined;
  if (parts[2] === 'tree' || parts[2] === 'blob') {
    const rest = parts.slice(3);
    if (rest.length === 0) throw new Error('invalid_github_skill_source');
    const skillsIndex = rest.indexOf('skills');
    if (skillsIndex > 0) {
      ref = rest.slice(0, skillsIndex).join('/');
      path = rest.slice(skillsIndex).join('/');
    } else {
      ref = rest[0];
      path = rest.slice(1).join('/') || undefined;
    }
    const pathParts = path?.split('/');
    if (parts[2] === 'blob' && pathParts?.[pathParts.length - 1]?.toLowerCase() === 'skill.md') {
      path = pathParts.slice(0, -1).join('/') || undefined;
    }
  }
  if (path) assertSafeGitSkillPath(path);
  return {
    kind: 'github',
    value: raw,
    github: { owner, repo, ...(path ? { path } : {}), ...(ref ? { ref } : {}) },
  };
}

// agentbuddy identifiers are passed as argv to the external CLI (via execFile,
// never a shell), but we still reject anything that could be mistaken for a
// flag (leading `-`), a path escape (`..`), or carry whitespace/control chars.
const AGENTBUDDY_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const AGENTBUDDY_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const AGENTBUDDY_GROUP_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function assertSafeAgentbuddyToken(token: string, kind: string, re: RegExp = AGENTBUDDY_TOKEN_RE): void {
  if (!token || token.includes('\0') || /\s/.test(token) || !re.test(token)) {
    throw new Error(`invalid_agentbuddy_${kind}`);
  }
}

function assertSafeAgentbuddyGroup(group: string): void {
  assertSafeAgentbuddyToken(group, 'group', AGENTBUDDY_GROUP_RE);
  if (group.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new Error('invalid_agentbuddy_group');
  }
}

/** Parse a pasted agentbuddy install command into an agentbuddy source.
 *  Accepts the exact copy-command the marketplace shows, e.g.:
 *    agentbuddy skill collection add <uid>
 *    agentbuddy plugin collection add <uid>
 *    agentbuddy skill add <group> --skill <name> [--version <v>]
 *  and tolerates a leading `KEY=VALUE … npx [-y] agentbuddy@latest …` prefix
 *  (the env + runner the site prepends). Only install subcommands (`add`,
 *  `collection add`) of `skill`/`plugin` are accepted — other agentbuddy
 *  subcommands (publish/remove/login/…) return null so a stray command can't
 *  drive the CLI. Returns null for anything that isn't such a command. */
export function parseAgentbuddyCommand(raw: string): AgentbuddySource | null {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const binIdx = tokens.findIndex((t) => t === 'agentbuddy' || t.startsWith('agentbuddy@'));
  if (binIdx < 0) return null;
  // Drop the user's own -y/--yes (install always adds its own); keep the rest
  // positional so the structured shape below reads cleanly.
  const rest = tokens.slice(binIdx + 1).filter((t) => t !== '-y' && t !== '--yes');
  const protocol = rest[0];
  if (protocol !== 'skill' && protocol !== 'plugin') return null;
  // <protocol> collection add <uid>
  if (rest[1] === 'collection' && rest[2] === 'add' && rest[3]) {
    assertSafeAgentbuddyToken(rest[3], 'collection');
    return { protocol, collection: rest[3] };
  }
  // <protocol> add <group> --skill <name> [--version <v>]
  if (rest[1] === 'add' && rest[2] && !rest[2].startsWith('-')) {
    const group = rest[2];
    const skillIdx = Math.max(rest.indexOf('--skill'), rest.indexOf('-s'));
    const skill = skillIdx >= 0 ? rest[skillIdx + 1] : undefined;
    if (!skill) return null;
    const verIdx = Math.max(rest.indexOf('--version'), rest.indexOf('-v'));
    const version = verIdx >= 0 ? rest[verIdx + 1] : undefined;
    assertSafeAgentbuddyGroup(group);
    assertSafeAgentbuddyToken(skill, 'skill');
    if (version) assertSafeAgentbuddyToken(version, 'version', AGENTBUDDY_VERSION_RE);
    return { protocol, group, skill, ...(version ? { version } : {}) };
  }
  return null;
}

/** Recognize the open-source `skills` CLI (vercel-labs/skills) add command and
 *  route its GitHub source into botmux's native GitHub/Git install — no extra
 *  dependency, and public repos need no auth. Accepts:
 *    skills add <owner/repo>              (also the `add-skill <owner/repo>` bin)
 *    npx [-y] skills[@latest] add <owner/repo>
 *  where <owner/repo> is a GitHub shorthand or a GitHub/Git URL. Returns null
 *  for anything that isn't such a command. */
export function parseSkillsInstallCommand(raw: string): ParsedSkillInstallSource | null {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const binIdx = tokens.findIndex((t) => t === 'skills' || t === 'add-skill' || t.startsWith('skills@'));
  if (binIdx < 0) return null;
  const bin = tokens[binIdx];
  const rest = tokens.slice(binIdx + 1).filter((t) => t !== '-y' && t !== '--yes');
  const source = rest[0] === 'add'
    ? rest[1]
    : (bin === 'add-skill' && rest[0] && !rest[0].startsWith('-') ? rest[0] : undefined);
  if (!source) return null;
  // Bare owner/repo[/path] → GitHub shorthand; explicit URLs pass through.
  const hasScheme = source.includes('://') || /^[A-Za-z0-9._-]+@[^/]+:/.test(source);
  const normalized = !hasScheme && /^[A-Za-z0-9][\w.-]*\/[\w./-]+$/.test(source) ? `github:${source}` : source;
  try {
    const parsed = parseSkillInstallSource(normalized);
    return parsed.kind === 'github' || parsed.kind === 'git' ? parsed : null;
  } catch {
    return null;
  }
}

export function parseSkillInstallSource(raw: string): ParsedSkillInstallSource {
  const command = parseAgentbuddyCommand(raw);
  if (command) {
    return { kind: 'agentbuddy', value: raw, agentbuddy: command };
  }
  const skillsCommand = parseSkillsInstallCommand(raw);
  if (skillsCommand) return skillsCommand;
  if (raw.startsWith('github:')) {
    const rest = raw.slice('github:'.length);
    const parts = rest.split('/').filter(Boolean);
    if (parts.length < 2) throw new Error('invalid_github_skill_source');
    const path = parts.slice(2).join('/') || undefined;
    if (path) assertSafeGitSkillPath(path);
    return {
      kind: 'github',
      value: raw,
      github: { owner: parts[0], repo: parts[1], path },
    };
  }
  assertNoGitUrlCredentials(raw);
  if (raw.startsWith('git+')) {
    const value = raw.replace(/^git\+/, '');
    assertAllowedGitProtocol(value);
    return { kind: 'git', value };
  }
  const githubSource = parseGitHubBrowserUrl(raw);
  if (githubSource) return githubSource;
  if (raw.endsWith('.git') || raw.startsWith('git@')) {
    const value = raw;
    assertAllowedGitProtocol(value);
    return { kind: 'git', value };
  }
  return { kind: 'local', value: raw };
}

export function githubToGitUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}
