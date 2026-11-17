/**
 * Per-bot, per-chat role resolution + prompt injection.
 *
 * Guards the storage contract (under config.session.dataDir, keyed by
 * larkAppId so bots sharing a workingDir stay isolated) and that
 * buildNewTopicPrompt injects a <role> block when given { larkAppId, chatId }.
 * Run: pnpm vitest run test/role-resolver.test.ts
 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let dataDir: string;

/** Re-import role-resolver (and config) fresh so SESSION_DATA_DIR is honored. */
async function fresh() {
  vi.resetModules();
  return import('../src/core/role-resolver.js');
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-role-'));
  process.env.SESSION_DATA_DIR = dataDir;
});
afterEach(() => { delete process.env.SESSION_DATA_DIR; vi.restoreAllMocks(); });

describe('role-resolver storage', () => {
  it('writes under {dataDir}/roles/{larkAppId}/{chatId}.md and reads it back', async () => {
    const { writeRoleFile, resolveRoleFile } = await fresh();
    writeRoleFile('app1', 'oc_x', '# 代码审查员\n严肃，只看正确性。');
    const expectedPath = join(dataDir, 'roles', 'app1', 'oc_x.md');
    expect(existsSync(expectedPath)).toBe(true);
    expect(resolveRoleFile('app1', 'oc_x')).toContain('代码审查员');
  });

  it('rejects invalid chat ids for role file writes', async () => {
    const { writeRoleFile, resolveRoleFile, deleteRoleFile } = await fresh();
    expect(resolveRoleFile('app1', '../escape')).toBeNull();
    expect(() => writeRoleFile('app1', '../escape', 'bad')).toThrow(/invalid chat id/);
    expect(deleteRoleFile('app1', '../escape')).toBe(false);
  });

  it('keys on larkAppId — two bots sharing a chatId do not collide', async () => {
    const { writeRoleFile, resolveRoleFile } = await fresh();
    writeRoleFile('app1', 'oc_shared', 'role-A');
    writeRoleFile('app2', 'oc_shared', 'role-B');
    expect(resolveRoleFile('app1', 'oc_shared')).toBe('role-A');
    expect(resolveRoleFile('app2', 'oc_shared')).toBe('role-B');
  });

  it('returns null when no role file exists, and after delete', async () => {
    const { writeRoleFile, resolveRoleFile, deleteRoleFile } = await fresh();
    expect(resolveRoleFile('app1', 'oc_none')).toBeNull();
    writeRoleFile('app1', 'oc_y', 'hi');
    expect(deleteRoleFile('app1', 'oc_y')).toBe(true);
    expect(resolveRoleFile('app1', 'oc_y')).toBeNull();
    expect(deleteRoleFile('app1', 'oc_y')).toBe(false); // already gone
  });

  it('truncates content to MAX_ROLE_BYTES by UTF-8 byte length, on a char boundary', async () => {
    const { writeRoleFile, resolveRoleFile, MAX_ROLE_BYTES } = await fresh();
    // Write well over the limit in CJK (3 bytes each) so truncation must fire.
    const overCount = Math.ceil(MAX_ROLE_BYTES / 3) + 1000;
    writeRoleFile('app1', 'oc_big', '中'.repeat(overCount));
    const got = resolveRoleFile('app1', 'oc_big')!;
    expect(Buffer.byteLength(got, 'utf-8')).toBeLessThanOrEqual(MAX_ROLE_BYTES);
    // No partial/replacement char at the cut (would appear as U+FFFD).
    expect(got).not.toContain('�');
    // The raised limit is well above the old 4 KB.
    expect(MAX_ROLE_BYTES).toBeGreaterThan(4096);
  });
});

