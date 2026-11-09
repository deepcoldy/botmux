import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor(public opts: Record<string, unknown>) {} },
}));

import { getBot, registerBot } from '../src/bot-registry.js';
import {
  patchCardStreamElement, replyMessage, sendEphemeralCard, sendMessage,
  sendUserMessage, updateCardStreamElementContent, updateCardStreamingSettings, updateMessage,
} from '../src/im/lark/client.js';
import { OutputDeliveryCoordinator } from '../src/services/output-delivery-coordinator.js';
import { OutputDeliveryJournal } from '../src/services/output-delivery-journal.js';
import { outputSnapshot } from '../src/services/universal-output-handoff.js';
import { sanitizeLocalAddressNode, sanitizeLocalAddressText } from '../src/im/lark/local-address-policy.js';
import { localAddressContextForBot } from '../src/im/lark/local-address-context.js';
import { buildTerminalUrl, resetTerminalProxy } from '../src/core/terminal-url.js';
import { resolvePluginResultAccessUrl } from '../src/core/plugin-result-access-url.js';
import { buildDashboardUrls, localHttpOrigin, workbenchEntryUrl, workbenchSpaUrl } from '../src/core/dashboard-url.js';
import { config } from '../src/config.js';
import { globalConfigPath, mergeDashboardConfig } from '../src/global-config.js';
import { resolveDashboardOrigin } from '../src/core/workbench-link.js';
import { resolveWorkflowEntryLink } from '../src/core/workflow-entry-link.js';
import { DecisionBoardService } from '../src/core/decision-board/service.js';
import { buildWorkflowSidebarEntryButton } from '../src/im/lark/workflow-sidebar-entry.js';
import { buildV3ProgressCard } from '../src/im/lark/v3-progress-card.js';
import { buildV3GateCard } from '../src/im/lark/v3-gate-card.js';
import { buildV3BlockedCard } from '../src/im/lark/v3-blocked-card.js';
import { buildSessionsDetailCard, buildSessionTerminalUrl } from '../src/im/lark/sessions-card.js';
import { composeDetail } from '../src/dashboard/session-card-model.js';
import type { SessionRow } from '../src/core/dashboard-rows.js';
import { buildSessionClosedCard, buildStreamingCard, terminalMultiUrl } from '../src/im/lark/card-builder.js';
import { buildWorktreeCleanupResultCard } from '../src/im/lark/dismiss-card.js';
import { deliverDashboardAdminLink, resolveDashboardAdminLink } from '../src/core/dashboard-command/link.js';
import { buildTrustedResultDeliveryCard } from '../src/im/lark/trusted-result-delivery-card.js';
import { flushFakeTimers } from './helpers/flush-fake-timers.js';

const skillText = '协作说明：通过 [MIX Bot 协作技能](/data00/home/alice/.agents/skills/mix-bot-collaboration/SKILL.md) 联系 CAT，返回授权提示。';
const businessUrl = 'https://example.com/v2/activity?activityId=123&path=/home/business#detail';
const card = () => ({ schema: '2.0', body: { elements: [
  { tag: 'markdown', content: skillText },
  { tag: 'button', text: { tag: 'plain_text', content: '继续' },
    value: { action: 'continue', path: '/tmp/internal-state', session_id: 's1' } },
] } });
let nextApp = 0;
/** The client marks callback values it routes; everything else must arrive as built. */
const asBuilt = (body: unknown) => JSON.parse(typeof body === 'string' ? body : JSON.stringify(body),
  (key, value) => key === '__bm_cb' ? undefined : value);

