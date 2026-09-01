import { describe, expect, it } from 'bun:test';

import {
  enrichPackForDashboard,
  enrichPacksForDashboard,
  sanitizeSkillForDashboard,
} from '../src/dashboard/skill-pack-response.js';
import type { SkillPack, SkillPackage } from '../src/core/skills/types.js';

const pack: SkillPack = {
  id: 'review-pack',
  name: 'Review Pack',
  include: ['skill:private', 'skill:missing'],
  revision: 1,
  createdAt: '2026-08-07T00:00:00.000Z',
  updatedAt: '2026-08-07T00:00:00.000Z',
};

const privateSkill: SkillPackage = {
  id: 'private',
  name: 'private',
  tags: [],
  rootDir: '/tmp/private',
  entrypoint: 'SKILL.md',
  source: {
    type: 'git',
    url: 'ssh://user:s3cr3t@host/repo.git',
    path: 'skills/private',
  },
};

describe('Dashboard Skill Pack responses', () => {
  it('uses the same credential redaction boundary as the skills API', () => {
    const sanitized = sanitizeSkillForDashboard(privateSkill);
    expect(sanitized.source).toMatchObject({
      type: 'git',
      url: 'ssh://***:***@host/repo.git',
    });
    expect(privateSkill.source).toMatchObject({ url: 'ssh://user:s3cr3t@host/repo.git' });
  });

  it('returns a detached response object for non-git skills too', () => {
    const localSkill: SkillPackage = {
      ...privateSkill,
      id: 'local',
      name: 'local',
      source: { type: 'local-link', path: '/tmp/local' },
    };
    const sanitized = sanitizeSkillForDashboard(localSkill);
    expect(sanitized).not.toBe(localSkill);
    expect(sanitized.source).not.toBe(localSkill.source);
    expect(sanitized).toEqual(localSkill);
  });

  it('redacts resolvedSkills in the pack get response', () => {
    const response = enrichPackForDashboard(pack, { private: privateSkill }, [
      { larkAppId: 'cli_bot', botName: 'Reviewer' },
    ]);

    expect(response.resolvedSkills[0]?.source).toMatchObject({
      type: 'git',
      url: 'ssh://***:***@host/repo.git',
    });
    expect(response.missingSkills).toEqual(['missing']);
    expect(response.references).toEqual([{ larkAppId: 'cli_bot', botName: 'Reviewer' }]);
  });

  it('redacts resolvedSkills in every pack list response', () => {
    const [response] = enrichPacksForDashboard(
      [pack],
      { private: privateSkill },
      () => [{ larkAppId: 'cli_bot', botName: 'Reviewer' }],
    );

    expect(response.resolvedSkills[0]?.source).toMatchObject({
      type: 'git',
      url: 'ssh://***:***@host/repo.git',
    });
  });

  it('treats inherited object properties as missing skills', () => {
    const prototypePack: SkillPack = {
      ...pack,
      include: ['skill:constructor'],
    };

    const response = enrichPackForDashboard(prototypePack, {});

    expect(response.resolvedSkills).toEqual([]);
    expect(response.missingSkills).toEqual(['constructor']);
  });
});