describe('role injection mode', () => {
  it('defaults to "every" and round-trips "once" / back to "every"', async () => {
    const { readRoleInjectMode, writeRoleInjectMode } = await fresh();
    expect(readRoleInjectMode('app1', 'oc_m')).toBe('every');
    writeRoleInjectMode('app1', 'oc_m', 'once');
    expect(readRoleInjectMode('app1', 'oc_m')).toBe('once');
    writeRoleInjectMode('app1', 'oc_m', 'every'); // removes the sidecar
    expect(readRoleInjectMode('app1', 'oc_m')).toBe('every');
  });

  it('resolveRoleInjection carries the mode alongside the effective role', async () => {
    const { writeRoleFile, writeTeamRoleFile, writeRoleInjectMode, resolveRoleInjection } = await fresh();
    // No role → injectMode is 'every' regardless.
    expect(resolveRoleInjection('app1', 'oc_r')).toEqual({ content: null, source: 'none', injectMode: 'every' });
    // Mode applies to the team default too (per-chat setting, not per-source).
    writeTeamRoleFile('app1', 'TEAM');
    writeRoleInjectMode('app1', 'oc_r', 'once');
    expect(resolveRoleInjection('app1', 'oc_r')).toEqual({ content: 'TEAM', source: 'team', injectMode: 'once' });
    // A per-chat override wins for content; mode is unchanged.
    writeRoleFile('app1', 'oc_r', 'CHAT');
    expect(resolveRoleInjection('app1', 'oc_r')).toEqual({ content: 'CHAT', source: 'chat', injectMode: 'once' });
  });

  it('stores the dispatch completion switch per bot + chat without clobbering injection mode', async () => {
    const {
      deleteRoleMeta,
      readRoleDispatchCompletionEnabled,
      readRoleInjectMode,
      writeRoleDispatchCompletionEnabled,
      writeRoleInjectMode,
    } = await fresh();
    const metaPath = join(dataDir, 'roles', 'app1', 'oc_dispatch.meta.json');

    expect(readRoleDispatchCompletionEnabled('app1', 'oc_dispatch')).toBe(false);
    writeRoleInjectMode('app1', 'oc_dispatch', 'once');
    writeRoleDispatchCompletionEnabled('app1', 'oc_dispatch', true);
    expect(readRoleInjectMode('app1', 'oc_dispatch')).toBe('once');
    expect(readRoleDispatchCompletionEnabled('app1', 'oc_dispatch')).toBe(true);

    writeRoleDispatchCompletionEnabled('app1', 'oc_dispatch', false);
    expect(readRoleInjectMode('app1', 'oc_dispatch')).toBe('once');
    expect(readRoleDispatchCompletionEnabled('app1', 'oc_dispatch')).toBe(false);

    writeRoleDispatchCompletionEnabled('app1', 'oc_dispatch', true);
    deleteRoleMeta('app1', 'oc_dispatch');
    expect(existsSync(metaPath)).toBe(false);
    expect(readRoleInjectMode('app1', 'oc_dispatch')).toBe('every');
    expect(readRoleDispatchCompletionEnabled('app1', 'oc_dispatch')).toBe(false);
  });

  it('treats damaged or non-object role metadata as empty', async () => {
    const {
      readRoleDispatchCompletionEnabled,
      readRoleInjectMode,
      writeRoleInjectMode,
    } = await fresh();
    const metaPath = join(dataDir, 'roles', 'app1', 'oc_invalid_meta.meta.json');
    writeRoleInjectMode('app1', 'oc_invalid_meta', 'once');

    for (const invalid of ['null', '[]', '{']) {
      writeFileSync(metaPath, invalid);
      expect(readRoleInjectMode('app1', 'oc_invalid_meta')).toBe('every');
      expect(readRoleDispatchCompletionEnabled('app1', 'oc_invalid_meta')).toBe(false);
    }
  });

  it('falls back to the bot-level default injection mode when a chat has none', async () => {
    const {
      readRoleDispatchCompletionEnabled,
      readRoleInjectMode,
      readTeamRoleInjectMode,
      writeRoleDispatchCompletionEnabled,
      writeTeamRoleInjectMode,
      writeRoleInjectMode,
    } = await fresh();
    // bot-level default itself defaults to 'every' (legacy).
    expect(readTeamRoleInjectMode('appB')).toBe('every');
    expect(readRoleInjectMode('appB', 'oc_x')).toBe('every');
    // Opt the whole bot into 'once' → any chat without its own sidecar inherits it.
    writeTeamRoleInjectMode('appB', 'once');
    expect(readTeamRoleInjectMode('appB')).toBe('once');
    expect(readRoleInjectMode('appB', 'oc_x')).toBe('once');
    expect(readRoleInjectMode('appB', 'oc_y')).toBe('once');
    // A per-chat explicit 'every' still wins over the bot default and survives
    // unrelated metadata updates in the same sidecar.
    writeRoleInjectMode('appB', 'oc_x', 'every');
    writeRoleDispatchCompletionEnabled('appB', 'oc_x', true);
    expect(readRoleInjectMode('appB', 'oc_x')).toBe('every');
    expect(readRoleDispatchCompletionEnabled('appB', 'oc_x')).toBe(true);
    // Clearing the bot default returns unset chats to 'every'.
    writeTeamRoleInjectMode('appB', 'every');       // removes the meta sidecar
    expect(readRoleInjectMode('appB', 'oc_y')).toBe('every');
  });

  it('buildFollowUpContent omits the <role> block when mode is "once", keeps it on "every"', async () => {    await fresh();
    const { writeRoleFile, writeRoleInjectMode } = await import('../src/core/role-resolver.js');
    writeRoleFile('app1', 'oc_once', 'ONCE_PERSONA');
    const { buildNewTopicPrompt, buildFollowUpContent } = await import('../src/core/session-manager.js');

    // every (default): role present in both opening + follow-up
    expect(buildFollowUpContent('hi', 's1', { larkAppId: 'app1', chatId: 'oc_once' })).toContain('ONCE_PERSONA');

    // once: opening keeps it, follow-up drops it
    writeRoleInjectMode('app1', 'oc_once', 'once');
    const opening = buildNewTopicPrompt(
      'hi', 's1', 'claude-code', undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { larkAppId: 'app1', chatId: 'oc_once' },
    );
    expect(opening).toContain('ONCE_PERSONA');
    const followUp = buildFollowUpContent('hi again', 's1', { larkAppId: 'app1', chatId: 'oc_once' });
    expect(followUp).not.toContain('ONCE_PERSONA');
    expect(followUp).not.toContain('<role');
  });

  it('keeps the coordinator project protocol on follow-ups when a custom role is injected once', async () => {
    await fresh();
    const { writeRoleFile, writeRoleInjectMode } = await import('../src/core/role-resolver.js');
    const { writeGroupCollaborationMode } = await import('../src/services/group-collaboration-mode-store.js');
    writeRoleFile('app1', 'oc_project', 'CUSTOM_COORDINATOR_ROLE');
    writeRoleInjectMode('app1', 'oc_project', 'once');
    await writeGroupCollaborationMode(dataDir, {
      chatId: 'oc_project', mode: 'project', coordinatorAppId: 'app1', workerAppIds: ['worker1'],
    });
    const { buildNewTopicPrompt, buildFollowUpContent } = await import('../src/core/session-manager.js');

    const opening = buildNewTopicPrompt(
      '开始讨论', 's1', 'claude-code', undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { larkAppId: 'app1', chatId: 'oc_project' },
    );
    expect(opening).toContain('CUSTOM_COORDINATOR_ROLE');
    expect(opening).toContain('<project_group_mode');

    const followUp = buildFollowUpContent('继续', 's1', { larkAppId: 'app1', chatId: 'oc_project' });
    expect(followUp).not.toContain('CUSTOM_COORDINATOR_ROLE');
    expect(followUp).not.toContain('<role');
    expect(followUp).toContain('<project_group_mode');
    expect(followUp).toContain('independent of custom &lt;role&gt; content');
  });
});

