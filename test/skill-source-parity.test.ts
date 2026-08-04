import { describe, expect, it } from 'vitest';
import { detectSourceType } from '../src/dashboard/web/skills/skill-library-tab.js';
import { parseSkillInstallSource } from '../src/core/skills/sources.js';
import { discoverDashboardSkills, parseDashboardSkillInstallRequest } from '../src/dashboard/skill-install-request.js';

/** The wizard's detectSourceType() is only a visual hint; parseSkillInstallSource()
 *  on the daemon is authoritative. They must never disagree about a supported
 *  form, otherwise the wizard promises a source type the backend rejects. */
describe('skill source: frontend hint vs backend classification', () => {
  const supported: Array<[string, string]> = [
    ['anthropics/skills', 'github'],
    ['anthropics/skills/document-skills', 'github'],
    ['github:anthropics/skills', 'github'],
    ['https://github.com/acme/skills', 'github'],
    ['https://git.internal.corp/team/skills.git', 'git'],
    ['https://git.internal.corp/team/skills', 'git'],
    ['git@github.com:acme/skills.git', 'git'],
    ['agentbuddy:collection/abc123', 'agentbuddy'],
    ['agentbuddy:acme/deploy', 'agentbuddy'],
    ['agentbuddy skill collection add abc', 'agentbuddy'],
    ['npx -y agentbuddy@latest skill add acme --skill deploy', 'agentbuddy'],
    ['npm_config_registry="https://registry.example.com" npx -y agentbuddy@latest skill add skills.example.com/doubao/health', 'agentbuddy'],
    ['/srv/agentbuddy/skills/foo', 'local'],
    ['./agentbuddy-skills', 'local'],
    ['~/skills/foo', 'local'],
    ['relative-skill-dir', 'local'],
  ];

  for (const [input, expected] of supported) {
    it(`agrees on ${input}`, () => {
      expect(detectSourceType(input)).toBe(expected);
      expect(parseSkillInstallSource(input).kind).toBe(expected);
    });
  }

  it('neither side treats a URL containing "agentbuddy" as an agentbuddy source', () => {
    expect(detectSourceType('https://market.example.com/agentbuddy/xxx')).toBe('git');
    expect(parseSkillInstallSource('https://market.example.com/agentbuddy/xxx').kind).toBe('git');
  });
});

describe('agentbuddy direct-install routing', () => {
  it('canonical identifiers route to direct install (no discovery listing)', async () => {
    for (const source of ['agentbuddy:collection/abc123', 'agentbuddy:acme/deploy', 'agentbuddy skill collection add abc']) {
      const request = parseDashboardSkillInstallRequest({ source });
      expect(request.kind).toBe('agentbuddy');
      await expect(discoverDashboardSkills(request)).resolves.toEqual({ skills: [], directInstall: true });
    }
  });

  it('github shorthand does NOT take the direct-install path', async () => {
    const request = parseDashboardSkillInstallRequest({ source: 'anthropics/skills' });
    expect(request.kind).toBe('github');
    expect(request).toMatchObject({ owner: 'anthropics', repo: 'skills' });
  });

  it('malformed agentbuddy identifiers are rejected at the request layer', () => {
    expect(() => parseDashboardSkillInstallRequest({ source: 'agentbuddy:acme' })).toThrow(/invalid_agentbuddy/);
    expect(() => parseDashboardSkillInstallRequest({ source: 'agentbuddy:collection/a/b' })).toThrow(/invalid_agentbuddy/);
  });
});
