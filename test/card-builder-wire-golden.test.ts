/**
 * card-builder 出站卡片 JSON 的「逐字节」金样回归。
 *
 * 为什么要逐字节：卡片 JSON 是发给飞书的线上契约，且好几处（header 键序
 * title/template、config 键序、按钮键序）历史上写法不一。把 header / config /
 * 回调按钮等样板收敛成 helper 时，helper 必须保持每个调用点原有的键序——否则
 * `JSON.stringify` 结果就会悄悄变化。这里对每个被样板收敛触及的 builder 取
 * 代表性输入，把完整序列化字符串与金样逐字比较。
 *
 * 金样由收敛前的实现生成：
 *   UPDATE_CARD_GOLDEN=1 bun run vitest run test/card-builder-wire-golden.test.ts
 * 有意改卡片时才重新生成，并在 PR 里说明为什么线上 JSON 要变。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAdoptBlockedCard,
  buildAdoptSelectCard,
  buildCodexAppThreadSelectCard,
  buildConfigCard,
  buildConfigQuotaCard,
  buildConfigTextCard,
  buildForkPanelCard,
  buildGrantCard,
  buildGrantRequesterNoticeCard,
  buildGrantResultCard,
  buildPrivateSnapshotCard,
  buildQuotaExhaustedCard,
  buildQuotePickerCard,
  buildRelayPickerCard,
  buildRelayedFrozenCard,
  buildRepoSelectCard,
  buildSessionCard,
  buildSessionClosedCard,
  buildSlashListCard,
  buildStreamingCard,
  buildTuiPromptCard,
  buildTuiPromptFailedCard,
  buildTuiPromptProcessingCard,
  buildTuiPromptResolvedCard,
  buildTurnFailedCard,
} from '../src/im/lark/card-builder.js';
import { globalConfigPath } from '../src/global-config.js';

const GOLDEN_PATH = resolve('test/fixtures/card-builder-wire-golden.json');
const UPDATE = process.env.UPDATE_CARD_GOLDEN === '1';

const configData = (over: Record<string, unknown> = {}): any => ({
  larkAppId: 'app_cfg',
  botName: 'Config Bot',
  cliId: 'codex',
  cliOptions: [{ id: 'codex', label: 'Codex' }, { id: 'claude-code', label: 'Claude Code' }],
  model: null,
  modelChoices: [],
  lang: null,
  p2pMode: null,
  brandLabel: null,
  defaultWorkingDir: null,
  autoStartPrompt: null,
  customPassthroughCommands: null,
  startupCommands: null,
  teamRole: null,
  quota: null,
  admins: 2,
  booleans: [
    { key: 'disableStreamingCard', on: false },
    { key: 'silentTurnReactions', on: true },
    { key: 'writableTerminalLinkInCard', on: false },
    { key: 'privateCard', on: true },
    { key: 'autoStartOnGroupJoin', on: false },
    { key: 'autoStartOnNewTopic', on: false },
    { key: 'disableCliBypass', on: false },
    { key: 'restrictGrantCommands', on: false },
    { key: 'p2pOpen', on: true },
    { key: 'grantRequestToOwnerDm', on: false },
  ],
  ...over,
});

const projects = [
  { name: 'alpha', path: '/home/u/alpha', type: 'repo', branch: 'main' },
  { name: 'beta', path: '/home/u/beta', type: 'repo', branch: 'dev' },
  { name: 'beta-wt', path: '/home/u/beta-wt', type: 'worktree', branch: 'feat/x' },
] as any[];

const NOW = Date.UTC(2026, 9, 13, 6, 0, 0);

const failedBase = {
  rootId: 'om_root', sessionId: 'sess1', cliId: 'claude-code' as const, cliName: 'Claude Code',
  status: 'failed' as const, retryOffer: 'none' as const, locale: 'en' as const,
};

const CASES: Record<string, () => string> = {
  // ── config 三张卡（header 键序 template→title）──
  'config.main.default': () => buildConfigCard(configData()),
  'config.main.en.quota': () => buildConfigCard(configData({ quota: 12, model: 'gpt-5', modelChoices: ['gpt-5', 'o3'], lang: 'en', p2pMode: 'thread' }), 'en'),
  'config.main.zh.legacy-quota': () => buildConfigCard(configData({ quota: 5000, p2pMode: 'group' }), 'zh'),
  'config.quota.en': () => buildConfigQuotaCard(configData({ quota: 12 }), 'en'),
  'config.quota.zh': () => buildConfigQuotaCard(configData({ quota: null }), 'zh'),
  'config.text.en': () => buildConfigTextCard(configData({ brandLabel: 'Brand', autoStartPrompt: 'hello', teamRole: 'dev' }), 'en'),

  // ── 会话卡 ──
  'session.basic': () => buildSessionCard('sess1', 'om_root', 'https://term.example/s/1', 'My task', 'claude-code', false, false, 'en'),
  'session.manage': () => buildSessionCard('sess1', 'om_root', 'https://term.example/s/1', 'My task', 'codex', true, false, 'zh'),
  'session.adopt': () => buildSessionCard('sess1', 'om_root', 'https://term.example/s/1', 'My task', 'claude-code', false, true, 'en'),
  'session.noterminal': () => buildSessionCard('sess1', 'om_root', '', 'My task', undefined, false, false, undefined),
  'session.localcli': () => buildSessionCard('sess1', 'om_root', 'https://term.example/s/1', 'T', 'codex', false, false, 'en', true),
  'session.runtimename': () => buildSessionCard('sess1', 'om_root', 'https://term.example/s/1', 'T', 'codex', true, false, 'en', true, 'My Runtime'),
  'closed.resume-cmd': () => buildSessionClosedCard('sess1', 'om_root', 'My task', 'claude-code', '/work/dir', 'claude --resume abc', 'en'),
  'closed.no-cmd': () => buildSessionClosedCard('sess1', 'om_root', '', 'gemini', undefined, null, 'zh'),
  'closed.fresh': () => buildSessionClosedCard('sess1', 'om_root', 'T', 'codex', '/w', null, 'en', 'Custom', true),
  'fork.empty': () => buildForkPanelCard([], 'en'),
  'fork.children': () => buildForkPanelCard([
    { instruction: 'do a', status: 'active', link: 'https://x/a' },
    { instruction: 'do b', status: 'closed', link: 'https://x/b' },
  ], 'zh'),
  'slashlist': () => buildSlashListCard({
    cliName: 'Claude Code', builtin: ['/clear', '/compact'], adapterDefaults: ['/init'], custom: ['/mine'],
    discovered: [{ name: '/disc', description: 'a discovered one' }], workingDir: '/w', mcpServers: ['srv'],
  }, 'en'),
  'relayed-frozen': () => buildRelayedFrozenCard('Title', 'claude-code', undefined, 'en'),
  'relayed-frozen.img': () => buildRelayedFrozenCard('', 'codex', 'img_v2_abc', 'zh'),

  // ── 流式卡 / 私有快照 ──
  'stream.working.hidden': () => buildStreamingCard('sess1', 'om_root', 'https://term.example/s/1', 'Task', 'screen', 'working', 'claude-code', 'hidden', 'nonce1', undefined, false, false, 'en'),
  'stream.idle.screenshot': () => buildStreamingCard('sess1', 'om_root', 'https://term.example/s/1', 'Task', 'screen', 'idle', 'codex', 'screenshot', undefined, 'img_key', false, false, 'zh'),
  'stream.starting': () => buildStreamingCard('sess1', 'om_root', '', 'Task', '', 'starting', undefined, 'hidden', undefined, undefined, false, false, 'en'),
  'stream.adopt.takeover': () => buildStreamingCard('sess1', 'om_root', 'https://term.example/s/1', 'Task', 'screen', 'working', 'claude-code', 'hidden', undefined, undefined, true, true, 'en'),
  'stream.stalled.writable': () => buildStreamingCard('sess1', 'om_root', 'https://term.example/s/1', 'Task', 'screen', 'stalled', 'claude-code', 'hidden', undefined, undefined, false, false, 'en', undefined, 'https://term.example/w/1', true),
  'stream.interrupted': () => buildStreamingCard('sess1', 'om_root', 'https://term.example/s/1', 'Task', 'screen', 'interrupted', 'claude-code', 'hidden', undefined, undefined, false, false, 'en'),
  'snapshot.working': () => buildPrivateSnapshotCard('https://term.example/w/1', 'Task', 'working', 'claude-code', undefined, 'screen text', 'sess1', 'om_root', 'en'),
  'snapshot.idle.img': () => buildPrivateSnapshotCard('https://term.example/w/1', 'Task', 'idle', 'codex', 'img_key', '', 'sess1', 'om_root', 'zh'),

  // ── 选仓卡 ──
  'repo.select': () => buildRepoSelectCard(projects, '/home/u/alpha', 'om_root', 'en'),
  'repo.select.multi': () => buildRepoSelectCard(projects, undefined, 'om_root', 'zh', true),

  // ── 授权 / 额度 / adopt / 失败 ──
  'grant.owner': () => buildGrantCard({ ownerOpenId: 'ou_owner', targets: [{ openId: 'ou_a', name: 'Alice' }], chatId: 'oc_1', nonce: 'n1', mode: 'owner' }, 'en'),
  'grant.request': () => buildGrantCard({ ownerOpenId: 'ou_owner', targets: [{ openId: 'ou_a', name: 'Alice' }, { openId: 'ou_b', name: 'Bob' }], chatId: 'oc_1', nonce: 'n1', mode: 'request', durationMs: 3600_000, quota: 20 }, 'zh'),
  'grant.request.dm': () => buildGrantCard({ ownerOpenId: 'ou_owner', targets: [{ openId: 'ou_a', name: 'Alice' }], chatId: 'oc_1', nonce: 'n1', mode: 'request', delivery: 'dm_group', chatName: 'Team' }, 'en'),
  'grant.result.chat': () => buildGrantResultCard('chat', 'en', 5, undefined, 'ou_a'),
  'grant.result.deny': () => buildGrantResultCard('deny', 'zh'),
  'grant.result.global.plain': () => buildGrantResultCard('global', 'en', 3, Date.UTC(2026, 9, 20, 0, 0, 0)),
  'grant.notice.chat': () => buildGrantRequesterNoticeCard('chat', 'dm_group', [{ openId: 'ou_a', name: 'Alice' }], 'en', 5),
  'grant.notice.p2p-deny': () => buildGrantRequesterNoticeCard('deny', 'dm_p2p', [], 'zh'),
  'quota.exhausted': () => buildQuotaExhaustedCard('ou_a', 10, 'en'),
  'quota.exhausted.reapply': () => buildQuotaExhaustedCard('ou_a', 10, 'zh', true),
  'adopt.blocked': () => buildAdoptBlockedCard('om_root', 'sess1', 'codex', 'en'),
  'adopt.blocked.default': () => buildAdoptBlockedCard('om_root', 'sess1', undefined, 'zh'),
  'turnfailed.failed': () => buildTurnFailedCard({ ...failedBase }),
  'turnfailed.ambiguous.full': () => buildTurnFailedCard({
    ...failedBase, status: 'ambiguous', errorCode: 'cli_crash', reason: 'boom', failedAt: new Date(NOW),
    task: 'refactor everything', continuations: 2, retryOffer: 'plain' as any, retryTurnId: 'turn1',
    mentionOpenId: 'ou_a', terminalUrl: 'https://term.example/s/1',
  }),

  // ── TUI prompt ──
  'tui.prompt': () => buildTuiPromptCard('om_root', 'sess1', 'Choose <one>', [
    { text: 'Yes', selected: true }, { text: 'No', selected: false },
  ], false, undefined, 'en'),
  'tui.prompt.multi': () => buildTuiPromptCard('om_root', 'sess1', 'Pick', [
    { label: 'a', text: 'A', selected: false, type: 'toggle' },
    { label: 'b', text: 'B', selected: false, type: 'toggle' },
    { text: 'Other', selected: false, type: 'input' },
    { text: 'Go', selected: false, type: 'confirm' },
  ], true, [0], 'zh'),
  'tui.processing': () => buildTuiPromptProcessingCard('Yes *x*', 'en'),
  'tui.resolved': () => buildTuiPromptResolvedCard('Yes *x*', 'zh'),
  'tui.failed': () => buildTuiPromptFailedCard('Input was not delivered', 'en'),

  // ── 选择器（V2）──
  'relay.picker': () => buildRelayPickerCard([
    { sessionId: 's1', chatLabel: 'Team', title: 'task one', workingDir: '/w/one', cliId: 'claude-code', lastMessageAt: NOW - 90_000, chatMode: 'group', running: false },
    { sessionId: 's2', chatLabel: 'DM', title: 'task two', cliId: 'codex', lastMessageAt: NOW - 7200_000, chatMode: 'p2p', running: true },
  ], 'oc_t', 'om_t', 'ou_me', 'en', { selectedSessionId: 's1' }),
  'relay.picker.p2p-empty': () => buildRelayPickerCard([], 'oc_t', 'om_t', 'ou_me', 'zh', undefined, 'thread', 'p2p'),
  'quote.picker': () => buildQuotePickerCard([
    { containerId: 'omt_1', containerKind: 'thread', title: 'topic one', starterName: 'Alice', lastMessageAt: NOW - 60_000 },
    { containerId: 'om_2', containerKind: 'root', title: 'reply chain' },
  ], 'oc_1', 'om_root', 'ou_me', 'en', { selectedContainerId: 'omt_1' }),
  'adopt.picker.empty': () => buildAdoptSelectCard([], 'om_root', 'en'),
  'adopt.picker.entries': () => buildAdoptSelectCard([
    { source: 'tmux', tmuxTarget: '0:1.0', cliPid: 100, cliId: 'claude-code', sessionId: 'abc', cwd: '/w/a', startedAt: NOW - 5000, paneCols: 80, paneRows: 24 } as any,
  ], 'om_root', 'zh'),
  'codex-thread.select': () => buildCodexAppThreadSelectCard([
    { threadId: 'th1', name: 'Fix bug', preview: 'p', cwd: '/w/proj', updatedAtMs: NOW - 3600_000 } as any,
    { threadId: 'th2', preview: 'second', cwd: '/w/other', updatedAtMs: NOW - 86400_000 } as any,
  ], 'om_root', 'en'),
};

let home: string;
let origTZ: string | undefined;
let platformSpy: ReturnType<typeof vi.spyOn>;
const produced: Record<string, string> = {};

beforeAll(() => {
  origTZ = process.env.TZ;
  process.env.TZ = 'UTC';
});
afterAll(() => {
  if (origTZ === undefined) delete process.env.TZ; else process.env.TZ = origTZ;
  if (UPDATE) {
    mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
    const sorted = Object.fromEntries(Object.entries(produced).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(GOLDEN_PATH, JSON.stringify(sorted, null, 1) + '\n');
  }
});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'botmux-card-golden-'));
  vi.stubEnv('HOME', home);
  mkdirSync(dirname(globalConfigPath()), { recursive: true });
  platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  platformSpy.mockRestore();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('card-builder wire JSON golden (byte-for-byte)', () => {
  const golden: Record<string, string> = !UPDATE && existsSync(GOLDEN_PATH)
    ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) : {};

  for (const [name, build] of Object.entries(CASES)) {
    it(name, () => {
      const out = build();
      expect(typeof out).toBe('string');
      JSON.parse(out); // 必须是合法 JSON
      if (UPDATE) { produced[name] = out; return; }
      expect(golden[name], `no golden recorded for ${name}`).toBeDefined();
      expect(out).toBe(golden[name]);
    });
  }

  it('金样与用例一一对应（无陈旧条目）', () => {
    if (UPDATE) return;
    expect(Object.keys(golden).sort()).toEqual(Object.keys(CASES).sort());
  });
});