describe('buildNewTopicPrompt role injection', () => {
  it('injects a <role> block when { larkAppId, chatId } resolves a role', async () => {
    await fresh();
    const { writeRoleFile } = await import('../src/core/role-resolver.js');
    writeRoleFile('app1', 'oc_z', 'PERSONA_MARKER');
    const { buildNewTopicPrompt } = await import('../src/core/session-manager.js');
    const prompt = buildNewTopicPrompt(
      'hello', 'sess1', 'claude-code', undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { larkAppId: 'app1', chatId: 'oc_z' },
    );
    expect(prompt).toContain('<role context="group" chat_id="oc_z">');
    expect(prompt).toContain('PERSONA_MARKER');
  });

  it('omits the <role> block when no role exists', async () => {
    await fresh();
    const { buildNewTopicPrompt } = await import('../src/core/session-manager.js');
    const prompt = buildNewTopicPrompt(
      'hello', 'sess1', 'claude-code', undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { larkAppId: 'app1', chatId: 'oc_absent' },
    );
    expect(prompt).not.toContain('<role');
  });
});

describe('team-level role + layered resolution', () => {
  it('writes/reads team role under {dataDir}/team-roles/{larkAppId}.md', async () => {
    const { writeTeamRoleFile, resolveTeamRoleFile } = await fresh();
    writeTeamRoleFile('app1', '# 后端机器人\n擅长服务端。');
    expect(existsSync(join(dataDir, 'team-roles', 'app1.md'))).toBe(true);
    expect(resolveTeamRoleFile('app1')).toContain('后端机器人');
  });

  it('resolveRole layers: chat override ＞ team ＞ none', async () => {
    const { writeRoleFile, writeTeamRoleFile, deleteRoleFile, resolveRole } = await fresh();
    expect(resolveRole('app1', 'oc_a')).toEqual({ content: null, source: 'none' });
    writeTeamRoleFile('app1', 'TEAM_ROLE');
    expect(resolveRole('app1', 'oc_a')).toEqual({ content: 'TEAM_ROLE', source: 'team' });
    writeRoleFile('app1', 'oc_a', 'CHAT_ROLE');
    expect(resolveRole('app1', 'oc_a')).toEqual({ content: 'CHAT_ROLE', source: 'chat' });
    deleteRoleFile('app1', 'oc_a');
    expect(resolveRole('app1', 'oc_a')).toEqual({ content: 'TEAM_ROLE', source: 'team' });
  });

  it('team role is per-bot (keyed on larkAppId), shared across chats', async () => {
    const { writeTeamRoleFile, resolveRole } = await fresh();
    writeTeamRoleFile('app1', 'A');
    writeTeamRoleFile('app2', 'B');
    expect(resolveRole('app1', 'oc_any').content).toBe('A');
    expect(resolveRole('app2', 'oc_any').content).toBe('B');
  });

  it('deleteTeamRoleFile removes it', async () => {
    const { writeTeamRoleFile, deleteTeamRoleFile, resolveTeamRoleFile } = await fresh();
    writeTeamRoleFile('app1', 'X');
    expect(deleteTeamRoleFile('app1')).toBe(true);
    expect(resolveTeamRoleFile('app1')).toBeNull();
    expect(deleteTeamRoleFile('app1')).toBe(false);
  });
});

