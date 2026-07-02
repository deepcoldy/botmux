/**
 * Unit tests for CLI adapters: factory, buildArgs, patterns, properties.
 *
 * Run:  pnpm vitest run test/cli-adapters.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
import type { CliAdapter, CliId } from '../src/adapters/cli/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_CLI_IDS: CliId[] = ['claude-code', 'seed', 'aiden', 'coco', 'codex', 'codex-app', 'gemini', 'genius', 'opencode', 'antigravity', 'mtr', 'hermes', 'mira', 'mir', 'traex', 'pi', 'copilot', 'oh-my-pi', 'kimi'];

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
  const DIRECT_CLI_IDS: CliId[] = ['claude-code', 'seed', 'aiden', 'coco', 'codex', 'cursor', 'gemini', 'genius', 'opencode', 'antigravity', 'mtr', 'hermes', 'traex', 'copilot', 'kimi'];

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

  it('keeps Codex home untouched', () => {
    expect(adapter.buildSpawnEnv).toBeUndefined();
    expect(adapter.authPaths).toEqual(['~/.codex/auth.json']);
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
      '-C',
      '/repo/root',
    ]);
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
    expect(args.at(-1)).toBe('hello omp');
    expect(adapter.passesInitialPromptViaArgs).toBe(true);
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

  it('skillsDir points to ~/.omp/agent/skills', () => {
    expect(adapter.skillsDir).toBe('~/.omp/agent/skills');
  });

  it('has no modelChoices (setup skips model prompt)', () => {
    expect(adapter.modelChoices).toBeUndefined();
  });
});

describe('mtr buildArgs', () => {
  const adapter = createMtrAdapter('/usr/bin/mtr');

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
    expect(adapter.readyPattern!.test('97% left')).toBe(true);
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
