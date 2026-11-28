import { describe, expect, it } from 'vitest';

import { MAX_LOCAL_LINK_SOURCES, discoverDashboardSkills, parseDashboardSkillInstallRequest, parseInstallLocalLinksMode, parseInstallLocalLinksSources, shouldAutoLinkLocalSkillPath } from '../src/dashboard/skill-install-request.js';

describe('dashboard skill install request parsing', () => {
  it('rejects lightweight install errors before starting a job', () => {
    expect(() => parseDashboardSkillInstallRequest({ source: '' })).toThrow(/source_required/);
    expect(() => parseDashboardSkillInstallRequest({
      source: 'git+https://token@example.com/acme/skills.git',
      path: 'skills/deploy',
    })).toThrow(/git_url_credentials_not_allowed/);
    expect(() => parseDashboardSkillInstallRequest({
      source: 'git+https://github.com/acme/skills.git',
      path: '../deploy',
    })).toThrow(/invalid_git_skill_path/);
  });

  it('accepts repository roots for discovery-backed remote installs', () => {
    expect(parseDashboardSkillInstallRequest({ source: 'git+https://github.com/acme/skills.git' })).toMatchObject({
      kind: 'git',
      url: 'https://github.com/acme/skills.git',
    });
    expect(parseDashboardSkillInstallRequest({ source: 'https://github.com/acme/skills' })).toMatchObject({
      kind: 'github',
      owner: 'acme',
      repo: 'skills',
    });
    expect(parseDashboardSkillInstallRequest({
      source: 'https://github.com/acme/skills',
      skillNames: ['deploy', 'review'],
    })).toMatchObject({
      kind: 'github',
      skillNames: ['deploy', 'review'],
    });
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

  it('routes agentbuddy command sources to the direct-install (no discover) path', () => {
    expect(parseDashboardSkillInstallRequest({ source: 'agentbuddy skill add example.com/team/mkt --skill deploy --version 1.2.3' })).toEqual({
      kind: 'agentbuddy',
      agentbuddy: { protocol: 'skill', group: 'example.com/team/mkt', skill: 'deploy', version: '1.2.3' },
    });
    expect(parseDashboardSkillInstallRequest({ source: 'agentbuddy plugin collection add col123abc' })).toEqual({
      kind: 'agentbuddy',
      agentbuddy: { protocol: 'plugin', collection: 'col123abc' },
    });
  });

  it('routes a pasted agentbuddy command to direct-install', async () => {
    const request = parseDashboardSkillInstallRequest({ source: 'agentbuddy skill collection add abc123' });
    expect(request).toEqual({ kind: 'agentbuddy', agentbuddy: { protocol: 'skill', collection: 'abc123' } });
    // discover signals the UI to install directly (skip discover-then-select)
    expect(await discoverDashboardSkills(request)).toEqual({ skills: [], directInstall: true });
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

  it('auto-links native local skill library paths without a dashboard toggle, except versioned plugin caches', () => {
    expect(shouldAutoLinkLocalSkillPath('/Users/me/.codex/skills/deploy')).toBe(true);
    expect(shouldAutoLinkLocalSkillPath('/Users/me/.claude/skills/deploy')).toBe(true);
    expect(shouldAutoLinkLocalSkillPath('/repo/.agents/skills/deploy')).toBe(true);
    expect(shouldAutoLinkLocalSkillPath('/repo/custom-skills/deploy')).toBe(false);
    // Versioned plugin caches (e.g. ~/.claude/plugins/cache/.../7.0.0/skills/...)
    // must default to copy mode so plugin upgrades do not break the link.
    expect(shouldAutoLinkLocalSkillPath('/Users/me/.claude/plugins/cache/claude-plugins-official/superpowers/7.0.0/skills/writing-skills')).toBe(false);
    expect(parseDashboardSkillInstallRequest({ source: '/Users/me/.codex/skills/deploy' })).toMatchObject({
      kind: 'local',
      link: true,
    });
    expect(parseDashboardSkillInstallRequest({ source: '/Users/me/.codex/skills/deploy', link: false })).toMatchObject({
      kind: 'local',
      link: false,
    });
    expect(parseDashboardSkillInstallRequest({
      source: '/Users/me/.claude/plugins/cache/claude-plugins-official/superpowers/7.0.0/skills/writing-skills',
    })).toMatchObject({
      kind: 'local',
      link: false,
    });
    expect(parseDashboardSkillInstallRequest({ source: '/repo/custom-skills/deploy' })).toMatchObject({
      kind: 'local',
      link: false,
    });
  });

  it('parses optional batch install mode with backward-compatible link default', () => {
    expect(parseInstallLocalLinksMode({ sources: ['/a'] })).toBe('link');
    expect(parseInstallLocalLinksMode({ sources: ['/a'], mode: 'link' })).toBe('link');
    expect(parseInstallLocalLinksMode({ sources: ['/a'], mode: 'copy' })).toBe('copy');
    expect(parseInstallLocalLinksMode({ sources: ['/a'], copy: true })).toBe('copy');
    expect(parseInstallLocalLinksMode(null)).toBe('link');
  });
});
