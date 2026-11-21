/**
 * 任务消息签名行的「工作流 ›」侧边栏入口（设计 2026-11-03 §11.1 / §11.2 / §15.1）。
 *
 * 钉三件事：
 *   1. 只有 bot 执行模式的 run 上出现，链接指向 `/workflow/<主 Bot>/<run>`、不带凭证、按品牌出
 *      侧边栏 AppLink，按钮在签名行最右侧；
 *   2. 没有入口时（临时进程执行的 run、普通会话、拿不到 Dashboard 地址）卡片与改动前**逐字节**
 *      相同——比对的基准是改动前（0260feeaa）构建器对同一输入的产物，存在 fixtures 里。以后
 *      有意改这些卡片本身的形态时，同步重新生成这份 fixture；它只钉「入口不出现时不动卡片」；
 *   3. 卡片解析器把入口当签名行附属物略过，交接卡被子 Bot 读成输入时不多出一条链接。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildCanonicalFinalReplyCard } from '../src/im/lark/md-card.js';
import { extractCardContent } from '../src/im/lark/message-parser.js';
import { buildV3HandoffCard, buildV3NodeCard, buildV3NodeReportCard, type V3HandoffCardInput, type V3NodeCardView } from '../src/im/lark/v3-node-card.js';
import { buildV3ProgressCard, v3ProgressWorkflowEntry } from '../src/im/lark/v3-progress-card.js';
import { createV3NodeCardSync } from '../src/im/lark/v3-node-card-sync.js';
import {
  attachWorkflowSidebarEntry,
  workflowNodeSessionEntry,
  workflowSidebarEntryLink,
  type WorkflowSidebarEntryLink,
} from '../src/im/lark/workflow-sidebar-entry.js';
import { createWorkflowNodeDaemon, type WorkflowNodeDaemonDeps } from '../src/core/workflow-node-daemon.js';
import { resolveWorkflowEntryLink } from '../src/core/workflow-entry-link.js';
import type { V3ProgressView } from '../src/workflows/v3/progress-projection.js';
import { BotRun, cleanupBotRuns, reportDag, reportFiles } from './helpers/v3-external-harness.js';
import { CHAT, MAIN, SECRET, handoffWorld } from './helpers/workflow-handoff-harness.js';

afterEach(() => cleanupBotRuns());

/** 改动前（0260feeaa）各构建器对下列同一组输入的输出。 */
const BEFORE = JSON.parse(readFileSync(resolve('test/fixtures/workflow-sidebar-cards-before.json'), 'utf-8')) as Record<string, string>;

const ORIGIN = 'https://dash.example.test';
const entry = (brand: 'feishu' | 'lark' = 'feishu', runId = 'risk-261103-1010') =>
  workflowSidebarEntryLink({ dashboardOrigin: ORIGIN, mainLarkAppId: 'cli_main_app', runId, brand, sidebar: true })!;

const VIEW: V3NodeCardView = {
  runTitle: '代码风险报告', runId: 'risk-261103-1010', nodeId: 'write-report', nodeIndex: 3, nodeCount: 4,
  botName: '文档Bot', selfExecuted: false, attemptNumber: 1, status: { kind: 'handing_off' },
  upstream: [{ nodeId: 'inspect', done: true }], now: 0,
};
const HANDOFF: Omit<V3HandoffCardInput, 'target'> = {
  runTitle: '代码风险报告', nodeId: 'write-report', attemptNumber: 1, goal: '生成报告', acceptance: '有结论',
  inputs: [{ from: 'inspect', output: 'changes', name: 'changes.md' }], omitted: [],
  outputs: [{ key: 'report', path: 'risk-report.md', kind: 'markdown' }],
  resultFields: [{ name: 'message', type: 'string', required: true }], timeoutSec: 1800,
  handoffRef: 'om_handoff1', nonce: 'nonce-1',
};
const REPORT = { nodeId: 'write-report', botName: '文档Bot', summary: 'done', files: [{ key: 'report', name: 'r.md', bytes: 2048 }], elapsedMs: 360000 };
const PROGRESS = {
  runId: 'risk-261103-1010', title: '代码风险报告', status: 'running',
  source: { kind: 'ad_hoc' }, counts: { total: 4, done: 1, skipped: 0, cancelled: 0, running: 1, pending: 2, failed: 0, blocked: 0, gateWaiting: 0 },
  currentNodeIds: ['write-report'], waitingNodeIds: [], loops: [], revisit: { count: 0, refreshedNodeIds: [] },
  updatedAt: '2026-11-03T02:00:00.000Z',
} as unknown as V3ProgressView;
const PROGRESS_OPTS = { webDetailUrl: 'http://127.0.0.1:7891/#/v3/risk-261103-1010' };

