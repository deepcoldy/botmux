import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveSessionId, runSkillSessionCommand } from '../src/core/skills/cli-session-command.js';
import { writeSessionSkillManifest } from '../src/core/skills/manifest-store.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('botmux skill session command', () => {
  let dataDir: string;
  let skillDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-skill-data-'));
    skillDir = mkdtempSync(join(tmpdir(), 'botmux-skill-dir-'));
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
    write(join(skillDir, 'SKILL.md'), '# Deploy');
    write(join(skillDir, 'references', 'release.md'), '# Release');
    writeSessionSkillManifest({
      sessionId: 's1',
      cliId: 'codex',
      workingDir: '/repo',
      policyMode: 'priority',
      prioritySkills: [{
        id: 'deploy',
        name: 'deploy',
        description: 'Deploy services',
        tags: [],
        rootDir: skillDir,
        entrypoint: 'SKILL.md',
        source: { type: 'user', root: skillDir },
        priorityReason: 'bot:include',
      }],
      diagnostics: [],
      generatedAt: '2026-06-14T00:00:00.000Z',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it('lists skills from the current session manifest', () => {
    expect(runSkillSessionCommand(['list'], { BOTMUX_SESSION_ID: 's1' }).stdout).toContain('deploy');
  });

  it('shows SKILL.md entrypoint', () => {
    expect(runSkillSessionCommand(['show', 'deploy'], { BOTMUX_SESSION_ID: 's1' }).stdout).toContain('# Deploy');
  });

  it('renders botmux-send from the explicit per-session reply style env', () => {
    const result = runSkillSessionCommand(['show', 'botmux-send'], {
      BOTMUX_SESSION_ID: 's1',
      BOTMUX_LARK_APP_ID: 'app-1',
      BOTMUX_REPLY_STYLE: JSON.stringify({ recipes: false, layout: false }),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('name: botmux-send');
    expect(result.stdout).not.toContain('可选排版配方');
    expect(result.stdout).not.toContain('结果摘要');
    expect(result.stdout).not.toContain('--layout');
  });

  it('renders the default guide outside an injected session even with a stale ambient style', () => {
    const result = runSkillSessionCommand(['show', 'botmux-send'], {
      BOTMUX_REPLY_STYLE: JSON.stringify({ recipes: false, layout: false }),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('可选排版配方');
    expect(result.stdout).toContain('--layout result');
  });

  it('reads relative resources', () => {
    expect(runSkillSessionCommand(['read', 'deploy', 'references/release.md'], { BOTMUX_SESSION_ID: 's1' }).stdout).toContain('# Release');
  });

  it('enumerates an empty resource set for an in-memory built-in without a session manifest', () => {
    const result = runSkillSessionCommand(['resources', 'botmux-send'], {
      BOTMUX_SESSION_ID: 'missing-session',
    });
    expect(result).toEqual({ code: 0, stdout: '\n', stderr: '' });
  });

  it('reports that in-memory built-ins have no readable sidecar resources', () => {
    const result = runSkillSessionCommand(['read', 'botmux-send', 'references/demo.md'], {
      BOTMUX_SESSION_ID: 'missing-session',
    });
    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'built-in skill botmux-send has no resources\n',
    });
  });

  it('refuses to run without a session id', () => {
    expect(runSkillSessionCommand(['list'], {}).stderr).toContain('missing BOTMUX_SESSION_ID');
  });

  it('reports a corrupt manifest as unreadable, not not-found', () => {
    write(join(dataDir, 'skill-manifests', 'broken.json'), '{ nope');
    const res = runSkillSessionCommand(['show', 'deploy'], { BOTMUX_SESSION_ID: 'broken' });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('corrupt');
    expect(res.stderr).not.toContain('not found');
  });

  it('reports a present-but-unreadable manifest as unreadable (exit 1), for any uid', () => {
    // EISDIR stands in for a permission fault: root bypasses mode bits, so a
    // chmod-000 file would be readable exactly where the daemon runs.
    mkdirSync(join(dataDir, 'skill-manifests', 'locked.json'), { recursive: true });
    const res = runSkillSessionCommand(['show', 'deploy'], { BOTMUX_SESSION_ID: 'locked' });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('exists but is unreadable');
    expect(res.stderr).toContain('EISDIR');
    expect(res.stderr).not.toContain('not found');
  });

  it.each([
    [['--help']],
    [['-h']],
    [['help']],
    [['list', '--help']],
    [['show', '--help']],
    [['show', '-h']],
    [['resources', '--help']],
    [['read', 'deploy', '--help']],
  ])('prints usage for %j without needing a session id or manifest', (args) => {
    for (const env of [{}, { BOTMUX_SESSION_ID: 'absent' }, { BOTMUX_SESSION_ID: 's1' }]) {
      const res = runSkillSessionCommand(args, env);
      expect(res.code).toBe(0);
      expect(res.stderr).toBe('');
      expect(res.stdout).toMatch(/^usage:/);
    }
  });

  it('keeps first-position help as the help command even when a skill is named help', () => {
    const helpSkillDir = mkdtempSync(join(tmpdir(), 'botmux-skill-help-named-'));
    write(join(helpSkillDir, 'SKILL.md'), '# Help skill');
    writeSessionSkillManifest({
      sessionId: 's-help',
      cliId: 'codex',
      workingDir: '/repo',
      policyMode: 'priority',
      prioritySkills: [{
        id: 'help',
        name: 'help',
        description: 'A skill literally named help',
        tags: [],
        rootDir: helpSkillDir,
        entrypoint: 'SKILL.md',
        source: { type: 'user', root: helpSkillDir },
        priorityReason: 'bot:include',
      }],
      diagnostics: [],
      generatedAt: '2026-06-14T00:00:00.000Z',
    });
    try {
      const helpCmd = runSkillSessionCommand(['help'], { BOTMUX_SESSION_ID: 's-help' });
      expect(helpCmd).toMatchObject({ code: 0, stderr: '' });
      expect(helpCmd.stdout).toMatch(/^usage:/);

      // Second-position help is a skill name, not the help command: the boundary
      // must stay at args[0] and never widen to args.includes('help').
      const shown = runSkillSessionCommand(['show', 'help'], { BOTMUX_SESSION_ID: 's-help' });
      expect(shown.code).toBe(0);
      expect(shown.stderr).toBe('');
      expect(shown.stdout).toContain('# Help skill');
      expect(shown.stdout).not.toMatch(/^usage:/);

      const read = runSkillSessionCommand(['read', 'help', 'SKILL.md'], { BOTMUX_SESSION_ID: 's-help' });
      expect(read.code).toBe(0);
      expect(read.stderr).toBe('');
      expect(read.stdout).toContain('# Help skill');
    } finally {
      rmSync(helpSkillDir, { recursive: true, force: true });
    }
  });

  it('still reports a genuinely absent manifest as not found', () => {
    const res = runSkillSessionCommand(['show', 'deploy'], { BOTMUX_SESSION_ID: 'absent' });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('manifest not found');
  });
});

describe('botmux skill under the doubao sbox shell (no BOTMUX_SESSION_ID)', () => {
  let dataDir: string;
  let skillDir: string;
  const NATIVE_ID = '38450000000000001';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-skill-doubao-'));
    skillDir = mkdtempSync(join(tmpdir(), 'botmux-skill-doubao-dir-'));
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
    write(join(skillDir, 'SKILL.md'), '# Deploy');
    writeSessionSkillManifest({
      sessionId: 's1',
      cliId: 'doubao',
      workingDir: '/repo',
      policyMode: 'priority',
      prioritySkills: [{
        id: 'deploy',
        name: 'deploy',
        description: 'Deploy services',
        tags: [],
        rootDir: skillDir,
        entrypoint: 'SKILL.md',
        source: { type: 'user', root: skillDir },
        priorityReason: 'bot:include',
      }],
      diagnostics: [],
      generatedAt: '2026-06-14T00:00:00.000Z',
    });
    seedPersistedSessionRows(dataDir, 'cli_capture_a', {
      s1: { sessionId: 's1', status: 'active', cliId: 'doubao', cliSessionId: NATIVE_ID },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it('resolves the session from MCP_VM_CONVERSATION_ID', () => {
    const result = runSkillSessionCommand(['show', 'deploy'], { MCP_VM_CONVERSATION_ID: NATIVE_ID });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('# Deploy');
  });

  it('fails closed for an unknown native conversation id', () => {
    const result = runSkillSessionCommand(['show', 'deploy'], { MCP_VM_CONVERSATION_ID: '38450000000000002' });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('missing BOTMUX_SESSION_ID');
  });

  it('rejects a malformed conversation id instead of probing the store', () => {
    const result = runSkillSessionCommand(['show', 'deploy'], { MCP_VM_CONVERSATION_ID: 'not-a-snowflake' });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('missing BOTMUX_SESSION_ID');
  });

  it('fails closed when the native id is bound to two botmux sessions', () => {
    seedPersistedSessionRows(dataDir, 'cli_capture_b', {
      s2: { sessionId: 's2', status: 'active', cliId: 'doubao', cliSessionId: NATIVE_ID },
    });
    const result = runSkillSessionCommand(['show', 'deploy'], { MCP_VM_CONVERSATION_ID: NATIVE_ID });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('missing BOTMUX_SESSION_ID');
  });

  it('fails closed when an active peer row is malformed', () => {
    seedPersistedSessionRows(dataDir, 'cli_capture_b', {
      s2: { sessionId: null, status: 'active', cliId: 'doubao', cliSessionId: NATIVE_ID },
    });

    const result = runSkillSessionCommand(['show', 'deploy'], { MCP_VM_CONVERSATION_ID: NATIVE_ID });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('missing BOTMUX_SESSION_ID');
  });

  it('keeps an explicit BOTMUX_SESSION_ID authoritative and never consults the native id', () => {
    // The native id resolves to a DIFFERENT session: precedence inversion would
    // load s2's (absent) manifest instead of s1's deployed skill.
    seedPersistedSessionRows(dataDir, 'cli_capture_b', {
      s2: { sessionId: 's2', status: 'active', cliId: 'doubao', cliSessionId: '99999999999999999' },
    });
    const result = runSkillSessionCommand(['show', 'deploy'], {
      BOTMUX_SESSION_ID: 's1',
      MCP_VM_CONVERSATION_ID: '99999999999999999',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('# Deploy');
  });
});

describe('resolveSessionId gating (recording lookup, no store)', () => {
  it('returns the explicit session id and never invokes the lookup, even with a resolvable native id', () => {
    const lookup = vi.fn(() => 's2');
    expect(resolveSessionId({
      BOTMUX_SESSION_ID: 's1',
      MCP_VM_CONVERSATION_ID: '38450000000000001',
    }, lookup)).toBe('s1');
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['non-numeric', 'not-a-snowflake'],
    ['too short', '123456789'],
    ['too long', '1234567890123456789012345'],
  ])('does not invoke the lookup for a %s native conversation id', (_label, nativeId) => {
    const lookup = vi.fn(() => 's1');
    expect(resolveSessionId({ MCP_VM_CONVERSATION_ID: nativeId }, lookup)).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('passes a well-formed native id to the lookup with the doubao cliId and returns its result', () => {
    const lookup = vi.fn(() => 's7');
    expect(resolveSessionId({ MCP_VM_CONVERSATION_ID: '  38450000000000001  ' }, lookup)).toBe('s7');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith({ cliId: 'doubao', cliSessionId: '38450000000000001' });
  });

  it('returns undefined when the lookup finds no unique owner', () => {
    expect(resolveSessionId({ MCP_VM_CONVERSATION_ID: '38450000000000001' }, vi.fn(() => undefined))).toBeUndefined();
  });

  it('fails closed to undefined when the lookup throws', () => {
    const lookup = vi.fn(() => { throw new Error('store unreadable'); });
    expect(resolveSessionId({ MCP_VM_CONVERSATION_ID: '38450000000000001' }, lookup)).toBeUndefined();
  });
});
