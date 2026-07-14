/**
 * Unit tests for CLI adapters: factory, buildArgs, patterns, properties.
 *
 * Run:  pnpm vitest run test/cli-adapters.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { codexHome } from '../src/services/codex-paths.js';

// ---------------------------------------------------------------------------
// Mock external dependencies BEFORE importing adapters
// ---------------------------------------------------------------------------

// Mock child_process so resolveCommand()'s shell probe returns nothing (the
// command falls through to the bare name). resolveCommand short-circuits
// absolute paths before probing, so absolute pathOverrides never hit this.
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
  spawnSync: vi.fn(() => ({ stdout: '', status: 0 })),
}));

import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { createAidenAdapter } from '../src/adapters/cli/aiden.js';
import { createCocoAdapter } from '../src/adapters/cli/coco.js';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { createCodexAppAdapter } from '../src/adapters/cli/codex-app.js';
import { createCursorAdapter } from '../src/adapters/cli/cursor.js';
import { createGeminiAdapter } from '../src/adapters/cli/gemini.js';
import { createGeniusAdapter } from '../src/adapters/cli/genius.js';
import { createOpenCodeAdapter } from '../src/adapters/cli/opencode.js';
import { createAntigravityAdapter } from '../src/adapters/cli/antigravity.js';
import { createMtrAdapter, mtrSessionIdForBotmuxSession } from '../src/adapters/cli/mtr.js';
import { GOAL_ENV } from '../src/workflows/v3/contract.js';
import { createHermesAdapter } from '../src/adapters/cli/hermes.js';
import { createMiraAdapter } from '../src/adapters/cli/mira.js';
import { createMirAdapter } from '../src/adapters/cli/mir.js';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { createPiAdapter } from '../src/adapters/cli/pi.js';
import { createCopilotAdapter } from '../src/adapters/cli/copilot.js';
import { createOhMyPiAdapter } from '../src/adapters/cli/oh-my-pi.js';
import { createKimiAdapter } from '../src/adapters/cli/kimi.js';
import { createGrokAdapter } from '../src/adapters/cli/grok.js';
import { createKiroCliAdapter } from '../src/adapters/cli/kiro-cli.js';
import type { CliAdapter, CliId, PtyHandle } from '../src/adapters/cli/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_CLI_IDS: CliId[] = ['claude-code', 'seed', 'aiden', 'coco', 'codex', 'codex-app', 'gemini', 'genius', 'opencode', 'antigravity', 'mtr', 'hermes', 'mira', 'mir', 'traex', 'pi', 'copilot', 'oh-my-pi', 'kimi', 'grok', 'kiro-cli'];

// ---------------------------------------------------------------------------
// 1. Factory: createCliAdapterSync
// ---------------------------------------------------------------------------

describe('createCliAdapterSync factory', () => {
  it.each(ALL_CLI_IDS)('returns an adapter for "%s"', (id) => {
    const adapter = createCliAdapterSync(id, `/mock/bin/${id}`);
    expect(adapter).toBeDefined();
    expect(adapter.id).toBe(id);
  });

  it('throws for unknown CLI id', () => {
    expect(() => createCliAdapterSync('unknown-cli' as CliId)).toThrow(/Unknown CLI adapter/);
  });

  it.each(ALL_CLI_IDS)('adapter for "%s" has resolvedBin set', (id) => {
    const adapter = createCliAdapterSync(id, `/opt/${id}`);
    if (id === 'codex-app' || id === 'mira' || id === 'mir') expect(adapter.resolvedBin).toBe(process.execPath);
    else expect(adapter.resolvedBin).toBe(`/opt/${id}`);
  });
});

// ---------------------------------------------------------------------------
// 1b. Lazy binary resolution — constructing an adapter must NOT shell out.
// Regression for the setup hang: `botmux setup` builds an adapter just to read
// `modelChoices`; if resolveCommand ran at construction it could suspend setup
// via the interactive shell probe. The probe must defer to first resolvedBin read.
// ---------------------------------------------------------------------------

describe('lazy binary resolution', () => {
  // Direct CLI adapters resolve their actual executable lazily. Runner-backed
  // adapters (codex-app/mira) intentionally use process.execPath and are covered
  // by their own buildArgs tests below.
  const DIRECT_CLI_IDS: CliId[] = ['claude-code', 'seed', 'aiden', 'coco', 'codex', 'cursor', 'gemini', 'genius', 'opencode', 'antigravity', 'mtr', 'hermes', 'traex', 'copilot', 'kimi', 'grok', 'kiro-cli'];

  it.each(DIRECT_CLI_IDS)('"%s": construction does not probe; first resolvedBin read does', async (id) => {
    const { spawnSync } = await import('node:child_process');
    const probe = vi.mocked(spawnSync);
    probe.mockClear();
    const adapter = createCliAdapterSync(id); // bare command name → would probe if eager
    // Seed eagerly resolves its bin to derive its data root; the others must not
    // touch the shell until resolvedBin is read.
    if (id !== 'seed') expect(probe).not.toHaveBeenCalled();
    probe.mockClear();
    void adapter.resolvedBin;
    if (id !== 'seed') expect(probe).toHaveBeenCalled();
  });

  it('memoises: a second resolvedBin read does not probe again', async () => {
    const { spawnSync } = await import('node:child_process');
    const probe = vi.mocked(spawnSync);
    const adapter = createCliAdapterSync('claude-code');
    void adapter.resolvedBin; // resolve + cache
    probe.mockClear();
    void adapter.resolvedBin; // cached → no probe
    expect(probe).not.toHaveBeenCalled();
  });

  it('codex buildArgs reuses the lazily resolved CLI path', async () => {
    const { spawnSync } = await import('node:child_process');
    const probe = vi.mocked(spawnSync);
    probe.mockClear();
    const adapter = createCliAdapterSync('codex');
    expect(probe).not.toHaveBeenCalled();
    void adapter.resolvedBin;
    expect(probe).toHaveBeenCalled();
    probe.mockClear();
    adapter.buildArgs({ sessionId: 's', resume: false });
    expect(probe).not.toHaveBeenCalled();
  });

});

// ---------------------------------------------------------------------------
// 2. buildArgs
// ---------------------------------------------------------------------------

describe('claude-code buildArgs', () => {
  const adapter = createClaudeCodeAdapter('/usr/bin/claude');

  it('new session passes --session-id and permission flags', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-1', resume: false });
    expect(args).toContain('--session-id');
    expect(args).toContain('sess-1');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--resume');
  });

  it('resume session passes --resume', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-1', resume: true });
    expect(args).toContain('--resume');
    expect(args).toContain('sess-1');
    expect(args).not.toContain('--session-id');
  });

  it('disallows plan mode tools', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false });
    const idx = args.indexOf('--disallowed-tools');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toContain('EnterPlanMode');
    expect(args[idx + 1]).toContain('ExitPlanMode');
    expect(args[idx + 1]).not.toContain('AskUserQuestion');
  });

  it('disallows native AskUserQuestion in v3 goal-mode', () => {
    const previous = process.env[GOAL_ENV.V3_MARKER];
    process.env[GOAL_ENV.V3_MARKER] = '1';
    try {
      const args = adapter.buildArgs({ sessionId: 's', resume: false });
      const idx = args.indexOf('--disallowed-tools');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1].split(',')).toEqual(['EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion']);
    } finally {
      if (previous === undefined) delete process.env[GOAL_ENV.V3_MARKER];
      else process.env[GOAL_ENV.V3_MARKER] = previous;
    }
  });

  it('passes inline --settings that skips the dangerous-mode prompt', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false });
    const idx = args.indexOf('--settings');
    expect(idx).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(args[idx + 1]);
    expect(parsed.skipDangerousModePermissionPrompt).toBe(true);
    expect(parsed.permissions.defaultMode).toBe('bypassPermissions');
  });

  it('omits dangerous permission flags/keys AND --settings entirely when disableCliBypass is true', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false, disableCliBypass: true });
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).toContain('--disallowed-tools');
    // SessionStart 就绪 hook 改走全局 settings.json（见 hookInstall.sessionStartCommand），
    // 不再注入进程级 --settings；bypass 键也没有 → 没东西可传 → 干脆不带 --settings。
    expect(args).not.toContain('--settings');
    expect(adapter.hookInstall?.sessionStartCommand).toContain('session-ready');
  });

  it('ignores initialPrompt (not passed via args)', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false, initialPrompt: 'hello' });
    expect(args).not.toContain('hello');
    expect(adapter.passesInitialPromptViaArgs).toBeFalsy();
  });

  it('injects heredoc guidance into append-system-prompt', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false });
    const idx = args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    const prompt = args[idx + 1];
    expect(prompt).toContain("botmux send <<'EOF'");
    expect(prompt).toContain('第一行');
    expect(prompt).toContain('第二行');
    expect(prompt).toContain('botmux send "第一行\\n第二行"');
    expect(prompt).toContain('字面量');
  });

  it('passes configured model with --model', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false, model: 'opus' });
    const idx = args.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('opus');
  });

  it('surfaces curated model choices for setup', () => {
    expect(adapter.modelChoices).toContain('sonnet');
    expect(adapter.modelChoices).toContain('opus');
  });
});

describe('aiden buildArgs', () => {
  const adapter = createAidenAdapter('/usr/bin/aiden');

  it('new session does not include --resume or session id', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-2', resume: false });
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('sess-2');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('agentFull');
  });

  it('resume session passes --resume with session id', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-2', resume: true });
    expect(args).toContain('--resume');
    expect(args).toContain('sess-2');
  });

  it('omits agentFull permission mode when disableCliBypass is true', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-2', resume: false, disableCliBypass: true });
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('agentFull');
  });
});

describe('coco buildArgs', () => {
  const adapter = createCocoAdapter('/usr/bin/coco');

  it('new session passes --session-id', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-3', resume: false });
    expect(args).toContain('--session-id');
    expect(args).toContain('sess-3');
    expect(args).toContain('--yolo');
  });

  it('resume session passes --resume', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-3', resume: true });
    expect(args).toContain('--resume');
    expect(args).toContain('sess-3');
    expect(args).not.toContain('--session-id');
  });

  it('disallows plan mode tools', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false });
    // CoCo uses repeated --disallowed-tool flags
    const indices = args.reduce<number[]>((acc, v, i) => v === '--disallowed-tool' ? [...acc, i] : acc, []);
    expect(indices.length).toBe(2);
    expect(args[indices[0] + 1]).toBe('EnterPlanMode');
    expect(args[indices[1] + 1]).toBe('ExitPlanMode');
  });

  it('omits --yolo when disableCliBypass is true', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-3', resume: false, disableCliBypass: true });
    expect(args).toContain('--session-id');
    expect(args).not.toContain('--yolo');
  });

  it('passes configured model through coco config override', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false, model: 'Doubao-Seed-2.0-Code' });
    const idx = args.indexOf('--config');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('model.name=Doubao-Seed-2.0-Code');
  });

  it('uses Trae skill root for filesystem skill discovery', () => {
    expect(adapter.skillsDir).toBe('~/.trae/skills');
  });
});

describe('codex buildArgs', () => {
  const adapter = createCodexAdapter('/usr/bin/codex');

  it('spawns the Codex binary directly', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-4', resume: false });
    expect(adapter.resolvedBin).toBe('/usr/bin/codex');
    expect(args[0]).toBe('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--codex-bin');
  });

  it('injects botmux session id through Codex shell environment policy', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-4', resume: false });
    const idx = args.indexOf('-c');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('shell_environment_policy.set.BOTMUX_SESSION_ID="sess-4"');
  });

  it('does not inject a stale turn id into Codex shell environment policy', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-4', resume: false });
    expect(args.join('\n')).not.toContain('BOTMUX_TURN_ID');
  });

  it('keeps the whole ~/.codex real in the sandbox (SQLite needs fcntl locks the home overlay lacks)', () => {
    expect(adapter.buildSpawnEnv).toBeUndefined();
    // Not just auth.json: codex's state_*.sqlite / logs_*.sqlite live under
    // ~/.codex and time out (~57s → exit 1) if the dir is on the overlayfs home,
    // which doesn't support POSIX byte-range locks. Bind the whole dir real.
    expect(adapter.authPaths).toEqual(['~/.codex']);
    // skillsDir resolves under CODEX_HOME (default ~/.codex) so it tracks where
    // Codex actually scans skills when CODEX_HOME is overridden.
    expect(adapter.skillsDir).toBe(join(codexHome(), 'skills'));
  });

  it('passes fixed Codex args regardless of session/resume when no resume target is known', () => {
    const args1 = adapter.buildArgs({ sessionId: 'sess-4', resume: false });
    const args2 = adapter.buildArgs({ sessionId: 'sess-4', resume: true });
    expect(args1).toEqual(args2);
    expect(args1).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args1).toContain('--no-alt-screen');
  });

  it('TOML-quotes session id values for Codex config override', () => {
    const args = adapter.buildArgs({ sessionId: 'sess with "quote"', resume: false });
    const idx = args.indexOf('-c');
    expect(args[idx + 1]).toBe('shell_environment_policy.set.BOTMUX_SESSION_ID="sess with \\"quote\\""');
  });

  it('passes the effective working directory as Codex agent root', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-4', resume: false, workingDir: '/repo/root' });
    expect(args).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '--no-alt-screen',
      '-c',
      'shell_environment_policy.set.BOTMUX_SESSION_ID="sess-4"',
      '-c',
      'check_for_update_on_startup=false',
      '-C',
      '/repo/root',
    ]);
  });

  it('omits approval/sandbox bypass flag when disableCliBypass is true', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-4', resume: false, workingDir: '/repo/root', disableCliBypass: true });
    expect(args).toEqual([
      '--no-alt-screen',
      '-c',
      'shell_environment_policy.set.BOTMUX_SESSION_ID="sess-4"',
      '-c',
      'check_for_update_on_startup=false',
      '-C',
      '/repo/root',
    ]);
  });

  it('always disables the startup update picker for botmux-managed launches', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-4', resume: false });
    const idx = args.indexOf('check_for_update_on_startup=false');
    expect(idx).toBeGreaterThan(0);
    expect(args[idx - 1]).toBe('-c');
  });

  it('keeps the startup update override on resume before the Codex session id', () => {
    const args = adapter.buildArgs({
      sessionId: 'sess-4',
      resume: true,
      resumeSessionId: 'codex-session-id',
    });
    const configIdx = args.indexOf('check_for_update_on_startup=false');
    expect(args[0]).toBe('resume');
    expect(args[configIdx - 1]).toBe('-c');
    expect(configIdx).toBeLessThan(args.indexOf('codex-session-id'));
  });

  it('passes configured model with --model', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-4', resume: false, model: 'gpt-5-codex' });
    const idx = args.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('gpt-5-codex');
  });

  it('installs built-in skills into Codex\'s CODEX_HOME/skills dir', () => {
    // Codex has no per-session skill injection (no --plugin-dir equivalent), so
    // botmux installs into Codex's global scan root, which lives under CODEX_HOME
    // (default ~/.codex). Pin it here so a future refactor can't silently drop the
    // field and leave Codex skill-less, while still respecting a custom CODEX_HOME.
    expect(adapter.skillsDir).toBe(join(codexHome(), 'skills'));
    expect(adapter.pluginDir).toBeUndefined();
  });
});

describe('codex-app buildArgs', () => {
  const adapter = createCodexAppAdapter('/usr/bin/codex');

  it('spawns the node runner and passes the Codex binary', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-app', resume: false, workingDir: '/repo/root' });
    expect(adapter.resolvedBin).toBe(process.execPath);
    expect(args[0]).toMatch(/codex-app-runner\.js$/);
    expect(args).toContain('--session-id');
    expect(args).toContain('sess-app');
    expect(args).toContain('--codex-bin');
    expect(args).toContain('/usr/bin/codex');
    expect(args).toContain('--cwd');
    expect(args).toContain('/repo/root');
  });

  it('resumes with the persisted Codex App thread id', () => {
    const args = adapter.buildArgs({
      sessionId: 'sess-app',
      resume: true,
      resumeSessionId: 'thread-123',
    });
    expect(args).toContain('--thread-id');
    expect(args).toContain('thread-123');
  });
});

describe('mira buildArgs', () => {
  const adapter = createMiraAdapter();

  it('spawns the node runner', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-mira', resume: false, model: 'kimi-k2.5' });
    expect(adapter.resolvedBin).toBe(process.execPath);
    expect(args[0]).toMatch(/mira-runner\.js$/);
    expect(args).toContain('--session-id');
    expect(args).toContain('sess-mira');
    expect(args).not.toContain('--model');
    expect(args).not.toContain('kimi-k2.5');
  });

  it('resumes with the persisted Mira session id', () => {
    const args = adapter.buildArgs({
      sessionId: 'sess-mira',
      resume: true,
      resumeSessionId: 'mira-session-123',
    });
    expect(args).toContain('--mira-session-id');
    expect(args).toContain('mira-session-123');
  });
});

describe('mir buildArgs (runner model)', () => {
  const adapter = createMirAdapter();

  it('spawns the mir-runner via node with --session-id', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-mir', resume: false });
    expect(adapter.resolvedBin).toBe(process.execPath);
    expect(args[0]).toMatch(/mir-runner\.js$/);
    expect(args).toContain('--session-id');
    expect(args).toContain('sess-mir');
  });

  it('forwards bot identity + locale to the runner', () => {
    const args = adapter.buildArgs({
      sessionId: 's', resume: false, botName: 'Mir', botOpenId: 'ou_x', locale: 'zh',
    });
    expect(args).toContain('--bot-name');
    expect(args).toContain('Mir');
    expect(args).toContain('--bot-open-id');
    expect(args).toContain('ou_x');
    expect(args).toContain('--locale');
    expect(args).toContain('zh');
  });

  it('ignores model (mircli model is a global file, not a flag)', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false, model: 'opus4.6' });
    expect(args).not.toContain('--model');
    expect(args).not.toContain('opus4.6');
  });

  it('passes a cliPathOverride to the runner via --mircli-bin (absolute kept as-is)', () => {
    const overridden = createMirAdapter('/opt/mircli/bin/mircli');
    const args = overridden.buildArgs({ sessionId: 's', resume: false });
    const idx = args.indexOf('--mircli-bin');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('/opt/mircli/bin/mircli');
  });

  it('omits --mircli-bin when no cliPathOverride is configured', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false });
    expect(args).not.toContain('--mircli-bin');
  });

  it('has no portable copy-paste resume command (mircli owns the session store)', () => {
    expect(adapter.buildResumeCommand?.({ sessionId: 'sess-mir', cliSessionId: 'conv-abc' })).toBeNull();
  });

  it('readyPattern matches the runner prompt indicator', () => {
    expect(adapter.readyPattern?.test('› ')).toBe(true);
  });

  it('injectsSessionContext (runner injects its own context) + empty systemHints', () => {
    expect(adapter.injectsSessionContext).toBe(true);
    expect(adapter.systemHints).toEqual([]);
  });
});

describe('copilot buildArgs', () => {
  const adapter = createCopilotAdapter('/usr/bin/copilot');

  it('fresh session passes --allow-all-tools without resume flags', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-cp', resume: false });
    expect(args).toContain('--allow-all-tools');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--continue');
    expect(args).not.toContain('sess-cp');
  });

  it('resume with cliSessionId passes --resume <id>', () => {
    const args = adapter.buildArgs({
      sessionId: 'sess-cp',
      resume: true,
      resumeSessionId: 'copilot-sess-abc',
    });
    expect(args).toContain('--resume');
    const idx = args.indexOf('--resume');
    expect(args[idx + 1]).toBe('copilot-sess-abc');
  });

  it('resume without cliSessionId falls back to --continue', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-cp', resume: true });
    expect(args).toContain('--continue');
    expect(args).not.toContain('--resume');
  });

  it('passes configured model with --model', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-cp', resume: false, model: 'gpt-5' });
    const idx = args.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('gpt-5');
  });

  it('does not bake initialPrompt into args', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-cp', resume: false, initialPrompt: 'hello copilot' });
    expect(args).not.toContain('hello copilot');
    expect(adapter.passesInitialPromptViaArgs).toBeFalsy();
  });

  it('surfaces curated model choices for setup', () => {
    expect(adapter.modelChoices).toContain('claude-sonnet-4');
    expect(adapter.modelChoices).toContain('gpt-5');
  });
});

describe('cursor buildArgs', () => {
  const adapter = createCursorAdapter('/usr/bin/cursor-agent');

  it('fresh session passes force/model flags without resume flags', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-cursor', resume: false, model: 'gpt-5' });
    expect(args).toContain('--force');
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--continue');
  });

  it('resume with persisted Cursor chatId passes --resume <chatId>', () => {
    const chatId = 'c8c78608-0eef-4930-8007-c41ba71ba05d';
    const args = adapter.buildArgs({
      sessionId: 'sess-cursor',
      resume: true,
      resumeSessionId: chatId,
    });
    expect(args).toContain('--resume');
    const idx = args.indexOf('--resume');
    expect(args[idx + 1]).toBe(chatId);
    expect(args).not.toContain('--continue');
  });

  it('resume without a persisted chatId falls back to --continue', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-cursor', resume: true });
    expect(args).toContain('--continue');
    expect(args).not.toContain('--resume');
  });
});

describe('genius buildArgs', () => {
  const adapter = createGeniusAdapter('/usr/bin/genius');

  it('fresh session passes --session-id and bypasses routine approvals', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-genius', resume: false });
    expect(args).toContain('--session-id');
    expect(args).toContain('sess-genius');
    expect(args).toContain('--dangerously-skip-permissions');
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
    expect(settings.permissions.defaultMode).toBe('bypassPermissions');
    expect(args).not.toContain('--resume');
  });

  it('pre-authorizes botmux send when CLI bypass is disabled', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-genius', resume: false, disableCliBypass: true });
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
    expect(args).toContain('--allowedTools');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Bash(botmux send:*)');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--allow-dangerously-skip-permissions');
    expect(args).not.toContain('--settings');
  });

  it('resume session passes --resume', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-genius', resume: true, resumeSessionId: 'cli-genius' });
    expect(args).toContain('--resume');
    expect(args).toContain('cli-genius');
    expect(args).not.toContain('--session-id');
  });

  it('exposes ~/.genius as a Claude-family transcript root for bridge fallback', () => {
    expect(adapter.claudeDataDir).toBe(join(homedir(), '.genius'));
    expect(adapter.claudeStateJsonPath).toBe(join(homedir(), '.genius', '.claude.json'));
  });

  it('supports type-ahead after the first prompt has booted', () => {
    expect(adapter.supportsTypeAhead).toBe(true);
  });

  it('injects botmux guidance via append-system-prompt', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-genius', resume: false });
    const idx = args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toContain('botmux send');
  });
});

describe('gemini buildArgs', () => {
  const adapter = createGeminiAdapter('/usr/bin/gemini');

  it('basic args include --yolo', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-5', resume: false });
    expect(args).toContain('--yolo');
    expect(args).not.toContain('-i');
  });

  it('omits --yolo when disableCliBypass is true while preserving initial prompt', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-5', resume: false, initialPrompt: 'do something', disableCliBypass: true });
    expect(args).not.toContain('--yolo');
    expect(args).toEqual(['-i', 'do something']);
  });

  it('passes initialPrompt via -i flag', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-5', resume: false, initialPrompt: 'do something' });
    expect(args).toContain('-i');
    const idx = args.indexOf('-i');
    expect(args[idx + 1]).toBe('do something');
  });

  it('passes configured model with --model', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-5', resume: false, model: 'gemini-3-pro-preview' });
    const idx = args.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('gemini-3-pro-preview');
  });

  it('passesInitialPromptViaArgs is true', () => {
    expect(adapter.passesInitialPromptViaArgs).toBe(true);
  });

  it('does not include session id', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-5', resume: false });
    expect(args).not.toContain('sess-5');
  });
});

describe('opencode buildArgs', () => {
  const adapter = createOpenCodeAdapter('/usr/bin/opencode');

  it('keeps the whole opencode data dir real in the sandbox (SQLite needs fcntl locks the home overlay lacks)', () => {
    // Not just auth.json: opencode's global opencode.db (WAL) lives here and
    // can't lock on the overlayfs home — same failure mode as codex.
    expect(adapter.authPaths).toEqual(['~/.local/share/opencode']);
  });

  it('returns empty args for basic case', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-6', resume: false });
    expect(args).toEqual([]);
  });

  it('passes initialPrompt via --prompt flag', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-6', resume: false, initialPrompt: 'hello world' });
    expect(args).toContain('--prompt');
    const idx = args.indexOf('--prompt');
    expect(args[idx + 1]).toBe('hello world');
  });

  it('passes configured model with --model', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-6', resume: false, model: 'anthropic/claude-sonnet-4.5' });
    const idx = args.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('anthropic/claude-sonnet-4.5');
  });

  it('passesInitialPromptViaArgs is true', () => {
    expect(adapter.passesInitialPromptViaArgs).toBe(true);
  });

  it('does not include session id or resume', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-6', resume: true });
    expect(args).not.toContain('sess-6');
    expect(args).not.toContain('--resume');
  });
});

describe('pi buildArgs', () => {
  const adapter = createPiAdapter('/usr/bin/pi');

  it('launches Pi native TUI with session id, no --tools restriction (keeps MCP usable)', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-pi', resume: false, initialPrompt: 'hello pi' });
    expect(adapter.resolvedBin).toBe('/usr/bin/pi');
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe('sess-pi');
    // Pi must NOT receive a --tools allowlist: pinning the built-in tools shadows
    // MCP tools. Let Pi use its default tool set so MCP servers stay usable.
    expect(args).not.toContain('--tools');
    expect(args.at(-1)).toBe('hello pi');
    expect(adapter.passesInitialPromptViaArgs).toBe(true);
    expect(adapter.altScreen).toBe(true);
  });
});

describe('oh-my-pi buildArgs', () => {
  const adapter = createOhMyPiAdapter('/usr/bin/omp');

  it('launches omp TUI with tools, approval-mode, and no-title', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-omp', resume: false, initialPrompt: 'hello omp' });
    expect(adapter.resolvedBin).toBe('/usr/bin/omp');
    expect(args).toContain('--tools');
    expect(args).toContain('read,bash,edit,write,browser,web_search,ast_grep,ast_edit,lsp,debug,find,eval,search,task,ask');
    expect(args).toContain('--approval-mode');
    expect(args[args.indexOf('--approval-mode') + 1]).toBe('yolo');
    expect(args).toContain('--no-title');
    expect(args).not.toContain('hello omp');
    expect(adapter.passesInitialPromptViaArgs).toBe(false);
    expect(adapter.altScreen).toBe(true);
  });

  it('does not include --session-id (oh-my-pi has none)', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-omp', resume: false });
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('sess-omp');
  });

  it('omits --approval-mode yolo when disableCliBypass is true', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-omp', resume: false, disableCliBypass: true });
    expect(args).not.toContain('--approval-mode');
    expect(args).not.toContain('yolo');
    expect(args).toContain('--no-title');
  });

  it('passes configured model with --model', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-omp', resume: false, model: 'opus' });
    const idx = args.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('opus');
  });

  it('passes working directory with --cwd', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-omp', resume: false, workingDir: '/repo/root' });
    const idx = args.indexOf('--cwd');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('/repo/root');
  });

  const ompPaste = (text: string) => `\x1b[200~${text}\x1b[201~`;

  it('pastes tmux input below OMP placeholder thresholds and submits with Enter', async () => {
    const events: string[] = [];
    const pty = {
      write(data: string) { events.push(`write:${JSON.stringify(data)}`); },
      resize() {},
      onData() {},
      onExit() {},
      kill() {},
      pasteText(text: string) { events.push(`paste:${text}`); },
      sendText(text: string) { events.push(`text:${text}`); },
      sendSpecialKeys(...keys: string[]) { events.push(`keys:${keys.join(',')}`); },
    } satisfies PtyHandle;

    await adapter.writeInput(pty, 'review this');

    expect(events).toEqual([`text:${ompPaste('review this')}`, 'keys:Enter']);
  });

  it('uses the same explicit bracketed-paste wire format on raw PTY', async () => {
    const events: string[] = [];
    const pty = {
      write(data: string) { events.push(data); },
      resize() {},
      onData() {},
      onExit() {},
      kill() {},
    } satisfies PtyHandle;

    await adapter.writeInput(pty, 'review this');

    expect(events).toEqual([ompPaste('review this'), '\r']);
  });

  it('chunks long and many-line input below both OMP placeholder thresholds', async () => {
    const pasted: string[] = [];
    const keys: string[] = [];
    const pty = {
      write() {},
      resize() {},
      onData() {},
      onExit() {},
      kill() {},
      pasteText() { throw new Error('adapter must use one consistent explicit wire format'); },
      sendText(text: string) { pasted.push(text); },
      sendSpecialKeys(...sent: string[]) { keys.push(...sent); },
    } satisfies PtyHandle;

    const content = Array.from({ length: 25 }, (_, i) => `${i}: ${'x'.repeat(60)}`).join('\n');
    await adapter.writeInput(pty, content);

    const payloads = pasted.map(text => text.slice('\x1b[200~'.length, -'\x1b[201~'.length));
    expect(payloads.join('')).toBe(content);
    expect(payloads.length).toBeGreaterThan(2);
    expect(payloads.every(text => text.length <= 512)).toBe(true);
    expect(payloads.every(text => (text.match(/\n/g) ?? []).length <= 9)).toBe(true);
    expect(keys).toEqual(['Enter']);
  });

  it('normalizes paste text so terminal control bytes cannot become OMP key events', async () => {
    const events: string[] = [];
    const pty = {
      write() {},
      resize() {},
      onData() {},
      onExit() {},
      kill() {},
      sendText(text: string) { events.push(text); },
      sendSpecialKeys(...keys: string[]) { events.push(`keys:${keys.join(',')}`); },
    } satisfies PtyHandle;

    await adapter.writeInput(pty, 'a\tb\r\nc\x7fd\x1b[31mred\x1b[0m e\u0301');

    expect(events).toEqual([ompPaste('a   b\ncdred é'), 'keys:Enter']);
  });

  it('clears the OMP composer when a later paste chunk is dropped', async () => {
    const events: string[] = [];
    let textCall = 0;
    const pty = {
      write(data: string) { events.push(`write:${data}`); },
      resize() {},
      onData() {},
      onExit() {},
      kill() {},
      sendText(text: string) { events.push(`text:${text.length}`); return ++textCall !== 2; },
      sendSpecialKeys(...keys: string[]) { events.push(`keys:${keys.join(',')}`); },
    } satisfies PtyHandle;

    await expect(adapter.writeInput(pty, 'x'.repeat(1200))).resolves.toEqual({ submitted: false });

    expect(events).toEqual(['text:524', 'text:524', 'keys:C-c']);
  });

  it('clears the OMP composer when Enter retries are all dropped', async () => {
    const events: string[] = [];
    const pty = {
      write(data: string) { events.push(`write:${data}`); },
      resize() {},
      onData() {},
      onExit() {},
      kill() {},
      sendText(text: string) { events.push(`text:${text}`); },
      sendSpecialKeys(...keys: string[]) {
        events.push(`keys:${keys.join(',')}`);
        return keys[0] === 'C-c';
      },
    } satisfies PtyHandle;

    await expect(adapter.writeInput(pty, 'review this')).resolves.toEqual({ submitted: false });

    expect(events).toEqual([
      `text:${ompPaste('review this')}`,
      'keys:Enter',
      'keys:Enter',
      'keys:Enter',
      'keys:C-c',
    ]);
  });

  it('blocks new text behind an uncleared partial composer and retries cleanup first', async () => {
    const isolatedAdapter = createOhMyPiAdapter('/usr/bin/omp');
    const events: string[] = [];
    let cleanupAttempts = 0;
    const pty = {
      write() {},
      resize() {},
      onData() {},
      onExit() {},
      kill() {},
      sendText(text: string) { events.push(`text:${text}`); return false; },
      sendSpecialKeys(...keys: string[]) {
        events.push(`keys:${keys.join(',')}`);
        if (keys[0] === 'C-c') return ++cleanupAttempts > 1;
        return true;
      },
    } satisfies PtyHandle;

    await expect(isolatedAdapter.writeInput(pty, 'first')).resolves.toEqual({ submitted: false });
    await expect(isolatedAdapter.writeInput(pty, 'second')).resolves.toEqual({ submitted: false });

    expect(events).toEqual([
      `text:${ompPaste('first')}`,
      'keys:C-c',
      'keys:C-c',
      `text:${ompPaste('second')}`,
      'keys:C-c',
    ]);
  });

  it('skillsDir points to ~/.omp/agent/skills', () => {
    expect(adapter.skillsDir).toBe('~/.omp/agent/skills');
  });

  it('has no modelChoices (setup skips model prompt)', () => {
    expect(adapter.modelChoices).toBeUndefined();
  });
});

describe('mtr buildArgs', () => {
  const adapter = createMtrAdapter('/usr/bin/mtr');

  it('keeps the whole opencode data dir real in the sandbox (mtr.db needs fcntl locks the home overlay lacks)', () => {
    expect(adapter.authPaths).toEqual(['~/.local/share/opencode']);
  });

  it('fresh session passes deterministic --set-session and initial prompt', () => {
    const args = adapter.buildArgs({ sessionId: 'bm-session-1', resume: false, initialPrompt: 'hello mtr' });
    const expected = mtrSessionIdForBotmuxSession('bm-session-1');
    expect(args).toEqual(['--set-session', expected, '--prompt', 'hello mtr']);
    expect(expected).toMatch(/^ses_[0-9A-Za-z]+$/);
  });

  it('ignores configured model because this adapter has no modelChoices', () => {
    const args = adapter.buildArgs({ sessionId: 'bm-session-1', resume: false, model: 'anything' });
    expect(args).not.toContain('--model');
    expect(adapter.modelChoices).toBeUndefined();
  });

  it('resume session passes --session with the same deterministic native id', () => {
    const args = adapter.buildArgs({ sessionId: 'bm-session-1', resume: true });
    expect(args).toEqual(['--session', mtrSessionIdForBotmuxSession('bm-session-1')]);
  });

  it('resume prefers a stored MTR-native cliSessionId', () => {
    const args = adapter.buildArgs({
      sessionId: 'bm-session-1',
      resume: true,
      resumeSessionId: 'ses_001122334455abcdefABCDEF12',
    });
    expect(args).toEqual(['--session', 'ses_001122334455abcdefABCDEF12']);
  });

  it('passesInitialPromptViaArgs is true', () => {
    expect(adapter.passesInitialPromptViaArgs).toBe(true);
  });
});

describe('hermes buildArgs', () => {
  const adapter = createHermesAdapter('/usr/bin/hermes');

  it('fresh session passes yolo, hooks, and session-id passthrough flags', () => {
    const args = adapter.buildArgs({ sessionId: 'bm-hermes-1', resume: false });
    expect(args).toEqual(['--yolo', '--accept-hooks', '--pass-session-id']);
  });

  it('resume session passes --resume with botmux session id', () => {
    const args = adapter.buildArgs({ sessionId: 'bm-hermes-1', resume: true });
    expect(args).toEqual(['--resume', 'bm-hermes-1', '--yolo', '--accept-hooks', '--pass-session-id']);
  });

  it('omits yolo and hook acceptance when disableCliBypass is true', () => {
    const args = adapter.buildArgs({ sessionId: 'bm-hermes-1', resume: false, disableCliBypass: true });
    expect(args).toEqual(['--pass-session-id']);
  });

  it('does not bake initialPrompt into args', () => {
    const args = adapter.buildArgs({ sessionId: 'bm-hermes-1', resume: false, initialPrompt: 'hello hermes' });
    expect(args).not.toContain('hello hermes');
    expect(adapter.passesInitialPromptViaArgs).toBeFalsy();
  });

  it('uses explicit ready signal gate without type-ahead', () => {
    expect(adapter.injectsReadyHook).toBe(true);
    expect(adapter.deferFirstPromptTimeoutUntilReady).toBe(true);
    expect(adapter.supportsTypeAhead).toBeFalsy();
  });
});

describe('antigravity buildArgs', () => {
  const adapter = createAntigravityAdapter('/usr/local/bin/agy');

  it('fresh session passes --dangerously-skip-permissions only', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-7', resume: false });
    expect(args).toEqual(['--dangerously-skip-permissions']);
  });

  it('omits dangerous permission flag when disableCliBypass is true', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-7', resume: false, disableCliBypass: true });
    expect(args).toEqual([]);
  });

  it('does NOT inject initialPrompt via -i (agy -i does not auto-submit)', () => {
    // Empirically: agy's -i deposits a prompt that is neither auto-submitted
    // nor finishable with a follow-up Enter, AND the deposit isn't logged to
    // history.jsonl — we'd lose submit verification. Worker stdin-injects
    // via writeInput instead.
    const args = adapter.buildArgs({ sessionId: 'sess-7', resume: false, initialPrompt: 'do the thing' });
    expect(args).not.toContain('-i');
    expect(args).not.toContain('--prompt-interactive');
    expect(args).not.toContain('do the thing');
  });

  it('passesInitialPromptViaArgs is falsy (worker enqueues for stdin path)', () => {
    expect(adapter.passesInitialPromptViaArgs).toBeFalsy();
  });

  it('resume with cli-native conversation id passes --conversation <id>', () => {
    const args = adapter.buildArgs({
      sessionId: 'bm-7',
      resume: true,
      resumeSessionId: 'eb4cabea-3060-4b76-8e85-5778cc7ddb49',
    });
    expect(args).toContain('--conversation');
    const idx = args.indexOf('--conversation');
    expect(args[idx + 1]).toBe('eb4cabea-3060-4b76-8e85-5778cc7ddb49');
  });

  it('ignores configured model because this adapter has no modelChoices', () => {
    const args = adapter.buildArgs({ sessionId: 'bm-7', resume: false, model: 'gemini-3-pro-preview' });
    expect(args).not.toContain('--model');
    expect(adapter.modelChoices).toBeUndefined();
  });

  it('resume without resumeSessionId starts fresh (no --continue, no random id)', () => {
    // We deliberately don't fall back to --continue: "most recent" is racy
    // across parallel botmux sessions, and we never map botmux sessionId
    // into Antigravity's id space (it would be ignored anyway).
    const args = adapter.buildArgs({ sessionId: 'bm-7', resume: true });
    expect(args).not.toContain('--conversation');
    expect(args).not.toContain('--continue');
    expect(args).not.toContain('bm-7');
  });

  it('never bakes initial prompt into args (resume or fresh)', () => {
    const args = adapter.buildArgs({
      sessionId: 'bm-7',
      resume: true,
      resumeSessionId: 'cid',
      initialPrompt: 'this should not appear',
    });
    expect(args).not.toContain('-i');
    expect(args).not.toContain('this should not appear');
  });

  it('does not include botmux session id (Antigravity self-generates conversation id)', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-7', resume: false });
    expect(args).not.toContain('sess-7');
    expect(args).not.toContain('--session-id');
  });
});

// ---------------------------------------------------------------------------
// 3. completionPattern and readyPattern
// ---------------------------------------------------------------------------

describe('completionPattern', () => {
  it('claude-code matches "Worked for" completion line', () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    const lines = [
      '\u2733 Worked for 12s',
      '\u2733 Crunched for 3m',
      '\u2733 Cogitated for 1h',
      '\u2733 Cooked for 45s',
      '\u2733 Churned for 8s',
      '\u2733 Sauteed for 2s',
      '\u2733 Sautéed for 2s',
      '\u2733 Baked for 29s',
      '\u2733 Brewed for 42s',
    ];
    for (const line of lines) {
      expect(adapter.completionPattern!.test(line), `should match: ${line}`).toBe(true);
    }
  });

  it('claude-code does not match unrelated text', () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    expect(adapter.completionPattern!.test('Processing...')).toBe(false);
    expect(adapter.completionPattern!.test('Worked on it')).toBe(false);
  });

  it('aiden has no completionPattern', () => {
    expect(createAidenAdapter('/bin/aiden').completionPattern).toBeUndefined();
  });

  it('coco has no completionPattern', () => {
    expect(createCocoAdapter('/bin/coco').completionPattern).toBeUndefined();
  });

  it('codex has no completionPattern', () => {
    expect(createCodexAdapter('/bin/codex').completionPattern).toBeUndefined();
  });

  it('codex-app has no completionPattern', () => {
    expect(createCodexAppAdapter('/bin/codex').completionPattern).toBeUndefined();
  });

  it('mira has no completionPattern', () => {
    expect(createMiraAdapter().completionPattern).toBeUndefined();
  });

  it('gemini has no completionPattern', () => {
    expect(createGeminiAdapter('/bin/gemini').completionPattern).toBeUndefined();
  });

  it('opencode has no completionPattern', () => {
    expect(createOpenCodeAdapter('/bin/opencode').completionPattern).toBeUndefined();
  });

  it('antigravity has no completionPattern', () => {
    expect(createAntigravityAdapter('/bin/agy').completionPattern).toBeUndefined();
  });

  it('mtr has no completionPattern', () => {
    expect(createMtrAdapter('/bin/mtr').completionPattern).toBeUndefined();
  });

  it('hermes has no completionPattern', () => {
    expect(createHermesAdapter('/bin/hermes').completionPattern).toBeUndefined();
  });

  it('hermes readyPattern matches the ❯ prompt symbol', () => {
    // Hermes TUI's prompt_symbol is "❯" (see skin_engine.py: prompt_symbol).
    // We match it so the IdleDetector can fire idle as soon as the input box
    // appears, instead of waiting 2s quiescence + 3s spinner-guard. Mirrors
    // claude-code.ts:840 which also uses /❯/. This regression test guards
    // against someone "tidying" the field back to undefined.
    const p = createHermesAdapter('/bin/hermes').readyPattern;
    expect(p).toBeInstanceOf(RegExp);
    expect(p!.test('…spinner ⟪⚔ ▲✢\n\n  ❯ ')).toBe(true);
    // Must not false-positive on common decorative characters used elsewhere
    // in the TUI.
    expect(p!.test('┊ 🌐 preparing browser_navigate…')).toBe(false);
    expect(p!.test('·')).toBe(false);
  });

  it('pi has no completionPattern', () => {
    expect(createPiAdapter('/bin/pi').completionPattern).toBeUndefined();
  });

  it('copilot has no completionPattern', () => {
    expect(createCopilotAdapter('/bin/copilot').completionPattern).toBeUndefined();
  });
});

describe('readyPattern', () => {
  it('claude-code matches prompt indicator', () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    expect(adapter.readyPattern).toBeDefined();
    expect(adapter.readyPattern!.test('❯')).toBe(true);
    expect(adapter.readyPattern!.test('some prefix ❯ suffix')).toBe(true);
  });

  it('coco matches status bar indicator', () => {
    const adapter = createCocoAdapter('/bin/coco');
    expect(adapter.readyPattern).toBeDefined();
    expect(adapter.readyPattern!.test('⏵⏵')).toBe(true);
    expect(adapter.readyPattern!.test('line with ⏵⏵ status')).toBe(true);
  });

  it('codex matches prompt indicator', () => {
    const adapter = createCodexAdapter('/bin/codex');
    expect(adapter.readyPattern).toBeDefined();
    expect(adapter.readyPattern!.test('›')).toBe(true);
    expect(adapter.readyPattern!.test('redraw prefix › ask anything')).toBe(true);
    expect(adapter.readyPattern!.test('\n  › ask anything')).toBe(true);
    expect(adapter.readyPattern!.test('97% left')).toBe(true);
    expect(adapter.readyPattern!.test('› 1. Update now')).toBe(false);
    expect(adapter.readyPattern!.test('\n  › 2. Skip')).toBe(false);
  });

  it('traex matches prompt and context indicators', () => {
    const adapter = createTraexAdapter('/bin/traex');
    expect(adapter.readyPattern).toBeDefined();
    expect(adapter.readyPattern!.test('›')).toBe(true);
    expect(adapter.readyPattern!.test('❯ Run /review on my current changes')).toBe(true);
    expect(adapter.readyPattern!.test('GPT-5.5 · Context 100% left')).toBe(true);
    expect(adapter.readyPattern!.test('❯ 1. Continue into TRAE CLI')).toBe(false);
  });

  it('traex defers the first-prompt timeout until its readyPattern appears', () => {
    // The whole "first message swallowed by the trust/advisory screen" fix hinges
    // on this opt-in being present, so pin it (the worker reads it === true).
    const adapter = createTraexAdapter('/bin/traex');
    expect(adapter.deferFirstPromptTimeoutUntilReady).toBe(true);
    expect(adapter.supportsTypeAhead).toBe(true);
  });

  it('hermes defers the first-prompt timeout without type-ahead', () => {
    // Hermes cold-start initialization may outlive the 15s soft timeout; defer
    // that timeout to avoid flushing the first Lark message before the composer
    // exists. Unlike Codex/CoCo/Claude/TraeX, Hermes can drop input typed before
    // the first real prompt, so keep type-ahead disabled.
    const adapter = createHermesAdapter('/bin/hermes');
    expect(adapter.deferFirstPromptTimeoutUntilReady).toBe(true);
    expect(adapter.supportsTypeAhead).toBeUndefined();
  });

  it('genius matches current and legacy prompt indicators', () => {
    const adapter = createGeniusAdapter('/bin/genius');
    expect(adapter.readyPattern).toBeDefined();
    expect(adapter.readyPattern!.test('›')).toBe(true);
    expect(adapter.readyPattern!.test('\n› ')).toBe(true);
    expect(adapter.readyPattern!.test('\n❯ ')).toBe(true);
    expect(adapter.readyPattern!.test('⏵⏵ accept edits on')).toBe(true);
  });

  it('codex-app matches runner prompt indicator', () => {
    const adapter = createCodexAppAdapter('/bin/codex');
    expect(adapter.readyPattern).toBeDefined();
    expect(adapter.readyPattern!.test('›')).toBe(true);
  });

  it('mira matches runner prompt indicator', () => {
    const adapter = createMiraAdapter();
    expect(adapter.readyPattern).toBeDefined();
    expect(adapter.readyPattern!.test('›')).toBe(true);
  });

  it('aiden has no readyPattern', () => {
    expect(createAidenAdapter('/bin/aiden').readyPattern).toBeUndefined();
  });

  it('gemini has no readyPattern', () => {
    expect(createGeminiAdapter('/bin/gemini').readyPattern).toBeUndefined();
  });

  it('opencode has no readyPattern', () => {
    expect(createOpenCodeAdapter('/bin/opencode').readyPattern).toBeUndefined();
  });

  it('antigravity has no readyPattern', () => {
    expect(createAntigravityAdapter('/bin/agy').readyPattern).toBeUndefined();
  });

  it('mtr has no readyPattern', () => {
    expect(createMtrAdapter('/bin/mtr').readyPattern).toBeUndefined();
  });

  it('hermes readyPattern is set (Hermes TUI exposes ❯ as the prompt symbol)', () => {
    // Previously undefined — that forced every Hermes turn to wait the full
    // 2s quiescence + 3s spinner-guard cycle before botmux could deliver the
    // next user message, which compounded across parallel sessions to 2-3
    // minute delays. Setting readyPattern to /❯/ brings Hermes in line with
    // claude-code/codex-app and recovers the same prompt-detection path they
    // already use. The "matches ❯" assertion lives in the dedicated test
    // below; this one is a coarse regression guard so the field cannot be
    // silently cleared back to undefined.
    const p = createHermesAdapter('/bin/hermes').readyPattern;
    expect(p).toBeInstanceOf(RegExp);
  });

  it('pi has no readyPattern', () => {
    expect(createPiAdapter('/bin/pi').readyPattern).toBeUndefined();
  });

  it('copilot has no readyPattern', () => {
    expect(createCopilotAdapter('/bin/copilot').readyPattern).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. systemHints
// ---------------------------------------------------------------------------

describe('systemHints', () => {
  it('claude-code has empty systemHints (uses --append-system-prompt instead)', () => {
    expect(createClaudeCodeAdapter('/bin/claude').systemHints).toEqual([]);
  });

  it('codex-app has empty systemHints (runner injects app-server instructions)', () => {
    expect(createCodexAppAdapter('/bin/codex').systemHints).toEqual([]);
    expect(createCodexAppAdapter('/bin/codex').injectsSessionContext).toBe(true);
  });

  it('mira has empty systemHints (runner injects API instructions)', () => {
    expect(createMiraAdapter().systemHints).toEqual([]);
    expect(createMiraAdapter().injectsSessionContext).toBe(true);
    expect(createMiraAdapter().modelChoices).toBeUndefined();
  });

  const nonClaudeAdapters: Array<[string, () => CliAdapter]> = [
    ['aiden', () => createAidenAdapter('/bin/aiden')],
    ['coco', () => createCocoAdapter('/bin/coco')],
    ['codex', () => createCodexAdapter('/bin/codex')],
    ['gemini', () => createGeminiAdapter('/bin/gemini')],
    ['opencode', () => createOpenCodeAdapter('/bin/opencode')],
    ['antigravity', () => createAntigravityAdapter('/bin/agy')],
    ['mtr', () => createMtrAdapter('/bin/mtr')],
    ['hermes', () => createHermesAdapter('/bin/hermes')],
    ['pi', () => createPiAdapter('/bin/pi')],
    ['copilot', () => createCopilotAdapter('/bin/copilot')],
    ['kiro-cli', () => createKiroCliAdapter('/bin/kiro-cli')],
  ];

  it.each(nonClaudeAdapters)('%s systemHints include botmux send routing guidance', (_name, factory) => {
    const hints = factory().systemHints;
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.some(h => h.includes('botmux send'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. id property
// ---------------------------------------------------------------------------

describe('id property', () => {
  const expected: [CliId, () => CliAdapter][] = [
    ['claude-code', () => createClaudeCodeAdapter('/bin/claude')],
    ['aiden', () => createAidenAdapter('/bin/aiden')],
    ['coco', () => createCocoAdapter('/bin/coco')],
    ['codex', () => createCodexAdapter('/bin/codex')],
    ['codex-app', () => createCodexAppAdapter('/bin/codex')],
    ['gemini', () => createGeminiAdapter('/bin/gemini')],
    ['opencode', () => createOpenCodeAdapter('/bin/opencode')],
    ['antigravity', () => createAntigravityAdapter('/bin/agy')],
    ['mtr', () => createMtrAdapter('/bin/mtr')],
    ['hermes', () => createHermesAdapter('/bin/hermes')],
    ['mira', () => createMiraAdapter()],
    ['pi', () => createPiAdapter('/bin/pi')],
    ['copilot', () => createCopilotAdapter('/bin/copilot')],
    ['kiro-cli', () => createKiroCliAdapter('/bin/kiro-cli')],
  ];

  it.each(expected)('adapter id is "%s"', (expectedId, factory) => {
    expect(factory().id).toBe(expectedId);
  });
});

// ---------------------------------------------------------------------------
// 6. altScreen property
// ---------------------------------------------------------------------------

describe('altScreen property', () => {
  it('gemini uses alt screen', () => {
    expect(createGeminiAdapter('/bin/gemini').altScreen).toBe(true);
  });

  it('opencode uses alt screen', () => {
    expect(createOpenCodeAdapter('/bin/opencode').altScreen).toBe(true);
  });

  it('claude-code does not use alt screen', () => {
    expect(createClaudeCodeAdapter('/bin/claude').altScreen).toBe(false);
  });

  it('aiden does not use alt screen', () => {
    expect(createAidenAdapter('/bin/aiden').altScreen).toBe(false);
  });

  it('coco does not use alt screen', () => {
    expect(createCocoAdapter('/bin/coco').altScreen).toBe(false);
  });

  it('codex does not use alt screen', () => {
    expect(createCodexAdapter('/bin/codex').altScreen).toBe(false);
  });

  it('codex-app does not use alt screen', () => {
    expect(createCodexAppAdapter('/bin/codex').altScreen).toBe(false);
  });

  it('antigravity uses alt screen (TUI)', () => {
    expect(createAntigravityAdapter('/bin/agy').altScreen).toBe(true);
  });

  it('mtr uses alt screen (TUI)', () => {
    expect(createMtrAdapter('/bin/mtr').altScreen).toBe(true);
  });

  it('hermes does not use alt screen', () => {
    expect(createHermesAdapter('/bin/hermes').altScreen).toBe(false);
  });

  it('mira does not use alt screen', () => {
    expect(createMiraAdapter().altScreen).toBe(false);
  });

  it('pi native TUI uses alt screen', () => {
    expect(createPiAdapter('/bin/pi').altScreen).toBe(true);
  });

  it('copilot uses alt screen (Ink TUI)', () => {
    expect(createCopilotAdapter('/bin/copilot').altScreen).toBe(true);
  });

  it('kiro-cli uses alt screen', () => {
    expect(createKiroCliAdapter('/bin/kiro-cli').altScreen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. buildResumeCommand — terminal copy-paste shown on the closed-session card
// ---------------------------------------------------------------------------

describe('buildResumeCommand', () => {
  it('claude-code prefers cliSessionId (rotation) and falls back to sessionId', () => {
    const a = createClaudeCodeAdapter('/usr/bin/claude');
    expect(a.buildResumeCommand?.({ sessionId: 'bm-1', cliSessionId: 'cli-99' }))
      .toBe('claude --resume cli-99');
    expect(a.buildResumeCommand?.({ sessionId: 'bm-1' }))
      .toBe('claude --resume bm-1');
  });

  it('aiden uses botmux sessionId directly (no separate cli id)', () => {
    const a = createAidenAdapter('/bin/aiden');
    expect(a.buildResumeCommand?.({ sessionId: 'sess-aiden', cliSessionId: 'ignored' }))
      .toBe('aiden --resume sess-aiden');
  });

  it('coco uses botmux sessionId', () => {
    const a = createCocoAdapter('/bin/coco');
    expect(a.buildResumeCommand?.({ sessionId: 'sess-coco' }))
      .toBe('coco --resume sess-coco');
  });

  it('codex returns null when neither cliSessionId nor history rollout is available', () => {
    // Use a random UUID instead of a fixed string so the test stays hermetic
    // even on dev machines whose ~/.codex/history.jsonl might happen to
    // contain a hit for a recognisable test sessionId.
    const a = createCodexAdapter('/bin/codex');
    const unlikely = randomUUID();
    expect(a.buildResumeCommand?.({ sessionId: unlikely })).toBeNull();
  });

  it('codex emits `codex resume <cliSessionId>` when cliSessionId is known', () => {
    const a = createCodexAdapter('/bin/codex');
    expect(a.buildResumeCommand?.({ sessionId: 'bm-x', cliSessionId: 'cdx-uuid-1' }))
      .toBe('codex resume cdx-uuid-1');
  });

  it('codex-app has no copy-paste resume command', () => {
    const a = createCodexAppAdapter('/bin/codex');
    expect(a.buildResumeCommand?.({ sessionId: 'bm-x', cliSessionId: 'thread-1' })).toBeNull();
  });

  it('mira has no copy-paste resume command', () => {
    const a = createMiraAdapter();
    expect(a.buildResumeCommand?.({ sessionId: 'bm-x', cliSessionId: 'mira-session-1' })).toBeNull();
  });

  it('gemini does not implement buildResumeCommand (no precise resume)', () => {
    const a = createGeminiAdapter('/bin/gemini');
    expect(a.buildResumeCommand).toBeUndefined();
  });

  it('opencode emits `opencode -s <cliSessionId>` when known', () => {
    const a = createOpenCodeAdapter('/bin/opencode');
    expect(a.buildResumeCommand?.({ sessionId: 'bm-oc', cliSessionId: 'ses_0123abcDEF' }))
      .toBe('opencode -s ses_0123abcDEF');
  });

  it('mtr emits `mtr --session <native-session-id>`', () => {
    const a = createMtrAdapter('/bin/mtr');
    expect(a.buildResumeCommand?.({ sessionId: 'bm-mtr' }))
      .toBe(`mtr --session ${mtrSessionIdForBotmuxSession('bm-mtr')}`);
    expect(a.buildResumeCommand?.({ sessionId: 'bm-mtr', cliSessionId: 'ses_001122334455abcdefABCDEF12' }))
      .toBe('mtr --session ses_001122334455abcdefABCDEF12');
  });

  it('hermes emits `hermes --resume <sessionId>`', () => {
    const a = createHermesAdapter('/bin/hermes');
    expect(a.buildResumeCommand?.({ sessionId: 'bm-hermes', cliSessionId: 'ignored' }))
      .toBe('hermes --resume bm-hermes');
  });

  it('antigravity emits `agy --conversation <cliSessionId>` when known, null otherwise', () => {
    const a = createAntigravityAdapter('/bin/agy');
    expect(a.buildResumeCommand?.({ sessionId: 'bm-ag', cliSessionId: 'cid-uuid' }))
      .toBe('agy --conversation cid-uuid');
    expect(a.buildResumeCommand?.({ sessionId: 'bm-ag' })).toBeNull();
  });

  it('pi emits `pi --session-id <sessionId>`', () => {
    const a = createPiAdapter('/bin/pi');
    expect(a.buildResumeCommand?.({ sessionId: 'bm-pi', cliSessionId: 'ignored' }))
      .toBe('pi --session-id bm-pi');
  });

  it('oh-my-pi emits `omp --continue` (best-effort, ignores sessionId)', () => {
    const a = createOhMyPiAdapter('/bin/omp');
    expect(a.buildResumeCommand?.({ sessionId: 'bm-omp', cliSessionId: 'ignored' }))
      .toBe('omp --continue');
  });

  it('copilot emits `copilot --resume <cliSessionId>` when known, null otherwise', () => {
    const a = createCopilotAdapter('/bin/copilot');
    expect(a.buildResumeCommand?.({ sessionId: 'bm-cp', cliSessionId: 'copilot-sess-1' }))
      .toBe('copilot --resume copilot-sess-1');
    expect(a.buildResumeCommand?.({ sessionId: 'bm-cp' })).toBeNull();
  });

  it('kimi emits `kimi --resume <cliSessionId>` when known, null otherwise', () => {
    const a = createKimiAdapter('/usr/bin/kimi');
    expect(a.buildResumeCommand?.({ sessionId: 'bm-kimi', cliSessionId: 'kimi-sess-1' }))
      .toBe('kimi --resume kimi-sess-1');
    expect(a.buildResumeCommand?.({ sessionId: 'bm-kimi' })).toBeNull();
  });

  it('grok emits `grok --resume <id>` preferring cliSessionId, falling back to sessionId', () => {
    const a = createGrokAdapter('/usr/bin/grok');
    expect(a.buildResumeCommand?.({ sessionId: 'bm-grok', cliSessionId: 'grok-sess-1' }))
      .toBe('grok --resume grok-sess-1');
    expect(a.buildResumeCommand?.({ sessionId: 'bm-grok' }))
      .toBe('grok --resume bm-grok');
  });

});

describe('grok buildArgs', () => {
  const adapter = createGrokAdapter('/usr/bin/grok');
  const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const GROK_TEST_HOME = join(tmpdir(), `botmux-grok-adapter-test-${process.pid}`);

  beforeEach(() => {
    process.env.GROK_HOME = GROK_TEST_HOME;
    rmSync(GROK_TEST_HOME, { recursive: true, force: true });
    mkdirSync(GROK_TEST_HOME, { recursive: true });
  });
  afterEach(() => {
    rmSync(GROK_TEST_HOME, { recursive: true, force: true });
    delete process.env.GROK_HOME;
    delete process.env.BOTMUX_TIME_SCALE;
  });

  it('new session pins --session-id and --always-approve by default', () => {
    const args = adapter.buildArgs({ sessionId: sid, resume: false });
    expect(args).toContain('--always-approve');
    expect(args).toContain('--no-plan');
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe(sid);
    expect(args).not.toContain('--resume');
  });

  it('injects botmux guidance via --rules (Claude --append-system-prompt equivalent)', () => {
    expect(adapter.injectsSessionContext).toBe(true);
    expect(adapter.systemHints).toEqual([]);
    const args = adapter.buildArgs({
      sessionId: sid,
      resume: false,
      botName: 'grok-loopy',
      botOpenId: 'ou_test',
      locale: 'zh',
    });
    const idx = args.indexOf('--rules');
    expect(idx).toBeGreaterThanOrEqual(0);
    const rules = args[idx + 1];
    expect(rules).toContain('<botmux_routing>');
    expect(rules).toContain('botmux send');
    expect(rules).toContain('<identity>');
    expect(rules).toContain('grok-loopy');
    // Prefer append over full override — override would drop Grok's agent prompt.
    expect(args).not.toContain('--system-prompt-override');
    expect(args).not.toContain('--system-prompt');
  });

  it('omits --session-id when the session dir already exists (grok exits 1 on id reuse)', () => {
    // The worker's tier-2 crash-restart fallback re-spawns FRESH with the
    // same botmux UUID; grok refuses a reused --session-id, so the adapter
    // must drop the flag instead of spawn-looping.
    mkdirSync(join(GROK_TEST_HOME, 'sessions', encodeURIComponent('/tmp/proj'), sid), { recursive: true });
    const args = adapter.buildArgs({ sessionId: sid, resume: false, workingDir: '/tmp/proj' });
    expect(args).not.toContain('--session-id');
    expect(args).toContain('--always-approve');
  });

  it('passes --model when configured', () => {
    const args = adapter.buildArgs({ sessionId: sid, resume: false, model: 'grok-4.5' });
    const idx = args.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('grok-4.5');
  });

  it('omits --always-approve when disableCliBypass is true but still disables plan mode', () => {
    const args = adapter.buildArgs({ sessionId: sid, resume: false, disableCliBypass: true });
    expect(args).not.toContain('--always-approve');
    expect(args).toContain('--no-plan');
  });

  it('passes initialPrompt as a positional arg', () => {
    const args = adapter.buildArgs({ sessionId: sid, resume: false, initialPrompt: 'hello grok' });
    expect(args[args.length - 1]).toBe('hello grok');
    expect(adapter.passesInitialPromptViaArgs).toBe(true);
  });

  it('resumes with --resume using resumeSessionId when available', () => {
    const args = adapter.buildArgs({
      sessionId: sid,
      resume: true,
      resumeSessionId: '019f55e6-10a3-7f31-bc07-2fb370ae8239',
    });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('019f55e6-10a3-7f31-bc07-2fb370ae8239');
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--continue');
  });

  it('resumes with botmux sessionId when no resumeSessionId is stored', () => {
    const args = adapter.buildArgs({ sessionId: sid, resume: true });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe(sid);
  });

  it('carves out GROK_HOME (directory-level: SQLite under sessions/) and resolves skills/hooks under it', () => {
    expect(adapter.authPaths).toEqual([GROK_TEST_HOME]);
    expect(adapter.skillsDir).toBe(join(GROK_TEST_HOME, 'skills'));
    expect(adapter.hookInstall?.configPath).toBe(join(GROK_TEST_HOME, 'hooks', 'botmux-session-ready.json'));
  });

  it('surfaces curated model choices for setup', () => {
    expect(adapter.modelChoices).toContain('grok-4.5');
  });

  it('enables type-ahead, ready-hook gate, and grok-hooks SessionStart install', () => {
    expect(adapter.supportsTypeAhead).toBe(true);
    expect(adapter.injectsReadyHook).toBe(true);
    expect(adapter.deferFirstPromptTimeoutUntilReady).toBe(true);
    expect(adapter.readyPattern?.test('│ ❯')).toBe(true);
    expect(adapter.hookInstall?.format).toBe('grok-hooks');
    expect(adapter.hookInstall?.sessionStartCommand).toMatch(/session-ready/);
  });

  it('busyPattern matches the real 0.2.93 busy UI (model + tool phases), not the idle bar', () => {
    const busy = adapter.busyPattern!;
    expect(busy.test('⠧ Waiting for response… 0.3s')).toBe(true);
    expect(busy.test('Shift+Tab:mode  │  Ctrl+c:cancel  │  Ctrl+x:shortcuts')).toBe(true);
    expect(busy.test('Shift+Tab:mode  │  Ctrl+x:shortcuts')).toBe(false);
  });

  it('does not claim Claude-style pluginDir (TUI rejects --plugin-dir)', () => {
    expect(adapter.pluginDir).toBeUndefined();
  });

  it('writeInput verifies against prompt_history.jsonl (submit-time log) and captures the session id', async () => {
    process.env.BOTMUX_TIME_SCALE = '0.01';
    const cwd = '/tmp/proj';
    const historyDir = join(GROK_TEST_HOME, 'sessions', encodeURIComponent(cwd));
    mkdirSync(historyDir, { recursive: true });
    const historyPath = join(historyDir, 'prompt_history.jsonl');
    const grokMintedSid = '019f55e6-10a3-7f31-bc07-2fb370ae8239';

    const events: string[] = [];
    const pty = {
      write() {},
      cliCwd: cwd,
      sendText(text: string) { events.push(`text:${text}`); },
      sendSpecialKeys(...keys: string[]) {
        events.push(`keys:${keys.join(',')}`);
        // Grok appends the submit to the bucket-level prompt_history at
        // submit time (even while a turn is running).
        appendFileSync(historyPath, JSON.stringify({
          timestamp: '2026-07-12T10:00:00Z', session_id: grokMintedSid, prompt: 'line1\nline2', is_bash: false,
        }) + '\n');
      },
    } satisfies PtyHandle;

    const result = await adapter.writeInput(pty, 'line1\nline2');
    expect(result).toEqual({ submitted: true, cliSessionId: grokMintedSid });
    expect(events).toEqual(['text:line1\nline2', 'keys:Enter']);
  });

  it('writeInput retries only Enter (does not re-paste full text)', async () => {
    process.env.BOTMUX_TIME_SCALE = '0.01';
    const cwd = '/tmp/proj';
    const historyDir = join(GROK_TEST_HOME, 'sessions', encodeURIComponent(cwd));
    mkdirSync(historyDir, { recursive: true });
    const historyPath = join(historyDir, 'prompt_history.jsonl');
    const grokMintedSid = '019f55e6-10a3-7f31-bc07-2fb370ae8239';

    const events: string[] = [];
    let enterCount = 0;
    const pty = {
      write() {},
      cliCwd: cwd,
      sendText(text: string) { events.push(`text:${text}`); },
      sendSpecialKeys(...keys: string[]) {
        events.push(`keys:${keys.join(',')}`);
        enterCount++;
        // First Enter is swallowed (slow history); second lands the submit.
        if (enterCount >= 2) {
          appendFileSync(historyPath, JSON.stringify({
            timestamp: '2026-07-12T10:00:00Z', session_id: grokMintedSid, prompt: 'once only', is_bash: false,
          }) + '\n');
        }
      },
    } satisfies PtyHandle;

    const result = await adapter.writeInput(pty, 'once only');
    expect(result).toEqual({ submitted: true, cliSessionId: grokMintedSid });
    // Text pasted exactly once; Enter retried.
    expect(events.filter((e) => e.startsWith('text:'))).toEqual(['text:once only']);
    expect(events.filter((e) => e === 'keys:Enter').length).toBeGreaterThanOrEqual(2);
  });

  it('writeInput treats sendText/sendSpecialKeys false as definite failure (adopt pipe path)', async () => {
    process.env.BOTMUX_TIME_SCALE = '0.01';
    const cwd = '/tmp/proj';
    mkdirSync(join(GROK_TEST_HOME, 'sessions', encodeURIComponent(cwd)), { recursive: true });
    const pty = {
      write() {},
      cliCwd: cwd,
      // TmuxPipeBackend returns false when the pane write is dropped (no throw).
      sendText(): boolean { return false; },
      sendSpecialKeys(): boolean { return false; },
    } satisfies PtyHandle;
    const result = await adapter.writeInput(pty, 'dropped write');
    expect(result).toEqual({ submitted: false });
  });

  it('writeInput treats false from Enter (after successful paste) as failure', async () => {
    process.env.BOTMUX_TIME_SCALE = '0.01';
    const cwd = '/tmp/proj';
    mkdirSync(join(GROK_TEST_HOME, 'sessions', encodeURIComponent(cwd)), { recursive: true });
    const pty = {
      write() {},
      cliCwd: cwd,
      sendText(): boolean { return true; },
      sendSpecialKeys(): boolean { return false; },
    } satisfies PtyHandle;
    const result = await adapter.writeInput(pty, 'paste ok enter dropped');
    expect(result).toEqual({ submitted: false });
  });

  it('writeInput hands back a recheck closure when the submit never lands in-band', async () => {
    process.env.BOTMUX_TIME_SCALE = '0.01';
    const cwd = '/tmp/proj';
    const historyDir = join(GROK_TEST_HOME, 'sessions', encodeURIComponent(cwd));
    mkdirSync(historyDir, { recursive: true });
    const historyPath = join(historyDir, 'prompt_history.jsonl');

    const pty = {
      write() {},
      cliCwd: cwd,
      sendText() {},
      sendSpecialKeys() {},
    } satisfies PtyHandle;

    const result = await adapter.writeInput(pty, 'never lands');
    expect(result).toMatchObject({ submitted: false });
    const recheck = (result as { recheck?: () => unknown }).recheck!;
    expect(recheck()).toBe(false);
    // Late append (slow submit) — the deferred recheck must pick it up.
    appendFileSync(historyPath, JSON.stringify({
      timestamp: '2026-07-12T10:00:01Z', session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', prompt: 'never lands', is_bash: false,
    }) + '\n');
    expect(recheck()).toEqual({ submitted: true, cliSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
  });

  it('writeInput fails closed without cliCwd (no cross-bucket history scan)', async () => {
    process.env.BOTMUX_TIME_SCALE = '0.01';
    const sent: string[] = [];
    const pty = {
      write() {},
      sendText(t: string) { sent.push(t); },
      sendSpecialKeys() {},
    } satisfies PtyHandle;
    const result = await adapter.writeInput(pty, 'orphan prompt');
    expect(result).toEqual({ submitted: false });
    expect(sent).toEqual(['orphan prompt']);
  });
});

describe('kimi buildArgs', () => {
  const adapter = createKimiAdapter('/usr/bin/kimi');

  it('new session passes --yolo by default', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-1', resume: false });
    expect(args).toContain('--yolo');
    expect(args).not.toContain('--resume');
  });

  it('passes --model when configured', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-1', resume: false, model: 'kimi-k2.5' });
    const idx = args.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('kimi-k2.5');
  });

  it('omits --yolo when disableCliBypass is true', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-1', resume: false, disableCliBypass: true });
    expect(args).not.toContain('--yolo');
  });

  it('ignores initialPrompt (not passed via args)', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-1', resume: false, initialPrompt: 'hello' });
    expect(args).not.toContain('hello');
    expect(adapter.passesInitialPromptViaArgs).toBeFalsy();
  });

  it('resumes latest session when no resumeSessionId is available', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-1', resume: true });
    expect(args).toContain('--continue');
    expect(args).not.toContain('--resume');
  });

  it('resumes the provided cli session id when available', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-1', resume: true, resumeSessionId: 'kimi-session-123' });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('kimi-session-123');
    expect(args).not.toContain('--continue');
  });

  it('surfaces curated model choices for setup', () => {
    expect(adapter.modelChoices).toContain('kimi-k2.5');
  });
});

describe('kiro-cli buildArgs', () => {
  const adapter = createKiroCliAdapter('/usr/bin/kiro-cli');

  it('starts the documented chat command and pre-trusts core tools by default', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-kiro', resume: false });
    expect(args).toEqual(['chat', '--trust-tools=read,write,shell']);
  });

  it('omits trust flags when disableCliBypass is true', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-kiro', resume: false, disableCliBypass: true });
    expect(args).toEqual(['chat']);
  });

  it('keeps the initial prompt on stdin so the adapter can capture /session-id first', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-kiro', resume: false, initialPrompt: 'hello kiro' });
    expect(args).toEqual(['chat', '--trust-tools=read,write,shell']);
    expect(args).not.toContain('hello kiro');
    expect(adapter.passesInitialPromptViaArgs).toBeFalsy();
  });

  it('resumes a specific Kiro session id when available', () => {
    const args = adapter.buildArgs({
      sessionId: 'sess-kiro',
      resume: true,
      resumeSessionId: 'kiro-native-session',
    });
    expect(args).toEqual(['chat', '--trust-tools=read,write,shell', '--resume-id', 'kiro-native-session']);
    expect(adapter.buildResumeCommand?.({ sessionId: 'sess-kiro', cliSessionId: 'kiro-native-session' }))
      .toBe('kiro-cli chat --resume-id kiro-native-session');
  });

  it('does not use directory-latest resume without an explicit Kiro session id', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-kiro', resume: true });
    expect(args).toEqual(['chat', '--trust-tools=read,write,shell']);
    expect(args).not.toContain('--resume');
    expect(adapter.buildResumeCommand?.({ sessionId: 'sess-kiro' })).toBeNull();
  });

  it('ignores model because Kiro has no chat --model flag', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-kiro', resume: false, model: 'claude-opus-4.8' });
    expect(args).toEqual(['chat', '--trust-tools=read,write,shell']);
    expect(args).not.toContain('--model');
    expect(args).not.toContain('claude-opus-4.8');
  });

  it('keeps Kiro auth, settings, skills, and SQLite sessions real in the sandbox', () => {
    expect(adapter.authPaths).toEqual(['~/.kiro']);
    expect(adapter.skillsDir).toBe('~/.kiro/skills');
  });
});

describe('traex/coco sandbox authPaths', () => {
  it('traex keeps the whole ~/.trae/cli real in the sandbox (codex-based, same SQLite lock hazard)', () => {
    // traex keeps codex-style state_*.sqlite / logs_*.sqlite + rollout sessions
    // under ~/.trae/cli; the daemon bridge reads them at the REAL path, and the
    // overlayfs home lacks the fcntl locks SQLite needs (see codex.ts).
    const adapter = createTraexAdapter('/bin/traex');
    expect(adapter.authPaths).toEqual(['~/.trae/cli']);
  });

  it('coco keeps ~/.trae/cli (shared trae state/SQLite) AND ~/.cache/coco (transcripts the bridge reads) real', () => {
    const adapter = createCocoAdapter('/bin/coco');
    expect(adapter.authPaths).toEqual(['~/.trae/cli', '~/.cache/coco']);
  });
});
