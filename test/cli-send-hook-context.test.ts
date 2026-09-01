import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript, spawnTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { startOutboxWatcher } from '../src/adapters/backend/sandbox.js';
import {
  managedOriginCapabilityPath,
  RELAY_ORIGIN_CAPABILITY_BASENAME,
  replaceManagedOriginCapabilityFile,
} from '../src/core/managed-origin-capability.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliSource = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawnTsScript(join(__dirname, '..', 'src', 'cli.ts'), args, {
      cwd: join(__dirname, '..'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${stderr}`));
    }, 10_000);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('cmdSend hook context wiring', () => {
  it('passes Lark business error details through every cmdSend failure exit', () => {
    const cmdSendStart = cliSource.indexOf('async function cmdSend(');
    const cmdDispatchStart = cliSource.indexOf('async function cmdDispatch(', cmdSendStart);
    const cmdSend = cliSource.slice(cmdSendStart, cmdDispatchStart);
    expect(cliSource).toContain('describeSendFailure');
    expect(cmdSend).toContain('语音发送失败：${describeSendFailure(e)}');
    expect(cmdSend).toContain('文档评论发送失败：${describeSendFailure(e)}');
    expect(cmdSend).toContain('发送失败: ${describeSendFailure(err)}');
  });

  it('parses and relays an explicit layout before building the canonical reply card', () => {
    const cmdSendStart = cliSource.indexOf('async function cmdSend(');
    const cmdDispatchStart = cliSource.indexOf('async function cmdDispatch(', cmdSendStart);
    const cmdSend = cliSource.slice(cmdSendStart, cmdDispatchStart);
    const parseAt = cmdSend.indexOf('const replyLayoutRequest = parseReplyLayoutRequest(rest);');
    const relayAt = cmdSend.indexOf('await relaySend(rest, relayDir, replyLayout);');

    expect(parseAt).toBeGreaterThanOrEqual(0);
    expect(relayAt).toBeGreaterThan(parseAt);
    expect(cmdSend).toContain('let replyLayout = replyLayoutRequest.layout;');
    expect(cmdSend).toContain('extractFirstReplyCardHeading(text)');
    expect(cmdSend).toContain('buildReplyLayoutHeader(replyLayout, layoutBody.heading, replyStyle)');
    expect(cmdSend).toContain('resolveReplyStyle(resolveReplyStyleConfig(s.larkAppId))');
    expect(cmdSend).toContain('createReplyCard([...elements], layoutHeader)');
    expect(cmdSend).toContain('createReplyCard(elements, layoutHeader)');
    expect(cliSource).toContain('--layout result|progress|risk|blocked|handoff');
  });

  it('strips trailing memory citations before relay and direct-send rendering', () => {
    const relayStart = cliSource.indexOf('async function relaySend(');
    const relayEnd = cliSource.indexOf('\nfunction currentBotIsApiOnly', relayStart);
    const relaySend = cliSource.slice(relayStart, relayEnd);
    expect(relaySend).toContain('content = stripTrailingOaiMemoryCitation(content);');
    expect(relaySend.indexOf('content = stripTrailingOaiMemoryCitation(content);'))
      .toBeLessThan(relaySend.indexOf('prepareCardMarkdown('));

    const cmdSendStart = cliSource.indexOf('async function cmdSend(');
    const cmdDispatchStart = cliSource.indexOf('async function cmdDispatch(', cmdSendStart);
    const cmdSend = cliSource.slice(cmdSendStart, cmdDispatchStart);
    expect(cmdSend).toContain('content = stripTrailingOaiMemoryCitation(content);');
    expect(cmdSend.indexOf('content = stripTrailingOaiMemoryCitation(content);'))
      .toBeLessThan(cmdSend.indexOf('const managedPayloadError = managedVcSendPayloadError({'));
  });

  it('delegates CLI session snapshot loading to the session-store gate (scope repair lives behind it)', () => {
    const loadSessionsStart = cliSource.indexOf('function loadSessions()');
    expect(loadSessionsStart).toBeGreaterThanOrEqual(0);
    const loadSessionsEnd = cliSource.indexOf('\nfunction ', loadSessionsStart);
    const loadSessions = cliSource.slice(loadSessionsStart, loadSessionsEnd);

    // The scope repair moved behind the store gate together with the loader
    // itself — repair-on-load behavior is asserted in test/session-store.test.ts
    // (loadAllSessionsSnapshot). The CLI must not regrow a parallel reader or
    // the unlocked whole-file writer it once had.
    expect(loadSessions).toContain('loadAllSessionsSnapshot(');
    expect(loadSessions).not.toContain('readFileSync');
    expect(cliSource).not.toContain('function saveSession(');
  });

  it('passes the current session id into outbound send/reply hooks', () => {
    expect(cliSource).toContain('const hookContext = {');
    expect(cliSource).toMatch(/sendMessage\(\s*appId,\s*sendTarget\.chatId,\s*content,\s*msgType,\s*uuid,\s*hookContext,/);
    expect(cliSource).toMatch(/replyMessage\(\s*appId,\s*sendTarget\.rootMessageId,\s*content,\s*msgType,\s*sendTarget\.mode === 'thread',\s*uuid,\s*hookContext,/);
  });

  it('resolves mention-back from the exact turn instead of the latest queued sender', () => {
    expect(cliSource).toContain(
      'const replyTargetSenderOpenId = explicitVcMeetingImOrigin?.replyTargetSenderOpenId',
    );
    expect(cliSource).toContain('?? turnReplyTarget?.senderOpenId');
    expect(cliSource).toContain('hasQuoteTargetSender: !!replyTargetSenderOpenId');
    expect(cliSource).toMatch(/mentions\.push\(\{ open_id: replyTargetSenderOpenId, name: '' \}\)/);
  });

  it('gates the legacy global quote-sender fallback on NO currentTurnId — an exact-turn miss never borrows the advanced global slot (#750 cross-turn guard)', () => {
    // The reply-target sender chain is: VC → #597 frozen dispatch → exact
    // turnReplyTarget.senderOpenId → (ONLY when no currentTurnId) legacy global
    // s.quoteTargetSenderOpenId. The last hop MUST be gated on `currentTurnId`:
    // with a turnId, an exact-turn map miss/eviction resolves to NO sender, never
    // the global latest slot (which may have advanced to a DIFFERENT turn B). An
    // unconditional `?? s.quoteTargetSenderOpenId` would re-introduce the
    // cross-turn --mention-back bug #750 fixed (A evicted, global sender = B →
    // B wrongly @-ed as A's reply target). This is a precise structural guard;
    // pickTurnReplyTarget's own hit already enforces quoteTargetId===currentTurnId.
    // frozen dispatch and exact-turn hops precede the gated legacy fallback.
    expect(cliSource).toContain('?? frozenTurnDispatch?.replyTargetSenderOpenId');
    expect(cliSource).toContain('?? turnReplyTarget?.senderOpenId');
    // The legacy global slot is reachable ONLY behind the no-turn gate — assert
    // the exact gated form and FORBID any unconditional `?? s.quoteTargetSenderOpenId`.
    expect(cliSource).toContain('?? (currentTurnId ? undefined : s.quoteTargetSenderOpenId)');
    expect(cliSource).not.toMatch(/\?\?\s*s\.quoteTargetSenderOpenId\s*;/);
  });

  it('prefers the current Codex App ledger entry over mutable shared-chat reply state', () => {
    expect(cliSource).toContain(
      'originSession?.codexAppDispatchLedger',
    );
    expect(cliSource).toContain("turnMatches.filter(entry => entry.dispatchAttempt === originDispatchAttempt)");
    expect(cliSource).toContain('if (exactMatches.length !== 1)');
    expect(cliSource).toContain('const frozenTurnDispatch = originSessionId === sid');
    expect(cliSource).toMatch(
      /const sendTarget = !sendInto && !sendTopLevel && !overrideChatId && frozenTurnReplyTarget\s*\? frozenTurnReplyTarget/,
    );
    expect(cliSource).toContain('?? frozenTurnDispatch?.replyTargetSenderOpenId');
    expect(cliSource).toContain('?? frozenTurnDispatch?.quoteTargetId');
    expect(cliSource).toContain('lastCallerOpenId: frozenTurnDispatch.replyTargetSenderOpenId');
    expect(cliSource).toContain('lastCallerIsBot: frozenTurnDispatch.replyTargetSenderIsBot');
  });

  it('fails closed when a durable turn is bound to a non-Lark delivery sink', () => {
    expect(cliSource).toContain("exactOriginDispatch?.deliverySink === 'http_wait'");
    expect(cliSource).toContain("exactOriginDispatch?.deliverySink === 'http_async'");
    expect(cliSource).toContain("exactOriginDispatch?.deliverySink === 'suppressed'");
    expect(cliSource).toContain("exactOriginDispatch?.deliverySink === 'doc_comment'");
    expect(cliSource).toContain('a document-comment turn supports only its exact plain-text comment reply');
  });

  it('retains per-turn document-comment routing for non-Codex CLI adapters only', () => {
    expect(cliSource).toContain("originSession?.cliId !== 'codex-app' && !!docTarget");
    expect(cliSource).toContain('const isOriginDocCommentTurn =');
    expect(cliSource.match(/if \(isOriginDocCommentTurn\)/g)).toHaveLength(2);
  });

  it('binds delivery-sink authority to the trusted origin, not --session-id destination', () => {
    const cmdSendStart = cliSource.indexOf('async function cmdSend(');
    const cmdDispatchStart = cliSource.indexOf('async function cmdDispatch(', cmdSendStart);
    const cmdSend = cliSource.slice(cmdSendStart, cmdDispatchStart);
    expect(cmdSend).toContain('const originSessionId = trustedRelayCtx?.sessionId');
    expect(cmdSend).toContain('const authoritativeOriginTurnCtx = trustedRelayCtx');
    expect(cmdSend).toContain(': (liveMarkerCtx?.turnId');
    expect(cmdSend).toContain(': isolatedManagedOriginCtx?.turnId');
    expect(cmdSend).not.toMatch(/const originSessionId =[\s\S]{0,200}sessionIdArg/);
    expect(cmdSend).toContain('const sid = sessionIdArg ?? ancestorCtx?.sessionId');
    expect(cmdSend).toContain('const exactOriginDispatch = (() => {');
    expect(cmdSend).toContain('if (sid !== originSessionId');
    expect(cmdSend).toContain('const exactDocSession = originSession!;');
  });

  it('does not promote detached spawn-time turn env while durable output is unsettled', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-send-stale-origin-'));
    try {
      seedPersistedSessionRows(dataDir, 'app-a', {
        origin: {
          sessionId: 'origin',
          chatId: 'oc_origin',
          rootMessageId: 'om_origin',
          title: 'origin',
          status: 'active',
          createdAt: new Date(0).toISOString(),
          larkAppId: 'app-a',
          codexAppDispatchLedger: [{
            dispatchId: 'dispatch-live',
            turnId: 'turn-live',
            dispatchAttempt: 1,
            state: 'accepted',
            content: 'private result',
            deliverySink: 'http_wait',
          }],
        },
        destination: {
          sessionId: 'destination',
          chatId: 'oc_destination',
          rootMessageId: 'om_destination',
          title: 'destination',
          status: 'active',
          createdAt: new Date(0).toISOString(),
          larkAppId: 'app-a',
        },
      });
      const result = spawnSyncTsScript(
        join(__dirname, '..', 'src', 'cli.ts'),
        ['send', 'must-not-leak', '--session-id', 'destination', '--no-mention'],
        {
          cwd: join(__dirname, '..'),
          encoding: 'utf8',
          env: {
            ...process.env,
            SESSION_DATA_DIR: dataDir,
            BOTMUX_SESSION_ID: 'origin',
            // These are inherited spawn-time fallbacks, not a live marker or
            // protected capability. They must not select (or bypass) a sink.
            BOTMUX_TURN_ID: 'turn-stale',
            BOTMUX_DISPATCH_ATTEMPT: '99',
            BOTMUX_HOST_RELAY_AUTHORIZED: '',
            BOTMUX_SEND_RELAY: '',
            BOTMUX_WORKFLOW: '',
            BOTMUX_LARK_APP_ID: '',
            BOTMUX_LARK_APP_SECRET: '',
          },
        },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('unsettled durable output but no fresh authoritative dispatch identity');
      expect(result.stderr).not.toContain('must-not-leak');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('routes a read-isolated Codex App send through the capability-gated host relay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-send-read-iso-relay-'));
    const dataDir = join(root, 'data');
    const outbox = join(root, 'outbox');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(outbox, { recursive: true });
    const capability = 'ab'.repeat(32);
    replaceManagedOriginCapabilityFile(join(outbox, RELAY_ORIGIN_CAPABILITY_BASENAME), JSON.stringify({
      token: capability,
      turnId: 'turn-live',
      dispatchAttempt: 4,
    }));
    const ledger = [{
      dispatchId: 'dispatch-live',
      turnId: 'turn-live',
      dispatchAttempt: 4,
      state: 'prepared',
      content: 'prompt',
      deliverySink: 'lark',
    }];
    seedPersistedSessionRows(dataDir, 'app-a', {
      session: {
        sessionId: 'session', chatId: 'oc_chat', rootMessageId: 'om_root',
        title: 'read isolated', status: 'active', createdAt: new Date(0).toISOString(),
        larkAppId: 'app-a', cliId: 'codex-app', codexAppDispatchLedger: ledger,
      },
    });
    const fixture = join(root, 'host-send.mjs');
    writeFileSync(fixture, `
      import { readFileSync } from 'node:fs';
      const argv = process.argv.slice(2);
      process.stdout.write(JSON.stringify({
        command: argv[0],
        content: readFileSync(argv[argv.indexOf('--content-file') + 1], 'utf8'),
        layout: argv.includes('--layout') ? argv[argv.indexOf('--layout') + 1] : null,
        responseKind: argv.includes('--response-kind') ? argv[argv.indexOf('--response-kind') + 1] : null,
        sessionId: argv[argv.indexOf('--session-id') + 1],
        turnId: process.env.BOTMUX_TURN_ID,
        dispatchAttempt: process.env.BOTMUX_DISPATCH_ATTEMPT,
        requiresLedger: process.env.BOTMUX_HOST_RELAY_REQUIRES_CODEX_APP_LEDGER,
      }));
    `);
    const authorize = (claim: { capability?: string }) => {
      const exact = ledger.filter(entry => entry.turnId === 'turn-live' && entry.dispatchAttempt === 4);
      return claim.capability === capability && exact.length === 1
        ? {
            ok: true as const,
            origin: {
              turnId: 'turn-live', dispatchAttempt: 4, requiresCodexAppLedger: true,
            },
          }
        : { ok: false as const, error: 'stale' };
    };
    const stop = startOutboxWatcher(outbox, { ...process.env }, 'session', {
      cliPath: fixture,
      authorize,
    });
    try {
      const result = await runCli(
        ['send', 'relay body', '--layout', 'risk', '--session-id', 'session', '--no-mention'],
        {
          ...process.env,
          SESSION_DATA_DIR: dataDir,
          BOTMUX_SESSION_ID: 'session',
          BOTMUX_SEND_RELAY: outbox,
          BOTMUX_HOST_RELAY_AUTHORIZED: '',
          BOTMUX_WORKFLOW: '',
        },
      );
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        command: 'send',
        content: 'relay body',
        layout: 'risk',
        responseKind: null,
        sessionId: 'session',
        turnId: 'turn-live',
        dispatchAttempt: '4',
        requiresLedger: '1',
      });

      const layoutOff = await runCli(
        ['send', 'relay body without shell', '--layout', 'risk', '--session-id', 'session', '--no-mention'],
        {
          ...process.env,
          SESSION_DATA_DIR: dataDir,
          BOTMUX_SESSION_ID: 'session',
          BOTMUX_SEND_RELAY: outbox,
          BOTMUX_HOST_RELAY_AUTHORIZED: '',
          BOTMUX_WORKFLOW: '',
          BOTMUX_LARK_APP_ID: 'app-a',
          BOTMUX_REPLY_STYLE: JSON.stringify({ layout: false }),
        },
      );
      expect(layoutOff.code, layoutOff.stderr).toBe(0);
      expect(layoutOff.stderr).toContain('当前 Bot 已关闭 layout');
      expect(JSON.parse(layoutOff.stdout)).toMatchObject({
        content: 'relay body without shell',
        layout: null,
      });
    } finally {
      stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when relay capability is missing even if the default protected snapshot remains', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-send-missing-relay-cap-'));
    const dataDir = join(root, 'data');
    const outbox = join(root, 'outbox');
    mkdirSync(outbox, { recursive: true });
    replaceManagedOriginCapabilityFile(
      managedOriginCapabilityPath(dataDir, 'session', 'ef'.repeat(32)),
      JSON.stringify({
        sessionId: 'session', capability: 'bc'.repeat(32),
        channelId: 'ef'.repeat(32),
        turnId: 'turn-stale', dispatchAttempt: 2,
      }),
    );
    try {
      const result = await runCli(
        ['send', 'must not send', '--session-id', 'session', '--no-mention'],
        {
          ...process.env,
          SESSION_DATA_DIR: dataDir,
          BOTMUX_SESSION_ID: 'session',
          BOTMUX_SEND_RELAY: outbox,
          BOTMUX_HOST_RELAY_AUTHORIZED: '',
          BOTMUX_WORKFLOW: '',
        },
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('managed host relay capability is stale or missing');
      expect(result.stderr).not.toContain('must not send');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets a visible live marker win over a stale relay/default capability', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-send-live-marker-wins-'));
    const dataDir = join(root, 'data');
    const outbox = join(root, 'outbox');
    mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
    mkdirSync(outbox, { recursive: true });
    writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
      sessionId: 'session', turnId: 'turn-live',
    }));
    writeFileSync(join(outbox, RELAY_ORIGIN_CAPABILITY_BASENAME), JSON.stringify({
      token: 'cd'.repeat(32), turnId: 'turn-stale', dispatchAttempt: 9,
    }));
    replaceManagedOriginCapabilityFile(
      managedOriginCapabilityPath(dataDir, 'session', 'fe'.repeat(32)),
      JSON.stringify({
        sessionId: 'session', capability: 'cd'.repeat(32),
        channelId: 'fe'.repeat(32),
        turnId: 'turn-stale', dispatchAttempt: 9,
      }),
    );
    seedPersistedSessionRows(dataDir, 'app-a', {
      session: {
        sessionId: 'session', chatId: 'oc_chat', rootMessageId: 'om_root',
        title: 'host', status: 'active', createdAt: new Date(0).toISOString(),
        larkAppId: 'app-a', cliId: 'codex-app',
        codexAppDispatchLedger: [{
          dispatchId: 'dispatch-live', turnId: 'turn-live',
          state: 'prepared', content: 'prompt', deliverySink: 'http_wait',
        }],
      },
    });
    try {
      const result = await runCli(
        ['send', 'must not relay', '--session-id', 'session', '--no-mention'],
        {
          ...process.env,
          SESSION_DATA_DIR: dataDir,
          BOTMUX_SESSION_ID: 'session',
          BOTMUX_SEND_RELAY: outbox,
          BOTMUX_HOST_RELAY_AUTHORIZED: '',
          BOTMUX_WORKFLOW: '',
          BOTMUX_LARK_APP_ID: '', BOTMUX_LARK_APP_SECRET: '',
        },
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('origin turn turn-live is bound to the http_wait host sink');
      expect(result.stderr).not.toContain('managed host relay capability');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a trusted host re-exec when its authorized Codex App ledger was already settled', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-send-host-ledger-gone-'));
    seedPersistedSessionRows(dataDir, 'app-a', {
      session: {
        sessionId: 'session', chatId: 'oc_chat', rootMessageId: 'om_root',
        title: 'settled', status: 'active', createdAt: new Date(0).toISOString(),
        larkAppId: 'app-a', cliId: 'codex-app', pid: process.pid,
      },
    });
    try {
      const result = await runCli(
        ['send', 'must not downgrade', '--session-id', 'session', '--no-mention'],
        {
          ...process.env,
          SESSION_DATA_DIR: dataDir,
          BOTMUX_SESSION_ID: 'session',
          BOTMUX_TURN_ID: 'turn-settled',
          BOTMUX_DISPATCH_ATTEMPT: '4',
          BOTMUX_HOST_RELAY_AUTHORIZED: '1',
          BOTMUX_HOST_RELAY_REQUIRES_CODEX_APP_LEDGER: '1',
          BOTMUX_SEND_RELAY: '',
          BOTMUX_WORKFLOW: '',
          BOTMUX_LARK_APP_ID: '', BOTMUX_LARK_APP_SECRET: '',
        },
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('authorized Codex App origin session/turn-settled is no longer unsettled');
      expect(result.stderr).not.toContain('must not downgrade');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('authorizes a host relay from its forced trusted origin before any provider side effect', () => {
    const cmdSendStart = cliSource.indexOf('async function cmdSend(');
    const cmdDispatchStart = cliSource.indexOf('async function cmdDispatch(', cmdSendStart);
    const cmdSend = cliSource.slice(cmdSendStart, cmdDispatchStart);
    expect(cmdSend).toContain("const trustedHostRelay = process.env.BOTMUX_HOST_RELAY_AUTHORIZED === '1';");
    expect(cmdSend).toContain('isTrustedVcMeetingHostRelayParent(');
    expect(cmdSend).toContain("BOTMUX_HOST_RELAY_REQUIRES_CODEX_APP_LEDGER === '1'");
    expect(cmdSend.indexOf('const exactOriginDispatch = (() => {'))
      .toBeLessThan(cmdSend.indexOf("const { synthesizeVoiceOpus }"));
    expect(cmdSend.indexOf("exactOriginDispatch?.deliverySink === 'http_wait'"))
      .toBeLessThan(cmdSend.indexOf("const { sendMessage, replyMessage, uploadImage, uploadFile"));
  });

  it('validates the exact document text path before reading content or invoking TTS/uploads', () => {
    const cmdSendStart = cliSource.indexOf('async function cmdSend(');
    const cmdDispatchStart = cliSource.indexOf('async function cmdDispatch(', cmdSendStart);
    const cmdSend = cliSource.slice(cmdSendStart, cmdDispatchStart);
    const docGuard = cmdSend.indexOf('if (isOriginDocCommentTurn)');
    expect(docGuard).toBeGreaterThan(-1);
    expect(docGuard).toBeLessThan(cmdSend.indexOf('// Read content from:'));
    expect(docGuard).toBeLessThan(cmdSend.indexOf('content = readFileSync(contentFile'));
    expect(docGuard).toBeLessThan(cmdSend.indexOf('content = await readStdin()'));
    expect(docGuard).toBeLessThan(cmdSend.indexOf("const { synthesizeVoiceOpus }"));
    const guardSource = cmdSend.slice(docGuard, cmdSend.indexOf('// Read content from:'));
    for (const forbidden of [
      'asVoice',
      'images.length > 0',
      'files.length > 0',
      'videoAttachments.length > 0',
      'videoCovers.length > 0',
      'customCardRequested',
      'sendTopLevel',
      'overrideChatId',
      'sendInto',
    ]) {
      expect(guardSource).toContain(forbidden);
    }
  });

  it('never writes the startup session snapshot after an async document reply', () => {
    const cmdSendStart = cliSource.indexOf('async function cmdSend(');
    const cmdDispatchStart = cliSource.indexOf('async function cmdDispatch(', cmdSendStart);
    const cmdSend = cliSource.slice(cmdSendStart, cmdDispatchStart);
    const docSendStart = cmdSend.indexOf('if (isOriginDocCommentTurn)', cmdSend.indexOf('// Read content from:'));
    const mentionParsing = cmdSend.indexOf('// Parse mentions:', docSendStart);
    const docSend = cmdSend.slice(docSendStart, mentionParsing);
    expect(docSend).toContain('Daemon settlement owns exact target retirement.');
    expect(docSend).not.toContain('saveSession(');
    expect(docSend).not.toMatch(/delete\s+exactDocSession\.docCommentTargets/);
  });

  it('gates --mention-back by turn-window participant ambiguity (no group-stats round-trip)', () => {
    // 2+ distinct counterparts OR an incomplete window → block --mention-back and
    // hand the model explicit --mention candidates. Reads the persisted
    // participant window; no getGroupStats fetch. Explicit VC turns skip it.
    expect(cliSource).toContain('collectTurnWindowParticipants(s, currentTurnId)');
    expect(cliSource).toContain('mentionBackAmbiguity({ chatType: s.chatType, participants: window.participants, incomplete: window.incomplete })');
    expect(cliSource).toMatch(/if \(mentionBack && !explicitVcMeetingImOrigin && !sendTopLevel\)/);
    expect(cliSource).toContain('console.error(mentionBackAmbiguityError(ambiguity.candidates, ambiguity.incomplete))');
    // The old asymmetric/group-stats gate is fully gone.
    expect(cliSource).not.toContain('shouldBlockMentionBackByParticipants');
    expect(cliSource).not.toMatch(/mentionBack[\s\S]{0,300}getGroupStats/);
  });

  it('freezes VC listener replay content and indexes only the successful primary output', () => {
    const cmdSendStart = cliSource.indexOf('async function cmdSend(');
    const cmdDispatchStart = cliSource.indexOf('async function cmdDispatch(', cmdSendStart);
    const cmdSend = cliSource.slice(cmdSendStart, cmdDispatchStart);
    expect(cmdSend).toContain('const canonicalOutput = prepared?.canonicalOutput ?? proposedOutput;');
    expect(cmdSend).toContain('prepareVcMeetingDeliveryReply(');
    expect(cmdSend).toContain('vcMeetingDeliveryReplyOrigin');
    expect(cmdSend).toContain('content: canonicalOutput.content');
    expect(cmdSend).toContain('msgType: canonicalOutput.msgType');
    expect(cmdSend).toContain('quoteTargetId: canonicalOutput.quoteTargetId');
    expect(cmdSend).toMatch(
      /const dispatchAfterOriginGate = async \([^)]*\): Promise<string> => \{[\s\S]*?revalidateVcMeetingManagedSend\(\);/,
    );
    expect(cmdSend).toMatch(/const dispatch = async \([^)]*\): Promise<string> => \{[\s\S]*?dispatchAfterOriginGate\(/);
    expect(cmdSend).toMatch(
      /const dispatchPrimary = async \([^)]*\): Promise<string> => \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*revalidateVcMeetingManagedSend\(\);/,
    );
    expect(cmdSend).toContain('recordVcMeetingPrimaryOutput(result.messageId, canonicalOutput.targetChatId);');
    expect(cmdSend.indexOf('recordVcMeetingPrimaryOutput(result.messageId'))
      .toBeGreaterThan(cmdSend.indexOf('const result = await dispatchPrimaryMessage('));
    expect(cmdSend).toContain('const managedControlError = managedVcSendControlError({');
    expect(cmdSend).toContain('const managedPayloadError = managedVcSendPayloadError({');
    expect(cmdSend).toContain('fileCount: files.length');
    expect(cmdSend).toContain('videoCount: videoAttachments.length');
    expect(cmdSend).toContain('containsNativeAtTag: containsLarkAtTag(content)');
    expect(cmdSend).toContain('const managedRenderedPayloadError = managedVcSendPayloadError({');
    expect(cmdSend).toContain('containsNativeAtTag: containsLarkAtTag(text)');
    expect(cmdSend).toContain('if (!noMention && !isSlashSend && !vcMeetingManagedSendOrigin)');
    expect(cmdSend).toContain('if (!sendTopLevel && !vcMeetingManagedSendOrigin)');
    expect(cmdSend.indexOf('const managedPayloadError = managedVcSendPayloadError({'))
      .toBeLessThan(cmdSend.indexOf("const { sendMessage, replyMessage, uploadImage, uploadFile"));
    expect(cmdSend.indexOf('const managedPayloadError = managedVcSendPayloadError({'))
      .toBeLessThan(cmdSend.indexOf("const { synthesizeVoiceOpus }"));
    expect(cmdSend.indexOf('const managedRenderedPayloadError = managedVcSendPayloadError({'))
      .toBeGreaterThan(cmdSend.indexOf('BOTMUX_CARD_PREPARED_CONTENT_FILE'));
    expect(cmdSend.indexOf('const managedRenderedPayloadError = managedVcSendPayloadError({'))
      .toBeLessThan(cmdSend.indexOf('imageKeys.push(await uploadImage'));
    expect(cmdSend).toContain('const managedQuoteError = managedVcQuoteError({');
    expect(cmdSend).toContain('const managedCustomCardError = managedVcCustomCardError(');
    expect(cmdSend).toMatch(/sessionQuoteTargetId: vcMeetingDeliveryReplyOrigin\s*\? undefined/);
    expect(cmdSend).toContain('const prepared = prepareVcMeetingListenerReply(proposedOutput);');
    expect(cmdSend).toMatch(/canonicalOutput\.msgType,[\s\S]*?prepared\?\.providerKey/);
    expect(cmdSend).toContain('...(prepared ? { suppressHook: true } : {})');
    expect(cmdSend).toContain('const managedProviderOptions = outboundMessageOptions(!!prepared);');
    expect(cmdSend).toContain('...(vcMeetingManagedSendOrigin ? { maxMessages: 1 } : {})');
  });

  it('defaults an omitted response kind to non-final while keeping feedback indexing final-only', () => {
    const cmdSendStart = cliSource.indexOf('async function cmdSend(');
    const cmdDispatchStart = cliSource.indexOf('async function cmdDispatch(', cmdSendStart);
    const cmdSend = cliSource.slice(cmdSendStart, cmdDispatchStart);
    expect(cmdSend).toContain("const responseKindOccurrences = rest.filter(token => token === '--response-kind' || token.startsWith('--response-kind=')).length");
    expect(cmdSend).toContain("responseKindOccurrences > 1");
    expect(cmdSend).toContain("flagPresentButValueMissing(rest, '--response-kind')");
    expect(cmdSend).toContain("const effectiveResponseKind = responseKind ?? 'progress'");
    expect(cmdSend).not.toContain('启用最终回答反馈后，必须显式指定 --response-kind progress|final');
    expect(cmdSend).toContain('无法确认本次提问者身份，不能发送带反馈控件的最终回答');
    expect(cmdSend).toContain('requesterSubjectId: feedbackRequesterSubjectId');
    expect(cmdSend).not.toContain("feedbackPolicy && responseKind === 'final'");
    expect(cmdSend).toContain("feedbackPolicy && effectiveResponseKind === 'final'");
    expect(cmdSend).toContain('const deliveryTurnId = currentTurnId ?? `send:${messageId}`');
    expect(cmdSend).toContain('const correlationDiscriminator = currentTurnId ? messageId : undefined');
    expect(cmdSend).toContain('turnId: deliveryTurnId');
    expect(cmdSend).toContain('correlationDiscriminator,');
    expect(cmdSend).not.toContain('const deliveryTurnId = `send:${messageId}`');
    expect(cmdSend).not.toContain('--feedback-level');
    const primarySend = cmdSend.indexOf('messageId = await dispatchPrimary');
    const feedbackIndex = cmdSend.indexOf('feedback indexing failed after delivery');
    expect(primarySend).toBeGreaterThanOrEqual(0);
    expect(feedbackIndex).toBeGreaterThan(primarySend);
    expect(cmdSend.slice(cmdSend.lastIndexOf('try {', feedbackIndex), feedbackIndex)).toContain('getSkillFeedbackStore');
    expect(cmdSend).toContain('policy: feedbackPolicy');
    expect(cmdSend).toContain('baseCard: feedbackBaseCard');
    expect(cmdSend).toContain('buildFeedbackElement(feedbackPolicy)');
  });
});
