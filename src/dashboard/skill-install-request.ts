import {
  discoverGitSkillCandidatesAsync,
  discoverLocalSkillCandidates,
  installAgentbuddySkillAsync,
  installGitSkillAsync,
  installLocalSkillsFromSource,
  installGitSkillsFromSourceAsync,
} from '../services/skill-registry-store.js';
import {
  assertSafeGitSkillPath,
  githubToGitUrl,
  parseSkillInstallSource,
} from '../core/skills/sources.js';
import type { AgentbuddySource } from '../core/skills/sources.js';
import type { SkillPackage, SkillSource } from '../core/skills/types.js';
import type { SkillSourceDiscovery } from '../services/skill-registry-store.js';

const AUTO_LINK_SKILL_ROOT_MARKERS = new Set([
  '.agents',
  '.botmux',
  '.claude',
  '.codex',
  '.cursor',
  '.gemini',
  '.opencode',
]);

export type DashboardSkillInstallRequest =
  | { kind: 'local'; value: string; link: boolean; skillNames: string[]; all: boolean; fullDepth: boolean }
  | { kind: 'git'; url: string; path?: string; ref?: string; skillNames: string[]; all: boolean; fullDepth: boolean }
  | { kind: 'github'; owner: string; repo: string; path?: string; ref?: string; skillNames: string[]; all: boolean; fullDepth: boolean }
  | { kind: 'agentbuddy'; agentbuddy: AgentbuddySource };

export function shouldAutoLinkLocalSkillPath(rawPath: string): boolean {
  const normalized = rawPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.some((part, index) => (
    AUTO_LINK_SKILL_ROOT_MARKERS.has(part)
    && parts.slice(index + 1).includes('skills')
  ));
}

/** Upper bound on a single batch local-link registration. Bounds the inline,
 *  synchronous loadSkillPackage loop (realpath + read per dir) that runs on the
 *  daemon event loop, so a runaway/garbage `sources` array can't stall message
 *  handling. Comfortably above any realistic native-skill count. */
export const MAX_LOCAL_LINK_SOURCES = 512;

/** Parse + sanitize the `sources` of POST /api/skills/install-local-links:
 *  keep only non-empty trimmed strings, dedup, preserving order. Pure so the
 *  endpoint's validation has a regression guard (the route just maps the result
 *  to sources_required / too_many_sources / install). */
export function parseInstallLocalLinksSources(body: unknown): string[] {
  const obj = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const raw = Array.isArray(obj.sources) ? obj.sources : [];
  const trimmed = raw
    .filter((source): source is string => typeof source === 'string' && source.trim().length > 0)
    .map((source) => source.trim());
  return [...new Set(trimmed)];
}

function parseSkillNames(body: Record<string, unknown>): string[] {
  const raw = Array.isArray(body.skillNames)
    ? body.skillNames
    : typeof body.skill === 'string'
      ? [body.skill]
      : [];
  return [...new Set(raw
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    .map(name => name.trim()))];
}

export function parseDashboardSkillInstallRequest(body: Record<string, unknown>): DashboardSkillInstallRequest {
  const source = typeof body.source === 'string' ? body.source.trim() : '';
  if (!source) throw new Error('source_required');
  const parsedSource = parseSkillInstallSource(source);
  if (parsedSource.kind === 'agentbuddy') {
    return { kind: 'agentbuddy', agentbuddy: parsedSource.agentbuddy! };
  }
  const skillNames = parseSkillNames(body);
  const all = body.all === true || skillNames.includes('*');
  const fullDepth = body.fullDepth === true;
  if (parsedSource.kind === 'local') {
    return {
      kind: 'local',
      value: parsedSource.value,
      link: body.link === true || shouldAutoLinkLocalSkillPath(parsedSource.value),
      skillNames,
      all,
      fullDepth,
    };
  }
  const parsedRef = parsedSource.github?.ref;
  const ref = typeof body.ref === 'string' && body.ref.trim() ? body.ref.trim() : parsedRef;
  if (parsedSource.kind === 'git') {
    const path = typeof body.path === 'string' && body.path.trim() ? body.path.trim() : undefined;
    if (path) assertSafeGitSkillPath(path);
    return { kind: 'git', url: parsedSource.value, ...(path ? { path } : {}), ref, skillNames, all, fullDepth };
  }
  const gh = parsedSource.github;
  const path = typeof body.path === 'string' && body.path.trim() ? body.path.trim() : gh?.path;
  if (!gh) throw new Error('invalid_github_source');
  if (path) assertSafeGitSkillPath(path);
  return { kind: 'github', owner: gh.owner, repo: gh.repo, ...(path ? { path } : {}), ref, skillNames, all, fullDepth };
}

export async function discoverDashboardSkills(request: DashboardSkillInstallRequest): Promise<SkillSourceDiscovery> {
  // agentbuddy resolves its own skill set — tell the UI to install directly
  // (works for pasted `agentbuddy:` identifiers AND marketplace URLs, which the
  // client can't recognize on its own since the parser is server-only).
  if (request.kind === 'agentbuddy') return { skills: [], directInstall: true };
  if (request.kind === 'local') return discoverLocalSkillCandidates(request.value, { fullDepth: request.fullDepth });
  if (request.kind === 'git') {
    return discoverGitSkillCandidatesAsync({
      url: request.url,
      ref: request.ref,
      path: request.path,
      fullDepth: request.fullDepth,
    });
  }
  return discoverGitSkillCandidatesAsync({
    url: githubToGitUrl(request.owner, request.repo),
    ref: request.ref,
    path: request.path,
    fullDepth: request.fullDepth,
  });
}

export async function installDashboardSkill(request: DashboardSkillInstallRequest): Promise<SkillPackage[]> {
  if (request.kind === 'agentbuddy') return installAgentbuddySkillAsync(request.agentbuddy);
  if (request.kind === 'local') return installLocalSkillsFromSource(request.value, {
    link: request.link,
    skillNames: request.skillNames,
    all: request.all,
    fullDepth: request.fullDepth,
  });
  if (request.kind === 'git') {
    if (request.path) return [await installGitSkillAsync({ url: request.url, path: request.path, ref: request.ref })];
    return installGitSkillsFromSourceAsync({
      url: request.url,
      ref: request.ref,
      skillNames: request.skillNames,
      all: request.all,
      fullDepth: request.fullDepth,
    });
  }
  const sourceOverride: SkillSource = {
    type: 'github',
    owner: request.owner,
    repo: request.repo,
    path: request.path ?? '.',
    ...(request.ref ? { ref: request.ref } : {}),
  };
  if (request.path) {
    return [await installGitSkillAsync({
      url: githubToGitUrl(request.owner, request.repo),
      path: request.path,
      ref: request.ref,
      sourceOverride,
    })];
  }
  return installGitSkillsFromSourceAsync({
    url: githubToGitUrl(request.owner, request.repo),
    ref: request.ref,
    sourceOverride,
    skillNames: request.skillNames,
    all: request.all,
    fullDepth: request.fullDepth,
  });
}