function find(value: unknown, pred: (node: Record<string, any>) => boolean): Record<string, any> | undefined {
  if (Array.isArray(value)) { for (const v of value) { const hit = find(v, pred); if (hit) return hit; } return undefined; }
  if (!value || typeof value !== 'object') return undefined;
  const node = value as Record<string, any>;
  if (pred(node)) return node;
  for (const child of Object.values(node)) { const hit = find(child, pred); if (hit) return hit; }
  return undefined;
}

/** The signature row's columns, or undefined when the card has no row. */
function signatureRow(cardJson: string): Array<Record<string, any>> | undefined {
  const card = JSON.parse(cardJson);
  return card.body.elements.find((el: any) => el.element_id === 'botmux_reply_actions')?.columns;
}

function entryButton(cardJson: string): Record<string, any> | undefined {
  return find(JSON.parse(cardJson), (node) => node.tag === 'button' && /工作流 ›|Workflow ›/.test(node.text?.content ?? ''));
}

describe('entry link', () => {
  it('points at /workflow/<main app>/<run> on the Dashboard origin, with no credential, as a brand-aware sidebar AppLink', () => {
    const feishu = entry('feishu');
    expect(feishu.url).toBe(`${ORIGIN}/workflow/cli_main_app/risk-261103-1010`);
    const pc = new URL(feishu.appLink);
    expect(pc.host).toBe('applink.feishu.cn');
    expect(pc.searchParams.get('mode')).toBe('sidebar-semi');
    expect(pc.searchParams.get('url')).toBe(feishu.url);
    expect(new URL(entry('lark').appLink!).host).toBe('applink.larksuite.com');
    expect(feishu.url).not.toMatch(/[?#]/);
    // An origin that came with a token / path keeps only its origin.
    expect(workflowSidebarEntryLink({ dashboardOrigin: `${ORIGIN}/?t=secret#/x`, mainLarkAppId: 'cli_main_app', runId: 'r1', brand: 'feishu', sidebar: true })!.url)
      .toBe(`${ORIGIN}/workflow/cli_main_app/r1`);
  });

  it('card builders pick the sidebar only when the Dashboard has H5 login, and the browser page otherwise', () => {
    const input = { mainLarkAppId: 'cli_main_app', runId: 'r1', brand: 'feishu' as const };
    expect(resolveWorkflowEntryLink(input, { dashboardOrigin: () => ORIGIN, h5LoginAvailable: () => true }))
      .toEqual({ url: `${ORIGIN}/workflow/cli_main_app/r1`, appLink: expect.stringContaining('mode=sidebar-semi') });
    expect(resolveWorkflowEntryLink(input, { dashboardOrigin: () => ORIGIN, h5LoginAvailable: () => false }))
      .toEqual({ url: `${ORIGIN}/#/workflows/r1` });
    expect(resolveWorkflowEntryLink(input, { dashboardOrigin: () => undefined, h5LoginAvailable: () => true })).toBeUndefined();
  });

    it('no Dashboard address, or ids that are not path-safe → no entry', () => {
    expect(workflowSidebarEntryLink({ dashboardOrigin: undefined, mainLarkAppId: 'cli_a', runId: 'r1', brand: 'feishu', sidebar: true })).toBeUndefined();
    expect(workflowSidebarEntryLink({ dashboardOrigin: ORIGIN, mainLarkAppId: 'cli_a', runId: '../etc', brand: 'feishu', sidebar: true })).toBeUndefined();
    expect(workflowSidebarEntryLink({ dashboardOrigin: ORIGIN, mainLarkAppId: 'cli/a', runId: 'r1', brand: 'feishu', sidebar: true })).toBeUndefined();
    expect(workflowSidebarEntryLink({ dashboardOrigin: 'javascript:alert(1)', mainLarkAppId: 'cli_a', runId: 'r1', brand: 'feishu', sidebar: true })).toBeUndefined();
  });
});

describe('without an entry every card is byte-identical to before', () => {
  it.each([
    ['nodeCard', () => buildV3NodeCard(VIEW)],
    ['nodeCardBlocked', () => buildV3NodeCard({ ...VIEW, status: { kind: 'blocked', errorCode: 'BOT_REPORTED_BLOCKED', message: 'no access' } })],
    ['handoffBot', () => buildV3HandoffCard({ ...HANDOFF, target: { kind: 'bot', openId: 'ou_bot_a' } })],
    ['handoffSelf', () => buildV3HandoffCard({ ...HANDOFF, target: { kind: 'self' } })],
    ['report', () => buildV3NodeReportCard(REPORT)],
    ['progress', () => buildV3ProgressCard(PROGRESS, PROGRESS_OPTS)],
    ['finalReply', () => attachWorkflowSidebarEntry(
      buildCanonicalFinalReplyCard({ markdown: 'hello **world**', recipientOpenId: 'ou_x', locale: 'zh' }), undefined)],
    ['finalReplyActions', () => attachWorkflowSidebarEntry(
      buildCanonicalFinalReplyCard({ markdown: 'hi', recipientOpenId: 'ou_x', locale: 'zh', cardActions: { larkAppId: 'cli_x', chatId: 'oc_x', rootId: 'om_r', sessionId: 's1' } }), undefined)],
  ])('%s', (name, build) => {
    expect(BEFORE[name]).toBeTypeOf('string');
    expect(build()).toBe(BEFORE[name]);
  });

  it('progress card: only a run pinned to nodeExecutor "bot" gets the entry', () => {
    const entryFor = (app: string, run: string) => workflowSidebarEntryLink({ dashboardOrigin: ORIGIN, mainLarkAppId: app, runId: run, brand: 'feishu', sidebar: true });
    const binding = { larkAppId: 'cli_main_app', chatId: 'oc_c' };
    expect(v3ProgressWorkflowEntry({ runId: 'r1', chatBinding: binding }, entryFor)).toBeUndefined();
    expect(v3ProgressWorkflowEntry({ runId: 'r1', nodeExecutor: 'bot' }, entryFor)).toBeUndefined();
    expect(v3ProgressWorkflowEntry({ runId: 'r1', nodeExecutor: 'bot', chatBinding: binding }, entryFor)?.url)
      .toBe(`${ORIGIN}/workflow/cli_main_app/r1`);
  });

  it('reply cards: only a session carrying a workflow node marker gets the entry', () => {
    const entryFor = (app: string, run: string) => workflowSidebarEntryLink({ dashboardOrigin: ORIGIN, mainLarkAppId: app, runId: run, brand: 'feishu', sidebar: true });
    expect(workflowNodeSessionEntry(undefined, entryFor)).toBeUndefined();
    expect(workflowNodeSessionEntry({ runId: 'r1', orchestratorAppId: 'cli_main_app' }, entryFor)?.url)
      .toBe(`${ORIGIN}/workflow/cli_main_app/r1`);
  });
});

describe('with an entry each card is its old self plus exactly one button, byte for byte', () => {
  const RUN = 'risk-261103-1010';
  const SIDEBAR_URL = `https://dash.example.test/workflow/cli_main_app/${RUN}`;
  const SIDEBAR_APPLINK = 'https://applink.feishu.cn/client/web_url/open?mode=sidebar-semi&min_width=350&width=800&max_width=1200&reload=false'
    + `&url=https%3A%2F%2Fdash.example.test%2Fworkflow%2Fcli_main_app%2F${RUN}`;
  const BROWSER_URL = `https://dash.example.test/#/workflows/${RUN}`;
  const MODES = {
    // Dashboard has usable H5 login: open in the Feishu sidebar on PC.
    sidebar: {
      link: () => workflowSidebarEntryLink({ dashboardOrigin: ORIGIN, mainLarkAppId: 'cli_main_app', runId: RUN, brand: 'feishu', sidebar: true })!,
      behaviors: [{ type: 'open_url', default_url: SIDEBAR_URL, pc_url: SIDEBAR_APPLINK }],
      multiUrl: { url: SIDEBAR_APPLINK, pc_url: SIDEBAR_APPLINK, android_url: SIDEBAR_URL, ios_url: SIDEBAR_URL },
    },
    // No H5 login: open the Dashboard run page in the browser.
    browser: {
      link: () => workflowSidebarEntryLink({ dashboardOrigin: ORIGIN, mainLarkAppId: 'cli_main_app', runId: RUN, brand: 'feishu', sidebar: false })!,
      behaviors: [{ type: 'open_url', default_url: BROWSER_URL }],
      multiUrl: { url: BROWSER_URL, pc_url: BROWSER_URL, android_url: BROWSER_URL, ios_url: BROWSER_URL },
    },
  } as const;
  const button = (mode: keyof typeof MODES) => ({
    tag: 'button', element_id: 'botmux_wf_entry', text: { tag: 'plain_text', content: '工作流 ›' },
    type: 'default', size: 'small', behaviors: MODES[mode].behaviors,
  });
  const entryColumn = (mode: keyof typeof MODES) => ({ tag: 'column', width: 'auto', vertical_align: 'center', elements: [button(mode)] });
  /** The old card with its signature element folded into one row with the entry. */
  const folded = (name: string, mode: keyof typeof MODES, isSignature: (el: any) => boolean) => {
    const card = JSON.parse(BEFORE[name]!);
    const index = card.body.elements.findIndex(isSignature);
    expect(index, name).toBeGreaterThan(-1);
    card.body.elements[index] = {
      tag: 'column_set', element_id: 'botmux_reply_actions', flex_mode: 'none', horizontal_spacing: 'default',
      columns: [
        { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [card.body.elements[index]] },
        entryColumn(mode),
      ],
    };
    return JSON.stringify(card);
  };
  const lastElement = (el: any) => el.tag === 'markdown' && /^<font color='grey'>botmux · /.test(el.content);
  const footer = (el: any) => el.element_id === 'botmux_reply_footer';

  for (const mode of ['sidebar', 'browser'] as const) {
    it(`${mode}: node / handoff / report cards`, () => {
      const link = MODES[mode].link();
      expect(buildV3NodeCard({ ...VIEW, entry: link })).toBe(folded('nodeCard', mode, lastElement));
      expect(buildV3NodeCard({ ...VIEW, status: { kind: 'blocked', errorCode: 'BOT_REPORTED_BLOCKED', message: 'no access' }, entry: link }))
        .toBe(folded('nodeCardBlocked', mode, lastElement));
      expect(buildV3HandoffCard({ ...HANDOFF, target: { kind: 'bot', openId: 'ou_bot_a' }, entry: link })).toBe(folded('handoffBot', mode, footer));
      expect(buildV3HandoffCard({ ...HANDOFF, target: { kind: 'self' }, entry: link })).toBe(folded('handoffSelf', mode, lastElement));
      expect(buildV3NodeReportCard({ ...REPORT, entry: link })).toBe(folded('report', mode, lastElement));
    });

    it(`${mode}: reply cards`, () => {
      const link = MODES[mode].link();
      expect(attachWorkflowSidebarEntry(
        buildCanonicalFinalReplyCard({ markdown: 'hello **world**', recipientOpenId: 'ou_x', locale: 'zh' }), link,
      )).toBe(folded('finalReply', mode, footer));
      const withActions = JSON.parse(BEFORE.finalReplyActions!);
      withActions.body.elements.find((el: any) => el.element_id === 'botmux_reply_actions').columns.push(entryColumn(mode));
      expect(attachWorkflowSidebarEntry(
        buildCanonicalFinalReplyCard({ markdown: 'hi', recipientOpenId: 'ou_x', locale: 'zh', cardActions: { larkAppId: 'cli_x', chatId: 'oc_x', rootId: 'om_r', sessionId: 's1' } }), link,
      )).toBe(JSON.stringify(withActions));
    });

    it(`${mode}: the progress card's「Web 详情」button becomes the entry`, () => {
      const card = JSON.parse(BEFORE.progress!);
      const actions = card.elements.at(-1).actions;
      expect(actions[0].text.content).toBe('Web 详情（需登录）');
      actions[0] = { tag: 'button', text: { tag: 'plain_text', content: '工作流 ›' }, type: 'default', multi_url: MODES[mode].multiUrl };
      expect(buildV3ProgressCard(PROGRESS, { ...PROGRESS_OPTS, workflowEntry: MODES[mode].link() })).toBe(JSON.stringify(card));
    });
  }
});

describe('with an entry the button is the signature row\'s rightmost column', () => {
  const rightmost = (cardJson: string) => signatureRow(cardJson)?.at(-1)?.elements?.[0];
  const expectEntry = (cardJson: string, link: WorkflowSidebarEntryLink) => {
    const button = rightmost(cardJson);
    expect(button).toMatchObject({ tag: 'button', text: { content: '工作流 ›' } });
    expect(button!.behaviors).toEqual([{ type: 'open_url', default_url: link.url, pc_url: link.appLink }]);
  };

  it.each([
    ['node card', (e: WorkflowSidebarEntryLink) => buildV3NodeCard({ ...VIEW, entry: e })],
    ['handoff to another bot', (e: WorkflowSidebarEntryLink) => buildV3HandoffCard({ ...HANDOFF, target: { kind: 'bot', openId: 'ou_bot_a' }, entry: e })],
    ['handoff to the main bot itself', (e: WorkflowSidebarEntryLink) => buildV3HandoffCard({ ...HANDOFF, target: { kind: 'self' }, entry: e })],
    ['report card', (e: WorkflowSidebarEntryLink) => buildV3NodeReportCard({ ...REPORT, entry: e })],
  ])('%s', (_name, build) => {
    const link = entry();
    const card = build(link);
    expectEntry(card, link);
    // The signature itself stays in the row's first column.
    expect(signatureRow(card)![0]!.elements[0].content).toMatch(/botmux/);
  });

  it('the handoff\'s mention stays in its signed footer next to the entry', () => {
    const card = buildV3HandoffCard({ ...HANDOFF, target: { kind: 'bot', openId: 'ou_bot_a' }, entry: entry() });
    const footer = signatureRow(card)![0]!.elements[0];
    expect(footer.element_id).toBe('botmux_reply_footer');
    expect(footer.content).toContain('<at id=ou_bot_a></at>');
  });

  it('a reply card with other controls gets the entry after them; attaching twice is a no-op', () => {
    const link = entry();
    const base = buildCanonicalFinalReplyCard({ markdown: 'hi', recipientOpenId: 'ou_x', locale: 'zh', cardActions: { larkAppId: 'cli_x', chatId: 'oc_x', rootId: 'om_r', sessionId: 's1' } });
    const once = attachWorkflowSidebarEntry(base, link);
    expect(signatureRow(once)!.map((col) => col.elements[0].tag)).toEqual(['markdown', 'overflow', 'button']);
    expectEntry(once, link);
    expect(attachWorkflowSidebarEntry(once, link)).toBe(once);
  });

  it('a reply card whose footer is a bare element is folded into one row with the entry', () => {
    const link = entry();
    const card = attachWorkflowSidebarEntry(buildCanonicalFinalReplyCard({ markdown: 'hi', recipientOpenId: 'ou_x', locale: 'zh' }), link);
    expect(signatureRow(card)!.map((col) => col.elements[0].element_id ?? col.elements[0].tag)).toEqual(['botmux_reply_footer', 'botmux_wf_entry']);
  });

  it('a card with no signature row is left alone', () => {
    const plain = JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'x' }] } });
    expect(attachWorkflowSidebarEntry(plain, entry())).toBe(plain);
  });

  it('progress card: the「Web 详情（需登录）」button becomes the same entry', () => {
    const link = entry();
    const card = buildV3ProgressCard(PROGRESS, { ...PROGRESS_OPTS, workflowEntry: link });
    expect(card).not.toContain('Web 详情（需登录）');
    expect(card).not.toContain(PROGRESS_OPTS.webDetailUrl);
    expect(entryButton(card)!.multi_url).toEqual({ url: link.appLink, pc_url: link.appLink, android_url: link.url, ios_url: link.url });
  });
});

