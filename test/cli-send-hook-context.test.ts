import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript, spawnTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { buildRelayHostEnv, startOutboxWatcher } from '../src/adapters/backend/sandbox.js';
import {
  ensureManagedOriginAttestationDirectory,
  managedOriginCapabilityPath,
  managedOriginIsolationMarkerPath,
  RELAY_ORIGIN_CAPABILITY_BASENAME,
  replaceManagedOriginCapabilityFile,
} from '../src/core/managed-origin-capability.js';
import {
  MANAGED_ORIGIN_PROOF_DOMAIN,
  writeManagedOriginAttestationProof,
} from '../src/core/managed-origin-attestation.js';
import {
  acceptVcMeetingDelivery,
  applyVcMeetingMemberProjection,
  markVcMeetingDeliveryDispatched,
} from '../src/services/vc-meeting-delivery-store.js';

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

  it('prints only whitelisted session lookup diagnostics before send exits missing-session', () => {
    const cmdSendStart = cliSource.indexOf('async function cmdSend(');
    const cmdDispatchStart = cliSource.indexOf('async function cmdDispatch(', cmdSendStart);
    const cmdSend = cliSource.slice(cmdSendStart, cmdDispatchStart);

    expect(cmdSend).toContain('[botmux send diagnostic] session_lookup_miss');
    expect(cmdSend).toContain('source=${sessionIdSource}');
    expect(cmdSend).toContain('dataDir=${sendDataDir}');
    expect(cmdSend).toContain('envSessionId=${process.env.BOTMUX_SESSION_ID ??');
    expect(cmdSend).toContain('envLarkAppId=${process.env.BOTMUX_LARK_APP_ID ??');
    expect(cmdSend).toContain('originSessionId=${originSessionId ??');
    expect(cmdSend).toContain('reason=${resolved.reason}');
    expect(cmdSend).toContain("relayDir=${relayDir ? 'present' : 'absent'}");
    expect(cmdSend).toContain('readIsolation=${isolatedSendRequired ?');
    expect(cmdSend).toContain("capability=${isolatedCapabilityCtx ? 'present' : 'absent'}");

    const diagnosticStart = cmdSend.indexOf('session_lookup_miss');
    expect(diagnosticStart).toBeGreaterThanOrEqual(0);
    const missingSessionAt = cmdSend.indexOf('console.error(resolved.message)', diagnosticStart);
    expect(missingSessionAt).toBeGreaterThan(diagnosticStart);
    const diagnosticBlock = cmdSend.slice(diagnosticStart, missingSessionAt);

    expect([...diagnosticBlock.matchAll(/\$\{([^}]*)\}/g)].map(m => m[1].trim())).toEqual([
      'sid',
      'sessionIdSource',
      'sendDataDir',
      "process.env.BOTMUX_SESSION_ID ?? '-'",
      "process.env.BOTMUX_LARK_APP_ID ?? '-'",
      "originSessionId ?? '-'",
      'resolved.reason',
      "relayDir ? 'present' : 'absent'",
      "isolatedSendRequired ? 'required' : kernelReadIsolationDetected ? 'detected' : 'off'",
      "isolatedCapabilityCtx ? 'present' : 'absent'",
    ]);
    expect([...diagnosticBlock.matchAll(/process\.env(\.[A-Za-z0-9_]+)?/g)].map(m => m[0])).toEqual([
      'process.env.BOTMUX_SESSION_ID',
      'process.env.BOTMUX_LARK_APP_ID',
    ]);
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
    expect(cliSource).toContain('--layout result|progress|risk|blocked|handoff');
  });

  it('preserves plugin-card ownership across the sandbox host relay', () => {
    const relayStart = cliSource.indexOf('async function relaySend(');
    const relayEnd = cliSource.indexOf('\nasync function relayDispatch(', relayStart);
    const relaySend = cliSource.slice(relayStart, relayEnd);
    expect(relaySend).toContain("'--plugin-card-action'");
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

  it('lets explicit recipients replace the implicit reply target in quote and footer routing', () => {
    expect(cliSource).toContain('shouldSuppressImplicitReplyTarget({');
    expect(cliSource).toContain('if (suppressImplicitReplyTarget) effectiveQuoteTargetId = undefined');
    expect(cliSource).toContain('hasExplicitMention: mentions.length > 0');
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

  // A Seatbelt profile can let existsSync() see the PID marker while denying
  // the read (EPERM); the marker reader reports that as sessionId ''. Real
  // Seatbelt denial cannot be reproduced here, so chmod 000 stands in for it
  // (meaningless as root, hence the skip and the explicit precondition).
  async function withUnreadableMarker(
    options: { attestable: boolean; dispatchAttempt?: number },
    run: (env: NodeJS.ProcessEnv) => Promise<void>,
  ): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'botmux-send-unreadable-marker-'));
    const dataDir = join(root, 'data');
    const markerDir = join(dataDir, '.botmux-cli-pids');
    const markerPath = join(markerDir, String(process.pid));
    const channelId = 'ad'.repeat(32);
    const capability = 'be'.repeat(32);
    const daemon = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += String(chunk); });
      req.on('end', () => {
        const request = JSON.parse(body) as {
          sessionId: string; channelId: string; originCapability: string; nonce: string;
        };
        if (request.sessionId === 'session' && request.channelId === channelId
          && request.originCapability === capability) {
          writeManagedOriginAttestationProof({
            dataDir,
            proof: {
              domain: MANAGED_ORIGIN_PROOF_DOMAIN,
              version: 1,
              nonce: request.nonce,
              channelId,
              sessionId: 'session',
              turnId: 'turn-live',
              ...(options.dispatchAttempt !== undefined ? { dispatchAttempt: options.dispatchAttempt } : {}),
              requiresCodexAppLedger: false,
              issuedAtMs: Date.now(),
            },
          });
        }
        res.writeHead(200).end();
      });
    });
    try {
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(markerPath, JSON.stringify({ sessionId: 'session', turnId: 'turn-live' }));
      chmodSync(markerPath, 0o000);
      expect(() => readFileSync(markerPath, 'utf-8')).toThrow();
      await new Promise<void>(resolve => daemon.listen(0, '127.0.0.1', resolve));
      const { port } = daemon.address() as AddressInfo;
      if (options.attestable) {
        ensureManagedOriginAttestationDirectory(dataDir, 'session', channelId);
        // Keep the CLI on the non-isolated classification so the unreadable
        // marker itself drives attestation; writing the proof re-creates the
        // read-isolation marker only after classification has finished.
        rmSync(managedOriginIsolationMarkerPath(dataDir, 'session', channelId));
        replaceManagedOriginCapabilityFile(
          managedOriginCapabilityPath(dataDir, 'session', channelId),
          JSON.stringify({ sessionId: 'session', channelId, capability, ipcPort: port }),
        );
      }
      if (options.dispatchAttempt !== undefined) {
        // A durable dispatch carries an attempt; the VC managed-output policy
        // then requires a live receipt whose attempt equals the attested one.
        const memberKey = { listenerAppId: 'listener', meetingId: 'meeting', memberId: 'member', memberEpoch: 1 };
        applyVcMeetingMemberProjection(dataDir, {
          ...memberKey, ownerBootId: 'owner-boot', ownerEpoch: 1, agentAppId: 'app-a',
          role: 'minutes', membershipGeneration: 1, status: 'active', responseMode: 'listener_thread',
          capabilities: ['listener.output.request', 'meeting.read'], ownedSinks: [],
          sinkOwnerGeneration: 1, joinedAtIngestSeq: 0, receiverSessionId: 'session',
          outputChatId: 'listener-chat', outputPlacement: 'auto',
        });
        acceptVcMeetingDelivery(dataDir, {
          ...memberKey, ownerBootId: 'owner-boot', ownerEpoch: 1, membershipGeneration: 1,
          deliveryKey: 'turn-live', inputHash: 'input-hash', fromSeq: 1, toSeq: 1,
          responseMode: 'listener_thread', listenerOutputProtocol: 'plain', receiverBootId: 'receiver-boot',
        });
        markVcMeetingDeliveryDispatched(dataDir, { ...memberKey, deliveryKey: 'turn-live' }, {
          receiverBootId: 'receiver-boot', workerGeneration: 1,
        });
      }
      seedPersistedSessionRows(dataDir, 'app-a', {
        session: {
          sessionId: 'session', chatId: 'oc_chat', rootMessageId: 'om_root',
          title: 'unreadable marker', status: 'active', createdAt: new Date(0).toISOString(),
          larkAppId: 'app-a', cliId: 'codex-app',
          codexAppDispatchLedger: options.dispatchAttempt === undefined
            ? [{
                dispatchId: 'dispatch-live', turnId: 'turn-live',
                state: 'prepared', content: 'prompt', deliverySink: 'http_wait',
              }]
            // Two attempts of the same turn: only the attested attempt may
            // select its entry (attempt 1 is the live durable receipt below).
            : [{
                dispatchId: 'dispatch-live', turnId: 'turn-live', dispatchAttempt: 1,
                state: 'prepared', content: 'prompt', deliverySink: 'http_wait',
              }, {
                dispatchId: 'dispatch-other', turnId: 'turn-live', dispatchAttempt: 2,
                state: 'prepared', content: 'prompt', deliverySink: 'lark',
              }],
        },
      });
      await run({
        ...process.env,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'session',
        BOTMUX_ORIGIN_CHANNEL_ID: channelId,
        BOTMUX_SEND_RELAY: '',
        BOTMUX_READ_ISOLATED: '',
        BOTMUX_HOST_RELAY_AUTHORIZED: '',
        BOTMUX_WORKFLOW: '',
        BOTMUX_LARK_APP_ID: '', BOTMUX_LARK_APP_SECRET: '',
        HOME: root,
      });
    } finally {
      await new Promise<void>(resolve => daemon.close(() => resolve()));
      try { chmodSync(markerPath, 0o600); } catch { /* setup may not have created it */ }
      rmSync(root, { recursive: true, force: true });
    }
  }

  it.skipIf(process.getuid?.() === 0)(
    'falls back to the attested managed origin when the live marker exists but is unreadable',
    async () => {
      await withUnreadableMarker({ attestable: true }, async env => {
        const result = await runCli(['send', 'must not send', '--session-id', 'session', '--no-mention'], env);
        expect(result.code).toBe(2);
        // Reaching the origin session's durable sink proves the origin resolved
        // to the attested session rather than the marker's empty string.
        expect(result.stderr).toContain('origin turn turn-live is bound to the http_wait host sink');
        expect(result.stderr).not.toContain('Invalid turn-send ledger session id');
      });
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'carries the attested dispatch attempt when the live marker is unreadable',
    async () => {
      await withUnreadableMarker({ attestable: true, dispatchAttempt: 1 }, async env => {
        const result = await runCli(['send', 'must not send', '--session-id', 'session', '--no-mention'], env);
        expect(result.code).toBe(2);
        // Attempt 1 passes the receipt check and selects its own (http_wait)
        // ledger entry, not attempt 2's lark entry.
        expect(result.stderr).toContain('origin turn turn-live is bound to the http_wait host sink');
      });
      await withUnreadableMarker({ attestable: true, dispatchAttempt: 2 }, async env => {
        const result = await runCli(['send', 'must not send', '--session-id', 'session', '--no-mention'], env);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('(origin_mismatch)');
        expect(result.stderr).not.toContain('bound to the http_wait host sink');
      });
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'does not let an unreadable marker fall back to the env session when nothing was attested',
    async () => {
      await withUnreadableMarker({ attestable: false }, async env => {
        const result = await runCli(['send', 'must not send', '--session-id', 'session', '--no-mention'], env);
        // Adopting the env session would hit its unsettled durable ledger and
        // refuse; with no trusted origin the send instead proceeds as an
        // ordinary reply (as before the fix) and stops at the unregistered
        // fixture bot, before any provider side effect.
        expect(result.stderr).not.toContain('origin session session has unsettled durable output');
        expect(result.stderr).not.toContain('Invalid turn-send ledger session id');
        expect(result.stderr).toContain('Bot not registered: app-a');
      });
    },
  );

  it('rejects a trusted host re-exec when its authorized Codex App ledger was already settled', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-send-host-ledger-gone-'));
    const channelId = 'ef'.repeat(32);
    ensureManagedOriginAttestationDirectory(dataDir, 'session', channelId);
    replaceManagedOriginCapabilityFile(
      managedOriginCapabilityPath(dataDir, 'session', channelId),
      JSON.stringify({ sessionId: 'session', channelId, capability: 'cd'.repeat(32) }),
    );
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
          ...buildRelayHostEnv({
            ...process.env,
            SESSION_DATA_DIR: dataDir,
            BOTMUX_SESSION_ID: 'session',
            BOTMUX_TURN_ID: 'turn-settled',
            BOTMUX_ORIGIN_CHANNEL_ID: channelId,
            BOTMUX_DISPATCH_ATTEMPT: '4',
            BOTMUX_HOST_RELAY_AUTHORIZED: '1',
            BOTMUX_SEND_RELAY: '',
            BOTMUX_WORKFLOW: '',
            BOTMUX_LARK_APP_ID: '', BOTMUX_LARK_APP_SECRET: '',
          }),
          // startOutboxWatcher applies this only after authorize succeeds.
          BOTMUX_HOST_RELAY_REQUIRES_CODEX_APP_LEDGER: '1',
        },
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('authorized Codex App origin session/turn-settled is no longer unsettled');
      expect(result.stderr).not.toContain('must not downgrade');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    { name: 'a matching numeric parent with a pane origin channel', workerPid: process.pid, readIsolated: '' },
    { name: 'a different worker parent', workerPid: process.pid + 1, readIsolated: '' },
    { name: 'an explicitly isolated child', workerPid: process.pid, readIsolated: '1' },
  ])('does not accept a host relay flag from $name', async ({ workerPid, readIsolated }) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-send-host-parent-'));
    try {
      const channelId = 'fe'.repeat(32);
      ensureManagedOriginAttestationDirectory(dataDir, 'session', channelId);
      seedPersistedSessionRows(dataDir, 'app-a', {
        session: {
          sessionId: 'session', chatId: 'oc_chat', rootMessageId: 'om_root',
          title: 'isolated', status: 'active', createdAt: new Date(0).toISOString(),
          larkAppId: 'app-a', cliId: 'codex', pid: workerPid,
        },
      });
      const result = await runCli(
        ['send', 'must not send', '--session-id', 'session', '--no-mention'],
        {
          ...process.env,
          SESSION_DATA_DIR: dataDir,
          BOTMUX_SESSION_ID: 'session',
          BOTMUX_ORIGIN_CHANNEL_ID: channelId,
          BOTMUX_HOST_RELAY_AUTHORIZED: '1',
          BOTMUX_SEND_RELAY: '',
          BOTMUX_READ_ISOLATED: readIsolated,
          BOTMUX_WORKFLOW: '',
          BOTMUX_LARK_APP_ID: '', BOTMUX_LARK_APP_SECRET: '',
        },
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('read-isolated owning data-root locator is missing or ambiguous');
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
      .toBeLessThan(cmdSend.indexOf("const { sendMessage, replyMessage"));
  });

  it('keeps Remote Runner outbound sends host-only, route-frozen, and non-terminal', () => {
    const cmdSendStart = cliSource.indexOf('async function cmdSend(');
    const cmdDispatchStart = cliSource.indexOf('async function cmdDispatch(', cmdSendStart);
    const cmdSend = cliSource.slice(cmdSendStart, cmdDispatchStart);
    const guard = cmdSend.indexOf('if (remoteRunnerOutbound)');
    const providerImport = cmdSend.indexOf("const { sendMessage, replyMessage");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(providerImport);
    expect(cmdSend.slice(guard, providerImport)).toContain('trustedRelayCtx.sessionId !== sid');
    expect(cmdSend.slice(guard, providerImport)).toContain("['progress', 'auxiliary']");
    expect(cmdSend.slice(guard, providerImport)).toContain('sendTopLevel || overrideChatId || sendInto');
    expect(cmdSend.slice(guard, providerImport)).toContain('mentionArgs.length > 0');
    expect(cmdSend).toContain('...(remoteRunnerOutbound ? { terminalIndependent: true } : {})');
  });

  it.each([
    ['explicit recipient', ['--no-mention', '--mention', 'ou_forbidden']],
    ['two mention decisions', ['--no-mention', '--mention-back']],
  ])('rejects Remote Runner outbound sends with %s through the real CLI', async (_name, mentionArgs) => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-remote-outbound-guard-'));
    const dataDir = join(root, 'data');
    writeFileSync(join(root, 'bots.json'), JSON.stringify([{
      larkAppId: 'app-a', larkAppSecret: 'test', cliId: 'remote-runner',
    }]));
    seedPersistedSessionRows(dataDir, 'app-a', {
      session: {
        sessionId: 'session', chatId: 'oc_chat', rootMessageId: 'om_root',
        title: 'remote', status: 'active', createdAt: new Date(0).toISOString(),
        larkAppId: 'app-a', cliId: 'remote-runner', pid: process.pid,
      },
    });
    try {
      const result = await runCli([
        'send', '--remote-runner-outbound', '--response-kind', 'progress',
        '--session-id', 'session', ...mentionArgs, 'must not send',
      ], {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: join(root, 'bots.json'),
        BOTMUX_SESSION_ID: 'session',
        BOTMUX_TURN_ID: 'turn-live',
        BOTMUX_HOST_RELAY_AUTHORIZED: '1',
        BOTMUX_SEND_RELAY: '',
        BOTMUX_WORKFLOW: '',
        BOTMUX_LARK_APP_ID: '',
        BOTMUX_LARK_APP_SECRET: '',
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('supports only current-session Markdown with one none/requester mention decision');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it('checkpoints document comment chunks before each non-idempotent provider call', () => {
    const cmdSendStart = cliSource.indexOf('async function cmdSend(');
    const cmdDispatchStart = cliSource.indexOf('async function cmdDispatch(', cmdSendStart);
    const cmdSend = cliSource.slice(cmdSendStart, cmdDispatchStart);
    const docSendStart = cmdSend.indexOf('if (isOriginDocCommentTurn)', cmdSend.indexOf('// Read content from:'));
    const mentionParsing = cmdSend.indexOf('// Parse mentions:', docSendStart);
    const docSend = cmdSend.slice(docSendStart, mentionParsing);

    expect(docSend).toContain('executeNonIdempotentSequence(');
    expect(docSend).not.toMatch(/executeTurnPrimary\([\s\S]*?for \(let i = 0; i < chunks\.length; i\+\+\)/);
    expect(docSend.indexOf('removeCommentReaction(')).toBeGreaterThan(docSend.indexOf('executeNonIdempotentSequence('));
  });

  it('rejects a non-final document-comment reply with actionable guidance before provider effects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-doc-comment-final-only-'));
    const dataDir = join(root, 'data');
    const sessionId = 'sid_doc_comment_final_only';
    const turnId = 'turn_doc_comment_final_only';
    mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
    writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
      sessionId, turnId,
    }));
    writeFileSync(join(root, 'bots.json'), JSON.stringify([{
      larkAppId: 'cli_test', larkAppSecret: 'test-secret', cliId: 'codex', replyCardMode: 'legacy',
    }]));
    seedPersistedSessionRows(dataDir, 'cli_test', { [sessionId]: {
      sessionId, status: 'active', cliId: 'codex', larkAppId: 'cli_test',
      chatId: 'doc:doc_test', rootMessageId: 'om_root', scope: 'thread', workingDir: root,
      docCommentTargets: { [turnId]: {
        fileToken: 'doc_test', fileType: 'docx', commentId: 'comment_test', turnId,
      } },
    } });
    try {
      const result = await runCli(
        ['send', '--no-mention', '--response-kind', 'progress', 'interim comment'],
        {
          ...process.env,
          HOME: root,
          SESSION_DATA_DIR: dataDir,
          BOTS_CONFIG: join(root, 'bots.json'),
          BOTMUX_SESSION_ID: sessionId,
          BOTMUX_LARK_APP_ID: 'cli_test',
          BOTMUX_HOST_RELAY_AUTHORIZED: '',
          BOTMUX_SEND_RELAY: '',
          BOTMUX_WORKFLOW: '',
        },
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('文档评论轮只允许一条 final 回复，请使用 --response-kind final');
      expect(result.stderr).not.toContain('Non-idempotent delivery sequences require a final response');
      expect(result.stderr).not.toContain('Unexpected test');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      /const dispatchPrimaryUnlocked = async \([^)]*\): Promise<string> => \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*revalidateVcMeetingManagedSend\(\);/,
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
      .toBeLessThan(cmdSend.indexOf("const { sendMessage, replyMessage"));
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
    expect(cmdSend).toContain('const deliveryUuid = prepared?.providerKey ?? providerUuid;');
    expect(cmdSend).toContain('voicePrimaryOutputChatId = canonicalOutput.targetChatId;');
    expect(cmdSend).toContain('recordVcMeetingPrimaryOutput(messageId, voicePrimaryOutputChatId);');
    expect(cmdSend).not.toContain('recordVcMeetingPrimaryOutput(messageId, targetChatId);');
    expect(cmdSend).toMatch(/canonicalOutput\.msgType,[\s\S]*?deliveryUuid/);
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
    expect(cmdSend).toMatch(/let effectiveResponseKind(?:: TurnSendKind)? = responseKind \?\? 'progress'/);
    expect(cmdSend).toContain("if (responseKind === undefined) effectiveResponseKind = 'final'");
    expect(cmdSend).not.toContain('启用最终回答反馈后，必须显式指定 --response-kind progress|final');
    expect(cmdSend).toContain('无法确认本次提问者身份，不能发送带反馈控件的最终回答');
    // The requester-identity gate is scoped to the `requester` audience only.
    // `reviewers`/`everyone` authorize clicks without a human requester (a
    // bot-triggered ownerless session), so re-widening this gate to every
    // audience would silently make those cards unsendable.
    expect(cmdSend).toContain("feedbackPolicy.audience === 'requester' && !feedbackRequesterSubjectId");
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
    const deliveryIndex = cmdSend.indexOf('turn delivery indexing failed after delivery');
    expect(primarySend).toBeGreaterThanOrEqual(0);
    // The delivery record is written AFTER the message is actually sent.
    expect(deliveryIndex).toBeGreaterThan(primarySend);
    expect(cmdSend.slice(cmdSend.lastIndexOf('try {', deliveryIndex), deliveryIndex)).toContain('getSkillFeedbackStore');
    // Turn-completion recording is gated on the response KIND, not on the
    // feedback policy — feedback off must still produce a correlatable record.
    expect(cmdSend).toContain("if (effectiveResponseKind === 'final' && !customCard && !pureFileSend && !pureVideoSend && !vcMeetingManagedSendOrigin && messageId)");
    const oncallIndex = cmdSend.indexOf('recordOncallGroupDelivery(resolveDataDir()');
    const completionIndex = cmdSend.indexOf("if (effectiveResponseKind === 'final' && !customCard && !pureFileSend && !pureVideoSend && !vcMeetingManagedSendOrigin && messageId)");
    expect(oncallIndex).toBeGreaterThan(primarySend);
    expect(oncallIndex).toBeLessThan(completionIndex);
    // The feedback control (policy + card snapshot) rides along only when a
    // policy actually applies; the record itself is unconditional.
    expect(cmdSend).toContain('const carriesFeedbackControl = !!feedbackPolicy;');
    expect(cmdSend).toContain("cardMode: carriesFeedbackControl ? 'feedback' : 'card'");
    expect(cmdSend).toContain('...(carriesFeedbackControl ? { policy: feedbackPolicy } : {})');
    expect(cmdSend).toContain('...(carriesFeedbackControl && feedbackBaseCard ? { baseCard: feedbackBaseCard } : {})');
    expect(cmdSend).toContain('buildFeedbackElement(feedbackPolicy)');
  });

  it('returns after a concurrent final replay before any post-primary side effects', () => {
    const cmdSendStart = cliSource.indexOf('async function cmdSend(');
    const cmdDispatchStart = cliSource.indexOf('async function cmdDispatch(', cmdSendStart);
    const cmdSend = cliSource.slice(cmdSendStart, cmdDispatchStart);
    const replayReturn = cmdSend.indexOf('if (turnPrimaryReplayed) {');
    const oncallDelivery = cmdSend.indexOf('if (oncallGroupCard && messageId)');

    expect(replayReturn).toBeGreaterThan(cmdSend.indexOf('messageId = await dispatchPrimary'));
    expect(replayReturn).toBeLessThan(oncallDelivery);
    expect(cmdSend.slice(replayReturn, oncallDelivery)).toContain('replayed: true');
    expect(cmdSend.slice(replayReturn, oncallDelivery)).toContain('return;');
  });
});
