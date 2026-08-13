import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-lock for PR D · API-only (core-only / headless) bot mode.
 *
 * apiOnly bots are driven purely over the HTTP control API and must NEVER
 * connect to Feishu at boot. The three boot-time coupling points — open_id
 * probe (/bot/v3/info), required-scope check, and the WSClient event
 * subscription — are each gated behind `!cfg.apiOnly` (or an `if (cfg.apiOnly)`
 * skip branch). These assertions pin that wiring so a refactor that drops a
 * guard turns red instead of silently making a headless bot dial Feishu.
 *
 * Negative-verified during authoring: removing any single guard fails this file.
 */
const daemonSource = readFileSync(resolve('src/daemon.ts'), 'utf8');
const registrySource = readFileSync(resolve('src/bot-registry.ts'), 'utf8');

function region(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('API-only bot mode — boot-time Feishu decoupling (source lock)', () => {
  it('skips the open_id probe for apiOnly bots and seeds a synthetic identity', () => {
    const block = region(daemonSource, 'checkAllowedChatGroupsConfig(bot);', 'checkRequiredScopes(cfg.larkAppId)');
    // The probe lives in the `else` of an `if (cfg.apiOnly)` branch.
    expect(block).toContain('if (cfg.apiOnly) {');
    expect(block).toContain('bot.botOpenId ||= `bot_${cfg.larkAppId}`;');
    // The real probe must be on the non-apiOnly side.
    const apiOnlyBranch = block.indexOf('if (cfg.apiOnly) {');
    const probeCall = block.indexOf('probeBotOpenId(cfg.larkAppId).then(');
    const elseKeyword = block.indexOf('} else {', apiOnlyBranch);
    expect(elseKeyword).toBeGreaterThan(apiOnlyBranch);
    expect(probeCall).toBeGreaterThan(elseKeyword);
  });

  it('gates the required-scope check behind !cfg.apiOnly', () => {
    const block = region(daemonSource, 'Required-scope check: 启动后 best-effort 校验', '主动开工 — 场景①');
    expect(block).toContain('if (!cfg.apiOnly) {');
    expect(block).toContain('checkRequiredScopes(cfg.larkAppId)');
    expect(block.indexOf('if (!cfg.apiOnly) {'))
      .toBeLessThan(block.indexOf('checkRequiredScopes(cfg.larkAppId)'));
  });

  it('gates the WSClient event subscription behind !cfg.apiOnly', () => {
    const block = region(daemonSource, 'botHandlers.set(cfg.larkAppId, botEventHandlers);', 'recoverV3DistillationProposalsForBot');
    // botHandlers.set stays unconditional (replay paths may read it); only the
    // WSClient start is gated.
    expect(block).toContain('if (!cfg.apiOnly) {');
    // The dispatcher start is deferred into a startEventDispatchers thunk (args
    // split across lines after the PR #597 merge); assert the gated call, not a
    // single-line arg signature.
    expect(block).toContain('startEventDispatchers.push(() => startLarkEventDispatcher(');
    expect(block.indexOf('if (!cfg.apiOnly) {'))
      .toBeLessThan(block.indexOf('startLarkEventDispatcher('));
  });

  it('exempts apiOnly bots from the larkAppSecret requirement but still type-checks it (registry)', () => {
    const block = region(registrySource, 'larkAppId is required and must be a string', 'MOSA-managed onboarding');
    // apiOnly: secret may be omitted, but if present must still be a string.
    expect(block).toContain("if (entry.apiOnly === true) {");
    expect(block).toContain("entry.larkAppSecret !== undefined && typeof entry.larkAppSecret !== 'string'");
    // Normal bots keep the hard requirement.
    expect(block).toContain("} else if (!entry.larkAppSecret || typeof entry.larkAppSecret !== 'string') {");
  });
});

describe('API-only bot mode — runtime Feishu transport gates (source lock)', () => {
  const clientSource = readFileSync(resolve('src/im/lark/client.ts'), 'utf8');
  const triggerSource = readFileSync(resolve('src/core/trigger-session.ts'), 'utf8');

  it('gates the central sessionReply transport seam on larkTransportEnabled', () => {
    // Gating at sessionReply covers ALL auxiliary worker UI (ready/screen/tui/
    // stuck/startup+exit) by construction — the codex P1-1 fix.
    const block = region(daemonSource, 'async function sessionReply(', 'const hookContext = ds ?');
    expect(block).toContain('larkTransportEnabled({');
    expect(block).toContain('apiOnly: getBot(appId).config.apiOnly');
    // Returns '' (empty id), NOT the synthetic anchor — a fake id would be stored
    // as streamCardId and a later PATCH would dial Feishu (the codex round-3 P1).
    expect(block).toContain("return '';");
    expect(block).not.toContain('return anchor;');
  });

  it('skips the getAvailableBots roster probe for no-transport sessions', () => {
    const block = region(triggerSource, 'Skip the Feishu roster probe', 'buildNewTopicCliInput(');
    expect(block).toContain('larkTransportEnabled({ chatId, apiOnly: bot.config.apiOnly })');
    expect(block).toContain('await getAvailableBots(larkAppId, chatId)');
    expect(block).toContain(': [];'); // empty roster when transport disabled
  });

  it('fail-closes the apiOnly trigger request shape (no real chat/root, requires HTTP mode)', () => {
    const block = region(triggerSource, "if (getBot(larkAppId).config.apiOnly === true) {", 'const dryRun =');
    expect(block).toContain('waitForFinalOutput && !req.options?.asyncReturnSessionId');
    expect(block).toContain('cannot target a Feishu rootMessageId');
    expect(block).toContain('cannot target a real Feishu chatId');
    expect(block).toContain('may only resume its own HTTP virtual session');
  });

  it('rejects botmux ask for no-transport sessions before the Lark dispatcher', () => {
    const block = region(daemonSource, "meeting receiver asks are not an idempotent managed action", 'canTalkChecker');
    expect(block).toContain('larkTransportEnabled({ chatId: askSession.chatId');
    expect(block).toContain("error: 'unsupported'");
  });

  it('excludes apiOnly bots from getAllBotClients (no normal-bot roster regression)', () => {
    const block = region(clientSource, 'function loadAllBotClientConfigs(', 'function getAllBotClients(');
    expect(block).toContain('c.apiOnly !== true');
    expect(block).toContain('.filter(notApiOnly)');
  });

  it('gates doc-subscription restore + comment poller behind !cfg.apiOnly', () => {
    const block = region(daemonSource, '文档订阅恢复 + 评论轮询', 'Sweep orphan sandbox trees');
    expect(block).toContain('if (!cfg.apiOnly) {');
    expect(block).toContain('restoreDocSubscriptions(activeSessions)');
    expect(block).toContain('pollWatchedDocComments(cfg.larkAppId)');
    expect(block.indexOf('if (!cfg.apiOnly) {'))
      .toBeLessThan(block.indexOf('restoreDocSubscriptions('));
  });

  it('gates allowedUsers contact resolution behind !cfg.apiOnly', () => {
    const block = region(daemonSource, 'Resolve allowed users per bot', 'needsResolve');
    expect(block).toContain('if (!cfg.apiOnly && ((bot.config.allowedUsers?.length');
  });

  it('fail-closes VC-meeting-agent config for apiOnly bots at the central accessor (blocks boot restore → lark-cli)', () => {
    // codex round-2 B2: the dashboard refuses to SET an apiOnly VC listener, but a
    // hand-edited / migrated bots.json (normal VC bot flipped to apiOnly, leaving
    // vcMeetingAgent.enabled:true + a stale runtime record on disk) would still hit
    // restoreVcMeetingRuntimeSessionsForBot at boot — whose call site is OUTSIDE the
    // `!cfg.apiOnly` block — and spawn `lark-cli vc +meeting-events --as bot`,
    // breaking zero-Feishu-network. The fix gates at the ONE central accessor every
    // VC entry funnels through (24 call sites incl. the boot restore) by delegating
    // to the pure `vcMeetingAgentConfigActive` predicate (behaviorally tested in
    // bot-registry.test.ts), which returns undefined for apiOnly.
    const block = region(daemonSource, 'function effectiveVcMeetingAgentConfig(', 'function configuredVcMeetingListenerChatId(');
    expect(block).toContain('vcMeetingAgentConfigActive(getBot(larkAppId)?.config)');
    // The predicate itself fail-closes apiOnly BEFORE the enabled check.
    const pred = region(registrySource, 'export function vcMeetingAgentConfigActive(', 'export function registerBot(');
    expect(pred).toContain('if (cfg.apiOnly === true) return undefined;');
    expect(pred.indexOf('apiOnly === true) return undefined'))
      .toBeLessThan(pred.indexOf('vcMeetingAgent?.enabled === true'));
  });
});

describe('API-only bot mode — bot-level primitive boundary (source lock)', () => {
  const clientSource = readFileSync(resolve('src/im/lark/client.ts'), 'utf8');
  const workerPoolSource = readFileSync(resolve('src/core/worker-pool.ts'), 'utf8');

  it('every outbound Feishu primitive calls assertLarkTransport before getBotClient', () => {
    // The authoritative bot-level gate: no caller can reach Feishu for an apiOnly
    // bot, regardless of session context.
    for (const op of [
      'sendMessage', 'replyMessage', 'updateMessage', 'deleteMessage',
      'addReaction', 'removeReaction', 'sendUserMessage', 'sendEphemeralCard',
      'deleteEphemeralCard', 'uploadImage', 'uploadFile',
    ]) {
      expect(clientSource, op).toContain(`assertLarkTransport(larkAppId, '${op}')`);
    }
    // assertLarkTransport (early, op-named) throws the typed error for apiOnly.
    expect(clientSource).toContain('if (apiOnly) throw new LarkTransportDisabledError');
  });

  it('getBotClient is the authoritative bot-level gate (reads AND writes)', () => {
    // The true single chokepoint: EVERY Feishu call resolves its client here, so
    // gating getBotClient covers client.ts primitives, doc-comment drive API,
    // open-platform rename/avatar, identity cache — reads included (apiOnly =
    // zero Feishu network, not merely "no writes").
    const registrySource = readFileSync(resolve('src/bot-registry.ts'), 'utf8');
    const block = region(registrySource, 'export function getBotClient(', 'return bot.client;');
    expect(block).toContain('bot.config.apiOnly === true');
    expect(block).toContain('throw new LarkTransportDisabledError(larkAppId');
    // The error class is defined in bot-registry (no import cycle) and re-exported.
    expect(registrySource).toContain('export class LarkTransportDisabledError');
    expect(clientSource).toContain('export { LarkTransportDisabledError }');
  });

  it('downloadMessageResource gates BEFORE the app→user-token fallback', () => {
    // getBotClient throws for apiOnly; without an early gate the app-token attempt
    // is caught and silently falls back to a raw user-token fetch (codex round-5).
    const clientSource = readFileSync(resolve('src/im/lark/client.ts'), 'utf8');
    const block = region(clientSource, 'export async function downloadMessageResource(', 'Try App Token first');
    expect(block).toContain("assertLarkTransport(larkAppId, 'downloadMessageResource')");
  });

  it('worker-pool suppresses ALL aux UI for no-transport sessions at managedAuxUiSuppressed', () => {
    const block = region(workerPoolSource, 'const managedAuxUiSuppressed =', 'const managedFinalOutputSuppressed');
    expect(block).toContain('larkTransportEnabled({ chatId: ds.chatId, apiOnly: getBot(ds.larkAppId).config.apiOnly })');
  });

  it('scheduleCardPatch is a defense-in-depth no-op for no-transport sessions', () => {
    const block = region(workerPoolSource, 'export function scheduleCardPatch(', 'if (streamingCardDisabled(ds, turnId)) return;');
    expect(block).toContain('larkTransportEnabled({ chatId: ds.chatId, apiOnly: getBot(ds.larkAppId).config.apiOnly })');
  });

  it('every Feishu-touching CLI command consults the central session-transport gate', () => {
    const cliSource = readFileSync(resolve('src/cli.ts'), 'utf8');
    // The central gate is defined once and keys on apiOnly bot OR virtual chatId.
    const helper = region(cliSource, 'function currentTurnHasNoTransport(', 'function assertTurnTransportOrExit(');
    expect(helper).toContain("chatId.startsWith('http_async_') || chatId.startsWith('http_wait_')");
    expect(helper).toContain('currentBotIsApiOnly(appId)');
    // Region-scoped per command (NOT file-wide contains): deleting the gate from
    // any ONE command's body must fail this test. Map op → (fn start, fn end).
    const envGated: Array<[string, string, string]> = [
      ['history', 'async function cmdHistory(', 'async function cmdQuoted('],
      ['quoted', 'async function cmdQuoted(', 'async function cmdSend('],
      ['send', 'async function cmdSend(', 'async function cmdDispatch('],
      ['dispatch', 'async function cmdDispatch(', 'async function cmdCreateGroup('],
      ['create-group', 'async function cmdCreateGroup(', 'async function cmdBots('],
    ];
    for (const [op, start, end] of envGated) {
      const body = region(cliSource, start, end);
      expect(body, `${op} env gate`).toContain(`assertTurnTransportOrExit('${op}')`);
    }
    // Target-aware gate scoped per command: --session-id-accepting commands gate
    // on the RESOLVED session (closes the cross-session bypass).
    const targetGated: Array<[string, string, string]> = [
      ['history', 'async function cmdHistory(', 'async function cmdQuoted('],
      ['quoted', 'async function cmdQuoted(', 'async function cmdSend('],
      ['send', 'async function cmdSend(', 'async function cmdDispatch('],
      ['dispatch', 'async function cmdDispatch(', 'async function cmdCreateGroup('],
    ];
    for (const [op, start, end] of targetGated) {
      const body = region(cliSource, start, end);
      expect(body, `${op} target-aware`).toContain('assertSessionTransportOrExit({ chatId: ');
    }
    // Root-dispatch gate: managed no-transport turn refused for ALL Lark-facing
    // commands, resolved via TAMPER-RESISTANT pid-marker ancestry (not raw env).
    const rootGate = region(cliSource, 'const LARK_FACING_COMMANDS = new Set(', 'switch (command) {');
    expect(rootGate).toContain('managedOriginHasNoTransport()');
    // The command set includes the verbs codex flagged (vc-agent, report).
    for (const cmd of ['send', 'dispatch', 'create-group', 'grant', 'vc-agent', 'report']) {
      expect(rootGate, `LARK_FACING has ${cmd}`).toContain(`'${cmd}'`);
    }
    // managedOriginHasNoTransport resolves via ancestry (env-independent).
    const originGate = region(cliSource, 'function managedOriginHasNoTransport(', '\n}\n');
    expect(originGate).toContain('resolveSessionContext(resolveDataDir(), process.env.BOTMUX_SESSION_ID)');
    expect(originGate).toContain('loadSessions().get(ctx.sessionId)');
    const sessGate = region(cliSource, 'function assertSessionTransportOrExit(', 'process.exit(2);\n}');
    expect(sessGate).toContain("chatId.startsWith('http_async_') || chatId.startsWith('http_wait_')");
    expect(sessGate).toContain('currentBotIsApiOnly(session.larkAppId)');
  });

  it('daemon session-write IPC routes gate no-transport via sessionTransportDisabled', () => {
    const ipcSource = readFileSync(resolve('src/core/dashboard-ipc-server.ts'), 'utf8');
    // Central daemon helper keyed on apiOnly bot OR virtual chatId.
    const helper = region(ipcSource, 'function sessionTransportDisabled(', '\n}\n');
    expect(helper).toContain('getBot(appId).config.apiOnly === true');
    expect(helper).toContain('larkTransportEnabled({');
    // Region-scoped per route (NOT file-wide count): each write route's body
    // must call the gate, so deleting one seam fails.
    const routes: Array<[string, string, string]> = [
      ['chat-rename', "ipcRoute('POST', '/api/sessions/:sessionId/chat-rename'", 'groupsStore.renameChat('],
      ['write-link-card', "ipcRoute('POST', '/api/sessions/:sessionId/write-link-card'", 'deliverWriteLinkCardToOwners(ds)'],
      ['locate', "ipcRoute('POST', '/api/sessions/:sessionId/locate'", 'replyMessage('],
    ];
    for (const [name, start, end] of routes) {
      const body = region(ipcSource, start, end);
      expect(body, `${name} route`).toContain('sessionTransportDisabled(');
    }
    // resume-notice gates its notice block.
    const resumeNotice = region(ipcSource, '会话已通过命令行恢复', 'getChatMode(ds.larkAppId');
    expect(resumeNotice).toContain('!sessionTransportDisabled(ds)');
  });

  it('daemon dashboard IPC session-history + restart-notice gate no-transport sessions', () => {
    const ipcSource = readFileSync(resolve('src/core/dashboard-ipc-server.ts'), 'utf8');
    const hist = region(ipcSource, "ipcRoute('GET', '/api/sessions/:sessionId/history'", 'listChatMessages(appId');
    expect(hist).toContain('larkTransportEnabled({ chatId: session.chatId, apiOnly: getBot(appId).config.apiOnly })');
    const notice = region(ipcSource, 'function postRestartNotice(', 'localeForBot(ds.larkAppId)');
    expect(notice).toContain('larkTransportEnabled({ chatId: ds.chatId, apiOnly: getBot(ds.larkAppId).config.apiOnly })');
  });

  it('createTeamGroup: no-transport (local apiOnly + remote apiOnly) excluded from creator AND members; remote normal kept', () => {
    const dashSource = readFileSync(resolve('src/dashboard.ts'), 'utf8');
    const block = region(dashSource, 'let noTransportRosterIds', 'proxyToDaemon(plan.creatorLarkAppId');
    // Remote apiOnly detected via the federated roster's larkTransportEnabled===false
    // (propagated spoke→sync→store→roster), NOT just local bots.json.
    expect(block).toContain('buildFederatedRoster(');
    expect(block).toContain('b.larkTransportEnabled === false');
    // Local apiOnly still detected from config.
    expect(block).toContain("b.larkAppId === id)?.apiOnly === true");
    // Creator = local-online AND transport; member excludes no-transport only.
    expect(block).toContain('const canBeCreator = (id: string): boolean => !!registry.getByAppId(id) && !isNoTransportBot(id);');
    expect(block).toContain('selectedIds.filter(id => !isNoTransportBot(id))');
    expect(block).not.toContain('selectedIds.filter(canBeCreator)');
  });

  it('federation propagates larkTransportEnabled (spoke pack → sanitizer → roster)', () => {
    const store = readFileSync(resolve('src/services/federation-store.ts'), 'utf8');
    expect(store).toContain('larkTransportEnabled?: boolean;');
    // Spoke packs it from local apiOnly config.
    const spoke = readFileSync(resolve('src/dashboard/federation-spoke-api.ts'), 'utf8');
    const localBots = region(spoke, 'function localBots(', '// owner (union_id+name) federated');
    expect(localBots).toContain('larkTransportEnabled: configReadable ? !apiOnlyIds.has(b.larkAppId) : false');
    // Receiver preserves it (explicit boolean only; absent→undefined→legacy normal).
    const api = readFileSync(resolve('src/dashboard/federation-api.ts'), 'utf8');
    expect(api).toContain("larkTransportEnabled: typeof r.larkTransportEnabled === 'boolean' ? r.larkTransportEnabled : undefined");
    // Aggregated roster carries it for remote bots.
    const fedRoster = readFileSync(resolve('src/services/federation-roster.ts'), 'utf8');
    expect(fedRoster).toContain('larkTransportEnabled: b.larkTransportEnabled,');
  });

  it('no-transport session FORCES read isolation on fresh/resume/restart; adopt is refused at restore', () => {
    // fresh-spawn forkWorker (shared by fresh/resume/restart) forces read
    // isolation for a no-transport session — the fail-closed credential boundary.
    const wp = readFileSync(resolve('src/core/worker-pool.ts'), 'utf8');
    expect(wp).toContain('readIsolation: botCfg.readIsolation === true\n      || !larkTransportEnabled({ chatId: ds.chatId, apiOnly: botCfg.apiOnly })');
    // Adopt does NOT gate via the init field (the observe branch returns before
    // fs-policy is built — an init readIsolation would be a dead no-op). Instead
    // adoptSandboxBlocked refuses a no-transport adopt at daemon restore and
    // converts it to cold-start, covering "normal adopt session later flipped to
    // apiOnly then restarted".
    const gate = region(wp, 'export function adoptSandboxBlocked(', 'export function forkAdoptWorker(');
    expect(gate).toContain('botCfg.apiOnly === true');
    expect(gate).toContain("session.chatId.startsWith('http_async_') || session.chatId.startsWith('http_wait_')");
  });
});

describe('API-only bot mode — non-client direct-Feishu paths (source lock)', () => {
  it('doc-comment driveApiCall enforces the same bot-level gate', () => {
    // doc-comment has its OWN drive API (subscribe/reply/comment/reaction) that
    // bypasses im/lark/client.ts — it must call assertLarkTransport too.
    const docSource = readFileSync(resolve('src/im/lark/doc-comment.ts'), 'utf8');
    const block = region(docSource, 'async function driveApiCall(', 'const bot = getBot(larkAppId);');
    expect(block).toContain('assertLarkTransport(larkAppId');
  });

  it('worker screenshot upload is disabled for apiOnly AND virtual-session (capability rides init)', () => {
    // The worker uploads via its OWN client (utils/lark-upload), bypassing the
    // daemon getBot gate, so the no-transport capability must ride the init
    // message. Covers apiOnly bot AND a normal bot in an HTTP virtual session.
    const workerSource = readFileSync(resolve('src/worker.ts'), 'utf8');
    expect(workerSource).toContain('apiOnlyForUpload = msg.apiOnly === true');
    expect(workerSource).toContain("msg.chatId?.startsWith('http_async_')");
    expect(workerSource).toContain("if (apiOnlyForUpload)");
    // worker-pool forwards apiOnly on the init message (both fork sites).
    const wpSource = readFileSync(resolve('src/core/worker-pool.ts'), 'utf8');
    expect((wpSource.match(/apiOnly: botCfg\.apiOnly/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // And WITHHOLDS the real secret from a no-transport worker (removes the
    // capability rather than trusting a flag the sandboxed agent could flip).
    expect(wpSource).toContain("larkTransportEnabled({ chatId: ds.chatId, apiOnly: botCfg.apiOnly }) ? botCfg.larkAppSecret : ''");
  });
});

describe('API-only bot mode — apiOnly survives config reconstruction (source lock)', () => {
  it('worker init message + cred file + riff synthetic config all carry apiOnly', () => {
    const workerSource = readFileSync(resolve('src/worker.ts'), 'utf8');
    const cliSource = readFileSync(resolve('src/cli.ts'), 'utf8');
    // Worker forwards apiOnly into the sandbox env (riffModeSession reads it) and
    // persists it in the send-cred file (registerSelfFromCredFile reads it).
    expect(workerSource).toContain("sessionEnv.BOTMUX_API_ONLY = '1'");
    expect(workerSource).toContain('apiOnly: cfg.apiOnly');
    // riffModeSession synthetic BotConfig picks up the env flag.
    expect(cliSource).toContain("apiOnly: process.env.BOTMUX_API_ONLY === '1'");
    // registerSelfFromCredFile keeps apiOnly (and no longer bails on empty secret
    // when apiOnly — an apiOnly bot legitimately has none).
    expect(cliSource).toContain('cred.apiOnly === true');
  });

  it('withholds LARK_APP_SECRET from the worker CLI env for no-transport sessions', () => {
    // SEPARATE leak from the init-message field: forkWorker + forkAdoptWorker
    // inject LARK_APP_SECRET into the spawned CLI env directly from botCfg.
    const wpSource = readFileSync(resolve('src/core/worker-pool.ts'), 'utf8');
    const envInjections = wpSource.match(
      /LARK_APP_SECRET: larkTransportEnabled\(\{ chatId: ds\.chatId, apiOnly: botCfg\.apiOnly \}\) \? botCfg\.larkAppSecret : ''/g,
    ) ?? [];
    expect(envInjections.length).toBeGreaterThanOrEqual(2);
  });

  it('skips open-platform rename/avatar handler registration for apiOnly bots', () => {
    // These drive the console via a browser web-session (NOT getBotClient), so
    // the bot-level gate can't catch them — skip registration entirely.
    const daemonSrc = readFileSync(resolve('src/daemon.ts'), 'utf8');
    const block = region(daemonSrc, 'setDisplayNameRefresher(refreshBotNameState);', 'One cap implementation shared');
    expect(block).toContain('if (!cfg.apiOnly) {');
    expect(block.indexOf('if (!cfg.apiOnly) {')).toBeLessThan(block.indexOf('setBotRenamer('));
    expect(block.indexOf('if (!cfg.apiOnly) {')).toBeLessThan(block.indexOf('setBotAvatarChanger('));
  });
});

describe('API-only bot mode — riff env re-freeze + VC listener exclusion (source lock)', () => {
  it('re-freezes no-transport keys AFTER the riff env merge (backendConfig.env cannot override)', () => {
    const workerSource = readFileSync(resolve('src/worker.ts'), 'utf8');
    const block = region(workerSource, 'const mergedEnv: Record<string, string> = {', 'riffBackendConfig = Object.assign(');
    // The merge puts backendConfig.env LAST; the re-freeze must run after it.
    expect(block).toContain('delete mergedEnv.BOTMUX_LARK_APP_SECRET;');
    expect(block).toContain("mergedEnv.BOTMUX_API_ONLY = '1';");
    expect(block).toContain('mergedEnv.BOTMUX_CHAT_ID = cfg.chatId;');
    expect(block.indexOf('...cfg.backendConfig.env')).toBeLessThan(block.indexOf('delete mergedEnv.BOTMUX_LARK_APP_SECRET;'));
  });

  it('excludes apiOnly bots from VC listener options and fail-closes scope fetch', () => {
    const dashSource = readFileSync(resolve('src/dashboard.ts'), 'utf8');
    const optsBlock = region(dashSource, 'function vcMeetingListenerBotOptions(', '.map(bot => ({');
    expect(optsBlock).toContain('bot.apiOnly !== true');
    const fetchBlock = region(dashSource, 'async function fetchGrantedScopesForBot(', 'const brand =');
    expect(fetchBlock).toContain('bot.apiOnly === true');
    expect(fetchBlock).toContain('api_only_bot_has_no_feishu_credentials');
  });

  it('skips open-platform rename/avatar handler registration for apiOnly (fails closed to local rename)', () => {
    // Daemon owns the config: with the handler unregistered, the IPC route
    // returns renamer_not_wired (local displayName only, no console/Feishu call).
    const daemonSrc = readFileSync(resolve('src/daemon.ts'), 'utf8');
    expect(daemonSrc).toContain('} // end !cfg.apiOnly (open-platform rename/avatar handlers)');
  });
});

describe('API-only bot mode — no-transport fs-policy authority provenance (worker wiring source lock)', () => {
  // codex P2: prior fs-policy tests hand-fed authority roots and never touched
  // worker.ts's REAL path assembly — deleting the freeze stayed green. These
  // lock the actual worker→buildFsPolicy wiring so the freeze can't be removed
  // silently. The behavioral half lives in fs-policy.test.ts (the pure helper).
  const workerSource = readFileSync(resolve('src/worker.ts'), 'utf8');
  const workerPoolSource = readFileSync(resolve('src/core/worker-pool.ts'), 'utf8');

  it('worker passes BOTH the configured botmuxHome AND the frozen default ~/.botmux into buildFsPolicy', () => {
    const block = region(workerSource, 'const fsPolicyCtx = {', 'redirectedCliData: willRedirectCliData,');
    // configured root (= dirname(dataDir)) and the ALWAYS-frozen default root
    expect(block).toContain('botmuxHome: canonical(dirname(dataDir)),');
    expect(block).toContain('defaultBotmuxHome: canonical(defaultBotmuxHome),');
    // and the daemon-frozen loaded config path (not a BOTS_CONFIG env guess)
    expect(block).toContain('loadedBotsConfigPath: cfg.loadedBotsConfigPath ? canonical(cfg.loadedBotsConfigPath) : undefined,');
    // the OLD guess-the-dir approach is gone (no larkAuthorityRoots off env)
    expect(workerSource).not.toContain('larkAuthorityRoots');
  });

  it('worker turns an unconfined no-transport layout into a fail-closed spawn abort', () => {
    // FsPolicyConfigError (external bots-config / workingDir-is-authority) must
    // abort the spawn with a diagnostic, never fall through to an unconfined run.
    expect(workerSource).toContain('import { buildFsPolicy, compileToSeatbelt, migrateLegacySandboxFields, resolveRedirectedAdapterAuthPaths, FsPolicyConfigError }');
    const block = region(workerSource, 'const policy = (() => {', 'suppressedAuthorityPaths?.length');
    expect(block).toContain('if (err instanceof FsPolicyConfigError) {');
    expect(block).toContain('refusing to start no-transport session');
    // suppressed (dropped) authority allow paths are LOGGED, not silent
    expect(workerSource).toContain('no-transport suppressed');
  });

  it('daemon freezes the actual loaded bots-config path into the worker init message', () => {
    // getLoadedConfigPath() is host-frozen; the worker must not re-guess from env.
    const block = region(workerPoolSource, 'apiOnly: botCfg.apiOnly,', 'brand: normalizeBrand(botCfg.brand),');
    expect(block).toContain('loadedBotsConfigPath: getLoadedConfigPath(),');
    // ...and its PROVENANCE travels with it, so the child-pin decision is made
    // from a host-owned fact instead of an existence probe (see config-dir.ts).
    expect(block).toContain('loadedBotsConfigProvenance: getLoadedConfigProvenance(),');
    // Assert the import contents, not one frozen line: pinning the exact string
    // makes this fail on any unrelated addition to the same import.
    const importLine = workerPoolSource.match(/import \{[^}]*\} from '\.\.\/bot-registry\.js';/)?.[0];
    expect(importLine).toBeDefined();
    for (const sym of ['getBot', 'getAllBots', 'loadBotConfigs', 'resolveBrandLabel',
      'getLoadedConfigPath', 'getLoadedConfigProvenance', 'resolveUsageDisplay']) {
      expect(importLine, `missing ${sym}`).toContain(sym);
    }
  });
});

describe('core-only entrypoint hardening (codex 4 P1s — source lock)', () => {
  const daemonSource = readFileSync(resolve('src/daemon.ts'), 'utf8');
  const ipcSource = readFileSync(resolve('src/core/dashboard-ipc-server.ts'), 'utf8');
  const registrySource = readFileSync(resolve('src/bot-registry.ts'), 'utf8');
  const entrySource = readFileSync(resolve('src/index-core-only.ts'), 'utf8');

  it('P1-1: keeps HMAC on (authRequired:true) and only ALLOWLISTS the tight riff routes', () => {
    // The bug: authRequired:false opened all 96 IPC routes. The fix keeps auth on
    // and adds a narrow core-only public allowlist — NOT a wholesale auth-off.
    const block = region(daemonSource, 'const coreOnly = process.env.BOTMUX_CORE_ONLY', 'desc.ipcPort = ipcHandle.port;');
    expect(block).toContain('authRequired: true,');
    expect(block).toContain('coreOnlyPublicRoutes: coreOnly,');
    expect(block).not.toContain('authRequired: coreOnly');   // old auth-off gone
    expect(block).not.toContain('BOTMUX_API_REQUIRE_AUTH');  // old opt-back-in gone
    // The allowlist is exactly trigger + trigger-result + insight (NOT /answer,
    // which is askId-keyed with no session binding — codex).
    const allow = region(ipcSource, 'function routeIsCoreOnlyPublic(', '\n}\n');
    expect(allow).toContain("pathname === '/api/trigger'");
    expect(allow).toContain('trigger-result$');
    expect(allow).toContain('insight$');
    expect(allow).not.toContain('answer');
    // And the gate consults it only under the core-only flag.
    expect(ipcSource).toContain('opts.coreOnlyPublicRoutes === true && routeIsCoreOnlyPublic(method, url.pathname)');
  });

  it('P1-2: core-only skips fleet sandbox migration + synthesis ignores ambient BOTS_CONFIG', () => {
    // Migration reads/backs-up/rewrites the on-disk fleet bots.json — must not run
    // for a headless core-only service.
    expect(daemonSource).toContain("if (process.env.BOTMUX_CORE_ONLY !== '1') {\n    await migrateSandboxConfigAtStartup();");
    // Synthesis is authoritative: no early-return on BOTS_CONFIG (the old
    // `if (process.env.BOTS_CONFIG) return null;` deference is gone).
    const synth = region(registrySource, 'function maybeSynthesizeCoreOnlyConfig(', 'return configs;');
    expect(synth).toContain("if (process.env.BOTMUX_CORE_ONLY !== '1') return null;");
    expect(synth).not.toContain('if (process.env.BOTS_CONFIG) return null;');
  });

  it('P1-3: readiness barrier — gate armed BEFORE bind; control routes + /healthz 503 until ready', () => {
    // /healthz reports 503 while armed-but-not-ready (via coreOnlyNotReady()).
    const health = region(ipcSource, "ipcRoute('GET', '/healthz'", '\n});');
    expect(health).toContain('coreOnlyNotReady()');
    expect(health).toContain('503');
    // The server-level gate ALSO 503s the public control routes when not ready —
    // so a trigger during 'starting' can't slip past by skipping the healthz probe.
    expect(ipcSource).toContain('if (coreOnlyPublic && coreOnlyNotReady())');
    // Ordering: arm BEFORE the bind (no bound-but-unarmed window), release only
    // after restore, ready line last.
    const armAt = daemonSource.indexOf('armCoreOnlyReadinessGate()');
    const bindAt = daemonSource.indexOf('const ipcHandle = await startIpcServer(');
    const restoreAt = daemonSource.indexOf('await restoreActiveSessions(activeSessions');
    const readyAt = daemonSource.indexOf('setCoreOnlyReady()');
    const readyLineAt = daemonSource.indexOf('[core-only] listening on 127.0.0.1:');
    expect(armAt).toBeGreaterThan(0);
    expect(bindAt).toBeGreaterThan(armAt);             // arm BEFORE bind (P1)
    expect(restoreAt).toBeGreaterThan(bindAt);
    expect(readyAt).toBeGreaterThan(restoreAt);        // release AFTER restore
    expect(readyLineAt).toBeGreaterThan(readyAt);      // ready line after release
  });

  it('P1-4: core-only forces terminal proxy + worker HTTP to loopback (unconditional)', () => {
    expect(daemonSource).toContain("const terminalProxyHost = coreOnly ? '127.0.0.1' : config.web.host;");
    expect(daemonSource).toContain('host: terminalProxyHost,');
    // Entrypoint pins the worker HTTP host to loopback UNCONDITIONALLY (a stray
    // parent/dotenv 0.0.0.0 must not survive) and drops the legacy alias.
    expect(entrySource).toContain("process.env.BOTMUX_WORKER_HTTP_HOST = '127.0.0.1';");
    expect(entrySource).toContain('delete process.env.BOTMUX_WORKER_HOST;');
    // NOT gated on "only when unset" anymore.
    expect(entrySource).not.toContain('if (!process.env.BOTMUX_WORKER_HTTP_HOST');
  });

  it('P1-2: entrypoint strips BOTS_CONFIG so no worker fork inherits it', () => {
    // The parser ignores BOTS_CONFIG for identity, but the raw env is inherited by
    // forked workers — an agent could cat $BOTS_CONFIG. Delete it after dotenv,
    // before startDaemon (so workerForkEnv(process.env) sees it gone).
    expect(entrySource).toContain('delete process.env.BOTS_CONFIG;');
    const delAt = entrySource.indexOf('delete process.env.BOTS_CONFIG;');
    const startAt = entrySource.indexOf('await startDaemon()');
    expect(delAt).toBeGreaterThan(0);
    expect(startAt).toBeGreaterThan(delAt); // stripped BEFORE the daemon (and any fork)
    // cmdServe (the CLI spawn path) also scrubs it from the child env.
    const cliSource = readFileSync(resolve('src/cli.ts'), 'utf8');
    const serve = region(cliSource, 'async function cmdServe(', 'child.on(');
    expect(serve).toContain('delete e.BOTS_CONFIG;');
    expect(serve).toContain("BOTMUX_WORKER_HTTP_HOST: '127.0.0.1',");
  });

  it('P1(2nd round): entrypoint FREEZES a dedicated state root, ignoring ambient SESSION_DATA_DIR', () => {
    // A managed turn that spawns `serve --api-only` carries the host's
    // SESSION_DATA_DIR; core-only must NOT read/mutate that fleet store. The
    // entrypoint overwrites SESSION_DATA_DIR with a dedicated per-bot root before
    // any config module reads it.
    expect(entrySource).toContain('process.env.SESSION_DATA_DIR = frozenStateDir;');
    expect(entrySource).toContain("join(homedir(), '.botmux', 'core-only', coreBotId, 'data')");
    expect(entrySource).toContain('BOTMUX_CORE_STATE_DIR'); // explicit override knob
    // Freeze happens before startDaemon (which reads config.session.dataDir).
    const freezeAt = entrySource.indexOf('process.env.SESSION_DATA_DIR = frozenStateDir;');
    const startAt = entrySource.indexOf('await startDaemon()');
    expect(freezeAt).toBeGreaterThan(0);
    expect(startAt).toBeGreaterThan(freezeAt);
    // cmdServe also strips ambient SESSION_DATA_DIR from the spawn env.
    const cliSource = readFileSync(resolve('src/cli.ts'), 'utf8');
    const serve = region(cliSource, 'async function cmdServe(', 'child.on(');
    expect(serve).toContain('delete e.SESSION_DATA_DIR;');
  });

  it('P1(2nd round): core-only skips host-wide maintenance / auto-restart / restart-report', () => {
    // The synthetic bot is idx=0 but must NOT own fleet maintenance (global
    // botmux update + detached `botmux restart`). Gate the whole block on !coreOnly.
    expect(daemonSource).toContain('if (idx === 0 && !coreOnly) {');
    // The maintenance starter is inside that gated block.
    const block = region(daemonSource, 'if (idx === 0 && !coreOnly) {', 'Host-overload watcher');
    expect(block).toContain('startMaintenance();');
    expect(block).toContain('startCliRuntimeUpdateMonitor(');
    expect(block).toContain('sendRestartReportIfPending(');
  });

  it('P1(3rd round): core-only does NOT write shared-HOME .data-dir breadcrumb or ~/.botmux/bin wrapper', () => {
    // writePidFile writes the global ~/.botmux/.data-dir signpost + ~/.botmux/bin
    // wrapper. Both are shared-HOME: core-only must not rewrite them (would point a
    // same-HOME host operator/fleet PATH at the core-only store/canary dist, unrestored
    // on exit). breadcrumb skipped in core-only; wrapper goes to a dedicated bin dir.
    const wp = region(daemonSource, 'function writePidFile(', 'logger.info(`PID file written');
    expect(wp).toContain("if (process.env.BOTMUX_CORE_ONLY !== '1') {"); // breadcrumb gated
    // The daemon resolves the wrapper bin dir via the single source of truth.
    expect(daemonSource).toContain('const BOTMUX_BIN_DIR = resolveBotmuxWrapperBinDir(process.env);');
    // fs-policy grants the dedicated bin dir readOnly for the sandboxed no-transport turn.
    const policySrc = readFileSync(resolve('src/adapters/cli/fs-policy.ts'), 'utf8');
    expect(policySrc).toContain('`${ctx.sessionDataDir}/bin`');
  });

  it('P1(4th round): wrapper bin dir has ONE resolver; every PATH consumer routes through it (no hardcoded ~/.botmux/bin prepend)', () => {
    // codex P1: the WRITE went to a dedicated dir but the CONSUMERS (worker.ts x4,
    // tmux x2) still prepended the shared ~/.botmux/bin — so PATH became
    // shared:dedicated:… and `command -v botmux` hit the shared/fleet wrapper.
    const wrapperSrc = readFileSync(resolve('src/core/botmux-wrapper.ts'), 'utf8');
    expect(wrapperSrc).toContain('export function resolveBotmuxWrapperBinDir(');
    expect(wrapperSrc).toContain("env.BOTMUX_CORE_ONLY === '1' && env.SESSION_DATA_DIR");
    // worker.ts: all 4 PATH prepends go through the resolver; NO hardcoded bin join.
    const workerSrc = readFileSync(resolve('src/worker.ts'), 'utf8');
    const prependCount = (workerSrc.match(/prependBotmuxBin\(resolveBotmuxWrapperBinDir\(process\.env\)/g) || []).length;
    expect(prependCount).toBeGreaterThanOrEqual(4);
    expect(workerSrc).not.toContain("join(homedir(), '.botmux', 'bin')");
    // worker-pool: fork PATH via the resolver.
    const wpSrc = readFileSync(resolve('src/core/worker-pool.ts'), 'utf8');
    expect(wpSrc).toContain('const botmuxBinDir = resolveBotmuxWrapperBinDir(process.env);');
    expect(wpSrc).not.toContain("join(homedir(), '.botmux', 'bin')");
    // tmux backend: pane scripts bake a HOST-RESOLVED bin dir literal (codex P1:
    // the pane can't resolve at runtime — BOTMUX_CORE_ONLY/SESSION_DATA_DIR are
    // scrubbed before the script runs). shellWrapperScript(binDir) takes it as an
    // arg; call sites resolve via resolveBotmuxWrapperBinDir(opts.env). NO hardcoded
    // $HOME/.botmux/bin and NO runtime-env shell resolution.
    const tmuxSrc = readFileSync(resolve('src/adapters/backend/tmux-backend.ts'), 'utf8');
    expect(tmuxSrc).toContain('export function shellWrapperScript(binDir: string)');
    expect(tmuxSrc).toContain('resolveBotmuxWrapperBinDir(opts.env ?? process.env)');
    expect(tmuxSrc).not.toContain('export PATH="$HOME/.botmux/bin:$PATH"');
    expect(tmuxSrc).not.toContain('botmuxWrapperPathExportSh'); // footgun removed
    // The other two persistent backends resolve host-side too (not the old const).
    for (const f of ['src/adapters/backend/tmux-pipe-backend.ts', 'src/adapters/backend/zellij-backend.ts']) {
      const src = readFileSync(resolve(f), 'utf8');
      expect(src, f).toContain('shellWrapperScript(resolveBotmuxWrapperBinDir(opts.env ?? process.env))');
      // No longer IMPORTS or CALLS the old const (a lingering mention in a prose
      // comment is fine — assert the import + call-site are gone, not the word).
      expect(src, f).not.toMatch(/import \{[^}]*\bSHELL_WRAPPER_SCRIPT\b/);
      expect(src, f).not.toMatch(/'-c', SHELL_WRAPPER_SCRIPT\b/);
    }
  });
});