describe('the card parser does not read the entry as content', () => {
  it('a handoff card read by the executing bot carries no navigation link', () => {
    const plain = extractCardContent(buildV3HandoffCard({ ...HANDOFF, target: { kind: 'bot', openId: 'ou_bot_a' } }));
    const withEntry = extractCardContent(buildV3HandoffCard({ ...HANDOFF, target: { kind: 'bot', openId: 'ou_bot_a' }, entry: entry() }));
    expect(withEntry).toBe(plain);
    expect(withEntry).not.toContain('/workflow/');
  });

  it('the simplified card rendering (Format A) drops the entry too, whatever link Feishu kept on it', () => {
    const body = [[{ tag: 'text', text: '要做什么：' }], [{ tag: 'text', text: 'do it' }]];
    const link = entry();
    const browser = workflowSidebarEntryLink({ dashboardOrigin: ORIGIN, mainLarkAppId: 'cli_main_app', runId: 'r1', brand: 'feishu', sidebar: false })!;
    const formatA = (button: Record<string, unknown>) => extractCardContent(JSON.stringify({ title: '', elements: [...body, [button]] }));
    const bare = formatA({ tag: 'text', text: '' });
    for (const button of [
      { tag: 'button', text: '工作流 ›' },
      { tag: 'button', text: { tag: 'plain_text', content: 'Workflow ›' } },
      { tag: 'button', text: '工作流 ›', multi_url: { url: link.appLink, pc_url: link.appLink } },
      { tag: 'button', text: '工作流 ›', url: link.url },
      { tag: 'button', text: '工作流 ›', url: browser.url },
    ]) expect(formatA(button)).toBe(bare);
    // A third-party button that only shares the label, but goes elsewhere, is still content.
    expect(formatA({ tag: 'button', text: '工作流 ›', url: 'https://tracker.example.test/issue/1' }))
      .toContain('https://tracker.example.test/issue/1');
  });
});

