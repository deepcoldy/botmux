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

const replyCaptureFixture = join(__dirname, 'fixtures', 'send-reply-card-capture.ts');

/** Run `botmux send` through the real CLI with Lark HTTP captured (no network). */
function runCapturedSend(args: string[], session: Record<string, unknown>, turnId = 'om_turn_capture') {
  const root = mkdtempSync(join(tmpdir(), 'botmux-send-capture-'));
  const dataDir = join(root, 'data');
  try {
    mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
    writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: 'sid_capture', turnId }));
    writeFileSync(join(root, 'bots.json'), JSON.stringify([{
      larkAppId: 'cli_test', larkAppSecret: 'test-secret', cliId: 'codex', replyCardMode: 'legacy',
    }]));
    seedPersistedSessionRows(dataDir, 'cli_test', { sid_capture: {
      sessionId: 'sid_capture', status: 'active', cliId: 'codex', larkAppId: 'cli_test',
      chatId: 'oc_test', rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
      ...session,
    } });
    const result = spawnSyncTsScript(replyCaptureFixture, ['send', ...args], {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(root, 'bots.json'),
        BOTMUX_SESSION_ID: 'sid_capture', BOTMUX_TURN_ID: turnId, BOTMUX_LARK_APP_ID: 'cli_test',
      },
    });
    const requests = String(result.stdout).split('\n')
      .filter(line => line.startsWith('CAPTURE_REPLY='))
      .map(line => JSON.parse(line.slice('CAPTURE_REPLY='.length)));
    return { status: result.status, stderr: String(result.stderr), requests };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('cmdSend hook context wiring', () => {
  it('strips a trailing memory citation before the direct send renders the reply', () => {
    const citation = [
      '<oai-mem-citation>', '<citation_entries>', 'MEMORY.md:10-12|note=[routing context]',
      '</citation_entries>', '<rollout_ids>', '019c1234', '</rollout_ids>', '</oai-mem-citation>',
    ].join('\n');
    const result = runCapturedSend(
      ['--no-mention', '--response-kind', 'final', `Visible answer.\n\n${citation}`],
      {},
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.requests).toHaveLength(1);
    const body = JSON.stringify(result.requests[0].body);
    expect(body).toContain('Visible answer.');
    expect(body).not.toContain('oai-mem-citation');
    expect(body).not.toContain('MEMORY.md:10-12');
  }, 40_000);

  // #750: --mention-back @s the sender of the EXACT current turn. An evicted
  // exact-turn record must resolve to no sender — never the global latest slot,
  // which may already belong to a different turn B.
  it.each([
    [
      'mentions the exact turn sender even after the global slot advanced to another turn',
      {
        quoteTargetId: 'om_turn_b', quoteTargetSenderOpenId: 'ou_turn_b',
        replyTargets: { om_turn_a: {
          updatedAt: new Date().toISOString(), senderOpenId: 'ou_turn_a',
          participants: [{ openId: 'ou_turn_a', isBot: false }],
        } },
      },
      'ou_turn_a',
    ],
    [
      'does not borrow the advanced global slot when the exact turn record is gone',
      {
        chatType: 'p2p', scope: 'chat',
        quoteTargetId: 'om_turn_b', quoteTargetSenderOpenId: 'ou_turn_b',
      },
      null,
    ],
    [
      'refuses --mention-back when the turn window has more than one counterpart',
      {
        replyTargets: { om_turn_a: {
          updatedAt: new Date().toISOString(), senderOpenId: 'ou_turn_a',
          participants: [{ openId: 'ou_turn_a', isBot: false }, { openId: 'ou_turn_c', isBot: false }],
        } },
      },
      null,
    ],
  ] as const)('%s', (_name, session, sent) => {
    const result = runCapturedSend(['--mention-back', '--response-kind', 'final', 'answer'], session, 'om_turn_a');
    const captured = JSON.stringify(result.requests);
    expect(captured).not.toContain('ou_turn_b');
    expect(captured).not.toContain('ou_turn_c');
    if (sent) {
      expect(result.status, result.stderr).toBe(0);
      expect(result.requests).toHaveLength(1);
      expect(captured).toContain(sent);
    } else {
      expect(result.status).toBe(2);
      expect(result.requests).toEqual([]);
    }
  }, 40_000);

  it.each(['http_async', 'suppressed'] as const)(
    'fails closed when the live durable turn is bound to the %s sink',
    async sink => {
      const root = mkdtempSync(join(tmpdir(), 'botmux-send-non-lark-sink-'));
      const dataDir = join(root, 'data');
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
        sessionId: 'session', turnId: 'turn-live',
      }));
      seedPersistedSessionRows(dataDir, 'app-a', {
        session: {
          sessionId: 'session', chatId: 'oc_chat', rootMessageId: 'om_root',
          title: 'host', status: 'active', createdAt: new Date(0).toISOString(),
          larkAppId: 'app-a', cliId: 'codex-app',
          codexAppDispatchLedger: [{
            dispatchId: 'dispatch-live', turnId: 'turn-live',
            state: 'prepared', content: 'prompt', deliverySink: sink,
          }],
        },
      });
      try {
        const result = await runCli(['send', 'must not send', '--session-id', 'session', '--no-mention'], {
          ...process.env,
          SESSION_DATA_DIR: dataDir,
          BOTMUX_SESSION_ID: 'session',
          BOTMUX_SEND_RELAY: '',
          BOTMUX_HOST_RELAY_AUTHORIZED: '',
          BOTMUX_WORKFLOW: '',
          BOTMUX_LARK_APP_ID: '', BOTMUX_LARK_APP_SECRET: '',
        });
        expect(result.code).toBe(2);
        expect(result.stderr).toContain(`bound to the ${sink} host sink`);
        expect(result.stderr).not.toContain('must not send');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

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
        // Tolerate a loopback port-scanner probe (`GET /` with an empty body):
        // parsing that as JSON would throw inside an event callback, which is a
        // hard crash rather than a rejected promise. See helpers/read-request-body.ts.
        let request: { sessionId: string; channelId: string; originCapability: string; nonce: string };
        try {
          request = JSON.parse(body) as typeof request;
        } catch {
          res.writeHead(400).end();
          return;
        }
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

  it.each([
    ['explicit plus none mention decisions', ['--no-mention', '--mention', 'ou_forbidden']],
    ['two mention decisions', ['--no-mention', '--mention-back']],
    // The relay event carries no destination override or richer payload: a
    // forged flag must not turn it into cross-chat delivery or an upload.
    ['a top-level route override', ['--no-mention', '--top-level']],
    ['a cross-chat route override', ['--no-mention', '--chat-id', 'oc_other']],
    ['a file attachment', ['--no-mention', '--file', join(__dirname, '..', 'package.json')]],
    ['a voice reply', ['--no-mention', '--voice']],
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
      expect(result.stderr).toContain('supports only current-session Markdown/images with one none/requester/explicit mention decision');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['auxiliary', 'final'] as const)(
    'accepts one explicit Remote Runner recipient for %s before ordinary content validation',
    async responseKind => {
      const root = mkdtempSync(join(tmpdir(), 'botmux-remote-outbound-explicit-'));
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
        const missingContent = join(root, 'missing.md');
        const result = await runCli([
          'send', '--remote-runner-outbound', '--response-kind', responseKind,
          '--session-id', 'session', '--mention', 'ou_target:Target',
          '--content-file', missingContent,
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
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`文件不存在: ${missingContent}`);
        expect(result.stderr).not.toContain('--remote-runner-outbound supports only');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['a voice reply', ['--voice']],
    ['a top-level route override', ['--top-level']],
    ['a cross-chat route override', ['--chat-id', 'oc_other']],
  ])('rejects %s on a document-comment turn before reading content', async (_name, extraArgs) => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-doc-comment-plain-only-'));
    const dataDir = join(root, 'data');
    const sessionId = 'sid_doc_comment_plain_only';
    const turnId = 'turn_doc_comment_plain_only';
    mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
    writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId, turnId }));
    writeFileSync(join(root, 'bots.json'), JSON.stringify([{
      larkAppId: 'cli_test', larkAppSecret: 'test-secret', cliId: 'codex', replyCardMode: 'legacy',
    }]));
    seedPersistedSessionRows(dataDir, 'cli_test', { [sessionId]: {
      sessionId, status: 'active', cliId: 'codex', larkAppId: 'cli_test',
      chatId: 'doc:doc_test', rootMessageId: 'om_root', scope: 'thread', workingDir: root,
      docCommentTargets: { [turnId]: { fileToken: 'doc_test', fileType: 'docx', commentId: 'comment_test', turnId } },
    } });
    // The content file does not exist: reaching the content read would exit 1
    // with a missing-file error instead of the document-comment refusal.
    const missingContent = join(root, 'missing.md');
    try {
      const result = await runCli(
        ['send', '--no-mention', '--response-kind', 'final', '--content-file', missingContent, ...extraArgs],
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
      expect(result.stderr).toContain('a document-comment turn supports only its exact plain-text comment reply');
      expect(result.stderr).not.toContain(missingContent);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // 源码结构护栏(K3)：轮次 final 的非幂等投递收口（41cec7ec9「轮次发送幂等收口」）。文档评论的
  // 每个分块都必须走 executeNonIdempotentSequence 的 checkpoint，否则「结果未知」后的重试会重复
  // 发评论；并发重试里输掉发布锁的进程（turnPrimaryReplayed）必须在主投递后立刻 return，不得重复
  // 索引、附件、加急、oncall 投递等副作用。两条都在 cmdSend 巨型函数里，现有 capture fixture 无法
  // 制造「请求已发出但结果未知」或两个进程的发布锁竞争，只能钉住调用的相对位置。
  it('never repeats non-idempotent provider effects on a retried or concurrently replayed final', () => {
    const cmdSendStart = cliSource.indexOf('async function cmdSend(');
    const cmdDispatchStart = cliSource.indexOf('async function cmdDispatch(', cmdSendStart);
    const cmdSend = cliSource.slice(cmdSendStart, cmdDispatchStart);

    const docSendStart = cmdSend.indexOf('if (isOriginDocCommentTurn)', cmdSend.indexOf('// Read content from:'));
    const docSend = cmdSend.slice(docSendStart, cmdSend.indexOf('// Parse mentions:', docSendStart));
    const checkpoint = docSend.indexOf('executeNonIdempotentSequence(');
    expect(docSendStart).toBeGreaterThan(-1);
    expect(checkpoint).toBeGreaterThan(-1);
    expect(docSend.indexOf('replyToDocComment(')).toBeGreaterThan(checkpoint);
    expect(docSend.indexOf('removeCommentReaction(')).toBeGreaterThan(checkpoint);

    const primarySend = cmdSend.indexOf('messageId = await dispatchPrimary');
    const replayReturn = cmdSend.indexOf('if (turnPrimaryReplayed) {', primarySend);
    const oncallDelivery = cmdSend.indexOf('if (oncallGroupCard && messageId)', replayReturn);
    expect(primarySend).toBeGreaterThan(-1);
    expect(replayReturn).toBeGreaterThan(primarySend);
    expect(oncallDelivery).toBeGreaterThan(replayReturn);
    expect(cmdSend.slice(replayReturn, oncallDelivery)).toMatch(/\breturn;/);
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

  // 源码结构护栏(K2)：会议托管 Agent（vcMeetingManagedSendOrigin）的出站围栏——路由/提及/附件/
  // 原生 @ 的限制必须在任何 provider 动作之前判定（fa9914f20 #470）。各判定是 send-policy.ts 的纯
  // 函数并由 test/send-policy.test.ts 行为覆盖；cmdSend 巨型函数里「先判后发」的接线没有 seam，
  // 制造托管会议 origin 又要整套 VC 投递存储，这里只钉判定与首个 provider 动作的相对顺序。
  it('decides managed VC meeting send restrictions before any provider effect', () => {
    const cmdSendStart = cliSource.indexOf('async function cmdSend(');
    const cmdDispatchStart = cliSource.indexOf('async function cmdDispatch(', cmdSendStart);
    const cmdSend = cliSource.slice(cmdSendStart, cmdDispatchStart);
    const at = (needle: string, from = 0) => {
      const i = cmdSend.indexOf(needle, from);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const firstProviderEffect = Math.min(
      at("const { sendMessage, replyMessage"),
      at("const { synthesizeVoiceOpus }"),
    );
    expect(at('managedVcSendControlError(')).toBeLessThan(firstProviderEffect);
    expect(at('managedVcSendPayloadError(')).toBeLessThan(firstProviderEffect);
    expect(at('managedVcQuoteError(')).toBeLessThan(firstProviderEffect);
    expect(at('managedVcCustomCardError(')).toBeLessThan(firstProviderEffect);
    // The rendered payload is re-checked after card preparation, before uploads.
    const payloadChecks = [...cmdSend.matchAll(/managedVcSendPayloadError\(/g)].map(m => m.index!);
    expect(payloadChecks.length).toBeGreaterThanOrEqual(2);
    const renderedCheck = payloadChecks[payloadChecks.length - 1]!;
    expect(renderedCheck).toBeLessThan(at('await uploadImage(', renderedCheck));
  });
});
