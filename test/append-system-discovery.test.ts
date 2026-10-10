import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  discoverPiAppendSystemPrompt,
  discoverOmpAppendSystemPrompt,
  isPiProjectTrusted,
} from '../src/adapters/cli/append-system-discovery.js';

describe('append-system-discovery', () => {
  describe('Pi discovery', () => {
    it('returns undefined when neither project nor user APPEND_SYSTEM.md exists', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'pi-disc-none-cwd-'));
      const agentDir = mkdtempSync(join(tmpdir(), 'pi-disc-none-agent-'));
      try {
        const result = discoverPiAppendSystemPrompt({ cwd, agentDir });
        expect(result).toBeUndefined();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    });

    it('loads project APPEND_SYSTEM.md when project is trusted in trust.json', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'pi-disc-trusted-cwd-'));
      const agentDir = mkdtempSync(join(tmpdir(), 'pi-disc-trusted-agent-'));
      try {
        // Setup trusted project
        writeFileSync(join(agentDir, 'trust.json'), JSON.stringify({ [cwd]: true }));
        mkdirSync(join(cwd, '.pi'), { recursive: true });
        writeFileSync(join(cwd, '.pi', 'APPEND_SYSTEM.md'), 'PROJECT_INSTRUCTIONS');
        // Also put global, project should take precedence
        writeFileSync(join(agentDir, 'APPEND_SYSTEM.md'), 'GLOBAL_INSTRUCTIONS');

        expect(isPiProjectTrusted(cwd, agentDir)).toBe(true);
        const result = discoverPiAppendSystemPrompt({ cwd, agentDir });
        expect(result).toBeDefined();
        expect(result?.path).toBe(join(cwd, '.pi', 'APPEND_SYSTEM.md'));
        expect(result?.content).toBe('PROJECT_INSTRUCTIONS');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    });

    it('inherits trust from an ancestor directory in trust.json', () => {
      const baseDir = mkdtempSync(join(tmpdir(), 'pi-disc-ancestor-'));
      const subDir = join(baseDir, 'packages', 'child');
      mkdirSync(subDir, { recursive: true });
      const agentDir = mkdtempSync(join(tmpdir(), 'pi-disc-agent-'));
      try {
        writeFileSync(join(agentDir, 'trust.json'), JSON.stringify({ [baseDir]: true }));
        mkdirSync(join(subDir, '.pi'), { recursive: true });
        writeFileSync(join(subDir, '.pi', 'APPEND_SYSTEM.md'), 'CHILD_INSTRUCTIONS');

        expect(isPiProjectTrusted(subDir, agentDir)).toBe(true);
        const result = discoverPiAppendSystemPrompt({ cwd: subDir, agentDir });
        expect(result?.content).toBe('CHILD_INSTRUCTIONS');
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    });

    it('falls back to global APPEND_SYSTEM.md when project is NOT trusted', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'pi-disc-untrusted-cwd-'));
      const agentDir = mkdtempSync(join(tmpdir(), 'pi-disc-untrusted-agent-'));
      try {
        // No entry or false in trust.json
        writeFileSync(join(agentDir, 'trust.json'), JSON.stringify({ [cwd]: false }));
        mkdirSync(join(cwd, '.pi'), { recursive: true });
        writeFileSync(join(cwd, '.pi', 'APPEND_SYSTEM.md'), 'UNTRUSTED_PROJECT_INSTRUCTIONS');
        writeFileSync(join(agentDir, 'APPEND_SYSTEM.md'), 'GLOBAL_FALLBACK_INSTRUCTIONS');

        expect(isPiProjectTrusted(cwd, agentDir)).toBe(false);
        const result = discoverPiAppendSystemPrompt({ cwd, agentDir });
        expect(result).toBeDefined();
        expect(result?.path).toBe(join(agentDir, 'APPEND_SYSTEM.md'));
        expect(result?.content).toBe('GLOBAL_FALLBACK_INSTRUCTIONS');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    });

    it('returns undefined when project is untrusted and global file does not exist', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'pi-disc-untrusted-only-cwd-'));
      const agentDir = mkdtempSync(join(tmpdir(), 'pi-disc-untrusted-only-agent-'));
      try {
        mkdirSync(join(cwd, '.pi'), { recursive: true });
        writeFileSync(join(cwd, '.pi', 'APPEND_SYSTEM.md'), 'UNTRUSTED_PROJECT');

        expect(isPiProjectTrusted(cwd, agentDir)).toBe(false);
        const result = discoverPiAppendSystemPrompt({ cwd, agentDir });
        expect(result).toBeUndefined();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    });

    it('trusts project when settings.json has defaultProjectTrust: "always"', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'pi-disc-always-cwd-'));
      const agentDir = mkdtempSync(join(tmpdir(), 'pi-disc-always-agent-'));
      try {
        writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'always' }));
        mkdirSync(join(cwd, '.pi'), { recursive: true });
        writeFileSync(join(cwd, '.pi', 'APPEND_SYSTEM.md'), 'ALWAYS_TRUSTED_RULES');

        expect(isPiProjectTrusted({ cwd, agentDir })).toBe(true);
        const result = discoverPiAppendSystemPrompt({ cwd, agentDir });
        expect(result?.content).toBe('ALWAYS_TRUSTED_RULES');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    });

    it('rejects project trust when settings.json has defaultProjectTrust: "never"', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'pi-disc-never-cwd-'));
      const agentDir = mkdtempSync(join(tmpdir(), 'pi-disc-never-agent-'));
      try {
        writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'never' }));
        mkdirSync(join(cwd, '.pi'), { recursive: true });
        writeFileSync(join(cwd, '.pi', 'APPEND_SYSTEM.md'), 'PROJECT_RULES');
        writeFileSync(join(agentDir, 'APPEND_SYSTEM.md'), 'GLOBAL_RULES');

        expect(isPiProjectTrusted({ cwd, agentDir })).toBe(false);
        const result = discoverPiAppendSystemPrompt({ cwd, agentDir });
        expect(result?.content).toBe('GLOBAL_RULES');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    });

    it('rejects project trust when extraArgs contains --no-approve even if trust.json has true', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'pi-disc-noapp-cwd-'));
      const agentDir = mkdtempSync(join(tmpdir(), 'pi-disc-noapp-agent-'));
      try {
        writeFileSync(join(agentDir, 'trust.json'), JSON.stringify({ [cwd]: true }));
        mkdirSync(join(cwd, '.pi'), { recursive: true });
        writeFileSync(join(cwd, '.pi', 'APPEND_SYSTEM.md'), 'PROJECT_RULES');
        writeFileSync(join(agentDir, 'APPEND_SYSTEM.md'), 'GLOBAL_RULES');

        expect(isPiProjectTrusted({ cwd, agentDir, extraArgs: ['--no-approve'] })).toBe(false);
        const result = discoverPiAppendSystemPrompt({ cwd, agentDir, extraArgs: ['--no-approve'] });
        expect(result?.content).toBe('GLOBAL_RULES');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    });

    it('grants project trust when extraArgs contains --approve even if untrusted', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'pi-disc-app-cwd-'));
      const agentDir = mkdtempSync(join(tmpdir(), 'pi-disc-app-agent-'));
      try {
        mkdirSync(join(cwd, '.pi'), { recursive: true });
        writeFileSync(join(cwd, '.pi', 'APPEND_SYSTEM.md'), 'APPROVED_PROJECT_RULES');

        expect(isPiProjectTrusted({ cwd, agentDir, extraArgs: ['--approve'] })).toBe(true);
        const result = discoverPiAppendSystemPrompt({ cwd, agentDir, extraArgs: ['--approve'] });
        expect(result?.content).toBe('APPROVED_PROJECT_RULES');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    });

    it('reads PI_CODING_AGENT_DIR from passed env without touching process.env', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'pi-disc-env-cwd-'));
      const workerAgent = mkdtempSync(join(tmpdir(), 'pi-disc-worker-agent-'));
      const botAgent = mkdtempSync(join(tmpdir(), 'pi-disc-bot-agent-'));
      const prevEnv = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = workerAgent;
      try {
        writeFileSync(join(workerAgent, 'APPEND_SYSTEM.md'), 'WORKER_RULES');
        writeFileSync(join(botAgent, 'APPEND_SYSTEM.md'), 'BOT_RULES');

        const result = discoverPiAppendSystemPrompt({ cwd, env: { PI_CODING_AGENT_DIR: botAgent } });
        expect(result?.content).toBe('BOT_RULES');
      } finally {
        if (prevEnv !== undefined) process.env.PI_CODING_AGENT_DIR = prevEnv;
        else delete process.env.PI_CODING_AGENT_DIR;
        rmSync(cwd, { recursive: true, force: true });
        rmSync(workerAgent, { recursive: true, force: true });
        rmSync(botAgent, { recursive: true, force: true });
      }
    });
  });

  describe('OMP discovery', () => {
    it('discovers project .omp/APPEND_SYSTEM.md with highest precedence', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'omp-disc-proj-'));
      const home = mkdtempSync(join(tmpdir(), 'omp-disc-home-'));
      try {
        mkdirSync(join(cwd, '.omp'), { recursive: true });
        writeFileSync(join(cwd, '.omp', 'APPEND_SYSTEM.md'), 'OMP_PROJECT_INSTRUCTIONS');

        mkdirSync(join(home, '.omp', 'agent'), { recursive: true });
        writeFileSync(join(home, '.omp', 'agent', 'APPEND_SYSTEM.md'), 'OMP_GLOBAL_INSTRUCTIONS');

        const result = discoverOmpAppendSystemPrompt({ cwd, homeDir: home });
        expect(result).toBeDefined();
        expect(result?.path).toBe(join(cwd, '.omp', 'APPEND_SYSTEM.md'));
        expect(result?.content).toBe('OMP_PROJECT_INSTRUCTIONS');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('falls back to .claude/APPEND_SYSTEM.md when .omp does not have one', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'omp-disc-claude-'));
      const home = mkdtempSync(join(tmpdir(), 'omp-disc-home-'));
      try {
        mkdirSync(join(cwd, '.claude'), { recursive: true });
        writeFileSync(join(cwd, '.claude', 'APPEND_SYSTEM.md'), 'CLAUDE_FALLBACK_INSTRUCTIONS');

        const result = discoverOmpAppendSystemPrompt({ cwd, homeDir: home });
        expect(result).toBeDefined();
        expect(result?.path).toBe(join(cwd, '.claude', 'APPEND_SYSTEM.md'));
        expect(result?.content).toBe('CLAUDE_FALLBACK_INSTRUCTIONS');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('discovers user ~/.omp/agent/APPEND_SYSTEM.md when no project file exists', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'omp-disc-cwd-'));
      const home = mkdtempSync(join(tmpdir(), 'omp-disc-home-'));
      try {
        mkdirSync(join(home, '.omp', 'agent'), { recursive: true });
        writeFileSync(join(home, '.omp', 'agent', 'APPEND_SYSTEM.md'), 'OMP_USER_AGENT_INSTRUCTIONS');

        const result = discoverOmpAppendSystemPrompt({ cwd, homeDir: home });
        expect(result).toBeDefined();
        expect(result?.path).toBe(join(home, '.omp', 'agent', 'APPEND_SYSTEM.md'));
        expect(result?.content).toBe('OMP_USER_AGENT_INSTRUCTIONS');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('prioritizes OMP_PROFILE over PI_PROFILE', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'omp-disc-cwd-'));
      const home = mkdtempSync(join(tmpdir(), 'omp-disc-home-'));
      try {
        mkdirSync(join(home, '.omp', 'profiles', 'omp-work', 'agent'), { recursive: true });
        writeFileSync(join(home, '.omp', 'profiles', 'omp-work', 'agent', 'APPEND_SYSTEM.md'), 'OMP_WORK_RULES');
        mkdirSync(join(home, '.omp', 'profiles', 'pi-work', 'agent'), { recursive: true });
        writeFileSync(join(home, '.omp', 'profiles', 'pi-work', 'agent', 'APPEND_SYSTEM.md'), 'PI_WORK_RULES');

        const result = discoverOmpAppendSystemPrompt({
          cwd,
          homeDir: home,
          env: { OMP_PROFILE: 'omp-work', PI_PROFILE: 'pi-work' },
        });
        expect(result?.content).toBe('OMP_WORK_RULES');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('does NOT fall back to default agent when named profile has no file', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'omp-disc-cwd-'));
      const home = mkdtempSync(join(tmpdir(), 'omp-disc-home-'));
      try {
        mkdirSync(join(home, '.omp', 'agent'), { recursive: true });
        writeFileSync(join(home, '.omp', 'agent', 'APPEND_SYSTEM.md'), 'DEFAULT_PROFILE_RULES');

        const result = discoverOmpAppendSystemPrompt({
          cwd,
          homeDir: home,
          env: { OMP_PROFILE: 'nonexistent-profile' },
        });
        expect(result).toBeUndefined();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('respects PI_PROFILE when OMP_PROFILE is absent', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'omp-disc-cwd-'));
      const home = mkdtempSync(join(tmpdir(), 'omp-disc-home-'));
      try {
        mkdirSync(join(home, '.omp', 'profiles', 'work', 'agent'), { recursive: true });
        writeFileSync(join(home, '.omp', 'profiles', 'work', 'agent', 'APPEND_SYSTEM.md'), 'PROFILE_INSTRUCTIONS');

        const result = discoverOmpAppendSystemPrompt({ cwd, homeDir: home, profile: 'work' });
        expect(result).toBeDefined();
        expect(result?.content).toBe('PROFILE_INSTRUCTIONS');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('discovers CLAUDE_CONFIG_DIR when claude is not disabled', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'omp-disc-cwd-'));
      const home = mkdtempSync(join(tmpdir(), 'omp-disc-home-'));
      const claudeDir = mkdtempSync(join(tmpdir(), 'omp-claude-dir-'));
      try {
        writeFileSync(join(claudeDir, 'APPEND_SYSTEM.md'), 'CLAUDE_ACTIVE_RULES');

        const result = discoverOmpAppendSystemPrompt({
          cwd,
          homeDir: home,
          env: { CLAUDE_CONFIG_DIR: claudeDir },
        });
        expect(result).toBeDefined();
        expect(result?.content).toBe('CLAUDE_ACTIVE_RULES');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
        rmSync(claudeDir, { recursive: true, force: true });
      }
    });

    it('rejects CLAUDE_CONFIG_DIR when disabledProviders contains claude', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'omp-disc-cwd-'));
      const home = mkdtempSync(join(tmpdir(), 'omp-disc-home-'));
      const claudeDir = mkdtempSync(join(tmpdir(), 'omp-claude-dir-'));
      try {
        writeFileSync(join(claudeDir, 'APPEND_SYSTEM.md'), 'CLAUDE_ACTIVE_RULES');

        const result = discoverOmpAppendSystemPrompt({
          cwd,
          homeDir: home,
          env: { CLAUDE_CONFIG_DIR: claudeDir },
          disabledProviders: ['claude'],
        });
        expect(result).toBeUndefined();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
        rmSync(claudeDir, { recursive: true, force: true });
      }
    });

    it('rejects CLAUDE_CONFIG_DIR when settings.json contains disabledProviders: ["claude"]', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'omp-disc-cwd-'));
      const home = mkdtempSync(join(tmpdir(), 'omp-disc-home-'));
      const claudeDir = mkdtempSync(join(tmpdir(), 'omp-claude-dir-'));
      try {
        mkdirSync(join(home, '.omp'), { recursive: true });
        writeFileSync(join(home, '.omp', 'settings.json'), JSON.stringify({ disabledProviders: ['claude'] }));
        writeFileSync(join(claudeDir, 'APPEND_SYSTEM.md'), 'CLAUDE_ACTIVE_RULES');

        const result = discoverOmpAppendSystemPrompt({
          cwd,
          homeDir: home,
          env: { CLAUDE_CONFIG_DIR: claudeDir },
        });
        expect(result).toBeUndefined();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
        rmSync(claudeDir, { recursive: true, force: true });
      }
    });

    it('discovers codex or gemini only when enabledProviders includes them', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'omp-disc-cwd-'));
      const home = mkdtempSync(join(tmpdir(), 'omp-disc-home-'));
      try {
        mkdirSync(join(home, '.codex'), { recursive: true });
        writeFileSync(join(home, '.codex', 'APPEND_SYSTEM.md'), 'CODEX_ACTIVE_RULES');

        // Unenabled by default -> returns undefined
        const unenabled = discoverOmpAppendSystemPrompt({ cwd, homeDir: home, env: { CLAUDE_CONFIG_DIR: '' } });
        expect(unenabled).toBeUndefined();

        // Enabled via enabledProviders in opts
        const enabled = discoverOmpAppendSystemPrompt({
          cwd,
          homeDir: home,
          enabledProviders: ['codex'],
          env: { CLAUDE_CONFIG_DIR: '' },
        });
        expect(enabled?.content).toBe('CODEX_ACTIVE_RULES');

        // Enabled via settings.json
        mkdirSync(join(home, '.omp'), { recursive: true });
        writeFileSync(join(home, '.omp', 'settings.json'), JSON.stringify({ enabledProviders: ['codex'] }));
        const enabledViaSettings = discoverOmpAppendSystemPrompt({
          cwd,
          homeDir: home,
          env: { CLAUDE_CONFIG_DIR: '' },
        });
        expect(enabledViaSettings?.content).toBe('CODEX_ACTIVE_RULES');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('respects disabledProviders in default profile agent/config.yml', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'omp-disc-cwd-'));
      const home = mkdtempSync(join(tmpdir(), 'omp-disc-home-'));
      const claudeDir = mkdtempSync(join(tmpdir(), 'omp-claude-dir-'));
      try {
        const agentDir = join(home, '.omp', 'agent');
        mkdirSync(agentDir, { recursive: true });
        writeFileSync(join(agentDir, 'config.yml'), 'disabledProviders:\n  - claude\n');
        writeFileSync(join(claudeDir, 'APPEND_SYSTEM.md'), 'CLAUDE_ACTIVE_RULES');

        const result = discoverOmpAppendSystemPrompt({
          cwd,
          homeDir: home,
          env: { CLAUDE_CONFIG_DIR: claudeDir },
        });
        expect(result).toBeUndefined();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
        rmSync(claudeDir, { recursive: true, force: true });
      }
    });

    it('respects disabledProviders in named profile agent/config.yml', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'omp-disc-cwd-'));
      const home = mkdtempSync(join(tmpdir(), 'omp-disc-home-'));
      const claudeDir = mkdtempSync(join(tmpdir(), 'omp-claude-dir-'));
      try {
        const agentDir = join(home, '.omp', 'profiles', 'work', 'agent');
        mkdirSync(agentDir, { recursive: true });
        writeFileSync(join(agentDir, 'config.yml'), 'disabledProviders:\n  - claude\n');
        writeFileSync(join(claudeDir, 'APPEND_SYSTEM.md'), 'CLAUDE_ACTIVE_RULES');

        const result = discoverOmpAppendSystemPrompt({
          cwd,
          homeDir: home,
          env: { CLAUDE_CONFIG_DIR: claudeDir, OMP_PROFILE: 'work' },
        });
        expect(result).toBeUndefined();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
        rmSync(claudeDir, { recursive: true, force: true });
      }
    });

    it('respects disabledProviders in project .omp/config.yml', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'omp-disc-cwd-'));
      const home = mkdtempSync(join(tmpdir(), 'omp-disc-home-'));
      const claudeDir = mkdtempSync(join(tmpdir(), 'omp-claude-dir-'));
      try {
        const projectOmp = join(cwd, '.omp');
        mkdirSync(projectOmp, { recursive: true });
        writeFileSync(join(projectOmp, 'config.yml'), 'disabledProviders:\n  - claude\n');
        writeFileSync(join(claudeDir, 'APPEND_SYSTEM.md'), 'CLAUDE_ACTIVE_RULES');

        const result = discoverOmpAppendSystemPrompt({
          cwd,
          homeDir: home,
          env: { CLAUDE_CONFIG_DIR: claudeDir },
        });
        expect(result).toBeUndefined();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
        rmSync(claudeDir, { recursive: true, force: true });
      }
    });
  });
});
