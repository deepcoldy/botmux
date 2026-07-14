import { describe, expect, it } from 'vitest';

import { assertSafeGitRef, assertSafeGitSkillPath, parseAgentbuddyCommand, parseSkillInstallSource, parseSkillsInstallCommand, redactGitUrlCredentials } from '../src/core/skills/sources.js';

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

  describe('agentbuddy install commands', () => {
    it('parses pasted skill/plugin collection add commands', () => {
      expect(parseSkillInstallSource('agentbuddy skill collection add iYrkTRRY')).toMatchObject({
        kind: 'agentbuddy',
        agentbuddy: { protocol: 'skill', collection: 'iYrkTRRY' },
      });
      expect(parseAgentbuddyCommand('agentbuddy plugin collection add iYrkTRRY')).toEqual({
        protocol: 'plugin',
        collection: 'iYrkTRRY',
      });
    });

    it('strips a leading env / npx / agentbuddy@latest prefix', () => {
      expect(parseAgentbuddyCommand('npm_config_registry="https://reg.example" npx -y agentbuddy@latest skill collection add abc123')).toEqual({
        protocol: 'skill',
        collection: 'abc123',
      });
    });

    it('parses a single skill add command with --skill / --version', () => {
      expect(parseAgentbuddyCommand('agentbuddy skill add acme/team/mkt --skill deploy --version 1.2.3')).toEqual({
        protocol: 'skill',
        group: 'acme/team/mkt',
        skill: 'deploy',
        version: '1.2.3',
      });
    });

    it('rejects non-install and malformed commands', () => {
      expect(parseAgentbuddyCommand('agentbuddy skill publish ./x')).toBeNull();
      expect(parseAgentbuddyCommand('agentbuddy login')).toBeNull();
      expect(parseAgentbuddyCommand('agentbuddy mcp collection add x')).toBeNull(); // unsupported protocol
      expect(parseAgentbuddyCommand('agentbuddy skill add acme --skill')).toBeNull(); // missing skill name
      expect(parseAgentbuddyCommand('just some text')).toBeNull();
      expect(() => parseAgentbuddyCommand('agentbuddy skill collection add ../etc')).toThrow(/invalid_agentbuddy_collection/);
    });
  });

  describe('open-source skills CLI commands', () => {
    it('routes `skills add owner/repo` to the GitHub install', () => {
      expect(parseSkillInstallSource('skills add vercel-labs/agent-browser')).toMatchObject({
        kind: 'github',
        github: { owner: 'vercel-labs', repo: 'agent-browser' },
      });
      expect(parseSkillsInstallCommand('npx -y skills@latest add vercel-labs/agent-skills')).toMatchObject({
        kind: 'github',
        github: { owner: 'vercel-labs', repo: 'agent-skills' },
      });
      expect(parseSkillsInstallCommand('add-skill vercel-labs/agent-skills')).toMatchObject({
        kind: 'github',
        github: { owner: 'vercel-labs', repo: 'agent-skills' },
      });
    });

    it('passes GitHub / git URLs through', () => {
      expect(parseSkillsInstallCommand('skills add https://github.com/acme/skills')).toMatchObject({
        kind: 'github', github: { owner: 'acme', repo: 'skills' },
      });
      expect(parseSkillsInstallCommand('skills add git@github.com:acme/skills.git')).toMatchObject({ kind: 'git' });
    });

    it('ignores non-add / non-command inputs', () => {
      expect(parseSkillsInstallCommand('skills list')).toBeNull();
      expect(parseSkillsInstallCommand('skills add')).toBeNull();
      expect(parseSkillsInstallCommand('just some text')).toBeNull();
    });
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
