import { describe, expect, it } from 'vitest';

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafeGitRef, assertSafeGitSkillPath, formatAgentbuddyIdentifier, parseAgentbuddyCommand, parseAgentbuddyIdentifier, parseSkillInstallSource, parseSkillsInstallCommand, redactGitUrlCredentials } from '../src/core/skills/sources.js';

describe('skill install sources', () => {
  it('rejects HTTPS git URLs with embedded credentials', () => {
    expect(() => parseSkillInstallSource('git+https://token@example.com/acme/skills.git')).toThrow(/git_url_credentials_not_allowed/);
    expect(() => parseSkillInstallSource('https://user:secret@example.com/acme/skills.git')).toThrow(/git_url_credentials_not_allowed/);
    expect(() => parseSkillInstallSource('https://user:secret@example.com/acme/skills')).toThrow(/git_url_credentials_not_allowed/);
  });

  it('rejects embedded passwords in SSH and git protocol URLs while allowing SSH usernames', () => {
    expect(() => parseSkillInstallSource('git+ssh://user:secret@example.com/acme/skills.git'))
      .toThrow(/git_url_credentials_not_allowed/);
    expect(() => parseSkillInstallSource('git://user:secret@example.com/acme/skills.git'))
      .toThrow(/git_url_credentials_not_allowed/);
    expect(parseSkillInstallSource('git+ssh://git@example.com/acme/skills.git')).toMatchObject({ kind: 'git' });
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

    it('parses the marketplace copy-command with a combined group/skill path', () => {
      const raw = 'npm_config_registry="https://registry.example.com" npx -y agentbuddy@latest skill add skills.example.com/doubao/health';
      expect(parseAgentbuddyCommand(raw)).toEqual({
        protocol: 'skill',
        group: 'skills.example.com/doubao',
        skill: 'health',
      });
      expect(parseSkillInstallSource(raw)).toMatchObject({
        kind: 'agentbuddy',
        agentbuddy: {
          protocol: 'skill',
          group: 'skills.example.com/doubao',
          skill: 'health',
        },
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

  describe('canonical agentbuddy identifiers', () => {
    it('parses agentbuddy:collection/<uid>', () => {
      expect(parseSkillInstallSource('agentbuddy:collection/iYrkTRRY')).toMatchObject({
        kind: 'agentbuddy',
        agentbuddy: { protocol: 'skill', collection: 'iYrkTRRY' },
      });
    });

    it('accepts an explicit protocol in front of collection (agentbuddyIdentifier round-trip)', () => {
      expect(parseAgentbuddyIdentifier('agentbuddy:plugin/collection/abc123')).toEqual({
        protocol: 'plugin',
        collection: 'abc123',
      });
      expect(parseAgentbuddyIdentifier('agentbuddy:skill/collection/abc123')).toEqual({
        protocol: 'skill',
        collection: 'abc123',
      });
    });

    it('parses agentbuddy:<group>/<skill>, last segment is the skill', () => {
      expect(parseSkillInstallSource('agentbuddy:acme/deploy')).toMatchObject({
        kind: 'agentbuddy',
        agentbuddy: { protocol: 'skill', group: 'acme', skill: 'deploy' },
      });
      expect(parseAgentbuddyIdentifier('agentbuddy:acme/team/mkt/deploy')).toEqual({
        protocol: 'skill',
        group: 'acme/team/mkt',
        skill: 'deploy',
      });
    });

    it('round-trips registry identifiers for skill and plugin group sources', () => {
      for (const source of [
        { protocol: 'skill' as const, group: 'skills.example.com/doubao', skill: 'health' },
        { protocol: 'plugin' as const, group: 'acme/team', skill: 'deploy', version: '1.2.3' },
      ]) {
        const identifier = `agentbuddy:${formatAgentbuddyIdentifier(source)}`;
        expect(parseAgentbuddyIdentifier(identifier)).toEqual(source);
      }
    });

    it('parses an optional @version suffix on the skill segment', () => {
      expect(parseAgentbuddyIdentifier('agentbuddy:acme/team/deploy@1.2.3')).toEqual({
        protocol: 'skill',
        group: 'acme/team',
        skill: 'deploy',
        version: '1.2.3',
      });
    });

    it('throws on malformed identifiers instead of falling through to local', () => {
      expect(() => parseSkillInstallSource('agentbuddy:')).toThrow(/invalid_agentbuddy_identifier/);
      expect(() => parseSkillInstallSource('agentbuddy:acme')).toThrow(/invalid_agentbuddy_identifier/);
      expect(() => parseSkillInstallSource('agentbuddy:collection/')).toThrow(/invalid_agentbuddy/);
      expect(() => parseSkillInstallSource('agentbuddy:collection/a/b')).toThrow(/invalid_agentbuddy_collection/);
      expect(() => parseSkillInstallSource('agentbuddy:../etc/passwd')).toThrow(/invalid_agentbuddy/);
      expect(() => parseSkillInstallSource('agentbuddy:acme//deploy')).toThrow(/invalid_agentbuddy_identifier/);
      expect(() => parseSkillInstallSource('agentbuddy:acme/-flag')).toThrow(/invalid_agentbuddy_skill/);
    });

    it('returns null (no agentbuddy intent) for strings without the scheme', () => {
      expect(parseAgentbuddyIdentifier('acme/deploy')).toBeNull();
      expect(parseAgentbuddyIdentifier('https://example.com/agentbuddy/x')).toBeNull();
    });

    it('does NOT treat an arbitrary URL containing "agentbuddy" as an agentbuddy source', () => {
      // No marketplace URL parser exists — such a URL is a git remote, never
      // an agentbuddy identifier and never a local path.
      expect(parseSkillInstallSource('https://market.example.com/agentbuddy/xxx?id=xxx')).toMatchObject({
        kind: 'git',
      });
    });

    it('does NOT treat a local path containing "agentbuddy" as an agentbuddy source', () => {
      expect(parseSkillInstallSource('/srv/agentbuddy/skills/foo')).toMatchObject({
        kind: 'local',
        value: '/srv/agentbuddy/skills/foo',
      });
      expect(parseSkillInstallSource('./agentbuddy-skills')).toMatchObject({ kind: 'local' });
    });
  });

  describe('agentbuddy identifier round-trip: uncovered shapes', () => {
    // Complements the group round-trip above. formatAgentbuddyIdentifier() is
    // what gets persisted as the skill's source; if parsing stops accepting
    // what the formatter writes, a saved agentbuddy skill silently becomes
    // unresolvable — so collections need the same guard as group sources.
    it('round-trips collection identifiers for both protocols', () => {
      for (const source of [
        { protocol: 'skill' as const, collection: 'iYrkTRRY' },
        { protocol: 'plugin' as const, collection: 'abc123' },
      ]) {
        const identifier = `agentbuddy:${formatAgentbuddyIdentifier(source)}`;
        expect(parseAgentbuddyIdentifier(identifier)).toEqual(source);
        expect(parseSkillInstallSource(identifier)).toMatchObject({ kind: 'agentbuddy', agentbuddy: source });
      }
    });

    it('round-trips the real marketplace copy-command through the saved format', () => {
      const raw = 'npm_config_registry="https://registry.example.com" npx -y agentbuddy@latest skill add skills.example.com/doubao/health';
      const parsed = parseAgentbuddyCommand(raw)!;
      expect(parsed).toBeTruthy();
      const identifier = formatAgentbuddyIdentifier(parsed);
      expect(identifier).toBe('skill/skills.example.com/doubao/health');
      expect(parseAgentbuddyIdentifier(`agentbuddy:${identifier}`)).toEqual(parsed);
    });

    it('treats a leading skill/plugin segment as the protocol, not part of the group', () => {
      expect(parseAgentbuddyIdentifier('agentbuddy:skill/doubao/health')).toEqual({
        protocol: 'skill',
        group: 'doubao',
        skill: 'health',
      });
      // Documented consequence of that rule: a group whose first segment is
      // literally "skill"/"plugin" is not expressible. It must fail loudly
      // rather than silently resolve to a different target.
      expect(() => parseAgentbuddyIdentifier('agentbuddy:skill/health')).toThrow(/invalid_agentbuddy_identifier/);
      expect(() => parseAgentbuddyIdentifier('agentbuddy:plugin/health')).toThrow(/invalid_agentbuddy_identifier/);
    });
  });

  describe('bare GitHub shorthand + http fallthrough', () => {
    it('normalizes owner/repo and owner/repo/path to a github source', () => {
      expect(parseSkillInstallSource('anthropics/skills')).toMatchObject({
        kind: 'github',
        github: { owner: 'anthropics', repo: 'skills' },
      });
      expect(parseSkillInstallSource('anthropics/skills/document-skills')).toMatchObject({
        kind: 'github',
        github: { owner: 'anthropics', repo: 'skills', path: 'document-skills' },
      });
    });

    it('keeps the explicit github: form working', () => {
      expect(parseSkillInstallSource('github:anthropics/skills/document-skills')).toMatchObject({
        kind: 'github',
        github: { owner: 'anthropics', repo: 'skills', path: 'document-skills' },
      });
    });

    it('prefers an existing local directory over GitHub shorthand', () => {
      const dir = mkdtempSync(join(tmpdir(), 'botmux-shorthand-'));
      const cwd = process.cwd();
      try {
        mkdirSync(join(dir, 'owner', 'repo'), { recursive: true });
        process.chdir(dir);
        expect(parseSkillInstallSource('owner/repo')).toMatchObject({ kind: 'local', value: 'owner/repo' });
      } finally {
        process.chdir(cwd);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('treats an unsupported http(s) URL as a git remote, never a local path', () => {
      const parsed = parseSkillInstallSource('https://git.internal.corp/team/skills');
      expect(parsed.kind).toBe('git');
      expect(parsed.kind).not.toBe('local');
    });

    it('rejects an unknown URL scheme loudly', () => {
      expect(() => parseSkillInstallSource('ftp://example.com/skills')).toThrow();
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

    it('accepts global flags around the source and shell-quoted sources', () => {
      for (const command of [
        'skills add -g vercel-labs/agent-browser',
        'skills add --global vercel-labs/agent-browser',
        'skills add vercel-labs/agent-browser -g',
        'npx -y skills@latest add -g vercel-labs/agent-browser',
        'add-skill -g vercel-labs/agent-browser',
        'add-skill vercel-labs/agent-browser --global',
        'skills add "vercel-labs/agent-browser"',
        "skills add 'vercel-labs/agent-browser'",
      ]) {
        expect(parseSkillsInstallCommand(command)).toMatchObject({
          kind: 'github',
          github: { owner: 'vercel-labs', repo: 'agent-browser' },
        });
      }
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
      expect(parseSkillsInstallCommand('skills add "unterminated')).toBeNull();
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
