/**
 * Unit tests for `botmux create-group` bot ref resolver.
 *
 * Pure function — no I/O involved. Tests cover:
 *  - larkAppId direct match
 *  - botName case-insensitive match
 *  - cliId fallback when botName is unknown (fresh CLI, no bots-info.json yet)
 *  - same name in multiple configs → pick first in bots.json order + warning
 *  - duplicate refs → dedup, keep first occurrence
 *  - unresolvable refs → reported in `invalid`
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  globalConfigPath,
  invalidateGlobalConfigCache,
  readRawGroupOwnerNotice,
  setGroupOwnerNoticeEnabled,
} from '../src/global-config.js';
import { config } from '../src/config.js';
import {
  createGroupCompletionStatus,
  parseCreateGroupCliArgs,
  parseOwnerNoticeCommand,
  runOwnerNoticeCommand,
  type OwnerNoticeCommandDeps,
  resolveBotRefs,
  resolveChatMode,
  resolveKickoff,
  shouldWriteCreateGroupCompletionStatus,
} from '../src/cli/create-group-resolver.js';

const CFG_CLAUDE = { larkAppId: 'cli_claude_1', cliId: 'claude-code' };
const CFG_COCO_1 = { larkAppId: 'cli_coco_1', cliId: 'claude-code' };
const CFG_COCO_2 = { larkAppId: 'cli_coco_2', cliId: 'claude-code' };
const CFG_CODEX = { larkAppId: 'cli_codex_1', cliId: 'codex' };

const INFO_CLAUDE = { larkAppId: 'cli_claude_1', botName: 'Claude' };
const INFO_COCO_1 = { larkAppId: 'cli_coco_1', botName: 'CoCo' };
const INFO_COCO_2 = { larkAppId: 'cli_coco_2', botName: 'CoCo' };
const INFO_CODEX = { larkAppId: 'cli_codex_1', botName: 'Codex' };

describe('resolveBotRefs', () => {
  it('resolves a single bot by botName', () => {
    const r = resolveBotRefs(['Claude'], [CFG_CLAUDE, CFG_CODEX], [INFO_CLAUDE, INFO_CODEX]);
    expect(r.larkAppIds).toEqual(['cli_claude_1']);
    expect(r.invalid).toEqual([]);
    expect(r.ambiguousWarnings).toEqual([]);
  });

  it('resolves botName case-insensitively', () => {
    const r = resolveBotRefs(['claude', 'CODEX'], [CFG_CLAUDE, CFG_CODEX], [INFO_CLAUDE, INFO_CODEX]);
    expect(r.larkAppIds).toEqual(['cli_claude_1', 'cli_codex_1']);
  });

  it.each([42, {}, true])('ignores a truthy non-string botName before a valid match: %j', botName => {
    const r = resolveBotRefs(
      ['Codex'],
      [CFG_CODEX],
      [{ larkAppId: 'cli_malformed', botName }, INFO_CODEX],
    );
    expect(r.larkAppIds).toEqual(['cli_codex_1']);
    expect(r.invalid).toEqual([]);
  });

  it('ignores null and scalar registry rows before a valid match', () => {
    const r = resolveBotRefs(
      ['Codex'],
      [CFG_CODEX],
      [null, 42, 'x', INFO_CODEX],
    );
    expect(r.larkAppIds).toEqual(['cli_codex_1']);
  });

  it('resolves multiple bots preserving input order', () => {
    const r = resolveBotRefs(['CoCo', 'Claude'], [CFG_COCO_1, CFG_CLAUDE], [INFO_COCO_1, INFO_CLAUDE]);
    expect(r.larkAppIds).toEqual(['cli_coco_1', 'cli_claude_1']);
  });

  it('resolves by exact larkAppId', () => {
    const r = resolveBotRefs(['cli_coco_2'], [CFG_COCO_1, CFG_COCO_2], [INFO_COCO_1, INFO_COCO_2]);
    expect(r.larkAppIds).toEqual(['cli_coco_2']);
  });

  it('falls back to cliId when botName is unknown', () => {
    const r = resolveBotRefs(['codex'], [CFG_CODEX], []);
    expect(r.larkAppIds).toEqual(['cli_codex_1']);
  });

  it('picks first match in bots.json order when botName is ambiguous + emits warning', () => {
    const r = resolveBotRefs(
      ['CoCo'],
      [CFG_COCO_1, CFG_COCO_2],
      [INFO_COCO_1, INFO_COCO_2],
    );
    expect(r.larkAppIds).toEqual(['cli_coco_1']);
    expect(r.ambiguousWarnings).toHaveLength(1);
    expect(r.ambiguousWarnings[0]).toContain('CoCo');
    expect(r.ambiguousWarnings[0]).toContain('cli_coco_1');
  });

  it('honors botConfigs order even when bots-info.json order is reversed', () => {
    // Regression for Codex blocker: bots-info.json is merge-written by multiple
    // daemons, so its entry order is NOT bots.json order. The resolver MUST
    // walk botConfigs (= bots.json deployment order) when picking among
    // name-matched entries, not the bots-info iteration order.
    const r = resolveBotRefs(
      ['CoCo'],
      [CFG_COCO_1, CFG_COCO_2],           // bots.json order: 1, 2
      [INFO_COCO_2, INFO_COCO_1],         // bots-info.json order: 2, 1 (reversed)
    );
    expect(r.larkAppIds).toEqual(['cli_coco_1']);  // still picks bots.json[0]
    expect(r.ambiguousWarnings[0]).toContain('cli_coco_1');
  });

  it('dedups duplicate refs preserving first occurrence', () => {
    const r = resolveBotRefs(
      ['Claude', 'CoCo', 'claude', 'cli_coco_1'],
      [CFG_CLAUDE, CFG_COCO_1],
      [INFO_CLAUDE, INFO_COCO_1],
    );
    expect(r.larkAppIds).toEqual(['cli_claude_1', 'cli_coco_1']);
  });

  it('reports unresolvable refs in `invalid`', () => {
    const r = resolveBotRefs(
      ['Claude', 'NotABot'],
      [CFG_CLAUDE],
      [INFO_CLAUDE],
    );
    expect(r.larkAppIds).toEqual(['cli_claude_1']);
    expect(r.invalid).toEqual(['NotABot']);
  });

  it('returns empty larkAppIds when no ref resolves', () => {
    const r = resolveBotRefs(['Ghost'], [CFG_CLAUDE], [INFO_CLAUDE]);
    expect(r.larkAppIds).toEqual([]);
    expect(r.invalid).toEqual(['Ghost']);
  });

  it('ignores empty/whitespace refs', () => {
    const r = resolveBotRefs(['', '  ', 'Claude'], [CFG_CLAUDE], [INFO_CLAUDE]);
    expect(r.larkAppIds).toEqual(['cli_claude_1']);
    expect(r.invalid).toEqual([]);
  });

  it('prefers larkAppId over name even when both could match', () => {
    // If a bot's larkAppId happens to also be a name (silly case), exact appId wins
    const r = resolveBotRefs(['cli_claude_1'], [CFG_CLAUDE], [INFO_CLAUDE]);
    expect(r.larkAppIds).toEqual(['cli_claude_1']);
    expect(r.ambiguousWarnings).toEqual([]);
  });
});

describe('resolveChatMode', () => {
  it('omits chatMode when the flag is absent or blank', () => {
    expect(resolveChatMode(undefined)).toEqual({ ok: true });
    expect(resolveChatMode('')).toEqual({ ok: true });
    expect(resolveChatMode('   ')).toEqual({ ok: true });
  });

  it('accepts group and topic, trimming and lowercasing', () => {
    expect(resolveChatMode('group')).toEqual({ ok: true, chatMode: 'group' });
    expect(resolveChatMode('topic')).toEqual({ ok: true, chatMode: 'topic' });
    expect(resolveChatMode('  TOPIC ')).toEqual({ ok: true, chatMode: 'topic' });
  });

  it('rejects any other value (including p2p, which is not a creatable group)', () => {
    for (const bad of ['p2p', 'thread', 'Topic Group', '话题']) {
      const r = resolveChatMode(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('--chat-mode');
    }
  });
});

describe('parseOwnerNoticeCommand', () => {
  it('leaves ordinary create-group calls alone, wherever the word appears later', () => {
    for (const rest of [
      [],
      ['--bot', 'Review', '--name', 'PR 42'],
      ['--bot', 'owner-notice'],
      ['--name', 'owner-notice', '--bot', 'Review'],
      ['--team', 't1', '--agent', 'cli_x'],
    ]) {
      expect(parseOwnerNoticeCommand(rest)).toEqual({ kind: 'none' });
    }
  });

  it('reads status with no value, and on/off (enable/disable) case-insensitively', () => {
    expect(parseOwnerNoticeCommand(['owner-notice'])).toEqual({ kind: 'status' });
    expect(parseOwnerNoticeCommand(['owner-notice', 'status'])).toEqual({ kind: 'status' });
    expect(parseOwnerNoticeCommand(['owner-notice', 'off'])).toEqual({ kind: 'set', enabled: false });
    expect(parseOwnerNoticeCommand(['owner-notice', 'OFF'])).toEqual({ kind: 'set', enabled: false });
    expect(parseOwnerNoticeCommand(['owner-notice', 'disable'])).toEqual({ kind: 'set', enabled: false });
    expect(parseOwnerNoticeCommand(['owner-notice', 'on'])).toEqual({ kind: 'set', enabled: true });
    expect(parseOwnerNoticeCommand(['owner-notice', 'enable'])).toEqual({ kind: 'set', enabled: true });
  });

  it('refuses anything else instead of guessing which way to flip', () => {
    for (const rest of [
      ['owner-notice', 'false'],
      ['owner-notice', '0'],
      ['owner-notice', 'off', 'now'],
      ['owner-notice', '--bot', 'Review'],
    ]) {
      expect(parseOwnerNoticeCommand(rest).kind).toBe('invalid');
    }
  });
});

describe('runOwnerNoticeCommand (real config file)', () => {
  let dir: string;
  let configFile: string;
  // The same wiring `botmux create-group owner-notice` uses.
  const realDeps: OwnerNoticeCommandDeps = {
    setEnabled: setGroupOwnerNoticeEnabled,
    isEnabled: () => config.groupOwnerNotice,
    rawValue: readRawGroupOwnerNotice,
    configPath: globalConfigPath,
  };
  const run = (...args: string[]) => {
    const cmd = parseOwnerNoticeCommand(['owner-notice', ...args]);
    if (cmd.kind === 'none') throw new Error('expected an owner-notice command');
    return runOwnerNoticeCommand(cmd, realDeps);
  };
  const stored = () => existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf-8')) : undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-owner-notice-cli-'));
    configFile = join(dir, 'config.json');
    vi.stubEnv('BOTMUX_GLOBAL_CONFIG_FILE', configFile);
    invalidateGlobalConfigCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('off writes false, status only reads, on removes the key', () => {
    expect(run()).toMatchObject({ exitCode: 0, enabled: true, stderr: [] });
    expect(stored()).toBeUndefined();

    expect(run('off')).toMatchObject({ exitCode: 0, enabled: false });
    expect(stored()).toEqual({ groupOwnerNotice: false });
    expect(run('status')).toMatchObject({ exitCode: 0, enabled: false });
    expect(stored()).toEqual({ groupOwnerNotice: false });

    expect(run('on')).toMatchObject({ exitCode: 0, enabled: true });
    expect(stored()).toEqual({});
  });

  it('refuses a bad value without touching the file', () => {
    const refused = run('false');
    expect(refused.exitCode).toBe(2);
    expect(refused.enabled).toBeUndefined();
    expect(stored()).toBeUndefined();
  });

  it('flags a hand-edited non-boolean that group creation ignores', () => {
    writeFileSync(configFile, JSON.stringify({ groupOwnerNotice: 'false' }));
    invalidateGlobalConfigCache();
    const status = run();
    expect(status.enabled).toBe(true);
    expect(status.stderr).toHaveLength(1);

    // Rewriting it through the command clears the warning.
    expect(run('off')).toMatchObject({ enabled: false, stderr: [] });
  });

  it('reports a failed write as exit 1 instead of claiming the new state', () => {
    const cmd = parseOwnerNoticeCommand(['owner-notice', 'off']);
    if (cmd.kind === 'none') throw new Error('expected an owner-notice command');
    const outcome = runOwnerNoticeCommand(cmd, {
      ...realDeps,
      setEnabled: () => { throw new Error('durable_config_coordinator_required'); },
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.enabled).toBeUndefined();
    expect(outcome.stdout).toEqual([]);
    expect(stored()).toBeUndefined();
  });
});

describe('parseCreateGroupCliArgs', () => {
  it('parses valid flags in a single pass without misinterpreting prompt/name values as flags', () => {
    expect(parseCreateGroupCliArgs([
      '--bot', 'cli_a',
      '--bot=cli_b',
      '--name', '--chat',
      '--chat-mode=topic',
      '--kickoff-bot', 'cli_b',
      '--kickoff-prompt', '--kickoff-bot=cli_b --team=t1 --help review',
      '--json-status',
    ])).toEqual({
      kind: 'ok',
      botRefs: ['cli_a', 'cli_b'],
      name: '--chat',
      chatMode: 'topic',
      workingDir: undefined,
      kickoffBot: 'cli_b',
      kickoffPrompt: '--kickoff-bot=cli_b --team=t1 --help review',
      jsonStatus: true,
    });

    // Leading-dash markdown bullet prose and equals-form literal flag text are allowed.
    expect(parseCreateGroupCliArgs([
      '--bot', 'cli_a', '--bot', 'cli_b',
      '--kickoff-bot=cli_b',
      '--kickoff-prompt', '- check tests',
    ])).toMatchObject({ kind: 'ok', kickoffBot: 'cli_b', kickoffPrompt: '- check tests' });

    expect(parseCreateGroupCliArgs([
      '--bot', 'cli_a', '--bot', 'cli_b',
      '--kickoff-bot=cli_b',
      '--kickoff-prompt=--kickoff-bot',
    ])).toMatchObject({ kind: 'ok', kickoffBot: 'cli_b', kickoffPrompt: '--kickoff-bot' });
  });

  it('rejects missing, blank, and duplicate kickoff flags (including trailing bare duplicates)', () => {
    const cases: Array<[string[], string]> = [
      [['--bot', 'cli_a', '--bot', 'cli_b', '--kickoff-bot', 'cli_b', '--kickoff-prompt', '--json-status'], '--kickoff-prompt 缺少值'],
      [['--bot', 'cli_a', '--bot', 'cli_b', '--kickoff-prompt', '--kickoff-bot', 'cli_b'], '--kickoff-prompt 缺少值'],
      [['--bot', 'cli_a', '--bot', 'cli_b', '--kickoff-prompt', '--kickoff-bot=cli_b'], '--kickoff-prompt 缺少值'],
      [['--bot', 'cli_a', '--bot', 'cli_b', '--kickoff-prompt', '--name', 'MyGroup'], '--kickoff-prompt 缺少值'],
      [['--bot', 'cli_a', '--bot', 'cli_b', '--kickoff-bot', ''], '--kickoff-bot 不能为空'],
      [['--bot', 'cli_a', '--bot', 'cli_b', '--kickoff-bot', '   '], '--kickoff-bot 不能为空'],
      [['--bot', 'cli_a', '--bot', 'cli_b', '--kickoff-bot=   '], '--kickoff-bot 不能为空'],
      [['--bot', 'cli_a', '--bot', 'cli_b', '--kickoff-bot'], '--kickoff-bot 缺少值'],
      [['--bot', 'cli_a', '--bot', 'cli_b', '--kickoff-bot', '--json-status'], '--kickoff-bot 缺少值'],
      [['--bot', 'cli_a', '--bot', 'cli_b', '--kickoff-prompt', '   '], '--kickoff-prompt 不能为空'],
      [['--bot', 'cli_a', '--bot', 'cli_b', '--kickoff-bot', 'cli_b', '--kickoff-prompt', 'hi', '--kickoff-bot'], '--kickoff-bot 不能重复指定'],
      [['--bot', 'cli_a', '--bot', 'cli_b', '--kickoff-bot', 'cli_b', '--kickoff-prompt', 'hi', '--kickoff-prompt'], '--kickoff-prompt 不能重复指定'],
    ];
    for (const [argv, expected] of cases) {
      const parsed = parseCreateGroupCliArgs(argv);
      expect(parsed.kind, argv.join(' ')).toBe('error');
      if (parsed.kind === 'error') expect(parsed.error, argv.join(' ')).toContain(expected);
    }
  });

  it('detects help, deprecated --chat, and --team/--agent mode flags cleanly', () => {
    expect(parseCreateGroupCliArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseCreateGroupCliArgs(['owner-notice', '--help'])).toEqual({ kind: 'help' });
    expect(parseCreateGroupCliArgs(['--bot', 'cli_a', '--chat', 'oc_1'])).toEqual({ kind: 'deprecated-chat' });
    expect(parseCreateGroupCliArgs(['--team', 't1', '--agent', 'cli_a'])).toEqual({ kind: 'team' });
  });
});

describe('resolveKickoff', () => {
  const selected = ['cli_creator', 'cli_reviewer'];
  const botInfo = [
    { larkAppId: 'cli_creator', botOpenId: 'ou_creator_self' },
    { larkAppId: 'cli_reviewer', botOpenId: 'ou_reviewer_self' },
    { larkAppId: 'cli_unselected', botOpenId: 'ou_unselected_self' },
  ];

  it('accepts an omitted kickoff pair', () => {
    expect(resolveKickoff(undefined, undefined, selected, botInfo)).toEqual({ ok: true });
  });

  it('requires both kickoff arguments and rejects whitespace-only values', () => {
    expect(resolveKickoff('ou_reviewer_self', undefined, selected, botInfo)).toEqual({
      ok: false,
      error: '--kickoff-bot 与 --kickoff-prompt 必须同时提供且不能为空。',
    });
    expect(resolveKickoff('   ', 'review this', selected, botInfo).ok).toBe(false);
  });

  it('resolves a selected non-creator bot and trims the prompt', () => {
    expect(resolveKickoff(' ou_reviewer_self ', ' review this ', selected, botInfo)).toEqual({
      ok: true,
      targetLarkAppId: 'cli_reviewer',
      prompt: 'review this',
    });
  });

  it('rejects an unknown or unselected bot open_id', () => {
    expect(resolveKickoff('ou_unknown', 'review', selected, botInfo).ok).toBe(false);
    expect(resolveKickoff('ou_unselected_self', 'review', selected, botInfo)).toEqual({
      ok: false,
      error: '--kickoff-bot 必须属于本次 --bot 列表。',
    });
  });

  it('rejects the creator bot', () => {
    expect(resolveKickoff('ou_creator_self', 'review', selected, botInfo)).toEqual({
      ok: false,
      error: '--kickoff-bot 不能是 creator（第一个 --bot）。',
    });
  });

  it('resolves a selected non-creator bot directly by larkAppId even without bots-info.json', () => {
    expect(resolveKickoff(' cli_reviewer ', ' start review ', selected, [])).toEqual({
      ok: true,
      targetLarkAppId: 'cli_reviewer',
      prompt: 'start review',
    });
  });

  it('rejects creator, unselected, and unknown larkAppIds cleanly', () => {
    expect(resolveKickoff('cli_creator', 'review', selected, [])).toEqual({
      ok: false,
      error: '--kickoff-bot 不能是 creator（第一个 --bot）。',
    });
    expect(resolveKickoff('cli_unselected', 'review', selected, [], ['cli_creator', 'cli_reviewer', 'cli_unselected'])).toEqual({
      ok: false,
      error: '--kickoff-bot 必须属于本次 --bot 列表。',
    });
    expect(resolveKickoff('cli_unknown', 'review', selected, [], ['cli_creator', 'cli_reviewer'])).toEqual({
      ok: false,
      error: '--kickoff-bot 未匹配到本机 bot: cli_unknown',
    });
  });

  it('fails closed on ambiguous/malformed refs and corrupted bots-info entries', () => {
    for (const bad of ['Reviewer', 'codex', 'local_helper', 'on_union1', 'cli_', 'ou_', '--kickoff-prompt', 'cli_has space']) {
      const res = resolveKickoff(bad, 'review', selected, botInfo);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('格式无效');
    }
    // Duplicate botOpenId in bots-info.json still fails closed.
    const dupInfo = [
      { larkAppId: 'cli_reviewer', botOpenId: 'ou_dup' },
      { larkAppId: 'cli_unselected', botOpenId: 'ou_dup' },
    ];
    expect(resolveKickoff('ou_dup', 'review', selected, dupInfo).ok).toBe(false);

    // Corrupted bots-info entry with a cli_ string stored in botOpenId must NOT hijack larkAppId lookup.
    const poisoned = [
      { larkAppId: 'cli_creator', botOpenId: 'cli_reviewer' },
      { larkAppId: 'cli_reviewer', botOpenId: 'ou_reviewer_self' },
    ];
    expect(resolveKickoff('cli_reviewer', 'review', selected, poisoned)).toEqual({
      ok: true,
      targetLarkAppId: 'cli_reviewer',
      prompt: 'review',
    });
  });
});

describe('createGroupCompletionStatus', () => {
  it('does not report completion when a requested kickoff was not accepted', () => {
    expect(createGroupCompletionStatus({
      chatId: 'oc_created',
      collaborationReady: true,
      kickoffRequested: true,
      kickoffMessageId: null,
      kickoffError: 'network down',
    })).toEqual({
      success: false,
      chatCreated: true,
      chatId: 'oc_created',
      shareLink: null,
      shareLinkError: null,
      collaborationReady: true,
      kickoffAccepted: false,
      kickoffRequested: true,
      kickoffMessageId: null,
      kickoffError: 'network down',
    });
  });

  it('includes shareLink and shareLinkError without flipping success on best-effort share link failure', () => {
    expect(createGroupCompletionStatus({
      chatId: 'oc_created',
      shareLink: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=tok_1',
      shareLinkError: null,
      collaborationReady: true,
      kickoffRequested: false,
      kickoffMessageId: null,
      kickoffError: null,
    })).toMatchObject({
      success: true,
      chatId: 'oc_created',
      shareLink: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=tok_1',
      shareLinkError: null,
    });

    expect(createGroupCompletionStatus({
      chatId: 'oc_created',
      shareLink: null,
      shareLinkError: 'permission_denied (code: 99991672)',
      collaborationReady: true,
      kickoffRequested: false,
      kickoffMessageId: null,
      kickoffError: null,
    })).toMatchObject({
      success: true,
      chatId: 'oc_created',
      shareLink: null,
      shareLinkError: 'permission_denied (code: 99991672)',
    });
  });

  it('reports completion once a requested kickoff was sent', () => {
    expect(createGroupCompletionStatus({
      chatId: 'oc_created',
      collaborationReady: true,
      kickoffRequested: true,
      kickoffMessageId: 'om_kickoff',
      kickoffError: null,
    })).toMatchObject({
      success: true,
      collaborationReady: true,
      kickoffAccepted: true,
    });
  });

  it('reports missing bot-to-bot grants without failing the created group', () => {
    // The grants are best-effort: a non-zero exit here would make callers that
    // retry on failure create a second group.
    expect(createGroupCompletionStatus({
      chatId: 'oc_created',
      collaborationReady: false,
      kickoffRequested: false,
      kickoffMessageId: null,
      kickoffError: null,
    })).toMatchObject({
      success: true,
      collaborationReady: false,
      kickoffAccepted: true,
    });
    expect(createGroupCompletionStatus({
      chatId: 'oc_created',
      collaborationReady: false,
      kickoffRequested: true,
      kickoffMessageId: 'om_kickoff',
      kickoffError: null,
    })).toMatchObject({
      success: true,
      collaborationReady: false,
      kickoffAccepted: true,
    });
  });

  it('keeps successful default stdout as the historical single chatId line', () => {
    const success = createGroupCompletionStatus({
      chatId: 'oc_created',
      collaborationReady: true,
      kickoffRequested: false,
      kickoffMessageId: null,
      kickoffError: null,
    });
    expect(shouldWriteCreateGroupCompletionStatus(success, false)).toBe(false);
    expect(shouldWriteCreateGroupCompletionStatus(success, true)).toBe(true);

    const partial = createGroupCompletionStatus({
      chatId: 'oc_created',
      collaborationReady: false,
      kickoffRequested: false,
      kickoffMessageId: null,
      kickoffError: null,
    });
    // Legacy wrappers parse the whole stdout as ^oc_...$: even a partial
    // non-zero result must leave stdout as the single early chatId line.
    expect(shouldWriteCreateGroupCompletionStatus(partial, false)).toBe(false);
    expect(shouldWriteCreateGroupCompletionStatus(partial, true)).toBe(true);
  });
});
