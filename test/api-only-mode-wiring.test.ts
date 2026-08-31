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

/** Drop whole-line `//` comments so a commented-out copy of the correct code
 *  cannot satisfy a source-lock while the live statement is broken. */
function stripLineComments(source: string): string {
  return source.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
}

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
    // The predicate itself fail-closes apiOnly BEFORE any enabled logic.
    const pred = region(registrySource, 'export function vcMeetingAgentConfigActive(', 'export function registerBot(');
    expect(pred).toContain('if (cfg.apiOnly === true) return undefined;');
    // Bot-agnostic join (2026-08): VC is active by default; enabled:false is the
    // per-bot opt-out. apiOnly must still short-circuit BEFORE that opt-out check.
    expect(pred.indexOf('apiOnly === true) return undefined'))
      .toBeLessThan(pred.indexOf('vcMeetingAgent?.enabled === false'));
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

  it('worker-pool suppresses ALL aux UI for no-transport sessions in managedAuxUiSuppressed', () => {
    // Plan B merge (2026-08): master had refactored this into a shared
    // auxUiSuppressedFor() that managedAuxUiSuppressed delegated to — but that
    // shared helper gates on the pre-Plan-B `vcMeetingReceiver` blanket, which
    // would re-suppress a plain user turn on a meeting-agent chat session (the
    // "手动@不回复" regression). So the merge KEEPS managedAuxUiSuppressed inline
    // with the no-transport gate + isMeetingDrivenTurn. Lock the no-transport
    // gate in its live home (the closure), not the delegation.
    const closure = region(workerPoolSource, 'const managedAuxUiSuppressed =', 'const managedFinalOutputSuppressed');
    expect(closure).toContain('larkTransportEnabled({ chatId: ds.chatId, apiOnly: getBot(ds.larkAppId).config.apiOnly })');
    expect(closure).toContain('return true;');
    // auxUiSuppressedFor still exists for the mojo quarantine caller and keeps its
    // own no-transport gate (fail-closed behaviour covered behaviourally in
    // test/mojo-quarantine-notice-policy.test.ts).
    const shared = region(workerPoolSource, 'export function auxUiSuppressedFor(', 'isSilentScheduledTurn');
    expect(shared).toContain('larkTransportEnabled({');
    expect(shared).toContain('apiOnly: getBot(ds.larkAppId).config.apiOnly,');
  });

  it('managedAuxUiSuppressed no longer special-cases a VC meeting agent (Plan B: ordinary chat session)', () => {
    // Plan B: a VC meeting agent is an ordinary chat-scope session, so its
    // streaming card / reactions flow through the ordinary suppression path just
    // like any group session. The old `vcMeetingReceiver` branch (and the
    // exposeReceiverStreamingCard opt-in it delegated to) is gone; the final
    // group-posting policy (silent vs listener_thread) is enforced separately in
    // managedFinalOutputSuppressed, not here.
    const block = region(workerPoolSource, 'const managedAuxUiSuppressed =', 'const managedFinalOutputSuppressed');
    expect(block).not.toContain('vcMeetingReceiver');
    expect(block).not.toContain('vcReceiverStreamingCardSuppressed');
    expect(block).toContain('return ordinaryManagedSuppression(turnId, dispatchAttempt);');
  });

  it('managedFinalOutputSuppressed gates the VC durable policy to meeting-driven turns only (plain user turns post normally)', () => {
    // Plan B: the meeting agent hosts BOTH transcript deliveries and plain user
    // IM turns. The durable silent/listener_thread policy must apply only to a
    // meeting-driven turn — a durable delivery (dispatchAttempt) or a stamped
    // meeting @mention follow-up (isMeetingDrivenTurn). A plain user turn has
    // neither and must fall to ordinaryManagedSuppression so the user's own reply
    // is never wrongly suppressed.
    const block = region(workerPoolSource, 'const managedFinalOutputSuppressed', 'const bot = getBot(ds.larkAppId);');
    expect(block).toContain('if (!isMeetingDrivenTurn(ds, turnId, dispatchAttempt)) {');
    expect(block).toContain('return ordinaryManagedSuppression(turnId, dispatchAttempt);');
    // The durable send-policy check still runs for meeting-driven turns.
    expect(block).toContain('evaluateVcMeetingManagedSend(config.session.dataDir, {');
  });

  it('isMeetingDrivenTurn distinguishes transcript deliveries / stamped follow-ups from plain user turns', () => {
    // The shared module-level gate both managedAuxUiSuppressed /
    // managedFinalOutputSuppressed (setupWorkerHandlers) and deliverFinalOutput
    // consult. A non-meeting session is never meeting-driven; a delivery carries a
    // dispatchAttempt; an @mention follow-up is recognised by its stamped origin.
    const block = region(workerPoolSource, 'function isMeetingDrivenTurn(', 'function setupWorkerHandlers(');
    expect(block).toContain('if (!ds.session.vcMeetingReceiver) return false;');
    expect(block).toContain('if (dispatchAttempt !== undefined) return true;');
    expect(block).toContain('return resolveVcMeetingImTurnOrigin(ds.session, turnId) !== undefined;');
  });

  it('VC delivery dispatch arms the streaming-card turn (beginNewTurn) for every meeting-agent delivery', () => {
    // triggerSessionTurn (the VC transcript-delivery route) never calls
    // beginNewTurn, so the card lifecycle must be armed here — for every delivery
    // turn now that the meeting agent is an ordinary session whose card should
    // surface (no exposeReceiverStreamingCard opt-in gate anymore).
    const block = region(daemonSource, 'dispatchTurn: (request, context) => {', 'return triggerSessionTurn(');
    expect(block).not.toContain('exposeReceiverStreamingCard');
    expect(block).toContain('beginNewTurn(target, title, context.stableTurnId)');
    expect(block).toContain('target?.session.vcMeetingReceiver && context.stableTurnId');
  });

  it('Plan B keeps in-meeting output: action-request still recognises the meeting agent via the retained marker', () => {
    // The whole in-meeting text/voice output chain (request-output → action-request
    // → managed-action) authorizes against the RETAINED vcMeetingReceiver marker +
    // managedTurnOrigin/vcMeetingImTurnOrigin, all keyed by sessionId — never by the
    // activeSessions map key that Stage 1 changed. This is why in-meeting output
    // survives the normal-session refactor with no code change. Pin the entry guard
    // so a future marker cleanup can't silently kill 会中发言.
    const block = region(daemonSource, "ipcRoute('POST', '/api/vc-meetings/action-request'", 'const claimedAttempt =');
    expect(block).toContain('findActiveBySessionId(receiverSessionId)');
    expect(block).toContain('if (!ds?.session.vcMeetingReceiver) {');
    expect(block).toContain("errorCode: 'not_receiver_session'");
  });

  it('Plan B idle-gap: request-output falls back to the durable receipt when the live managedTurnOrigin was cleared', () => {
    // A meeting agent reaches idle between the delivery turn (which armed
    // ds.managedTurnOrigin) and the moment it runs request-output — the origin is
    // cleared at the delivery turn's terminal edge, so the live-origin gate fails.
    // The handler must fall back to re-deriving authority from the DURABLE delivery
    // receipt (evaluateVcMeetingManagedSend) for a claimed delivery origin, which
    // never authorizes anything the receipt itself wouldn't (attempt match +
    // dispatched/completed status + active projection). It uses forInMeetingOutput
    // so a silent responseMode (which only gates listener auto-post) does NOT block
    // in-meeting speech — the hub still applies capability + text/voiceOutputPolicy.
    const block = region(daemonSource, 'let effectiveVerified = verified;', 'if (!effectiveVerified.ok) return jsonRes');
    // The fallback runs whenever live verification failed — including while a
    // delivery turn is still executing. Live verification proves origin via the
    // rotating worker capability only, and non-sandboxed sessions have no
    // origin-channel transport for it, so gating the fallback on "live origin
    // cleared" (the old `!ds.managedTurnOrigin` guard) hard-bricked in-turn
    // speech from non-sandboxed meeting agents (idle-gap gate #5).
    expect(block).not.toContain('!ds.managedTurnOrigin');
    expect(block).toContain('claimedAttempt !== undefined');
    expect(block).toContain('evaluateVcMeetingManagedSend(config.session.dataDir, {');
    expect(block).toContain('allowTerminalReceipt: true');
    // In-meeting output channel is silent-independent (decoupled from responseMode).
    expect(block).toContain('forInMeetingOutput: true');
    // Only a listener_thread durable decision synthesizes the verified origin.
    expect(block).toContain("durable.ok && durable.kind === 'listener_thread'");
    expect(block).toContain('dispatchAttempt: claimedAttempt');
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
      ['locate', "ipcRoute('POST', '/api/sessions/:sessionId/locate'", 'sendSessionOwnerThreadNotification('],
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

  it('no-transport session read isolation FOLLOWS local sandbox config (no forced isolation); adopt is refused at restore', () => {
    // fresh-spawn forkWorker (shared by fresh/resume/restart) NO LONGER force-
    // isolates a no-transport session. readIsolation is opt-in only, driven purely
    // by explicit per-bot `readIsolation`; a no-transport session with no sandbox
    // config reads bots.json like a normal chat (accepted trade-off — lateral
    // sibling-cred protection now depends on the owner enabling sandbox).
    const wp = readFileSync(resolve('src/core/worker-pool.ts'), 'utf8');
    expect(wp).toContain('readIsolation: botCfg.readIsolation === true,');
    // The old forced-isolation disjunct is gone: readIsolation must NOT be tied to
    // transport state anymore.
    expect(wp).not.toContain('readIsolation: botCfg.readIsolation === true\n      || !larkTransportEnabled(');
    // Adopt does NOT gate via the init field (the observe branch returns before
    // fs-policy is built — an init readIsolation would be a dead no-op). Instead
    // adoptSandboxBlocked refuses a no-transport adopt at daemon restore and
    // converts it to cold-start: adopt attaches to an ALREADY-running external CLI
    // that could never be wrapped, so a no-transport turn must cold-start instead.
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
    // The gate is derived from the CENTRAL larkTransportEnabled predicate keyed on
    // the init message (msg.chatId/msg.apiOnly), NOT ambient/cfg — so a normal bot
    // in an HTTP virtual session (real creds, apiOnly=false) is still disabled.
    // Matched STRUCTURALLY (predicate + both keys), not as one exact sentence:
    // an equivalent reformat (property reorder, prettier line-wrap) must not turn
    // this guard red, or the next person deletes it instead of fixing the code.
    // Each fragment is unique in worker.ts, so the trio still pins this one site.
    // Line comments are stripped first: a commented-out copy of the correct call
    // must not satisfy the guard while the live code is broken.
    const workerSource = stripLineComments(readFileSync(resolve('src/worker.ts'), 'utf8'));
    expect(workerSource).toMatch(/apiOnlyForUpload\s*=\s*!sessionLarkTransportEnabled\(/);
    expect(workerSource).toMatch(/chatId:\s*msg\.chatId/);
    expect(workerSource).toMatch(/apiOnly:\s*msg\.apiOnly/);
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

  it('skips open-platform rename/avatar/description handler registration for apiOnly bots', () => {
    // These drive the console via a browser web-session (NOT getBotClient), so
    // the bot-level gate can't catch them — skip registration entirely.
    const daemonSrc = readFileSync(resolve('src/daemon.ts'), 'utf8');
    const block = region(daemonSrc, 'setDisplayNameRefresher(refreshBotNameState);', 'One cap implementation shared');
    expect(block).toContain('if (!cfg.apiOnly) {');
    expect(block.indexOf('if (!cfg.apiOnly) {')).toBeLessThan(block.indexOf('setBotRenamer('));
    expect(block.indexOf('if (!cfg.apiOnly) {')).toBeLessThan(block.indexOf('setBotAvatarChanger('));
    expect(block.indexOf('if (!cfg.apiOnly) {')).toBeLessThan(block.indexOf('setBotDescriptionManager('));
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

  it('excludes apiOnly bots from VC meeting preflight and fail-closes scope fetch', () => {
    // 全局「会议事件接收 Bot」下拉退役后（daemon 侧改成谁收到会议事件谁处理），
    // 会给某个 bot 开权限/订事件的入口只剩这一个 preflight。apiOnly bot 结构上收不到
    // 飞书事件，必须在跑开放平台自动化之前就被挡住。
    const dashSource = readFileSync(resolve('src/dashboard.ts'), 'utf8');
    const preflightBlock = region(dashSource, 'async function preflightVcMeetingBot(', '\n}\n');
    const guardAt = preflightBlock.indexOf("if (bot.apiOnly === true) return { ok: false, error: 'vcMeetingBot_preflight_api_only' };");
    expect(guardAt).toBeGreaterThan(-1);
    // 拦截必须排在任何开放平台调用之前（自动化 + scope 回读）。
    for (const call of ['await automateOpenPlatformSetup(', 'await validateVcMeetingScopesForBot(']) {
      const callAt = preflightBlock.indexOf(call);
      expect(callAt, `${call} not found`).toBeGreaterThan(-1);
      expect(guardAt, `apiOnly guard must precede ${call}`).toBeLessThan(callAt);
    }
    const fetchBlock = region(dashSource, 'async function fetchGrantedScopesForBot(', 'const brand =');
    expect(fetchBlock).toContain('bot.apiOnly === true');
    expect(fetchBlock).toContain('api_only_bot_has_no_feishu_credentials');
  });

  it('never seeds per-bot meeting roles while granting permissions (the cross-bot invite regression)', () => {
    // 「拉 A 进会却把 B 拉进监听群」的根因是给 bot 配置时顺手播种了一条 per-bot
    // 预设，并把执行方 appId 焊了进去（本 bot 结构上不合格时还会静默换成别人）。
    // 角色预设现在归 fleet 共享目录，执行方在读路径绑定为收到会议事件的 bot 自己；
    // 这个入口只负责权限与事件订阅，落盘只允许补 larkCliProfile。
    const dashSource = readFileSync(resolve('src/dashboard.ts'), 'utf8');
    const preflightBlock = region(dashSource, 'async function preflightVcMeetingBot(', '\n}\n');
    for (const forbidden of ['consumerProfiles', 'defaultConsumerIds', 'defaultProfileBootstrap', 'agentAppId']) {
      expect(preflightBlock, `preflight must not touch ${forbidden}`).not.toContain(`${forbidden} =`);
      expect(preflightBlock, `preflight must not touch ${forbidden}`).not.toContain(`${forbidden}:`);
    }
    // 唯一允许的落盘字段。
    const writeBlock = region(preflightBlock, 'await withFileLock(', '\n    });');
    expect(writeBlock).toContain('next.larkCliProfile = targetAppId;');
    expect(writeBlock).not.toMatch(/next\.(?!larkCliProfile\b)[A-Za-z]+\s*=/u);
  });

  it('skips open-platform rename/avatar/description handler registration for apiOnly (fails closed to local rename)', () => {
    // Daemon owns the config: with the handler unregistered, the IPC route
    // returns renamer_not_wired (local displayName only, no console/Feishu call).
    const daemonSrc = readFileSync(resolve('src/daemon.ts'), 'utf8');
    expect(daemonSrc).toContain('} // end !cfg.apiOnly (open-platform profile handlers)');
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
    // Assert the meaningful imports are present (not a frozen full-literal named-import
    // list — that list legitimately grows, e.g. resolveLarkCliLinuxStoreDir for the
    // Linux keystore fix — so match the module + the two symbols this test relies on).
    const fsPolicyImport = region(workerSource, "import {", "} from './adapters/cli/fs-policy.js';");
    expect(fsPolicyImport).toContain('buildFsPolicy');
    expect(fsPolicyImport).toContain('FsPolicyConfigError');
    const block = region(workerSource, 'const policy = (() => {', 'suppressedAuthorityPaths?.length');
    expect(block).toContain('if (err instanceof FsPolicyConfigError) {');
    expect(block).toContain('refusing to start no-transport session');
    // suppressed (dropped) authority allow paths are LOGGED, not silent
    expect(workerSource).toContain('no-transport suppressed');
  });

  it('persistent-pane guard: state-machine + injectable executor wiring (behavioral tests in read-isolation)', () => {
    // The reattach guard delegates the DECISION to evaluatePersistentPaneMigration
    // and the ORDERED, fail-closed side effects to executePersistentPaneMigration.
    // Behavioral truth table + failure-path ordering live in read-isolation.test.ts
    // (real behavioral tests, not source-locks). Here we lock the WORKER WIRING.
    expect(workerSource).toContain('const migration = evaluatePersistentPaneMigration({');
    expect(workerSource).toContain('executePersistentPaneMigration(migration, migrationEffects)');
    expect(workerSource).not.toContain('persistentPaneReattachGuardEngaged');
    // issue #1 + #4: the gate must ENTER without requiring provenance for the
    // live-pane arms (a NEITHER-file no-transport tmux pane still reaches the
    // state machine), AND must ALSO enter on ANY session/backend that has stale
    // provenance on disk — so a dead pane's leftover marker/tombstone is cleared
    // before cold-spawn even for a transport-enabled chat that turned sandbox OFF
    // (else re-enabling sandbox warm-reattaches a fresh UNisolated pane as
    // "isolated" against the stale matching marker).
    expect(workerSource).toContain(
      'const persistentPaneGuardApplies = appliedIsolationCapabilities.length > 0\n'
      + '    || (noTransportSession && isolationCapableBackend)\n'
      + '    || stalePaneMarkerPresent || policyOffTombstonePresent;',
    );
    // issue #3: tombstone authorization requires a SECURE read + schema validation,
    // not a bare lstat "present".
    expect(workerSource).toContain('policyOffTombstoneValid(readManagedOriginAuthorityFile(policyOffTombstoneFilePath))');
    // Provenance removal is VERIFIED (unlink → re-probe → throw if still present).
    const remover = region(workerSource,
      'const removeProvenanceOrThrow =', 'const staleSessionName = persistentSessionName;');
    expect(remover).toContain('hostEntryExistsNoFollow(path)');
    expect(remover).toContain('could not remove stale');
    // The effects wire the real kill/probe/clear/reselect; the executor enforces
    // ordering + stop-on-failure (proven behaviorally in read-isolation.test.ts).
    const effects = region(workerSource,
      'const migrationEffects: PersistentPaneMigrationEffects = {',
      'executePersistentPaneMigration(migration, migrationEffects)');
    expect(effects).toContain('killStalePane:');
    expect(effects).toContain('confirmPaneGone:');
    // Tri-state fix: migration teardown fail-closes on ANY non-`missing` post-kill
    // probe for EVERY backend (kill unconfirmed on `unknown` — tmux swallows kill
    // errors, zellij ignores its exit — must not publish a new generation). This is
    // STRICTER than the shared shouldRejectPersistentPostKillProbe (ZMX-only
    // unknown), which the migration path deliberately no longer uses.
    expect(effects).toContain("postKillProbe !== 'missing'");
    expect(effects).not.toContain('shouldRejectPersistentPostKillProbe(');
    // Tri-state fix: an inconclusive (`unknown`) liveness probe fails closed via a
    // dedicated effect — never clear provenance / cold-spawn around a possibly-live
    // confined pane.
    expect(effects).toContain('refuseInconclusiveProbe:');
    expect(workerSource).toContain('could not verify existing ${effectiveBackendType} pane');
    expect(effects).toContain('clearProvenanceVerified:');
    expect(effects).toContain('reselectBackend:');
    // Generational-race fix: provenance is written PENDING before spawn (a nonce
    // record both validators reject) and only rewritten to committed AFTER spawn
    // confirms a fresh, non-reattached generation.
    expect(workerSource).toContain('provenancePendingContent(nonce)');
    expect(workerSource).toContain('let pendingProvenanceCommit: PersistentPaneCommit | null = null;');
    // The PENDING presence is fed into the state machine as a dominant input.
    expect(workerSource).toContain('pendingProvenancePresent,');
    expect(workerSource).toContain('provenancePendingNonce(readManagedOriginAuthorityFile(stalePaneMarkerPath))');
    // Commit runs AFTER actuallyReattachedPersistent is known, with a generation
    // fence + compare-before-replace on the pending nonce.
    const commitBlock = region(workerSource,
      'if (pendingProvenanceCommit) {', 'finalizeCodexAppControlGeneration(');
    // Condition #2: a predicted-fresh launch that dynamically reattached a late
    // pane must tear down + refuse, not silently keep running.
    expect(commitBlock).toContain('if (actuallyReattachedPersistent) {');
    expect(commitBlock).toContain('dynamically reattached a late-arriving pane');
    // Option B: isolation-capable zellij never commits (stays pending → cold-spawn).
    expect(commitBlock).toContain("effectiveBackendType === 'zellij'");
    expect(commitBlock).toContain('does not warm-reattach');
    // Condition #3: fence + compare-before-replace + commit-fail teardown.
    expect(commitBlock).toContain('spawnGeneration !== cliSpawnGeneration');
    expect(commitBlock).toContain('provenancePendingNonce(readManagedOriginAuthorityFile(commit.path))');
    expect(commitBlock).toContain('pending proof nonce mismatch');
    expect(commitBlock).toContain('replaceManagedOriginCapabilityFile(commit.path, commit.committedContent)');
    // Teardown = kill the EXACT backend target → confirm authoritative missing →
    // else keep pending + refuse (never erase evidence of a possibly-live pane).
    // CRITICAL: must NOT name-only kill — an isolated/MCP herdr agent lives on the
    // SHARED host session `botmux`, so a name-only killPersistentSession('herdr',
    // 'botmux') would tear down every bot's agent. Mirror the migration effects:
    // target helper for herdr's agent scope, frozen-PID path for ZMX identity.
    const teardown = region(commitBlock,
      'const teardownTarget = selectedBackend.persistentBackendTarget;', 'Condition #2:');
    // Dispatches on the pure, behaviorally-tested policy (read-isolation.test.ts).
    expect(teardown).toContain('persistentTeardownKillKind({');
    expect(teardown).toContain('killPersistentBackendTarget(teardownTarget!, cfg.sessionId)');
    expect(teardown).toContain('probePersistentBackendTarget(teardownTarget!)');
    expect(teardown).toContain('ZmxBackend.killManagedSession(persistentSessionName, cfg.sessionId, resolvedZmxSessionPid)');
    expect(teardown).toContain('probeOwnedZmxSession(persistentSessionName, cfg.sessionId).probe');
    expect(teardown).toContain("postKill !== 'missing'");
    expect(teardown).toContain('pending proof retained');

    // Blocker #3: the policy-ON PENDING write is a spawn-time ADMISSION
    // PRECONDITION, not best-effort — a write failure must THROW before spawn (else
    // a late-flip reattach skips the pendingProvenanceCommit-gated teardown and
    // runs unattributed). Assert the policy-ON arm fails closed, same as policy-off.
    const pendingWrite = region(workerSource,
      "if (appliedIsolationCapabilities.length > 0 && persistentSessionName && !willReattachPersistent) {",
      "} else if (appliedIsolationCapabilities.length === 0");
    expect(pendingWrite).toContain('could not record pending isolation-marker generation proof');
    expect(pendingWrite).not.toContain('non-fatal');
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
    expect(tmuxSrc).toContain("export function shellWrapperScript(binDir: string, kind: ShellKind = 'sh')");
    expect(tmuxSrc).toContain('const wrapperBinDir = resolveBotmuxWrapperBinDir(opts.env ?? process.env);');
    expect(tmuxSrc).toContain(': shellWrapperScript(wrapperBinDir, shellKind);');
    expect(tmuxSrc).not.toContain('export PATH="$HOME/.botmux/bin:$PATH"');
    expect(tmuxSrc).not.toContain('botmuxWrapperPathExportSh'); // footgun removed
    const fishAwarePersistentBackendCalls: Record<string, RegExp> = {
      'src/adapters/backend/tmux-pipe-backend.ts': /shellWrapperScript\(\s*resolveBotmuxWrapperBinDir\(opts\.env \?\? process\.env\),\s*shellKindForPath\(shellSpec\.shell\),\s*\)/,
      'src/adapters/backend/zellij-backend.ts': /shellWrapperScript\(resolveBotmuxWrapperBinDir\(opts\.env \?\? process\.env\), kind\)/,
      'src/adapters/backend/zmx-backend.ts': /shellWrapperScript\(wrapperBinDir, shellKind\)/,
    };
    for (const [f, callPattern] of Object.entries(fishAwarePersistentBackendCalls)) {
      const src = readFileSync(resolve(f), 'utf8');
      expect(src, f).toContain('resolveBotmuxWrapperBinDir(opts.env ?? process.env)');
      expect(src, f).toMatch(callPattern);
      // No longer IMPORTS or CALLS the old const (a lingering mention in a prose
      // comment is fine — assert the import + call-site are gone, not the word).
      expect(src, f).not.toMatch(/import \{[^}]*\bSHELL_WRAPPER_SCRIPT\b/);
      expect(src, f).not.toMatch(/'-c', SHELL_WRAPPER_SCRIPT\b/);
    }
  });
});
