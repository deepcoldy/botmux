import { describe, expect, it } from 'vitest';

import { assertSafeGitRef, assertSafeGitSkillPath, parseAgentbuddySource, parseSkillInstallSource, redactGitUrlCredentials } from '../src/core/skills/sources.js';

describe('skill install sources', () => {
  it('rejects HTTPS git URLs with embedded credentials', () => {
    expect(() => parseSkillInstallSource('git+https://token@example.com/acme/skills.git')).toThrow(/git_url_credentials_not_allowed/);
    expect(() => parseSkillInstallSource('https://user:secret@example.com/acme/skills.git')).toThrow(/git_url_credentials_not_allowed/);
    expect(() => parseSkillInstallSource('https://user:secret@example.com/acme/skills')).toThrow(/git_url_credentials_not_allowed/);
  });

  it('redacts URL credentials for display and errors', () => {
    expect(redactGitUrlCredentials('https://user:secret@example.com/acme/skills.git'))
      .toBe('https://***:***@example.com/acme/skills.git');
    expect(redactGitUrlCredentials('git+https://token@example.com/acme/skills.git'))
      .toBe('git+https://***@example.com/acme/skills.git');
  });

  it('allows SSH-style git sources', () => {
    expect(parseSkillInstallSource('git@github.com:acme/skills.git')).toMatchObject({
      kind: 'git',
      value: 'git@github.com:acme/skills.git',
    });
  });

  it('rejects command-executing git transports (ext:: RCE) regardless of git+ prefix', () => {
    // git's ext:: transport runs an arbitrary shell command on clone.
    expect(() => parseSkillInstallSource('git+ext::sh -c id')).toThrow(/git_url_protocol_not_allowed/);
    expect(() => parseSkillInstallSource('ext::sh -c id.git')).toThrow(/git_url_protocol_not_allowed/);
  });

  it('allows standard git transports incl. local file/path (parity with local install)', () => {
    expect(parseSkillInstallSource('https://example.com/acme/skills.git')).toMatchObject({ kind: 'git' });
    expect(parseSkillInstallSource('git+ssh://example.com/acme/skills.git')).toMatchObject({ kind: 'git' });
    expect(parseSkillInstallSource('git://example.com/acme/skills.git')).toMatchObject({ kind: 'git' });
    expect(parseSkillInstallSource('file:///srv/repos/skills.git')).toMatchObject({ kind: 'git' });
  });

  it('keeps local relative paths local', () => {
    expect(parseSkillInstallSource('../skills/deploy')).toMatchObject({
      kind: 'local',
      value: '../skills/deploy',
    });
  });

  it('rejects unsafe git skill paths', () => {
    expect(() => assertSafeGitSkillPath('../deploy')).toThrow(/invalid_git_skill_path/);
    expect(() => assertSafeGitSkillPath('skills/../deploy')).toThrow(/invalid_git_skill_path/);
    expect(() => assertSafeGitSkillPath('/tmp/deploy')).toThrow(/invalid_git_skill_path/);
    expect(() => assertSafeGitSkillPath('C:\\skills\\deploy')).toThrow(/invalid_git_skill_path/);
    expect(() => assertSafeGitSkillPath('skills/deploy\0x')).toThrow(/invalid_git_skill_path/);
    expect(() => assertSafeGitSkillPath('skills/deploy')).not.toThrow();
    expect(() => assertSafeGitSkillPath('.')).not.toThrow();
  });

  it('rejects unsafe paths in GitHub shorthand sources', () => {
    expect(() => parseSkillInstallSource('github:acme/skills/../deploy')).toThrow(/invalid_git_skill_path/);
    expect(parseSkillInstallSource('github:acme/skills/skills/deploy')).toMatchObject({
      kind: 'github',
      github: { owner: 'acme', repo: 'skills', path: 'skills/deploy' },
    });
  });

  it('parses copy-pasted GitHub browser URLs', () => {
    expect(parseSkillInstallSource('https://github.com/acme/skills/tree/main/skills/deploy')).toMatchObject({
      kind: 'github',
      github: { owner: 'acme', repo: 'skills', ref: 'main', path: 'skills/deploy' },
    });
    expect(parseSkillInstallSource('https://github.com/acme/skills/tree/feature/foo/skills/deploy')).toMatchObject({
      kind: 'github',
      github: { owner: 'acme', repo: 'skills', ref: 'feature/foo', path: 'skills/deploy' },
    });
    expect(parseSkillInstallSource('https://github.com/acme/skills')).toMatchObject({
      kind: 'github',
      github: { owner: 'acme', repo: 'skills' },
    });
    expect(parseSkillInstallSource('https://github.com/acme/skills/blob/main/skills/deploy/SKILL.md')).toMatchObject({
      kind: 'github',
      github: { owner: 'acme', repo: 'skills', ref: 'main', path: 'skills/deploy' },
    });
  });

  it('rejects unsafe paths in GitHub browser URLs', () => {
    expect(() => parseSkillInstallSource('https://github.com/acme/skills/tree/main/skills/../deploy')).toThrow(/invalid_git_skill_path/);
  });

  it('parses agentbuddy single-skill sources with optional version', () => {
    expect(parseSkillInstallSource('agentbuddy:example.com/team/marketplace/my-skill')).toMatchObject({
      kind: 'agentbuddy',
      agentbuddy: { group: 'example.com/team/marketplace', skill: 'my-skill' },
    });
    expect(parseAgentbuddySource('agentbuddy:example.com/team/marketplace/my-skill@1.0.363')).toEqual({
      group: 'example.com/team/marketplace',
      skill: 'my-skill',
      version: '1.0.363',
    });
  });

  it('tolerates the marketplace skills: identifier prefix', () => {
    expect(parseAgentbuddySource('agentbuddy:skills:acme/team/mkt/deploy')).toEqual({
      group: 'acme/team/mkt',
      skill: 'deploy',
    });
  });

  it('parses agentbuddy collection sources', () => {
    expect(parseSkillInstallSource('agentbuddy:collection/col123abc')).toMatchObject({
      kind: 'agentbuddy',
      agentbuddy: { collection: 'col123abc' },
    });
  });

  it('rejects agentbuddy identifiers that could be argv/flag/path injections', () => {
    expect(() => parseAgentbuddySource('agentbuddy:')).toThrow(/invalid_agentbuddy_source/);
    expect(() => parseAgentbuddySource('agentbuddy:noskill')).toThrow(/invalid_agentbuddy_source/);
    expect(() => parseAgentbuddySource('agentbuddy:-flag/skill')).toThrow(/invalid_agentbuddy_group/);
    expect(() => parseAgentbuddySource('agentbuddy:group/--skill')).toThrow(/invalid_agentbuddy_skill/);
    expect(() => parseAgentbuddySource('agentbuddy:group/../escape/skill')).toThrow(/invalid_agentbuddy_group/);
    expect(() => parseAgentbuddySource('agentbuddy:group/skill;rm -rf')).toThrow(/invalid_agentbuddy_skill/);
    expect(() => parseAgentbuddySource('agentbuddy:collection/../etc')).toThrow(/invalid_agentbuddy_collection/);
  });

  it('rejects git refs that could be parsed as checkout options', () => {
    expect(() => assertSafeGitRef('--upload-pack=touch /tmp/pwn')).toThrow(/invalid_git_ref/);
    expect(() => assertSafeGitRef('-x')).toThrow(/invalid_git_ref/);
    expect(() => assertSafeGitRef('main branch')).toThrow(/invalid_git_ref/);
    expect(() => assertSafeGitRef('main')).not.toThrow();
    expect(() => assertSafeGitRef('release/v1.2.3')).not.toThrow();
    expect(() => assertSafeGitRef(undefined)).not.toThrow();
  });
});
