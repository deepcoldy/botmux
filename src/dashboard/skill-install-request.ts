import {
  installGitSkillAsync,
  installLocalSkill,
} from '../services/skill-registry-store.js';
import {
  assertSafeGitSkillPath,
  githubToGitUrl,
  parseSkillInstallSource,
} from '../core/skills/sources.js';
import type { SkillPackage, SkillSource } from '../core/skills/types.js';

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
  | { kind: 'local'; value: string; link: boolean }
  | { kind: 'git'; url: string; path: string; ref?: string }
  | { kind: 'github'; owner: string; repo: string; path: string; ref?: string };

export function shouldAutoLinkLocalSkillPath(rawPath: string): boolean {
  const normalized = rawPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.some((part, index) => (
    AUTO_LINK_SKILL_ROOT_MARKERS.has(part)
    && parts.slice(index + 1).includes('skills')
  ));
}

export function parseDashboardSkillInstallRequest(body: Record<string, unknown>): DashboardSkillInstallRequest {
  const source = typeof body.source === 'string' ? body.source.trim() : '';
  if (!source) throw new Error('source_required');
  const parsedSource = parseSkillInstallSource(source);
  if (parsedSource.kind === 'local') {
    return { kind: 'local', value: parsedSource.value, link: body.link === true || shouldAutoLinkLocalSkillPath(parsedSource.value) };
  }
  const parsedRef = parsedSource.github?.ref;
  const ref = typeof body.ref === 'string' && body.ref.trim() ? body.ref.trim() : parsedRef;
  if (parsedSource.kind === 'git') {
    const path = typeof body.path === 'string' && body.path.trim() ? body.path.trim() : undefined;
    if (!path) throw new Error('path_required');
    assertSafeGitSkillPath(path);
    return { kind: 'git', url: parsedSource.value, path, ref };
  }
  const gh = parsedSource.github;
  const path = typeof body.path === 'string' && body.path.trim() ? body.path.trim() : gh?.path;
  if (!gh || !path) throw new Error('path_required');
  assertSafeGitSkillPath(path);
  return { kind: 'github', owner: gh.owner, repo: gh.repo, path, ref };
}

export async function installDashboardSkill(request: DashboardSkillInstallRequest): Promise<SkillPackage> {
  if (request.kind === 'local') return installLocalSkill(request.value, { link: request.link });
  if (request.kind === 'git') {
    return installGitSkillAsync({ url: request.url, path: request.path, ref: request.ref });
  }
  const sourceOverride: SkillSource = {
    type: 'github',
    owner: request.owner,
    repo: request.repo,
    path: request.path,
    ...(request.ref ? { ref: request.ref } : {}),
  };
  return installGitSkillAsync({
    url: githubToGitUrl(request.owner, request.repo),
    path: request.path,
    ref: request.ref,
    sourceOverride,
  });
}