describe('buildNewTopicPrompt team-role injection', () => {
  it('injects team role with context="team" when no per-chat override', async () => {
    await fresh();
    const { writeTeamRoleFile } = await import('../src/core/role-resolver.js');
    writeTeamRoleFile('app1', 'TEAM_PERSONA');
    const { buildNewTopicPrompt } = await import('../src/core/session-manager.js');
    const prompt = buildNewTopicPrompt(
      'hello', 'sess1', 'claude-code', undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { larkAppId: 'app1', chatId: 'oc_team' },
    );
    expect(prompt).toContain('<role context="team" chat_id="oc_team">');
    expect(prompt).toContain('TEAM_PERSONA');
  });
});

describe('buildFollowUpContent role injection', () => {
  it('does not apply RPC budget to a frozen non-RPC TraeX refork under a true global default', async () => {
    const { writeRoleFile } = await fresh();
    const { config } = await import('../src/config.js');
    const globalDefault = vi.spyOn(config, 'codexRpcInputDefault', 'get').mockReturnValue(true);
    try {
      const role = 'R8_EXACT_ROLE\n' + 'r'.repeat(26_000);
      writeRoleFile('app1', 'oc_r8', role);
      const { buildReforkCliInput } = await import('../src/core/session-manager.js');
      const ds = {
        larkAppId: 'app1',
        initConfig: { codexRpcInput: false },
        session: { sessionId: 'sid-r8', chatId: 'oc_r8', cliId: 'traex', cliSessionId: 'native-r8' },
      } as any;
      const built = buildReforkCliInput(ds, 'R8_USER', { cliId: 'traex' });
      expect(built.content).toContain(role);
      expect(built.content).toContain('R8_USER');
    } finally {
      globalDefault.mockRestore();
    }
  });
  it('places stable role context before the follow-up user message', async () => {
    await fresh();
    const { writeRoleFile } = await import('../src/core/role-resolver.js');
    writeRoleFile('app1', 'oc_follow', 'FOLLOWUP_PERSONA');
    const { buildFollowUpContent } = await import('../src/core/session-manager.js');
    const prompt = buildFollowUpContent('follow up', 'sess-follow', {
      larkAppId: 'app1',
      chatId: 'oc_follow',
      sender: { openId: 'ou_sender', type: 'user', name: 'Sender' },
      mentions: [{ name: 'Reviewer', openId: 'ou_reviewer' }],
    });

    expect(prompt).toContain('<role context="group" chat_id="oc_follow">');
    expect(prompt).toContain('FOLLOWUP_PERSONA');
    expect(prompt.indexOf('<session_id>')).toBeLessThan(prompt.indexOf('<role '));
    expect(prompt.indexOf('<role ')).toBeLessThan(prompt.indexOf('<botmux_reminder>'));
    expect(prompt.indexOf('<botmux_reminder>')).toBeLessThan(prompt.indexOf('<user_message>'));
    expect(prompt.indexOf('<sender ')).toBeGreaterThan(prompt.indexOf('</user_message>'));
    expect(prompt.indexOf('<mentions>')).toBeGreaterThan(prompt.indexOf('</user_message>'));
  });

  it('keeps every daemon TraeX RPC payload self-contained; the write edge deduplicates by receipt and budgets', async () => {
    await fresh();
    const { writeRoleFile } = await import('../src/core/role-resolver.js');
    const role = 'AUTHORIZATION_BOUNDARY\n' + '安全约束。'.repeat(1_050);
    writeRoleFile('app1', 'oc_traex', role);
    const { buildFollowUpCliInput } = await import('../src/core/session-manager.js');
    const {
      appendTraexSkillCatalog,
      prepareTraexNativeContext,
    } = await import('../src/core/traex-native-context.js');
    const opts = {
      larkAppId: 'app1', chatId: 'oc_traex', cliId: 'traex' as const,
      sender: { openId: 'ou_sender', type: 'user' as const, name: 'Sender' },
      traexRpcContext: true as const,
    };

    const first = buildFollowUpCliInput('用户正文'.repeat(3_000), 'sid-traex', opts);
    expect(first.content).toContain('AUTHORIZATION_BOUNDARY');
    expect(first.content).toContain('<sender type="user" open_id="ou_sender" name="Sender" />');
    const firstAtEdge = prepareTraexNativeContext(first.content, 'native-thread-1');
    expect(firstAtEdge).toMatchObject({
      nativeThreadId: 'native-thread-1',
      roleDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      includedRole: true,
      budgetBytes: 24 * 1024,
    });
    expect(firstAtEdge.fixedContextBytes).toBeLessThanOrEqual(24 * 1024);

    const { buildNewTopicCliInput } = await import('../src/core/session-manager.js');
    const { renderSkillCatalogBlock } = await import('../src/core/skills/prompt.js');
    const opening = buildNewTopicCliInput(
      '首轮用户正文'.repeat(3_000), 'sid-traex', 'traex', undefined,
      [{ type: 'file', path: '/tmp/traex-evidence.bin', name: 'traex-evidence.bin' }],
      undefined,
      Array.from({ length: 10 }, (_, index) => ({
        name: `bot-${index}`,
        displayName: `协作机器人-${index}`,
        openId: `ou_bot_${index}`,
      })),
      undefined,
      { name: 'Bot', openId: 'ou_bot' }, 'zh', opts.sender,
      { larkAppId: 'app1', chatId: 'oc_traex', turnId: 'om_open', traexRpcContextEnabled: true },
    );
    const { createCliAdapterSync } = await import('../src/adapters/cli/registry.js');
    const { builtinSkillEntries } = await import('../src/skills/injection-mode.js');
    const { whiteboardEnabled } = await import('../src/services/whiteboard-store.js');
    const traexAdapter = createCliAdapterSync('traex');
    const expectedBuiltinSkills = builtinSkillEntries({
      asksViaHook: traexAdapter.asksViaHook,
      whiteboardEnabled: whiteboardEnabled(),
      excludeRoutingCovered: true,
    });
    expect(opening.content.match(/<skill name="[^"]+"(?: trigger="[^"]*")? \/>/g) ?? [])
      .toHaveLength(expectedBuiltinSkills.length);
    for (const skill of expectedBuiltinSkills) {
      expect(opening.content).toContain(`<skill name="${skill.name}"`);
    }
    expect(opening.content).toContain('botmux send');
    expect(opening.content).toContain('--content-file');
    expect(opening.content).toContain('botmux history');
    expect(opening.content).toContain('botmux quoted');
    expect(opening.content).toContain('botmux bots list');
    expect(opening.content).toContain('--mention-back');
    expect(opening.content).toContain('--no-mention');
    expect(opening.content).toContain('&lt;user_message&gt;');
    const skillTemplate = {
      id: 'skill', name: 'skill', tags: [], rootDir: '/skills/skill', entrypoint: 'SKILL.md',
      source: { type: 'user' as const, root: '/skills/skill' }, priorityReason: 'bot:include',
      description: 'Use when handling this focused task. Full operational rules stay in the skill file.',
    };
    const catalog = renderSkillCatalogBlock({
      sessionId: 'sid-traex', cliId: 'traex', workingDir: '/repo', policyMode: 'priority',
      prioritySkills: Array.from({ length: 28 }, (_, index) => ({
        ...skillTemplate, id: `skill-${index}`, name: `skill-${index}`,
      })),
      diagnostics: [], generatedAt: '2026-10-14T00:00:00.000Z',
    }, { compact: true });
    const openingPrepared = appendTraexSkillCatalog(
      prepareTraexNativeContext(opening.content, 'native-thread-opening'),
      catalog,
    );
    expect(openingPrepared.fixedContextBytes).toBeLessThanOrEqual((24 * 1024) - 512);
    expect(openingPrepared.content).toContain('AUTHORIZATION_BOUNDARY');
    expect(openingPrepared.content).toContain('<identity>');
    expect(openingPrepared.content).toContain('首轮用户正文');
    expect(openingPrepared.content).toContain('/tmp/traex-evidence.bin');
    expect((openingPrepared.content.match(/<skill name="skill-/g) ?? [])).toHaveLength(28);

    const receipt = {
      nativeThreadId: 'native-thread-1',
      roleDigest: firstAtEdge.roleDigest,
      skillCatalogDigest: firstAtEdge.skillCatalogDigest,
      turnId: 'om_first',
      status: 'accepted' as const,
    };
    // The payload the daemon queues/persists still carries the role after the
    // thread accepted it: any path other than this RPC write (paste fallback,
    // a fresh thread, a re-fork) must not receive a role-less prompt.
    const resumed = buildFollowUpCliInput('新的用户正文', 'sid-traex', opts);
    expect(resumed.content).toContain('AUTHORIZATION_BOUNDARY');
    const resumedAtEdge = prepareTraexNativeContext(resumed.content, 'native-thread-1', receipt);
    expect(resumedAtEdge.content).not.toContain('<role');
    expect(resumedAtEdge.content).toContain('<user_message>\n新的用户正文\n</user_message>');
    expect(resumedAtEdge.content).toContain('<sender type="user" open_id="ou_sender" name="Sender" />');
    expect(resumedAtEdge.fixedContextBytes).toBeLessThanOrEqual(4 * 1024);

    writeRoleFile('app1', 'oc_traex', role + '\nCHANGED_ROLE_VERSION');
    const changed = prepareTraexNativeContext(
      buildFollowUpCliInput('变化后的用户正文', 'sid-traex', opts).content, 'native-thread-1', receipt,
    );
    expect(changed.content).toContain('CHANGED_ROLE_VERSION');
    expect(changed.roleDigest).not.toBe(receipt.roleDigest);
    expect(changed.includedRole).toBe(true);

    const changedReceipt = {
      nativeThreadId: 'native-thread-1',
      roleDigest: changed.roleDigest,
      skillCatalogDigest: changed.skillCatalogDigest,
      turnId: 'om_changed',
      status: 'accepted' as const,
    };
    const afterChange = prepareTraexNativeContext(
      buildFollowUpCliInput('版本已确认', 'sid-traex', opts).content, 'native-thread-1', changedReceipt,
    );
    expect(afterChange.content).not.toContain('<role');

    const ds = {
      session: {
        sessionId: 'sid-traex', chatId: 'oc_traex', rootMessageId: 'om_root',
        title: 'TraeX', status: 'active', createdAt: new Date().toISOString(),
        cliId: 'traex', cliSessionId: 'native-thread-1',
        traexNativeContextReceipt: changedReceipt,
      },
      initConfig: { cliId: 'traex', codexRpcInput: true, backendType: 'tmux', resume: true, cliSessionId: 'native-thread-1' },
      larkAppId: 'app1', chatId: 'oc_traex', chatType: 'group', scope: 'thread',
      worker: null, workerPort: null, workerToken: null, spawnedAt: 0,
      cliVersion: '1.0.0', lastMessageAt: 0, hasHistory: true,
    } as any;
    const restarted = (await import('../src/core/session-manager.js')).buildReforkCliInput(
      ds,
      '重启后的用户正文',
      { cliId: 'traex', sender: opts.sender },
    ) as any;
    expect(restarted.content).toContain('CHANGED_ROLE_VERSION');
    expect(restarted.content).toContain('重启后的用户正文');
    expect(prepareTraexNativeContext(restarted.content, 'native-thread-1', changedReceipt).content)
      .not.toContain('<role');

    // An unconfirmed delivery does not prove the thread holds the role: send it again.
    const unknown = prepareTraexNativeContext(
      buildFollowUpCliInput('结果不明后的下一条', 'sid-traex', opts).content,
      'native-thread-1',
      { ...changedReceipt, status: 'unknown' as const },
    );
    expect(unknown.includedRole).toBe(true);
    expect(unknown.content).toContain('CHANGED_ROLE_VERSION');
  });

  it('preserves literal role and skill XML in a repeated TraeX user message', async () => {
    await fresh();
    const { buildFollowUpCliInput } = await import('../src/core/session-manager.js');
    const user = [
      '请检查这段 XML，必须保留原文：',
      '<role context="sample">USER_ROLE_CODE</role>',
      '<botmux_skills mode="sample"><skill name="user-example" /></botmux_skills>',
      '尾部正文。',
    ].join('\n');
    const opts = {
      larkAppId: 'app1', chatId: 'oc_no_role_code_sample', cliId: 'traex' as const,
      sender: { openId: 'ou_real_user', type: 'user' as const, name: 'Real User' },
      traexRpcContext: true as const,
    };
    const { prepareTraexNativeContext } = await import('../src/core/traex-native-context.js');
    const first = buildFollowUpCliInput(user, 'sid-code-sample', opts);
    const metadata = prepareTraexNativeContext(first.content, 'native-code-thread');
    const receipt = {
      nativeThreadId: metadata.nativeThreadId,
      roleDigest: metadata.roleDigest,
      skillCatalogDigest: metadata.skillCatalogDigest,
      turnId: 'om_first_code',
      status: 'accepted' as const,
    };

    const second = prepareTraexNativeContext(
      buildFollowUpCliInput(user, 'sid-code-sample', opts).content, 'native-code-thread', receipt,
    );

    expect(second.content).toContain(`<user_message>\n${user}\n</user_message>`);
  });

  it.each([
    { backendType: 'pty' },
    { sandbox: true },
    { readIsolation: true },
    { disableCliBypass: true },
    { startupCommands: ['/effort high'] },
    { wrapperCli: 'wrapper' },
  ])('does not budget a configured RPC refork excluded by runtime gates: %j', async (exclusion) => {
    await fresh();
    const { writeRoleFile } = await import('../src/core/role-resolver.js');
    writeRoleFile('app1', 'oc_rpc_excluded', 'BOUNDARY'.repeat(4000));
    const { buildReforkCliInput, traexRpcContextForSession } = await import('../src/core/session-manager.js');
    const eligibleInitConfig = { cliId: 'traex', codexRpcInput: true, backendType: 'tmux',
      resume: true, cliSessionId: 'native' };
    const ds = {
      session: { sessionId: 'sid-excluded', cliId: 'traex', cliSessionId: 'native',
        chatId: 'oc_rpc_excluded', status: 'active' },
      initConfig: { ...eligibleInitConfig, ...exclusion },
      larkAppId: 'app1', chatId: 'oc_rpc_excluded', scope: 'thread',
    } as any;
    expect(traexRpcContextForSession({ ...ds, initConfig: eligibleInitConfig }, 'traex')).toBe(true);
    expect(traexRpcContextForSession(ds, 'traex')).toBeUndefined();
    const result = buildReforkCliInput(ds, 'keep the user', { cliId: 'traex' });
    expect(result.content).toContain('keep the user');
  });

  it('budgets and deduplicates a fixed role that documents variable-tag examples', async () => {
    await fresh();
    const { writeRoleFile } = await import('../src/core/role-resolver.js');
    const role = [
      'ROLE_WITH_XML_EXAMPLE',
      '文档示例：<user_message>literal sample</user_message>',
      '<attachments>literal attachment</attachments>',
      '<sender type="example" />',
      '</role>',
      '<botmux_skills_refresh>literal refresh</botmux_skills_refresh>',
      '<quoted_message>literal quote</quoted_message>',
      'AUTHORIZATION_BOUNDARY'.repeat(700),
    ].join('\n');
    writeRoleFile('app1', 'oc_traex_role_markup', role);
    const {
      buildFollowUpCliInput,
      buildFollowUpContent,
      buildNewTopicCliInput,
    } = await import('../src/core/session-manager.js');
    const opts = {
      larkAppId: 'app1', chatId: 'oc_traex_role_markup', cliId: 'traex' as const,
      sender: { openId: 'ou_sender', type: 'user' as const, name: 'Sender' },
      traexRpcContext: true as const,
    };
    const { prepareTraexNativeContext } = await import('../src/core/traex-native-context.js');

    const first = buildFollowUpCliInput('first', 'sid-role-markup', opts);
    const firstAtEdge = prepareTraexNativeContext(first.content, 'native-role-markup-thread');
    expect(firstAtEdge).toMatchObject({
      includedRole: true,
      roleDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(first.content).toContain('&lt;user_message&gt;literal sample&lt;/user_message&gt;');
    expect(first.content).not.toContain('<user_message>literal sample</user_message>');
    expect(first.content).toContain('&lt;attachments&gt;literal attachment&lt;/attachments&gt;');
    expect(first.content).toContain('&lt;sender type="example" /&gt;');
    expect(first.content).toContain('&lt;/role&gt;');
    expect(first.content).toContain(
      '&lt;botmux_skills_refresh&gt;literal refresh&lt;/botmux_skills_refresh&gt;',
    );
    expect(first.content).toContain('&lt;quoted_message&gt;literal quote&lt;/quoted_message&gt;');
    expect(firstAtEdge.fixedContextBytes)
      .toBeGreaterThanOrEqual(Buffer.byteLength(role, 'utf8'));

    const nonTraex = buildFollowUpContent('legacy', 'sid-role-markup-legacy', {
      larkAppId: 'app1', chatId: 'oc_traex_role_markup', cliId: 'codex', sender: opts.sender,
    });
    expect(nonTraex).toContain('<user_message>literal sample</user_message>');

    const opening = buildNewTopicCliInput(
      'opening', 'sid-role-markup-opening', 'traex', undefined,
      undefined, undefined, undefined, undefined,
      { name: 'Bot', openId: 'ou_bot' }, 'zh', opts.sender,
      {
        larkAppId: 'app1', chatId: 'oc_traex_role_markup',
        turnId: 'om_opening_role_markup', traexRpcContextEnabled: true,
      },
    );
    expect(opening.content).toContain('&lt;user_message&gt;literal sample&lt;/user_message&gt;');
    expect(opening.content).not.toContain('<user_message>literal sample</user_message>');
    const openingPrepared = prepareTraexNativeContext(
      opening.content,
      'native-role-markup-opening-thread',
    );
    expect(openingPrepared.includedRole).toBe(true);
    expect(openingPrepared.fixedContextBytes)
      .toBeGreaterThanOrEqual(Buffer.byteLength(role, 'utf8'));

    const receipt = {
      nativeThreadId: 'native-role-markup-thread',
      roleDigest: firstAtEdge.roleDigest,
      skillCatalogDigest: firstAtEdge.skillCatalogDigest,
      turnId: 'om_first_role_markup',
      status: 'accepted' as const,
    };
    const second = prepareTraexNativeContext(
      buildFollowUpCliInput('second', 'sid-role-markup', opts).content,
      'native-role-markup-thread',
      receipt,
    );
    expect(second.content).not.toContain('ROLE_WITH_XML_EXAMPLE');
    expect(second.fixedContextBytes).toBeLessThanOrEqual(4 * 1024);
  });
});