describe('wiring: cards posted for a bot-executed run carry the entry', () => {
  const BINDING = { larkAppId: MAIN, chatId: CHAT, chatType: 'group' as const, rootMessageId: 'om_main' };
  const entryFor = (app: string, runId: string) => workflowSidebarEntryLink({ dashboardOrigin: ORIGIN, mainLarkAppId: app, runId, brand: 'feishu', sidebar: true });

  it('the node card and the handoff card the executor sends, and the node card it patches later', async () => {
    const run = new BotRun(reportDag('wf-entry-exec'));
    const world = handoffWorld({ workflowEntry: (runId) => entryFor(MAIN, runId) });
    await run.drive(world.executor, { opts: { chatBinding: BINDING } });
    const want = `${ORIGIN}/workflow/${MAIN}/wf-entry-exec`;
    expect(entryButton(world.lark.sent[0]!.card)!.behaviors[0].default_url).toBe(want);
    expect(entryButton(world.lark.replies[0]!.card)!.behaviors[0].default_url).toBe(want);
    expect(world.lark.patches.length).toBeGreaterThan(0);
    for (const patch of world.lark.patches) expect(entryButton(patch.card)!.behaviors[0].default_url).toBe(want);

    const patched: string[] = [];
    const sync = createV3NodeCardSync({
      baseDir: run.base, selfLarkAppId: MAIN,
      loadRun: () => ({ dag: run.dag, nodeExecutor: 'bot', title: 'report' }),
      patchCard: async (_id, card) => { patched.push(card); },
      botName: (appId) => appId,
      workflowEntry: (runId) => entryFor(MAIN, runId),
    });
    await sync('wf-entry-exec');
    expect(entryButton(patched[0]!)!.behaviors[0].default_url).toBe(want);
  });

  it('the report card the executing bot\'s daemon posts names the MAIN bot\'s run, not its own app', async () => {
    const run = new BotRun(reportDag('wf-entry-report'));
    const world = handoffWorld();
    await run.drive(world.executor, { opts: { chatBinding: BINDING } });
    const attempt = run.openAttempt('write');
    run.accept(attempt.attemptId, 'sess-a');
    const posted: string[] = [];
    const asked: Array<[string, string]> = [];
    const deps = {
      selfLarkAppId: () => 'cli_a', dataDir: () => world.dataDir, baseDir: () => run.base,
      sendCard: async () => 'om_x', replyCard: async (_root: string, card: string) => { posted.push(card); return 'om_rc'; },
      patchCard: async () => {}, resolveBotInChat: async () => ({ ok: true, openId: 'ou_x' }),
      targetOpensTopicSessions: async () => 'yes', daemonPort: () => 4100, hostSecret: () => 'h', bindingSecret: () => SECRET,
      postDaemon: async () => ({ status: 200, body: { ok: true, outcome: 'succeeded' } }),
      ensureGrant: async () => {}, loadSessions: () => [], isProcessAlive: () => true, activeSessions: () => [],
      updateSession: () => {}, interruptTurn: () => true, proveBotSender: async () => true,
      deliverSelfTurn: async () => ({ sessionId: 's' }), attachmentsDir: () => world.dataDir,
      loadRun: () => ({ dag: run.dag, nodeExecutor: 'bot' as const, chatId: CHAT, title: 't' }),
      drive: () => {}, botName: (appId: string) => appId, warn: () => {},
      workflowEntry: (app: string, runId: string) => { asked.push([app, runId]); return entryFor(app, runId); },
    } as unknown as WorkflowNodeDaemonDeps;
    const wiring = createWorkflowNodeDaemon(deps);
    const files = reportFiles();
    const result = await wiring.reportRoute(
      {
        dispatchRoot: attempt.handoffMessageId, status: 'completed', content: 'done',
        files: files.files.map((f) => ({ key: f.key, name: f.name, data: f.data.toString('base64') })),
        resultText: JSON.stringify(files.result),
      },
      () => ({ ok: true, session: { sessionId: 'sess-a', rootMessageId: attempt.nodeCardMessageId!, larkAppId: 'cli_a', chatId: CHAT, scope: 'thread' } }),
    );
    expect(result.status).toBe(200);
    expect(asked).toEqual([[MAIN, 'wf-entry-report']]);
    expect(entryButton(posted[0]!)!.behaviors[0].default_url).toBe(`${ORIGIN}/workflow/${MAIN}/wf-entry-report`);
  });
});
