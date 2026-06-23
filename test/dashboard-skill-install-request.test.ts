import { describe, expect, it } from 'vitest';

import { MAX_LOCAL_LINK_SOURCES, parseDashboardSkillInstallRequest, parseInstallLocalLinksSources, shouldAutoLinkLocalSkillPath } from '../src/dashboard/skill-install-request.js';

describe('dashboard skill install request parsing', () => {
  it('rejects lightweight install errors before starting a job', () => {
    expect(() => parseDashboardSkillInstallRequest({ source: '' })).toThrow(/source_required/);
    expect(() => parseDashboardSkillInstallRequest({ source: 'git+https://github.com/acme/skills.git' })).toThrow(/path_required/);
    expect(() => parseDashboardSkillInstallRequest({
      source: 'git+https://token@example.com/acme/skills.git',
      path: 'skills/deploy',
    })).toThrow(/git_url_credentials_not_allowed/);
    expect(() => parseDashboardSkillInstallRequest({
      source: 'git+https://github.com/acme/skills.git',
      path: '../deploy',
    })).toThrow(/invalid_git_skill_path/);
  });

  it('parses GitHub shorthand paths and explicit overrides', () => {
    expect(parseDashboardSkillInstallRequest({ source: 'github:acme/skills/skills/deploy' })).toMatchObject({
      kind: 'github',
      owner: 'acme',
      repo: 'skills',
      path: 'skills/deploy',
    });
    expect(parseDashboardSkillInstallRequest({
      source: 'github:acme/skills/skills/deploy',
      path: 'skills/runbook',
      ref: 'main',
    })).toMatchObject({
      kind: 'github',
      path: 'skills/runbook',
      ref: 'main',
    });
  });

  it('parses GitHub browser URLs and uses their ref/path by default', () => {
    expect(parseDashboardSkillInstallRequest({
      source: 'https://github.com/acme/skills/tree/main/skills/deploy',
    })).toMatchObject({
      kind: 'github',
      owner: 'acme',
      repo: 'skills',
      path: 'skills/deploy',
      ref: 'main',
    });
    expect(parseDashboardSkillInstallRequest({
      source: 'https://github.com/acme/skills/tree/main',
      path: 'skills/runbook',
    })).toMatchObject({
      kind: 'github',
      path: 'skills/runbook',
      ref: 'main',
    });
  });

  it('sanitizes batch local-link sources: trims, drops blanks/non-strings, dedups', () => {
    expect(parseInstallLocalLinksSources({ sources: ['  /a/skills/x  ', '', '/a/skills/x', 42, null, '/b/skills/y'] }))
      .toEqual(['/a/skills/x', '/b/skills/y']);
    // Non-object / non-array / missing sources → empty (route maps to sources_required).
    expect(parseInstallLocalLinksSources({ sources: 'not-an-array' })).toEqual([]);
    expect(parseInstallLocalLinksSources({})).toEqual([]);
    expect(parseInstallLocalLinksSources(null)).toEqual([]);
    expect(parseInstallLocalLinksSources('garbage')).toEqual([]);
    expect(parseInstallLocalLinksSources({ sources: ['   ', ''] })).toEqual([]);
    expect(MAX_LOCAL_LINK_SOURCES).toBeGreaterThan(0);
  });

  it('auto-links native local skill library paths without a dashboard toggle', () => {
    expect(shouldAutoLinkLocalSkillPath('/Users/me/.codex/skills/deploy')).toBe(true);
    expect(shouldAutoLinkLocalSkillPath('/Users/me/.claude/skills/deploy')).toBe(true);
    expect(shouldAutoLinkLocalSkillPath('/repo/.agents/skills/deploy')).toBe(true);
    expect(shouldAutoLinkLocalSkillPath('/repo/custom-skills/deploy')).toBe(false);
    expect(parseDashboardSkillInstallRequest({ source: '/Users/me/.codex/skills/deploy' })).toMatchObject({
      kind: 'local',
      link: true,
    });
    expect(parseDashboardSkillInstallRequest({ source: '/repo/custom-skills/deploy' })).toMatchObject({
      kind: 'local',
      link: false,
    });
  });
});
