/**
 * Unit tests for CLI adapters: factory, buildArgs, patterns, properties.
 *
 * Run:  pnpm vitest run test/cli-adapters.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, appendFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { codexHome } from '../src/services/codex-paths.js';

// ---------------------------------------------------------------------------
// Mock external dependencies BEFORE importing adapters
// ---------------------------------------------------------------------------

// Mock child_process so resolveCommand()'s shell probe returns nothing (the
// command falls through to the bare name). resolveCommand short-circuits
// absolute paths before probing, so absolute pathOverrides never hit this.
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''),
  spawnSync: vi.fn(() => ({ stdout: '', status: 0 })),
  execFile: vi.fn((_bin, _args, _opts, cb) => { cb(null, '{}'); }),
}));

import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { TERMINAL_CANCEL_COOLDOWN_MS } from '../src/adapters/backend/critical-control-key.js';
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
import { createPiAdapter, buildPiArgs, piTurnBoundaryExtensionPath } from '../src/adapters/cli/pi.js';
import { createCopilotAdapter } from '../src/adapters/cli/copilot.js';
import { createOhMyPiAdapter, ompSessionDir } from '../src/adapters/cli/oh-my-pi.js';
import { assertEbsdPerBotEnv, createEbsdAdapter, ebsdBotmuxSessionDir } from '../src/adapters/cli/ebsd.js';
import { createKimiAdapter } from '../src/adapters/cli/kimi.js';
import { createGrokAdapter } from '../src/adapters/cli/grok.js';
import { createKiroCliAdapter } from '../src/adapters/cli/kiro-cli.js';
import { createReasonixAdapter } from '../src/adapters/cli/reasonix.js';
import { createDshAdapter } from '../src/adapters/cli/dsh.js';
import { createDshTuiAdapter } from '../src/adapters/cli/dsh-tui.js';
import { buildBotmuxShellHints, buildBotmuxSystemPromptText } from '../src/adapters/cli/shared-hints.js';
import { ALL_CLI_IDS as REGISTRY_ALL_CLI_IDS } from '../src/adapters/cli/registry.js';
import { isRemoteCliId } from '../src/core/remote-cli-ids.js';
import type { CliAdapter, CliId, PtyHandle } from '../src/adapters/cli/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Derived from the registry's closed Record<CliId,…> instead of re-typed: the
// hand-written copy this replaced had silently dropped mojo, cursor and relay,
// so those adapters were never exercised by the loops below.
// riff/mojo are remote backends whose adapter is a stub, but constructing one is
// still valid — the assertions below only touch adapter-shape invariants.
const ALL_CLI_IDS: readonly CliId[] = REGISTRY_ALL_CLI_IDS;

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

  it('supportsSessionCwdMove：claude-code true，codex 缺省', () => {
    expect(createCliAdapterSync('claude-code').supportsSessionCwdMove).toBe(true);
    expect(createCliAdapterSync('codex').supportsSessionCwdMove).toBeUndefined();
  });

  it.each(ALL_CLI_IDS)('adapter for "%s" has resolvedBin set', (id) => {
    const adapter = createCliAdapterSync(id, `/opt/${id}`);
    // Remote backends (riff/mojo) never have the worker spawn a local binary —
    // riff is pure HTTP and MojoBackend shells out per turn from the backend, so
    // their adapter deliberately reports an empty resolvedBin. Exempting them via
    // the shared predicate keeps this loop honest for every local CLI.
    if (isRemoteCliId(id)) expect(adapter.resolvedBin).toBe('');
    // dsh joins the bundled-Node-runner group (upstream #858): its resolvedBin is
    // the node binary, not the pinned path.
    else if (id === 'codex-app' || id === 'mira' || id === 'mir' || id === 'dsh') expect(adapter.resolvedBin).toBe(process.execPath);
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
  const DIRECT_CLI_IDS: CliId[] = ['claude-code', 'seed', 'aiden', 'coco', 'codex', 'cursor', 'gemini', 'genius', 'opencode', 'opencode2', 'antigravity', 'mtr', 'hermes', 'traex', 'copilot', 'ebsd', 'kimi', 'grok', 'kiro-cli', 'reasonix', 'dsh-tui'];

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
    expect(prompt).toContain('JSON.stringify');
    expect(prompt).toContain('--content-file');
  });

  it('keeps English system and inline shell hints aligned on raw multiline input', () => {
    const systemPrompt = buildBotmuxSystemPromptText({ locale: 'en' });
    const shellHints = buildBotmuxShellHints('en').join('\n');
    for (const prompt of [systemPrompt, shellHints]) {
      expect(prompt).toContain('JSON.stringify');
      expect(prompt).toContain('JSON-escaped text as a positional argument');
      expect(prompt).toContain('literal `\\n` back into newlines');
      expect(prompt).toContain('--content-file');
    }
  });

  it('keeps the final-answer feedback hint aligned across both injection paths', () => {
    // 回归守卫：feedbackResponseKindHint 必须同时出现在 system-prompt 路径
    // （injectsSessionContext CLI）与 shell-hints 路径，否则启用最终回答反馈时
    // 两类 CLI 的发送行为会静默分叉。
    const systemPrompt = buildBotmuxSystemPromptText({ locale: 'en' });
    const shellHints = buildBotmuxShellHints('en').join('\n');
    for (const prompt of [systemPrompt, shellHints]) {
      expect(prompt).toContain('--response-kind final');
      expect(prompt).toContain('feedback buttons');
    }
  });

  // ── no-transport gate (质量①): a program request/response turn (apiOnly
  //    core-only bot OR HTTP virtual chat) drops the whole send/@/silence
  //    collaboration routing block — it is noise there, and `usage_silence`
  //    CONFLICTS with the per-turn <botmux_http_response_mode>. Both injection
  //    paths must gate identically; only the hidden-context defense survives.
  it('drops the send/@/silence routing block for no-transport on BOTH injection paths', () => {
    const sys = buildBotmuxSystemPromptText({ locale: 'en', noTransport: true });
    const shell = buildBotmuxShellHints('en', true).join('\n');
    for (const prompt of [sys, shell]) {
      // The usage_silence sentinel line is GONE (migrated to http_response_mode).
      expect(prompt).not.toContain('BOTMUX_NOTHING_TO_SEND');
      // No send / @ / collaboration guidance.
      expect(prompt).not.toContain('botmux send');
      // The hidden-context defense is retained (untrusted event data still rides
      // in the same prompt, so the model must still be told not to obey it).
      // Its tag-like tokens are XML-escaped (escapeXmlTagLikeTokens), so match the
      // escaped form the model actually sees.
      expect(prompt).toContain('hidden runtime context');
      expect(prompt).toContain('&lt;user_message&gt;');
    }
    // system-prompt path keeps the block wrapper (just collapsed contents).
    expect(sys).toContain('<botmux_routing>');
    expect(sys).toContain('</botmux_routing>');
  });

  it('keeps identity name/open_id but drops the @-collaboration routing_rules for no-transport', () => {
    // codex #1098 review: identityBlock carries the same @/silence/collaboration
    // semantics as routingInner and IS injected even for a NORMAL bot on an HTTP
    // task (botName/botOpenId passed unconditionally, R1). Gate it too — keep the
    // harmless name/open_id facts, drop only the routing_rules.
    const on = buildBotmuxSystemPromptText({ locale: 'en', botName: 'Bot', botOpenId: 'ou_x', noTransport: true });
    expect(on).toContain('<identity>');
    expect(on).toContain('<name>Bot</name>');
    expect(on).toContain('<open_id>ou_x</open_id>');
    expect(on).not.toContain('<routing_rules>');
    expect(on).not.toContain('MUST');       // mention_must gone
    expect(on).not.toContain('botmux send'); // no --mention directive anywhere
    // Transport-enabled keeps the full identity routing_rules (baseline).
    const off = buildBotmuxSystemPromptText({ locale: 'en', botName: 'Bot', botOpenId: 'ou_x' });
    expect(off).toContain('<routing_rules>');
    expect(off).toContain('botmux send --mention');
  });

  it('keeps the full routing block for a transport-enabled session (default, no gate)', () => {
    // Guard the negative: without noTransport the send/@/silence lines stay,
    // byte-for-byte the pre-feature baseline (default arg is falsy/omitted).
    const sysDefault = buildBotmuxSystemPromptText({ locale: 'en' });
    const sysExplicitFalse = buildBotmuxSystemPromptText({ locale: 'en', noTransport: false });
    const shellDefault = buildBotmuxShellHints('en').join('\n');
    const shellExplicitFalse = buildBotmuxShellHints('en', false).join('\n');
    for (const prompt of [sysDefault, sysExplicitFalse, shellDefault, shellExplicitFalse]) {
      expect(prompt).toContain('BOTMUX_NOTHING_TO_SEND');
      expect(prompt).toContain('botmux send');
    }
    // Omitting the arg and passing false must be identical (no accidental gate).
    expect(sysDefault).toBe(sysExplicitFalse);
    expect(shellDefault).toBe(shellExplicitFalse);
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

  it('bypasses the interactive hook-trust gate right after the approval/sandbox bypass when the toggle is on', () => {
    // codex 0.14x adds a "Press t to trust" gate for the botmux-installed
    // ~/.codex/hooks.json hooks; a headless pane can never press `t`, so without
    // this flag the first Lark turn wedges. It is a DISTINCT flag from the
    // approval/sandbox bypass — assert both are present and adjacent.
    const args = adapter.buildArgs({ sessionId: 'sess-4', resume: false, bypassHookTrust: true });
    expect(args).toContain('--dangerously-bypass-hook-trust');
    expect(args.indexOf('--dangerously-bypass-hook-trust'))
      .toBe(args.indexOf('--dangerously-bypass-approvals-and-sandbox') + 1);
  });

  // The 4-combo acceptance matrix: the hook-trust flag appears ONLY when the
  // global toggle is on AND the bot is not restricted. disableCliBypass is the
  // fail-closed lower bound; the toggle expresses "approvals bypassed, hook-trust
  // review kept". (The worker passes an explicit bypassHookTrust for codex/traex.)
  it.each([
    { toggle: true,  restricted: false, flag: true  },
    { toggle: true,  restricted: true,  flag: false },
    { toggle: false, restricted: false, flag: false },
    { toggle: false, restricted: true,  flag: false },
  ])('hook-trust matrix: toggle=$toggle restricted=$restricted → flag=$flag', ({ toggle, restricted, flag }) => {
    const args = adapter.buildArgs({
      sessionId: 'sess-m', resume: false,
      bypassHookTrust: toggle, disableCliBypass: restricted,
    });
    expect(args.includes('--dangerously-bypass-hook-trust')).toBe(flag);
    // a restricted bot also loses the approval/sandbox bypass (existing behavior)
    expect(args.includes('--dangerously-bypass-approvals-and-sandbox')).toBe(!restricted);
  });

  it('omits the hook-trust flag when the toggle is unset (undefined ⇒ no flag at the adapter layer)', () => {
    // The worker always sends an explicit boolean; a bare call (no bypassHookTrust)
    // must NOT emit the flag — the default-ON decision lives in config, not here.
    const args = adapter.buildArgs({ sessionId: 'sess-4', resume: false });
    expect(args).not.toContain('--dangerously-bypass-hook-trust');
    // approval/sandbox bypass is independent and still present
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('injects botmux session id through Codex shell environment policy', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-4', resume: false });
    const idx = args.indexOf('-c');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('shell_environment_policy.set.BOTMUX_SESSION_ID="sess-4"');
  });

  it('RPC mode: attaches to the app-server thread AND disables the startup update check', () => {
    const args = adapter.buildArgs({
      sessionId: 'sess-rpc', resume: true,
      remoteWsUrl: 'ws://127.0.0.1:9931', remoteThreadId: 'thread-abc',
      // even with BOTH bypass toggles on, the --remote viewer early-returns before
      // baseArgs, so neither flag can leak into the pure viewer args
      bypassHookTrust: true, disableCliBypass: false,
    });
    // pure --remote viewer: no paste-mode bypass flag, no stale resume path
    expect(args).toEqual([
      '--remote', 'ws://127.0.0.1:9931', 'resume', '--no-alt-screen',
      '-c', 'check_for_update_on_startup=false', 'thread-abc',
    ]);
    // the -c disable must land BEFORE the thread id (a resume-subcommand config)
    const cIdx = args.indexOf('-c');
    expect(args[cIdx + 1]).toBe('check_for_update_on_startup=false');
    expect(args.indexOf('thread-abc')).toBeGreaterThan(cIdx);
    // no interactive-paste bypass flag leaks into the viewer args
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    // the app-server (behind --remote) rejects --dangerously-bypass-hook-trust and
    // runs enabled hooks without a trust gate anyway, so it must NOT leak here either
    expect(args).not.toContain('--dangerously-bypass-hook-trust');
  });

  it('traex RPC mode: same --remote viewer args + update-check disabled', () => {
    const traex = createTraexAdapter('/bin/traex');
    const args = traex.buildArgs({
      sessionId: 'sess-rpc', resume: true,
      remoteWsUrl: 'ws://127.0.0.1:9932', remoteThreadId: 'thread-xyz',
      bypassHookTrust: true,
    });
    expect(args).toEqual([
      '--remote', 'ws://127.0.0.1:9932', 'resume', '--no-alt-screen',
      '-c', 'check_for_update_on_startup=false', 'thread-xyz',
    ]);
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
    const args = adapter.buildArgs({ sessionId: 'sess-4', resume: false, workingDir: '/repo/root', bypassHookTrust: true });
    expect(args).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-hook-trust',
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
    // a restricted bot must not silently gain hook trust either
    expect(args).not.toContain('--dangerously-bypass-hook-trust');
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

  it('canonicalizes a symlinked codex so --codex-bin matches the sandbox-authorized path', () => {
    // Regression, same class as the dsh case below: `codex` on PATH is commonly a
    // symlink CHAIN — measured on the dev box, ~/.local/bin/codex →
    // …/standalone/current/bin/codex → …/releases/<version>/bin/codex, where the
    // middle `current` hop re-points on every upgrade. The file sandbox authorizes
    // only dirname(realpath(bin)) (worker.ts `execDirs`), while
    // codex-app-runner.ts spawns --codex-bin verbatim → `execvp … No such file or
    // directory` inside the sandbox and an app-server crash-loop.
    //
    // Verified against a real bwrap sandbox: raw path → execvp ENOENT, canonical
    // path → exit 0. All three call sites must agree, since they share one cache.
    const root = mkdtempSync(join(tmpdir(), 'codex-symlink-'));
    try {
      const realDir = join(root, 'releases', '1.2.3', 'bin');
      mkdirSync(realDir, { recursive: true });
      const realBin = join(realDir, 'codex');
      writeFileSync(realBin, '#!/bin/sh\n', { mode: 0o755 });
      // Two hops, mirroring the real install: link/codex → current/codex → realBin.
      const midDir = join(root, 'current', 'bin');
      mkdirSync(midDir, { recursive: true });
      const midBin = join(midDir, 'codex');
      symlinkSync(realBin, midBin);
      const linkDir = join(root, 'local', 'bin');
      mkdirSync(linkDir, { recursive: true });
      const linkBin = join(linkDir, 'codex');
      symlinkSync(midBin, linkBin);

      const symlinkAdapter = createCodexAppAdapter(linkBin);
      const canonicalReal = realpathSync(realBin);
      expect(linkBin).not.toBe(canonicalReal); // the hazard exists in this fixture

      const args = symlinkAdapter.buildArgs({ sessionId: 's', resume: false });
      const binIdx = args.indexOf('--codex-bin');
      expect(binIdx).toBeGreaterThanOrEqual(0);
      expect(args[binIdx + 1]).toBe(canonicalReal);
      // Must equal the argv exactly — the sandbox authorizes from THIS list while
      // the runner spawns the argv; any divergence is the bug.
      expect(symlinkAdapter.sandboxExtraExecPaths?.()).toEqual([canonicalReal]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes the opt-in browser bridge only to the Codex App runner', () => {
    const disabled = adapter.buildArgs({ sessionId: 'sess-app', resume: false });
    expect(disabled).not.toContain('--browser-family');

    const enabled = adapter.buildArgs({
      sessionId: 'sess-app',
      resume: false,
      codexBrowser: {
        enabled: true,
        family: 'edge',
        pluginRoot: '/opt/codex/chrome-plugin',
      },
    });
    expect(enabled).toEqual(expect.arrayContaining([
      '--browser-family', 'edge',
      '--browser-plugin-root', '/opt/codex/chrome-plugin',
    ]));
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

describe('dsh buildArgs (runner model)', () => {
  const adapter = createDshAdapter('/opt/dsh/bin/dsh-jsonrpc-agent');

  it('spawns the node runner and passes the dsh runtime binary', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-dsh', resume: false, workingDir: '/repo/root' });
    expect(adapter.resolvedBin).toBe(process.execPath);
    expect(args[0]).toMatch(/dsh-runner\.js$/);
    expect(args).toContain('--session-id');
    expect(args).toContain('sess-dsh');
    expect(args).toContain('--dsh-bin');
    expect(args).toContain('/opt/dsh/bin/dsh-jsonrpc-agent');
    expect(args).toContain('--cwd');
    expect(args).toContain('/repo/root');
  });

  it('forwards bot identity, locale and model to the runner', () => {
    const args = adapter.buildArgs({
      sessionId: 's', resume: false, botName: 'Monday', botOpenId: 'ou_x', locale: 'zh', model: 'deepseek-v4-pro',
    });
    expect(args).toContain('--bot-name');
    expect(args).toContain('Monday');
    expect(args).toContain('--bot-open-id');
    expect(args).toContain('ou_x');
    expect(args).toContain('--locale');
    expect(args).toContain('zh');
    expect(args).toContain('--model');
    expect(args).toContain('deepseek-v4-pro');
  });

  it('omits --model when no model is configured', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false });
    expect(args).not.toContain('--model');
  });

  it('forwards a per-bot turn timeout to the runner', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false, turnTimeoutMs: 30 * 60 * 1000 });
    expect(args).toContain('--turn-timeout-ms');
    expect(args).toContain(String(30 * 60 * 1000));
  });

  it('omits --turn-timeout-ms when unset or non-positive', () => {
    expect(adapter.buildArgs({ sessionId: 's', resume: false })).not.toContain('--turn-timeout-ms');
    expect(adapter.buildArgs({ sessionId: 's', resume: false, turnTimeoutMs: 0 })).not.toContain('--turn-timeout-ms');
    expect(adapter.buildArgs({ sessionId: 's', resume: false, turnTimeoutMs: -5 })).not.toContain('--turn-timeout-ms');
  });

  it('has no portable copy-paste resume command', () => {
    expect(adapter.buildResumeCommand?.({ sessionId: 'sess-dsh', cliSessionId: 'session-abc' })).toBeNull();
  });

  it('readyPattern matches the runner prompt indicator', () => {
    expect(adapter.readyPattern?.test('› ')).toBe(true);
  });

  it('defers the first prompt until the runner is ready (slow handshake)', () => {
    expect(adapter.deferFirstPromptTimeoutUntilReady).toBe(true);
  });

  it('does not type ahead (serial turns)', () => {
    expect(adapter.supportsTypeAhead).not.toBe(true);
  });

  it('advertises the deepseek model choices', () => {
    expect(adapter.modelChoices).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
  });

  it('canonicalizes a symlinked bin so --dsh-bin matches the sandbox-authorized path', () => {
    // Regression: a symlink-installed dsh-jsonrpc-agent (e.g. ~/.local/bin →
    // SDK package dir) plus a symlinked HOME made the runner spawn the raw
    // symlink path, which the file sandbox never exposes (it authorizes only
    // dirname(realpath(bin))) → `spawn ... ENOENT` crash-loop under sandbox=true.
    // Both --dsh-bin and sandboxExtraExecPaths() must resolve to the real target.
    const root = mkdtempSync(join(tmpdir(), 'dsh-symlink-'));
    try {
      const realDir = join(root, 'opt', 'runtime');
      mkdirSync(realDir, { recursive: true });
      const realBin = join(realDir, 'dsh-jsonrpc-agent-pkg-linux-x64');
      writeFileSync(realBin, '#!/bin/sh\n', { mode: 0o755 });
      const linkDir = join(root, 'local', 'bin');
      mkdirSync(linkDir, { recursive: true });
      const linkBin = join(linkDir, 'dsh-jsonrpc-agent');
      symlinkSync(realBin, linkBin);

      const symlinkAdapter = createDshAdapter(linkBin);
      const canonicalReal = realpathSync(realBin);

      const args = symlinkAdapter.buildArgs({ sessionId: 's', resume: false });
      const binIdx = args.indexOf('--dsh-bin');
      expect(binIdx).toBeGreaterThanOrEqual(0);
      expect(args[binIdx + 1]).toBe(canonicalReal);
      expect(symlinkAdapter.sandboxExtraExecPaths?.()).toEqual([canonicalReal]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writeInput frames content with the dsh marker', async () => {
    const written: string[] = [];
    const pty = {
      write: (data: string) => { written.push(data); return true; },
    } as unknown as PtyHandle;
    const result = await adapter.writeInput!(pty, 'hello dsh', { turnId: 'turn-1' });
    expect(result).toEqual({ submitted: true, submissionDisposition: 'submitted' });
    const line = written.join('');
    expect(line.startsWith('::botmux-dsh:')).toBe(true);
    const decoded = JSON.parse(Buffer.from(line.slice('::botmux-dsh:'.length).trim(), 'base64').toString('utf8'));
    expect(decoded.content).toBe('hello dsh');
    expect(decoded.replyTurnId).toBe('turn-1');
  });
});

describe('dsh-tui buildArgs (PTY TUI model)', () => {
  const adapter = createDshTuiAdapter('/opt/dsh-tui/bin/dsh-tui');

  it('spawns the dsh-tui binary directly (no runner)', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-tui', resume: false, workingDir: '/repo/root' });
    expect(adapter.resolvedBin).toBe('/opt/dsh-tui/bin/dsh-tui');
    // No runner script — the TUI is spawned directly with no args on fresh boot.
    expect(args.some(a => /runner\.js$/.test(a))).toBe(false);
  });

  it('passes --resume for session resume', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: true, resumeSessionId: 'abc-123' });
    expect(args).toContain('--resume');
    expect(args).toContain('abc-123');
  });

  it('passes bare --resume (no session id) to read resume.txt', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: true });
    expect(args).toEqual(['--resume']);
  });

  it('omits --resume on fresh spawn', () => {
    expect(adapter.buildArgs({ sessionId: 's', resume: false })).toEqual([]);
  });

  it('has no portable copy-paste resume command (session id not tracked)', () => {
    expect(adapter.buildResumeCommand?.({ sessionId: 's', cliSessionId: 'abc' })).toBeNull();
  });

  it('readyPattern matches the TUI prompt char', () => {
    expect(adapter.readyPattern?.test('❯ ')).toBe(true);
  });

  it('defers the first prompt until the TUI composer is ready', () => {
    expect(adapter.deferFirstPromptTimeoutUntilReady).toBe(true);
  });

  it('does not type ahead', () => {
    expect(adapter.supportsTypeAhead).not.toBe(true);
  });

  it('exposes ~/.dsh and ~/.dsh-tui as auth paths', () => {
    expect(adapter.authPaths).toContain('~/.dsh');
    expect(adapter.authPaths).toContain('~/.dsh-tui');
  });

  it('writeInput types text and presses Enter', async () => {
    const sent: string[] = [];
    const keys: string[][] = [];
    const pty = {
      sendText: (t: string) => { sent.push(t); return true; },
      sendSpecialKeys: (...k: string[]) => { keys.push(k); return true; },
    } as unknown as PtyHandle;
    await adapter.writeInput!(pty, 'hello tui');
    expect(sent).toEqual(['hello tui']);
    expect(keys).toEqual([['Enter']]);
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

  it('canonicalizes a symlinked mircli so --mircli-bin matches the sandbox-authorized path', () => {
    // Same defect class as codex-app above and dsh below: mir-runner.ts spawns
    // `this.mircliBin || MIRCLI_BIN || 'mircli'` verbatim, while the file sandbox
    // authorizes only dirname(realpath(bin)) (worker.ts `execDirs`) → a raw
    // symlink path ENOENTs inside the sandbox.
    //
    // mir's gap used to be the WIDEST of the three: before this it declared no
    // sandboxExtraExecPaths at all, so the second-stage binary was never exposed.
    const root = mkdtempSync(join(tmpdir(), 'mircli-symlink-'));
    try {
      const realDir = join(root, 'releases', '2.0.0', 'bin');
      mkdirSync(realDir, { recursive: true });
      const realBin = join(realDir, 'mircli');
      writeFileSync(realBin, '#!/bin/sh\n', { mode: 0o755 });
      // Two hops, matching how versioned CLIs are usually installed.
      const midDir = join(root, 'current', 'bin');
      mkdirSync(midDir, { recursive: true });
      const midBin = join(midDir, 'mircli');
      symlinkSync(realBin, midBin);
      const linkDir = join(root, 'local', 'bin');
      mkdirSync(linkDir, { recursive: true });
      const linkBin = join(linkDir, 'mircli');
      symlinkSync(midBin, linkBin);

      const symlinkAdapter = createMirAdapter(linkBin);
      const canonicalReal = realpathSync(realBin);
      expect(linkBin).not.toBe(canonicalReal); // the hazard exists in this fixture

      const args = symlinkAdapter.buildArgs({ sessionId: 's', resume: false });
      const idx = args.indexOf('--mircli-bin');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe(canonicalReal);
      // The sandbox authorizes from this list while the runner spawns the argv —
      // any divergence between the two IS the bug.
      expect(symlinkAdapter.sandboxExtraExecPaths?.()).toEqual([canonicalReal]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('declares no sandbox exec path when there is no cliPathOverride', () => {
    // Without an override the runner resolves `mircli` from PATH *inside* the
    // sandbox, which the adapter cannot know here — so it declares nothing rather
    // than guessing. Documents the remaining gap (tracked as a follow-up): that
    // PATH entry may not be bind-mounted, and would still ENOENT.
    expect(adapter.sandboxExtraExecPaths?.()).toEqual([]);
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

  it('resume without cliSessionId starts fresh (never --continue)', () => {
    // --continue would resume the globally most recent Copilot session, which
    // is shared across every botmux session of this bot — a worker restart
    // whose cliSessionId was never captured would then load a SIBLING
    // session's conversation (topic-group context leaking into a private
    // chat). Start fresh instead, matching reasonix/antigravity.
    const args = adapter.buildArgs({ sessionId: 'sess-cp', resume: true });
    expect(args).not.toContain('--continue');
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

  it('fresh session passes trust/force/model flags without resume flags', () => {
    const args = adapter.buildArgs({
      sessionId: 'sess-cursor',
      resume: false,
      initialPrompt: 'first Lark turn',
      model: 'gpt-5',
    });
    expect(args).toContain('--trust');
    expect(args).toContain('--force');
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5');
    expect(args.at(-1)).toBe('first Lark turn');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--continue');
  });

  it('resume with persisted Cursor chatId passes --resume <chatId>', () => {
    const chatId = 'c8c78608-0eef-4930-8007-c41ba71ba05d';
    const args = adapter.buildArgs({
      sessionId: 'sess-cursor',
      resume: true,
      resumeSessionId: chatId,
      initialPrompt: 'resume turn',
    });
    expect(args).toContain('--trust');
    expect(args).toContain('--resume');
    const idx = args.indexOf('--resume');
    expect(args[idx + 1]).toBe(chatId);
    expect(args.at(-1)).toBe('resume turn');
    expect(args).not.toContain('--continue');
  });

  it('resume without a persisted chatId starts fresh (never --continue)', () => {
    // --continue (= --resume=-1) would resume the globally most recent Cursor
    // chat, which is shared across every botmux session of this bot — a worker
    // restart whose cliSessionId was never captured would then load a SIBLING
    // session's conversation (topic-group context leaking into a private
    // chat). Start fresh instead, matching reasonix/antigravity.
    const args = adapter.buildArgs({ sessionId: 'sess-cursor', resume: true });
    expect(args).toContain('--trust');
    expect(args).not.toContain('--continue');
    expect(args).not.toContain('--resume');
  });

  // The workspace-trust dialog is a startup gate, not an approval flow: a
  // headless spawn can never answer it, and the injected first prompt would
  // answer it by accident (`a` trusts, `q` quits). So --trust must survive
  // disableCliBypass while --force is dropped.
  it('disableCliBypass drops --force but keeps --trust', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-cursor', resume: false, disableCliBypass: true });
    expect(args).toContain('--trust');
    expect(args).not.toContain('--force');
  });

  it('delivers the opening prompt through argv and enables post-ready type-ahead', () => {
    expect(adapter.passesInitialPromptViaArgs).toBe(true);
    expect(adapter.readyPattern?.test('  → Plan, search, build anything')).toBe(true);
    expect(adapter.deferFirstPromptTimeoutUntilReady).toBe(true);
    expect(adapter.supportsTypeAhead).toBe(true);
  });

  it('readyPattern matches BOTH the empty-session and post-turn composer placeholders', () => {
    // Cursor Agent 2026.08.11 renders `sessionEmpty ? "Plan, search, build
    // anything" : "Add a follow-up"` and never reverts. The worker resets the
    // IdleDetector (clearing readySeen) before every write, and quiescence-idle
    // is suppressed until readyPattern is seen again — so if the pattern only
    // matched the empty-session placeholder, turn 2+ would never re-seed ready
    // and the CLI would be stuck reporting "working" forever. Both must match.
    expect(adapter.readyPattern?.test('  → Plan, search, build anything')).toBe(true);
    expect(adapter.readyPattern?.test('  → Add a follow-up')).toBe(true);
    // Guard against over-broad matching: the arrow-prefixed composer glyph is
    // required, so unrelated screen text with the phrase must not false-match.
    expect(adapter.readyPattern?.test('Plan, search, build anything')).toBe(false);
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

  it('exposes paste-line raw command delivery capability', () => {
    const rawAdapter = createOpenCodeAdapter('/bin/opencode');

    expect(rawAdapter.rawCommandInputMode).toBe('paste-line');
    expect(rawAdapter.rawCommandSettleMs).toEqual(expect.any(Number));
    expect(Number.isFinite(rawAdapter.rawCommandSettleMs)).toBe(true);
    expect(rawAdapter.rawCommandSettleMs).toBeGreaterThan(0);
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
    expect(adapter.maxInitialPromptArgBytes).toBeUndefined();
    expect(adapter.altScreen).toBe(true);
  });

  it('loads the turn-boundary extension on every spawn so mid-turn retries are not read as failures', () => {
    // Pi's `stopReason:"error"` is per-REQUEST and its loop retries inside the
    // same turn, so the transcript alone cannot say when a turn ended. The
    // reader depends on the boundary marker this extension appends — if the
    // flag stops being passed, `pi-transcript` silently falls back to its
    // timeout backstop and every transient blip becomes a late failure card.
    // Asserted here (not only in the reader's own tests) because the policy
    // being right is worthless if the wiring that feeds it is missing.
    const args = adapter.buildArgs({ sessionId: 'sess-pi', resume: false });
    const flagIdx = args.indexOf('--extension');
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(args[flagIdx + 1]).toMatch(/pi-turn-boundary-extension\.(?:js|ts)$/);
    // Absolute: Pi resolves a relative --extension against ITS cwd, which is
    // the user's workspace, not ours.
    expect(isAbsolute(args[flagIdx + 1])).toBe(true);
    // …and the path must really be there. Pi treats an unloadable extension as
    // FATAL (exit 1), so a path we cannot back with a file would kill every Pi
    // session instead of merely losing the marker.
    expect(existsSync(args[flagIdx + 1])).toBe(true);
  });

  it('omits --extension rather than handing Pi a path that does not exist', () => {
    // The compiled binary is the real case: its module graph lives in the
    // virtual `/$bunfs/` root, so both `__dirname`-derived candidates resolve
    // to paths that exist only inside that process. Measured directly against
    // Pi 0.84.4: a missing `--extension` target aborts startup with
    // `Failed to load extension … Extension path does not exist` and exit 1.
    // Losing the boundary marker costs the reader's timeout backstop; a dead
    // Pi costs the whole session — so this must fail OPEN.
    expect(piTurnBoundaryExtensionPath()).toBeTruthy();
    const args = buildPiArgs({ sessionId: 'sess-pi', turnBoundaryExtension: undefined });
    expect(args).not.toContain('--extension');
    expect(args).toEqual(['--session-id', 'sess-pi']);
  });

  it('pins the configured model instead of inheriting Pi defaults', () => {
    const args = adapter.buildArgs({
      sessionId: 'sess-pi',
      resume: false,
      model: 'custom/long-context-model',
    });
    // Exact argv, minus the extension pair asserted by its own case above:
    // keeps this case about the model flag while still proving nothing else
    // crept into the launch line.
    expect(args.slice(2)).toEqual([
      '--session-id', 'sess-pi',
      '--model', 'custom/long-context-model',
    ]);
    expect(args[0]).toBe('--extension');
  });
});

describe('oh-my-pi buildArgs', () => {
  const adapter = createOhMyPiAdapter('/usr/bin/omp');
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-omp-adapter-'));
    vi.stubEnv('HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('launches an isolated omp TUI with runtime-default tools, approval-mode, and no-title', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-omp', resume: false, initialPrompt: 'hello omp' });
    expect(adapter.resolvedBin).toBe('/usr/bin/omp');
    expect(args).not.toContain('--tools');
    expect(args.join(' ')).not.toMatch(/browser|ast_grep/);
    expect(args).toContain('--approval-mode');
    expect(args[args.indexOf('--approval-mode') + 1]).toBe('yolo');
    expect(args).toContain('--no-title');
    expect(args[args.indexOf('--session-dir') + 1]).toBe(ompSessionDir('sess-omp'));
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--continue');
    expect(args).not.toContain('hello omp');
    expect(adapter.passesInitialPromptViaArgs).toBe(false);
    expect(adapter.altScreen).toBe(true);
    expect(adapter.authPaths).toEqual(['~/.omp/agent']);
    expect(adapter.supportsTypeAhead).toBe(true);
    expect(adapter.busyPattern?.test('Working...')).toBe(true);
    expect(adapter.busyPattern?.test('Working…')).toBe(true);
    expect(adapter.mergeQueuedInput).not.toBe(true);
    expect(adapter.reliableTurnTerminal).not.toBe(true);
  });

  it('does not include --session-id (oh-my-pi has none)', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-omp', resume: false });
    expect(args).not.toContain('--session-id');
  });

  it('rejects path-like session ids instead of escaping the managed OMP root', () => {
    expect(() => ompSessionDir('../sibling')).toThrow('Invalid Botmux session id for OMP');
    expect(() => ompSessionDir('nested/session')).toThrow('Invalid Botmux session id for OMP');
  });

  it('uses the canonical home path when HOME is a symlink', () => {
    const realHome = join(home, "real'home");
    const linkedHome = join(home, 'linked-home');
    mkdirSync(realHome);
    symlinkSync(realHome, linkedHome, 'dir');
    vi.stubEnv('HOME', linkedHome);

    const expected = join(realpathSync(realHome), '.omp', 'agent', 'sessions', 'botmux', 'sess-linked');
    expect(ompSessionDir('sess-linked')).toBe(expected);
    const args = adapter.buildArgs({ sessionId: 'sess-linked', resume: false });
    expect(args[args.indexOf('--session-dir') + 1]).toBe(expected);
  });

  it('resumes the newest top-level JSONL exactly and ignores nested transcripts', () => {
    const sessionDir = ompSessionDir('sess-omp');
    const nestedDir = join(sessionDir, 'nested');
    mkdirSync(nestedDir, { recursive: true });
    const older = join(sessionDir, 'older.jsonl');
    const newest = join(sessionDir, 'newest.jsonl');
    const nested = join(nestedDir, 'not-a-candidate.jsonl');
    writeFileSync(older, '{}\n');
    writeFileSync(newest, '{}\n');
    writeFileSync(nested, '{}\n');
    utimesSync(older, new Date(1_000), new Date(1_000));
    utimesSync(newest, new Date(2_000), new Date(2_000));
    utimesSync(nested, new Date(3_000), new Date(3_000));

    const args = adapter.buildArgs({ sessionId: 'sess-omp', resume: true });
    expect(args[args.indexOf('--resume') + 1]).toBe(newest);
    expect(args[args.indexOf('--session-dir') + 1]).toBe(sessionDir);
    expect(args).not.toContain('--continue');
    expect(adapter.checkResumeTargetExists?.({ sessionId: 'sess-omp' })).toBe(true);
    expect(adapter.buildResumeCommand?.({ sessionId: 'sess-omp' }))
      .toBe(`omp --resume '${newest}' --session-dir '${sessionDir}'`);
  });

  it('fails the resume probe closed when the isolated directory has no transcript', () => {
    mkdirSync(ompSessionDir('sess-omp'), { recursive: true });
    expect(adapter.checkResumeTargetExists?.({ sessionId: 'sess-omp' })).toBe(false);
    expect(adapter.buildResumeCommand?.({ sessionId: 'sess-omp' })).toBeNull();
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

  it('keeps its recovery Ctrl+C outside the backend-injected cancel window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T00:00:00.000Z'));
    try {
      const isolatedAdapter = createOhMyPiAdapter('/usr/bin/omp');
      const events: Array<{ key: string; at: number }> = [];
      const backendCancelAt = Date.now();
      const pty = {
        write() {},
        sendText() { return false; },
        sendSpecialKeys(...keys: string[]) {
          events.push({ key: keys.join(','), at: Date.now() });
          return true;
        },
        lastInjectedCancelAt: backendCancelAt,
      } as PtyHandle & { readonly lastInjectedCancelAt: number };

      const write = isolatedAdapter.writeInput(pty, 'ambiguous paste');
      await vi.advanceTimersByTimeAsync(TERMINAL_CANCEL_COOLDOWN_MS - 1);
      expect(events).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      await expect(write).resolves.toEqual({ submitted: false });
      expect(events).toEqual([{
        key: 'C-c',
        at: backendCancelAt + TERMINAL_CANCEL_COOLDOWN_MS,
      }]);
    } finally {
      vi.useRealTimers();
    }
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

describe('ebsd buildArgs', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-ebsd-adapter-'));
    vi.stubEnv('HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('launches the hidden service-mode TUI without OMP yolo or model flags', () => {
    const adapter = createEbsdAdapter('/usr/bin/ebsd');
    const args = adapter.buildArgs({
      sessionId: 'sid-ebsd',
      resume: false,
      model: 'must-not-forward',
      disableCliBypass: false,
    });
    expect(args).toEqual([
      'botmux', '--session-id', 'sid-ebsd', '--auth-mode', 'service',
    ]);
    expect(adapter.inputEnvelope).toBe('service-user');
    expect(adapter.allowExtraArgs).toBe(false);
    expect(adapter.supportsTypeAhead).toBe(false);
    expect(adapter.reliableTurnTerminal).toBe(true);
    expect(adapter.skillsDir).toBeUndefined();
    expect(adapter.spawnEnv).toMatchObject({ EBSD_NO_UPDATE_CHECK: '1' });
    expect(adapter.authPaths).toEqual(['~/.ebsd']);
    const serviceEnv = {
      EBSD_BOTMUX_DIAG_TOKEN_FILE: '/run/secrets/diag',
      EBSD_BOTMUX_BYTECLOUD_ACCESS_KEY_FILE: '/run/secrets/ak',
      EBSD_BOTMUX_BYTECLOUD_SECRET_KEY_FILE: '/run/secrets/sk',
      EBSD_BOTMUX_REPOSITORY_ROOT: '/srv/repos',
    };
    expect(adapter.sandboxReadonlyPaths?.(serviceEnv)).toEqual(['/srv/repos']);
    expect(adapter.sandboxSecretReadonlyPaths?.(serviceEnv)).toEqual([
      '/run/secrets/diag',
      '/run/secrets/ak',
      '/run/secrets/sk',
    ]);
  });

  it('resumes only an exact transcript and rejects escaping ids', () => {
    const adapter = createEbsdAdapter('/usr/bin/ebsd');
    const dir = ebsdBotmuxSessionDir('sid-ebsd');
    mkdirSync(dir, { recursive: true });
    const transcript = join(dir, 'session.jsonl');
    writeFileSync(transcript, '{}\n');
    expect(adapter.checkResumeTargetExists?.({ sessionId: 'sid-ebsd' })).toBe(true);
    expect(adapter.buildArgs({ sessionId: 'sid-ebsd', resume: true })).toEqual([
      'botmux', '--session-id', 'sid-ebsd', '--auth-mode', 'service', '--resume',
    ]);
    expect(() => adapter.buildArgs({ sessionId: '../sibling', resume: false })).toThrow(
      'Invalid BotMux session id for ebsd',
    );
    expect(() => adapter.buildArgs({ sessionId: 'x'.repeat(256), resume: false })).toThrow(
      'Invalid BotMux session id for ebsd',
    );
  });

  it('rejects per-bot HOME overrides that would split worker and child session roots', () => {
    expect(() => assertEbsdPerBotEnv({ HOME: '/tmp/other-home' })).toThrow(
      'ebsd does not allow a per-bot HOME override',
    );
    expect(() => assertEbsdPerBotEnv({ HTTPS_PROXY: 'http://proxy.invalid' })).not.toThrow();
  });

  it('does not retry or cancel an unconfirmed Enter', async () => {
    const adapter = createEbsdAdapter('/usr/bin/ebsd');
    const sendSpecialKeys = vi.fn(() => false);
    const pty: PtyHandle = {
      write: vi.fn(() => true),
      sendText: vi.fn(() => true),
      sendSpecialKeys,
    };

    const result = await adapter.writeInput?.(pty, 'diagnose');

    expect(result).toMatchObject({ submitted: false });
    expect(sendSpecialKeys.mock.calls).toEqual([['Enter']]);
  });

  it('does not promote a rejected direct PTY write to success', async () => {
    const adapter = createEbsdAdapter('/usr/bin/ebsd');
    const write = vi.fn(() => false);

    const result = await adapter.writeInput?.({ write }, 'diagnose');

    expect(result).toMatchObject({ submitted: false });
    expect(write).not.toHaveReturnedWith(true);
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

  it('resume session prefers persisted Hermes native session id', () => {
    const args = adapter.buildArgs({
      sessionId: 'bm-hermes-1',
      resume: true,
      resumeSessionId: '20260716_163643_7782fd',
    });
    expect(args).toEqual(['--resume', '20260716_163643_7782fd', '--yolo', '--accept-hooks', '--pass-session-id']);
  });

  it('buildResumeCommand prefers persisted Hermes native session id', () => {
    expect(adapter.buildResumeCommand?.({
      sessionId: 'bm-hermes-1',
      cliSessionId: '20260716_163643_7782fd',
    })).toBe('hermes --resume 20260716_163643_7782fd');
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

  it('relies on ❯ readyPattern without ready-gate or type-ahead', () => {
    // #353 armed the ready-gate via injectsReadyHook on the premise that Hermes
    // shell-executes BOTMUX_READY_COMMAND at composer-ready. The shipped Hermes
    // never honored that contract (no composer-ready hook exists), so the gate
    // always fell through its 45s timeout, delaying the first cold-start message.
    // Hermes must NOT arm the gate; its ❯ readyPattern (input box up in ~3.6s) is
    // the earliest reliable readiness signal.
    expect(adapter.injectsReadyHook).toBeFalsy();
    expect(adapter.readyPattern?.source).toBe('❯');
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

describe('busyPattern', () => {
  it('codex matches the active Working status but not idle or single-anchor text', () => {
    const busy = createCodexAdapter('/bin/codex').busyPattern;
    expect(busy).toBeDefined();
    expect(busy!.test('• Working (18s • esc to interrupt)')).toBe(true);
    expect(busy!.test('› Ask anything                                      97% left')).toBe(false);
    expect(busy!.test('Working through the implementation')).toBe(false);
    expect(busy!.test('press esc to interrupt')).toBe(false);
  });

  it('traex matches spinner-anchored working labels and standalone queue strings but not prose or idle composer', () => {
    // Regression: a static capacity-queue screen matches readyPattern's
    // `\d+% left` status-bar arm and survives the 2s quiescence window,
    // flipping the card/Dashboard to Idle while the session is still waiting
    // for capacity. The busyPattern must cover both the queue screen and the
    // normal working indicator so the worker's deferPromptReadyWhileBusy
    // backstop (and its idle probe) holds the session busy until a real
    // terminal state.
    //
    // Every anchor below is extracted verbatim from the traex binary's
    // compiled-in TUI string tables (verified across all 9 local releases,
    // 0.201.1-alpha.5 … 0.201.2-alpha.2, both `traex` and
    // `traex-code-mode-host`):
    //   spinner frames:  "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
    //   working labels:  "Working…", "Thinking…", "Pondering…",
    //                    "Working it out…" (full rotation in traex.ts)
    //   queue strings:   "Queued for capacity",
    //                    "Too many requests right now. You're in the queue."
    //   idle composer:   "Ask TraeCode CLI to do anything" + "100% context left"
    // TraeX forked from Codex and DELETED the "esc to interrupt" footer hint
    // (0 hits across all releases + the 94MB TUI logs), so the Codex
    // pattern's second anchor is invalid here.
    const busy = createTraexAdapter('/bin/traex').busyPattern;
    expect(busy).toBeDefined();
    // Spinner-anchored working labels: "<braille frame> <label>".
    expect(busy!.test('⠋ Working…')).toBe(true);
    expect(busy!.test('⠹ Thinking…')).toBe(true);
    expect(busy!.test('⠸ Pondering…')).toBe(true);
    expect(busy!.test('⠼ Working it out…')).toBe(true);
    // Spinner-prefixed queue state: the queue screen can render a frozen
    // braille frame in front of the label, and the label is part of the
    // compiled-in spinner string table.
    expect(busy!.test('⠋ Queued for capacity')).toBe(true);
    // Standalone capacity-queue strings — the queue screen may render
    // statically (no animating spinner), so no frame anchor is required.
    // Line-anchored: bare line, indented line, and `at position N` suffix
    // all match.
    expect(busy!.test('Queued for capacity')).toBe(true);
    expect(busy!.test('  Queued for capacity')).toBe(true);
    expect(busy!.test('Queued for capacity at position 3.')).toBe(true);
    expect(busy!.test("Too many requests right now. You're in the queue.")).toBe(true);
    expect(busy!.test("Too many requests right now. You're in the queue at position 3.")).toBe(true);
    // Mid-sentence prose quotes must NOT match — the line anchor is the
    // discriminator for the standalone arms (the braille frame for the
    // spinner arms).
    expect(busy!.test('The status line says Queued for capacity right now')).toBe(false);
    expect(busy!.test("It printed Too many requests right now. You're in the queue. and stopped")).toBe(false);
    // Idle composer must NOT match.
    expect(busy!.test('› Ask TraeCode CLI to do anything                        100% context left')).toBe(false);
    // Prose must NOT match — the braille frame anchor is the discriminator.
    expect(busy!.test('Working… on the fix')).toBe(false);
    expect(busy!.test('Working through the implementation')).toBe(false);
    expect(busy!.test('press esc to interrupt')).toBe(false);
  });

  it('traex staticBusyPattern latches only on line-anchored queue evidence', () => {
    // The pre-idle static latch (ZMX gap) consumes queue evidence straight
    // from the PTY byte stream — see TRAEX_STATIC_BUSY_PATTERN in traex.ts.
    // It must match every queue-screen shape (bare / indented / spinner-
    // prefixed / at-position suffix / ANSI-stripped by IdleDetector) and
    // must NOT match prose quotes or the idle composer.
    const staticBusy = createTraexAdapter('/bin/traex').staticBusyPattern;
    expect(staticBusy).toBeDefined();
    expect(staticBusy!.test('Queued for capacity')).toBe(true);
    expect(staticBusy!.test('  Queued for capacity')).toBe(true);
    expect(staticBusy!.test('Queued for capacity at position 3.')).toBe(true);
    expect(staticBusy!.test('⠋ Queued for capacity')).toBe(true);
    expect(staticBusy!.test("Too many requests right now. You're in the queue.")).toBe(true);
    expect(staticBusy!.test("Too many requests right now. You're in the queue at position 3.")).toBe(true);
    // Mid-sentence prose quotes must NOT latch.
    expect(staticBusy!.test('The status line says Queued for capacity right now')).toBe(false);
    expect(staticBusy!.test("It printed Too many requests right now. You're in the queue. and stopped")).toBe(false);
    // Idle composer must NOT latch.
    expect(staticBusy!.test('› Ask TraeCode CLI to do anything                        100% context left')).toBe(false);
    // Working labels without the queue string must NOT latch — the latch is
    // queue-only; ordinary working turns are covered by the spinner guard.
    expect(staticBusy!.test('⠋ Working…')).toBe(false);
  });
});

describe('idleToBusyPattern', () => {
  it('codex explicitly opts into idle→busy recovery with the strict active marker', () => {
    const adapter = createCodexAdapter('/bin/codex');
    const busy = adapter.idleToBusyPattern;
    expect(busy).toBeDefined();
    expect(busy!.test('• Working (18s • esc to interrupt)')).toBe(true);
    expect(busy!.test('Working through the implementation')).toBe(false);
  });

  it('pi opts in with the same Working... marker as its busyPattern', () => {
    // Pi's `Working...` is an ephemeral status line (never part of transcript
    // history redraws), so idle→busy recovery is safe: a falsely published
    // ready self-heals when the marker renders again.
    const adapter = createPiAdapter('/bin/pi');
    expect(adapter.idleToBusyPattern).toBeDefined();
    expect(adapter.idleToBusyPattern!.source).toBe(adapter.busyPattern!.source);
    expect(adapter.idleToBusyPattern!.test('● Working... (esc to interrupt)')).toBe(true);
    expect(adapter.idleToBusyPattern!.test('Working through the implementation')).toBe(false);
  });

  it('traex opts into idle→busy recovery with the same strict active marker as busyPattern', () => {
    // The capacity-queue screen can render AFTER a false idle was already
    // published (readyPattern's `\d+% left` arm matched the status bar and
    // quiescence fired). idleToBusyPattern must flip the session back to
    // working when the queue marker or a working spinner label appears in
    // the PTY stream. Strings are the same binary-extracted anchors as the
    // busyPattern test above.
    const adapter = createTraexAdapter('/bin/traex');
    expect(adapter.idleToBusyPattern).toBeDefined();
    expect(adapter.idleToBusyPattern!.source).toBe(adapter.busyPattern!.source);
    // Spinner-anchored working labels.
    expect(adapter.idleToBusyPattern!.test('⠋ Working…')).toBe(true);
    expect(adapter.idleToBusyPattern!.test('⠙ Pondering…')).toBe(true);
    // Standalone queue strings.
    expect(adapter.idleToBusyPattern!.test('Queued for capacity')).toBe(true);
    expect(adapter.idleToBusyPattern!.test("Too many requests right now. You're in the queue.")).toBe(true);
    // Prose without the braille frame anchor must NOT flip idle→busy.
    expect(adapter.idleToBusyPattern!.test('Working… on the fix')).toBe(false);
  });

  it.each([
    ['genius', createGeniusAdapter('/bin/genius')],
    ['grok', createGrokAdapter('/bin/grok')],
  ])('%s keeps legacy busyPattern semantics and does not opt in', (_name, adapter) => {
    expect(adapter.idleToBusyPattern).toBeUndefined();
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

  it('codex defers the first-prompt timeout until its readyPattern appears', () => {
    // Codex can cold-start slower than the worker's 15s soft timeout; keep the
    // first Lark message queued until the composer is visible.
    const adapter = createCodexAdapter('/bin/codex');
    expect(adapter.deferFirstPromptTimeoutUntilReady).toBe(true);
    expect(adapter.supportsTypeAhead).toBe(true);
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

describe('traex automation trust flags', () => {
  it('injects structured reasoning effort as a TraeX launch config', () => {
    const args = createTraexAdapter('/bin/traex').buildArgs({
      sessionId: 'traex-effort',
      resume: false,
      reasoningEffort: 'medium',
    });
    const i = args.indexOf('model_reasoning_effort="medium"');
    expect(i).toBeGreaterThan(0);
    expect(args[i - 1]).toBe('-c');
  });

  it('omits the reasoning effort launch config when none is configured', () => {
    const args = createTraexAdapter('/bin/traex').buildArgs({ sessionId: 'traex-effort', resume: false });
    expect(args.join(' ')).not.toContain('model_reasoning_effort');
  });

  it('bypasses both permission and hook-review gates for automation when the hook-trust toggle is on', () => {
    const args = createTraexAdapter('/bin/traex').buildArgs({ sessionId: 'traex-goal', resume: false, bypassHookTrust: true });
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).toContain('--dangerously-bypass-hook-trust');
  });

  it('keeps the approval bypass but drops hook-trust when the global toggle is off', () => {
    const args = createTraexAdapter('/bin/traex').buildArgs({ sessionId: 'traex-goal', resume: false, bypassHookTrust: false });
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--dangerously-bypass-hook-trust');
  });

  it('does not bypass permissions or hook trust for a restricted bot', () => {
    const args = createTraexAdapter('/bin/traex').buildArgs({
      sessionId: 'traex-goal',
      resume: false,
      disableCliBypass: true,
      bypassHookTrust: true, // even with the toggle on, disableCliBypass wins
    });
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--dangerously-bypass-hook-trust');
  });

  it('forwards only the file-backed goal contract into TRAE shell tools', () => {
    vi.stubEnv('BOTMUX_GOAL_PATH', '/tmp/goal "quoted".txt');
    vi.stubEnv('BOTMUX_GOAL_MANIFEST_PATH', '/tmp/manifest.json');
    vi.stubEnv('BOTMUX_V3_GOAL', '1');
    try {
      const args = createTraexAdapter('/bin/traex').buildArgs({ sessionId: 'traex-goal', resume: false });
      expect(args).toContain('shell_environment_policy.set.BOTMUX_GOAL_PATH="/tmp/goal \\"quoted\\".txt"');
      expect(args).toContain('shell_environment_policy.set.BOTMUX_GOAL_MANIFEST_PATH="/tmp/manifest.json"');
      expect(args).toContain('shell_environment_policy.set.BOTMUX_V3_GOAL="1"');
      expect(args).not.toContain('shell_environment_policy.inherit="all"');
    } finally {
      vi.unstubAllEnvs();
    }
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
    ['reasonix', () => createReasonixAdapter('/bin/reasonix')],
  ];

  it.each(nonClaudeAdapters)('%s systemHints include botmux send routing guidance', (_name, factory) => {
    const hints = factory().systemHints;
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.some(h => h.includes('botmux send'))).toBe(true);
  });

  it('traex systemHints declare the exact nothing-to-send protocol', () => {
    expect(createTraexAdapter('/bin/traex').systemHints.join('\n')).toContain('BOTMUX_NOTHING_TO_SEND');
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
    ['reasonix', () => createReasonixAdapter('/bin/reasonix')],
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

  it('reasonix uses alt screen (bubbletea TUI)', () => {
    expect(createReasonixAdapter('/bin/reasonix').altScreen).toBe(true);
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

  it('hermes emits `hermes --resume <cliSessionId>` when known', () => {
    const a = createHermesAdapter('/bin/hermes');
    expect(a.buildResumeCommand?.({ sessionId: 'bm-hermes', cliSessionId: 'ignored' }))
      .toBe('hermes --resume ignored');
    expect(a.buildResumeCommand?.({ sessionId: 'bm-hermes' }))
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

  it('oh-my-pi returns null when its isolated exact transcript is absent', () => {
    const a = createOhMyPiAdapter('/bin/omp');
    expect(a.buildResumeCommand?.({ sessionId: randomUUID(), cliSessionId: 'ignored' }))
      .toBeNull();
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

describe('native session rename capability', () => {
  it('is declared only by the verified Codex, Claude Code, and Grok adapters', () => {
    expect(createCodexAdapter('/bin/codex').buildSessionRenameCommand?.('新的标题'))
      .toBe('/rename 新的标题');
    expect(createClaudeCodeAdapter('/bin/claude').buildSessionRenameCommand?.('new title'))
      .toBe('/rename new title');
    expect(createGrokAdapter('/usr/bin/grok').buildSessionRenameCommand?.('新标题'))
      .toBe('/rename 新标题');

    expect(createCliAdapterSync('seed', '/bin/true').buildSessionRenameCommand).toBeUndefined();
    expect(createCodexAppAdapter('/bin/codex').buildSessionRenameCommand).toBeUndefined();
    expect(createCocoAdapter('/bin/coco').buildSessionRenameCommand).toBeUndefined();
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

  it('starts fresh when resume=true but no sessionId is available (never --continue)', () => {
    // Defense-in-depth: sessionId is normally the non-empty botmux UUID, but
    // if it is ever missing, --continue would resume the globally most recent
    // grok session — shared across botmux sessions of this bot — and leak a
    // sibling session's context. Start fresh instead.
    const args = adapter.buildArgs({ sessionId: '', resume: true });
    expect(args).not.toContain('--continue');
    expect(args).not.toContain('--resume');
  });

  it('carves out GROK_HOME (directory-level: SQLite under sessions/) and resolves skills/hooks under it', () => {
    expect(adapter.authPaths).toEqual([GROK_TEST_HOME]);
    expect(adapter.skillsDir).toBe(join(GROK_TEST_HOME, 'skills'));
    expect(adapter.hookInstall?.configPath).toBe(join(GROK_TEST_HOME, 'hooks', 'botmux-session-ready.json'));
  });

  it('surfaces curated model choices for setup', () => {
    expect(adapter.modelChoices).toEqual(['grok-4.6', 'grok-4.5']);
  });

  it('passes --reasoning-effort when configured', () => {
    const args = adapter.buildArgs({
      sessionId: sid,
      resume: false,
      model: 'grok-4.6',
      reasoningEffort: 'high',
    });
    expect(args.slice(0, 8)).toEqual([
      '--always-approve', '--no-plan',
      '--model', 'grok-4.6',
      '--reasoning-effort', 'high',
      '--session-id', sid,
    ]);
  });

  it('forks with --resume, --fork-session, and the child --session-id', () => {
    const childId = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const args = adapter.buildArgs({
      sessionId: childId,
      resume: true,
      resumeSessionId: sid,
      forkSession: true,
      reasoningEffort: 'medium',
    });
    expect(args.slice(0, 9)).toEqual([
      '--always-approve', '--no-plan',
      '--reasoning-effort', 'medium',
      '--resume', sid,
      '--fork-session',
      '--session-id', childId,
    ]);
  });

  it('does not fork a plain resume', () => {
    const args = adapter.buildArgs({
      sessionId: 'child',
      resume: true,
      resumeSessionId: 'source',
      forkSession: false,
    });
    expect(args.includes('--fork-session')).toBe(false);
    expect(args.includes('--session-id')).toBe(false);
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

  it('writeInput does not send a second Enter when history is delayed', async () => {
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
      },
    } satisfies PtyHandle;

    // First Enter already accepted; history shows up after the old 800ms
    // retry window (8ms scaled) but inside the 4s poll budget (40ms scaled).
    const late = setTimeout(() => {
      appendFileSync(historyPath, JSON.stringify({
        timestamp: '2026-07-12T10:00:00Z', session_id: grokMintedSid, prompt: 'once only', is_bash: false,
      }) + '\n');
    }, 20);

    try {
      const result = await adapter.writeInput(pty, 'once only');
      expect(result).toEqual({ submitted: true, cliSessionId: grokMintedSid });
    } finally {
      clearTimeout(late);
    }
    expect(events.filter((e) => e.startsWith('text:'))).toEqual(['text:once only']);
    expect(events.filter((e) => e === 'keys:Enter')).toEqual(['keys:Enter']);
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

    const events: string[] = [];
    const pty = {
      write() {},
      cliCwd: cwd,
      sendText() { events.push('text'); },
      sendSpecialKeys(...keys: string[]) { events.push(`keys:${keys.join(',')}`); },
    } satisfies PtyHandle;

    const result = await adapter.writeInput(pty, 'never lands');
    expect(result).toMatchObject({ submitted: false });
    expect(events.filter((e) => e === 'keys:Enter')).toEqual(['keys:Enter']);
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

  it('starts fresh when no resumeSessionId is available (never --continue)', () => {
    // --continue would resume the most recent Kimi session, which is shared
    // across every botmux session of this bot — a worker restart whose
    // cliSessionId was never captured would then load a SIBLING session's
    // conversation (topic-group context leaking into a private chat). Start
    // fresh instead, matching reasonix/antigravity.
    const args = adapter.buildArgs({ sessionId: 'sess-1', resume: true });
    expect(args).not.toContain('--continue');
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

// Regression: 话题群会话 A 的上下文偶发串到私聊会话 B。根因是 cursor / copilot /
// kimi 三个适配器在 resume=true 但 resumeSessionId 缺失（worker 重启时 cliSessionId
// 从未持久化）时回退到 `--continue`，而 `--continue` 恢复的是「全局最近会话」——
// 同一 bot 的多个 botmux 会话共享同一个 CLI 配置目录，于是 B 的 worker 可能把 A 的
// 会话加载进自己的上下文。reasonix / antigravity 已明确拒绝 `--continue`
//（"most recent is racy when multiple botmux sessions run in parallel"），
// 这三个适配器必须对齐：缺 id 时宁可新起干净会话，也不串用兄弟会话的上下文。
describe('resume without cliSessionId — cross-session isolation (cursor / copilot / kimi)', () => {
  const adapters = [
    { name: 'cursor', factory: () => createCursorAdapter('/usr/bin/cursor-agent') },
    { name: 'copilot', factory: () => createCopilotAdapter('/usr/bin/copilot') },
    { name: 'kimi', factory: () => createKimiAdapter('/usr/bin/kimi') },
  ] as const;

  for (const { name, factory } of adapters) {
    it(`${name}: resume=true without resumeSessionId starts a fresh session (no --continue, no --resume)`, () => {
      const adapter = factory();
      // Simulates the reported bug: session B (private chat) worker restarts
      // with resume=true but its cliSessionId was never persisted (crash
      // before capture / observation failed). The args must NOT contain
      // --continue, which would resume the globally most recent conversation
      // — potentially session A's (topic group) context.
      const args = adapter.buildArgs({ sessionId: 'bm-session-b', resume: true });
      expect(args).not.toContain('--continue');
      expect(args).not.toContain('--resume');
    });

    it(`${name}: resume=true WITH resumeSessionId still resumes the exact session`, () => {
      const adapter = factory();
      const args = adapter.buildArgs({
        sessionId: 'bm-session-b',
        resume: true,
        resumeSessionId: 'cli-session-b',
      });
      expect(args).toContain('--resume');
      expect(args[args.indexOf('--resume') + 1]).toBe('cli-session-b');
      expect(args).not.toContain('--continue');
    });

    it(`${name}: fresh spawn (resume=false) is unaffected`, () => {
      const adapter = factory();
      const args = adapter.buildArgs({ sessionId: 'bm-session-b', resume: false });
      expect(args).not.toContain('--continue');
      expect(args).not.toContain('--resume');
    });
  }
});

// Regression: the worker / closed card / resume receipt must be able to tell
// "resume will restore history" from "resume starts a fresh session" apart.
// Adapters whose buildArgs can only resume a PRECISE cliSessionId (no
// --continue/latest fallback) declare `resumeRequiresCliSessionId`; the worker
// demotes resume-without-id to a fresh launch + user notice, and the card
// copy stops claiming history is back.
describe('resumeRequiresCliSessionId capability', () => {
  it('cursor / copilot / kimi declare the capability (resume without an id starts fresh)', () => {
    expect(createCursorAdapter('/usr/bin/cursor-agent').resumeRequiresCliSessionId).toBe(true);
    expect(createCopilotAdapter('/usr/bin/copilot').resumeRequiresCliSessionId).toBe(true);
    expect(createKimiAdapter('/usr/bin/kimi').resumeRequiresCliSessionId).toBe(true);
  });

  it('adapters whose botmux sessionId IS the CLI session id do not declare it', () => {
    // claude-code / grok resume `resumeSessionId ?? sessionId` — a precise id
    // is always available, so no demotion is needed.
    expect(createClaudeCodeAdapter('/usr/bin/claude').resumeRequiresCliSessionId).toBeUndefined();
    expect(createGrokAdapter('/usr/bin/grok').resumeRequiresCliSessionId).toBeUndefined();
  });

  it('adapters that ignore resume entirely do not declare it', () => {
    // gemini always starts fresh regardless — but its resume story is "no
    // resume at all", not "resume requires an id"; keep it out of the demotion
    // path so its existing card copy is unchanged.
    expect(createGeminiAdapter('/usr/bin/gemini').resumeRequiresCliSessionId).toBeUndefined();
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

describe('reasonix buildArgs', () => {
  const adapter = createReasonixAdapter('/usr/bin/reasonix');

  it('starts a fresh interactive session with --yolo by default', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-rx', resume: false });
    expect(args).toEqual(['--yolo']);
  });

  it('omits --yolo when disableCliBypass is true', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-rx', resume: false, disableCliBypass: true });
    expect(args).toEqual([]);
  });

  it('injects --model when provided', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-rx', resume: false, model: 'deepseek-flash/deepseek-v4-flash' });
    expect(args).toEqual(['--yolo', '--model', 'deepseek-flash/deepseek-v4-flash']);
  });

  it('resumes a specific session id when available', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-rx', resume: true, resumeSessionId: 'rx-native-session' });
    expect(args).toEqual(['--yolo', '--resume', 'rx-native-session']);
    expect(adapter.buildResumeCommand?.({ sessionId: 'sess-rx', cliSessionId: 'rx-native-session' }))
      .toBe('reasonix --resume rx-native-session');
  });

  it('starts clean and re-arms capture when resume lacks a precise id', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-rx', resume: true });
    expect(args).toEqual(['--yolo']);
    expect(adapter.buildResumeCommand?.({ sessionId: 'sess-rx' })).toBeNull();
  });

  it('keeps the initial prompt on stdin (interactive mode has no prompt flag)', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-rx', resume: false, initialPrompt: 'hello reasonix' });
    expect(args).not.toContain('hello reasonix');
    expect(adapter.passesInitialPromptViaArgs).toBeFalsy();
  });

  it('relies on quiescence without a ready pattern', () => {
    expect(adapter.readyPattern).toBeUndefined();
    expect(adapter.deferFirstPromptTimeoutUntilReady).toBeUndefined();
  });

  it('binds the Reasonix state and skills root', () => {
    expect(adapter.authPaths).toEqual(['~/.reasonix']);
    expect(adapter.skillsDir).toBe('~/.reasonix/skills');
  });

  it('does not capture on resume spawns (id already persisted)', async () => {
    const { execFile } = await import('node:child_process');
    const mockedExec = vi.mocked(execFile);
    mockedExec.mockClear();
    const adapter = createReasonixAdapter('/usr/bin/reasonix');
    adapter.buildArgs({ sessionId: 'sess-rx', resume: true, resumeSessionId: 'session_known' });
    const pty = {
      sendText: vi.fn(),
      sendSpecialKeys: vi.fn(),
      cliCwd: '/work/proj',
      cliPid: 12345,
    } as unknown as PtyHandle;
    const result = await adapter.writeInput(pty, 'hello');
    expect(result).toBeUndefined();
    expect(mockedExec).not.toHaveBeenCalled();
  });
});

describe('traex/coco sandbox authPaths', () => {
  it('traex keeps ~/.trae/cli real (RW SQLite state) and exposes migration markers READ-ONLY (not the whole ~/.trae)', () => {
    // authPaths (readWrite) stays scoped to cli/ — widening to the whole ~/.trae
    // would give a chat-driven sandbox RW to sibling hooks/plugins/skills/config
    // that other bots execute. The first-run "Legacy TRAE CLI data detected"
    // migration prompt (which wedges goal-mode's human-less PTY) is instead
    // silenced by exposing the done-markers READ-ONLY via sandboxReadonlyPaths.
    const adapter = createTraexAdapter('/bin/traex');
    expect(adapter.authPaths).toEqual(['~/.trae/cli']);
    expect(adapter.sandboxReadonlyPaths?.()).toEqual([
      '~/.trae/.coco-rollouts-migrated',
      '~/.trae/.coco-migrated',
    ]);
  });

  it('coco keeps ~/.trae/cli + ~/.cache/coco real (RW) and exposes the same migration markers READ-ONLY', () => {
    // Coco runs the same traecli binary as traex → same migration prompt; markers
    // exposed read-only, authPaths NOT widened past cli/ (+ the coco cache the
    // transcript bridge reads).
    const adapter = createCocoAdapter('/bin/coco');
    expect(adapter.authPaths).toEqual(['~/.trae/cli', '~/.cache/coco']);
    expect(adapter.sandboxReadonlyPaths?.()).toEqual([
      '~/.trae/.coco-rollouts-migrated',
      '~/.trae/.coco-migrated',
    ]);
  });
});