function capture() {
  const app = 'local-egress-' + nextApp++;
  registerBot({ larkAppId: app, larkAppSecret: 's', cliId: 'claude-code' });
  const writes: any[] = [];
  const write = async (args: any) => {
    writes.push(args);
    return { code: 0, data: { message_id: 'om_written' } };
  };
  getBot(app).client = {
    im: { v1: { message: { create: write, reply: write, patch: write } } },
    cardkit: { v1: { card: { settings: write }, cardElement: { content: write, patch: write } } },
    request: write,
  } as any;
  return { app, writes };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

// The transport sees host-written bodies too: it checks card link fields and
// leaves prose to the model output entries (send, final output, reply card, CoT).
describe('local addresses at the real Lark SDK write boundary', () => {
  it.each(['send', 'reply', 'dm', 'dm-deadline', 'ephemeral', 'update'] as const)(
    '%s leaves prose as written and preserves callback data', async surface => {
      const { app, writes } = capture();
      const body = JSON.stringify(card());
      if (surface === 'send') await sendMessage(app, 'oc_chat', body, 'interactive');
      if (surface === 'reply') await replyMessage(app, 'om_parent', body, 'interactive');
      if (surface === 'dm') await sendUserMessage(app, 'ou_user', body, 'interactive');
      if (surface === 'dm-deadline') await sendUserMessage(app, 'ou_user', body, 'interactive', undefined, {});
      if (surface === 'ephemeral') await sendEphemeralCard(app, 'oc_chat', 'ou_user', body);
      if (surface === 'update') await updateMessage(app, 'om_card', body);
      expect(writes).toHaveLength(1);
      const sent = surface === 'ephemeral' ? writes[0].data.card : JSON.parse(writes[0].data.content);
      expect(asBuilt(sent)).toEqual(card());
    });

  it('leaves plain text and post prose byte-identical', async () => {
    const { app, writes } = capture();
    const text = '日志位于 /tmp/diagnosis.log\n```text\nfile:///home/alice/result.md\n```\n' + businessUrl;
    await sendMessage(app, 'oc_chat', text);
    expect(JSON.parse(writes[0].data.content).text).toBe(text);
    const post = JSON.stringify({ zh_cn: { title: '报告 /Users/alice/report.md', content: [[{ tag: 'text', text: skillText }]] } });
    await sendMessage(app, 'oc_chat', post, 'post');
    expect(writes[1].data.content).toBe(post);
  });

  it('leaves streaming snapshots as written and rejects a local link field in a patched element', async () => {
    const { app, writes } = capture();
    await updateCardStreamElementContent(app, 'card1', 'body', '[技能](/data00/home/ali', 1, 'u1');
    await updateCardStreamElementContent(app, 'card1', 'body', skillText, 2, 'u2');
    await patchCardStreamElement(app, 'card1', 'body', { content: skillText }, 3, 'u3');
    await updateCardStreamingSettings(app, 'card1', { streamingMode: false, sequence: 4, uuid: 'u4', summary: '/tmp/result.md' });
    expect(writes).toHaveLength(4);
    expect(JSON.stringify(writes[0].data)).toContain('/data00/home/ali');
    for (const write of writes.slice(1, 3)) expect(JSON.stringify(write.data)).toContain(JSON.stringify(skillText).slice(1, -1));
    expect(JSON.stringify(writes[3].data)).toContain('/tmp/result.md');
    await expect(patchCardStreamElement(app, 'card1', 'open', { tag: 'button', url: 'file:///tmp/report.md' }, 5, 'u5'))
      .rejects.toMatchObject({ code: 'LOCAL_ADDRESS_OUTBOUND_REJECTED' });
    expect(writes).toHaveLength(4);
  });

  it.each([
    { tag: 'button', url: 'file:///tmp/report.md' },
    { tag: 'button', behaviors: [{ type: 'open_url', default_url: 'http://127.0.0.1:3000/report' }] },
    { tag: 'a', href: './report.md', text: '报告' },
  ])('rejects local actionable URLs before any provider write', async element => {
    const { app, writes } = capture();
    await expect(sendMessage(app, 'oc_chat', JSON.stringify({ body: { elements: [element] } }), 'interactive'))
      .rejects.toMatchObject({ code: 'LOCAL_ADDRESS_OUTBOUND_REJECTED' });
    expect(writes).toHaveLength(0);
  });

  it('leaves a safe post and media keys byte-identical', async () => {
    const { app, writes } = capture();
    const post = '{ "zh_cn": { "title": "结果", "content": [[{"tag":"a","text":"活动","href":' + JSON.stringify(businessUrl) + '}]] } }';
    await sendMessage(app, 'oc_chat', post, 'post');
    expect(writes[0].data.content).toBe(post);
    const media = '{ "file_key": "file_v2_abc" }';
    await sendMessage(app, 'oc_chat', media, 'file');
    expect(writes[1].data.content).toBe(media);
  });

  it('retries the same body and provider UUID after a transient rejection', async () => {
    vi.useFakeTimers();
    const { app, writes } = capture();
    let attempt = 0;
    (getBot(app).client as any).im.v1.message.create = async (args: any) => {
      writes.push(args);
      return ++attempt === 1 ? { code: 230049, msg: 'message is being sent' }
        : { code: 0, data: { message_id: 'om_retry' } };
    };
    const publishing = sendMessage(app, 'oc_chat', JSON.stringify(card()), 'interactive', 'stable-local-uuid');
    await flushFakeTimers(2_000);
    await expect(publishing).resolves.toBe('om_retry');
    expect(writes).toHaveLength(2);
    expect(asBuilt(writes[0].data.content)).toEqual(card());
    expect(writes[1].data).toEqual(writes[0].data);
    expect(writes[1].data.uuid).toBe('stable-local-uuid');
  });

  it('durably rejects an impossible local jump without provider writes or repeated delivery', async () => {
    vi.useFakeTimers();
    const { app, writes } = capture();
    const directory = mkdtempSync(join(tmpdir(), 'botmux-local-rejection-'));
    const journal = new OutputDeliveryJournal(directory, app);
    try {
      const body = JSON.stringify({ body: { elements: [{ tag: 'button', url: 'file:///tmp/report.md' }] } });
      const record = journal.accept(outputSnapshot(app, {
        type: 'final_output', sessionId: 'sid-local', turnId: 'om_local', content: body, lastUuid: 'local-rejection',
      }), { kind: 'im', context: { target: { mode: 'thread', rootMessageId: 'om_root' } }, chatId: 'oc_chat', chatType: 'group' });
      const deps = {
        owns: () => true,
        process: vi.fn(async () => ({ status: 'delivered' as const,
          messageId: await sendMessage(app, 'oc_chat', body, 'interactive') })),
        settled: vi.fn(), error: vi.fn(),
      };
      const coordinator = new OutputDeliveryCoordinator(journal);
      await coordinator.deliver(record, deps);
      expect(journal.read(record.id)?.state).toBe('rejected');
      expect(journal.read(record.id)?.reason).not.toContain('/tmp/');
      await vi.advanceTimersByTimeAsync(65_000);
      await coordinator.deliver(record, deps);
      expect(journal.pending()).toEqual([]);
      expect(deps.process).toHaveBeenCalledOnce();
      expect(deps.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'LOCAL_ADDRESS_OUTBOUND_REJECTED' }), true);
      expect(deps.settled).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
    } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});

// No public external host configured: getLocalIp() is the advertised host, so
// the host's own capability links point at this machine's interface.
describe('host capability links in a default LAN deployment', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-lan-links-'));
    vi.stubEnv('HOME', home);
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
  });
  afterEach(() => {
    resetTerminalProxy(); vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  const writeToken = '0123456789abcdef0123456789abcdef';
  const viewToken = 'view_Token-abcdefghijklmnopqrstuvwxyz012345';
  const terminal = (workerPort = 45678) => buildTerminalUrl({
    session: { sessionId: 'sid-lan' }, workerPort, workerToken: writeToken, workerViewToken: viewToken,
  });
  const webOrigin = (port: number | string) => localHttpOrigin(config.web.externalHost, port);
  const dashboardOrigin = () => localHttpOrigin(config.dashboard.externalHost, config.dashboard.port);
  const linkCard = (url: string) => JSON.stringify({ body: { elements: [{ tag: 'button', url }] } });
  const multiCard = (multi_url: Record<string, string>) => JSON.stringify({ body: { elements: [{ tag: 'button', multi_url }] } });
  const rejected = { code: 'LOCAL_ADDRESS_OUTBOUND_REJECTED' };

  it('sends the Web terminal button the host built for a direct-port worker', async () => {
    const { app, writes } = capture();
    const terminalUrl = terminal();
    expect(() => sanitizeLocalAddressNode({ url: terminalUrl })).toThrow();
    const streaming = buildStreamingCard('sid-lan', 'om_root', terminalUrl, 'title', 'screen', 'working');
    await sendMessage(app, 'oc_chat', streaming, 'interactive');
    expect(writes).toHaveLength(1);
    expect(writes[0].data.content).toContain(terminalUrl);
  });

  it('sends the terminal button wrapped for the Feishu sidebar, judging the page inside the wrapper', async () => {
    const { app, writes } = capture();
    mergeDashboardConfig({ openTerminalInFeishu: true });
    const terminalUrl = terminal();
    const multi = terminalMultiUrl(terminalUrl);
    expect(multi.url.startsWith('https://applink.feishu.cn/client/web_url/open?')).toBe(true);
    expect(multi.android_url).toBe(terminalUrl);
    expect(() => sanitizeLocalAddressNode({ url: multi.url })).toThrow();
    await sendMessage(app, 'oc_chat', buildStreamingCard('sid-lan', 'om_root', terminalUrl, 'title', 'screen', 'working'), 'interactive');
    await sendMessage(app, 'oc_chat', multiCard({ url: multi.url, pc_url: multi.pc_url }), 'interactive');
    expect(writes).toHaveLength(2);
    expect(writes[0].data.content).toContain(JSON.stringify(multi.url).slice(1, -1));
    const devServer = terminalMultiUrl(`${webOrigin(5173)}/`);
    await expect(sendMessage(app, 'oc_chat', multiCard({ url: devServer.url, pc_url: devServer.pc_url }), 'interactive'))
      .rejects.toMatchObject(rejected);
    expect(sanitizeLocalAddressText(`[打开](${devServer.url}) 或 ${devServer.url}`, localAddressContextForBot(app)))
      .not.toContain('5173');
  });

  it.each([
    ['configured', undefined],
    ['fallback', Number(config.dashboard.port) + 4],
  ] as const)('sends the trusted plugin result card on the %s dashboard port', async (_kind, boundPort) => {
    if (boundPort) {
      mkdirSync(join(home, '.botmux'), { recursive: true });
      writeFileSync(join(home, '.botmux', '.dashboard-port'), String(boundPort));
    }
    const { app, writes } = capture();
    const accessUrl = resolvePluginResultAccessUrl('view_token_abcdefghijklmnopqrstuvwxyz')!;
    expect(() => sanitizeLocalAddressNode({ android_url: accessUrl })).toThrow();
    const entry = buildTrustedResultDeliveryCard({
      accessUrl, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), brand: 'feishu',
    });
    if (boundPort) expect(new URL(accessUrl).port).toBe(String(boundPort));
    await sendMessage(app, 'oc_chat', entry, 'interactive');
    expect(writes).toHaveLength(1);
    expect(writes[0].data.content).toContain(accessUrl);
  });

  it.each([
    ['progress', () => buildV3ProgressCard({ runId: 'lan-run-1', status: 'running', source: { kind: 'ad_hoc' },
      counts: { total: 1, done: 0, running: 1, waiting: 0, blocked: 0, failed: 0, skipped: 0, cancelled: 0, pending: 0 },
      currentNodeIds: ['n1'], waitingNodeIds: [], loops: [], revisit: { count: 0, refreshedNodeIds: [] }, updatedAt: '2026-07-11T12:34:56.000Z',
      terminal: { sessionId: 'sid-v3', webPort: 8765, viewToken } } as any)],
    ['gate', () => buildV3GateCard({ runId: 'lan-run-1', waitId: 'w1', nodeId: 'review', prompt: 'approve?' })],
    ['blocked', () => buildV3BlockedCard({ runId: 'lan-run-1', nodeId: 'n1', attemptId: 'a1', message: 'stuck' })],
  ] as const)('sends the v3 %s card with its run links', async (kind, build) => {
    const { app, writes } = capture();
    const body = build();
    const links = [...body.matchAll(/"(?:url|android_url)":"(http:[^"]+)"/g)].map(match => match[1]!);
    expect(links.some(url => url.endsWith('/#/v3/lan-run-1'))).toBe(true);
    if (kind === 'progress') expect(links.some(url => url.endsWith(`:8765/?viewToken=${viewToken}`))).toBe(true);
    for (const url of links) expect(() => sanitizeLocalAddressNode({ url })).toThrow();
    await sendMessage(app, 'oc_chat', body, 'interactive');
    expect(writes).toHaveLength(1);
    for (const url of links) expect(writes[0].data.content).toContain(url);
  });

  it('sends session detail cards, leaving out only a direct-port link that carries no capability', async () => {
    const { app, writes } = capture();
    const rows = [
      { sessionId: 'sid-other-bot', larkAppId: 'cli_other_bot', proxyPort: 8801, webPort: 40001 },
      { sessionId: 'sid-direct', larkAppId: 'cli_other_bot', webPort: 40002 },
    ].map(over => ({ rootMessageId: 'om_root', chatId: 'oc_chat', chatType: 'group', title: 't', cliId: 'claude-code',
      workingDir: '~/work', status: 'idle', lastMessageAt: 1, cliVersion: 'unknown', scope: 'thread', spawnedAt: 0,
      isOncall: false, hasHistory: true, ...over }) as SessionRow);
    const proxyUrl = buildSessionTerminalUrl(rows[0]!)!;
    expect(proxyUrl).toBe(`${webOrigin(8801)}/s/sid-other-bot`);
    expect(() => sanitizeLocalAddressNode({ url: proxyUrl })).toThrow();
    expect(buildSessionTerminalUrl(rows[1]!)).toBeNull();
    for (const row of rows) {
      await sendMessage(app, 'oc_chat', buildSessionsDetailCard(composeDetail(row, 2), {
        invokerOpenId: 'ou_owner', locale: 'zh', nowMs: 2, scope: 'global', terminalUrl: buildSessionTerminalUrl(row),
      }), 'interactive');
    }
    expect(writes).toHaveLength(2);
    expect(writes[0].data.content).toContain(':8801/s/sid-other-bot');
    expect(writes[1].data.content).not.toContain(':40002');
  });

  it('sends dashboard, workbench, workflow entry and decision-board item links', async () => {
    const { app, writes } = capture();
    const entry = resolveWorkflowEntryLink({ mainLarkAppId: 'cli_main', runId: 'run-lan-1', brand: 'feishu' },
      { h5LoginAvailable: () => true })!;
    const board = new DecisionBoardService({ dataDir: home, larkAppId: () => 'cli_board', brand: () => 'feishu',
      dashboardOrigin: () => resolveDashboardOrigin() } as any).itemLinks(3);
    const dashboard = buildDashboardUrls({ host: config.dashboard.externalHost, port: config.dashboard.port,
      token: 'dash_credential_abcdefghijklmnopqrstuvwxyz' }).url;
    const links = [dashboard, workbenchEntryUrl(dashboard)!, workbenchSpaUrl(dashboard)!, entry.url, board.url!,
      buildDashboardUrls({ host: config.dashboard.externalHost, port: config.dashboard.port }).url];
    for (const url of links) expect(() => sanitizeLocalAddressNode({ url })).toThrow();
    await sendMessage(app, 'oc_chat', JSON.stringify({ body: { elements: [buildWorkflowSidebarEntryButton(entry),
      { tag: 'button', multi_url: { url: board.appLink, android_url: board.url, ios_url: board.url } },
      ...links.map(url => ({ tag: 'button', url }))] } }), 'interactive');
    expect(writes).toHaveLength(1);
    for (const url of links) expect(writes[0].data.content).toContain(url);
  });

  it('sends a host link no builder in this process produced, as a separate `botmux send` process would', async () => {
    const { app, writes } = capture();
    const links = [`${dashboardOrigin()}/#/v3/run-from-cli`, `${webOrigin(8800)}/s/sid-from-cli?viewToken=${viewToken}`];
    const card = { body: { elements: links.map(url => ({ tag: 'button', url })) } };
    expect(sanitizeLocalAddressNode(card, localAddressContextForBot(app))).toEqual(card);
    await sendMessage(app, 'oc_chat', JSON.stringify(card), 'interactive');
    expect(writes).toHaveLength(1);
  });

  it('keeps sending Dashboard links after thousands of worker terminal links', async () => {
    const { app, writes } = capture();
    for (let port = 40000; port < 45000; port++) terminal(port);
    await sendMessage(app, 'oc_chat', linkCard(`${dashboardOrigin()}/`), 'interactive');
    expect(writes).toHaveLength(1);
  });

  it('rejects other paths, routes, parameters and ports on the hosts the links use', async () => {
    const { app, writes } = capture();
    const dashboard = dashboardOrigin();
    for (const url of [
      `${webOrigin(3000)}/`, `${webOrigin(5173)}/src/main.ts`, `${webOrigin(45678)}/`, `${webOrigin(45678)}/anything`,
      `${webOrigin(45678)}/?viewToken=GUESS`, `${webOrigin(45678)}/?viewToken=${viewToken}&next=x`,
      `${webOrigin(8800)}/s/victim?token=x`, `${webOrigin(3000)}/#/v3/run-1`, terminal().replace('://', '://alice@'),
      `${dashboard}/api/sessions`, `${dashboard}/admin`, `${dashboard}/?t=GUESSED`, `${dashboard}/#/settings`,
      `${dashboard}/plugin-result-access/short`, `${dashboard}/__daemon/shutdown`,
      `https://example.com/login?next=${encodeURIComponent(`${webOrigin(3000)}/`)}`,
    ]) {
      await expect(sendMessage(app, 'oc_chat', linkCard(url), 'interactive'), url).rejects.toMatchObject(rejected);
    }
    expect(writes).toHaveLength(0);
    // Link shapes exempt card link fields only; a model reply naming the page is prose.
    expect(sanitizeLocalAddressText('终端在 ' + terminal(), localAddressContextForBot(app))).not.toContain(terminal());
  });

  it('sends host-written prose unchanged: resume command, terminal snapshot, status, cleanup and the admin Dashboard link', async () => {
    const { app, writes } = capture();
    const repo = '/root/iserver/myrepo';
    const bodies = [
      buildSessionClosedCard('sid-lan', 'om_root', 'Fix bug', 'claude-code', repo, `cd ${repo} && claude --resume 1234`, 'zh'),
      buildStreamingCard('sid-lan', 'om_root', terminal(), 'title', `alice@devbox:${repo}$ ls ~/notes\nREADME.md`, 'working'),
      buildWorktreeCleanupResultCard([{ id: 'wt1', run: { status: 'removed', dir: `${repo}-wt-feature` } }], 'zh'),
    ];
    for (const body of bodies) await sendMessage(app, 'oc_chat', body, 'interactive');
    const status = `Session: sid-lan\nTerminal: ${terminal()}\nCWD: ${repo}`;
    await replyMessage(app, 'om_root', status);
    expect(writes.slice(0, 3).map(write => asBuilt(write.data.content))).toEqual(bodies.map(asBuilt));
    expect(JSON.parse(writes[3].data.content).text).toBe(status);

    const resolveLink = () => resolveDashboardAdminLink({ host: config.dashboard.externalHost,
      readPortFile: () => String(config.dashboard.port), readTokenFile: () => 'dash_credential_abcdefghijklmnopqrstuvwxyz' });
    const resolved = resolveLink();
    if (!resolved.ok) throw new Error('dashboard link unavailable');
    const reply = vi.fn(async () => undefined);
    const admin = { larkAppId: app, rootId: 'om_root', adminOpenId: 'ou_admin', reply };
    await expect(deliverDashboardAdminLink({ ...admin, message: { chatType: 'group', chatId: 'oc_chat', threadId: 'omt_1' } as any,
      seams: { resolveLink } })).resolves.toBe('dm');
    await expect(deliverDashboardAdminLink({ ...admin, message: { chatType: 'group', chatId: 'oc_chat' } as any,
      seams: { resolveLink, getChatMode: async () => 'group' } })).resolves.toBe('ephemeral');
    expect(JSON.parse(writes[4].data.content).text).toContain(resolved.link.url);
    expect(JSON.stringify(writes[5].data.card)).toContain(resolved.link.url);
  });
});
