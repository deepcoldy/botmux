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

    it('respects PI_PROFILE for user agent directory', () => {
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
  });
});
