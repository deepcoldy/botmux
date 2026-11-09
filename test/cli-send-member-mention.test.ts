import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncTsScript, spawnTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { ensureManagedOriginAttestationDirectory, managedOriginCapabilityPath,
  managedOriginIsolationMarkerPath, replaceManagedOriginCapabilityFile } from '../src/core/managed-origin-capability.js';
import { MANAGED_ORIGIN_PROOF_DOMAIN, writeManagedOriginAttestationProof } from '../src/core/managed-origin-attestation.js';
import { settleScheduledSend } from '../src/core/scheduled-send.js';
import { TurnSendLedger } from '../src/services/turn-send-ledger.js';

function send(scenario: 'unique' | 'duplicate' | 'missing') {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-member-mention-'));
  try {
    const botsPath = join(dir, 'bots.json');
    writeFileSync(botsPath, JSON.stringify([{
      larkAppId: 'cli_test', larkAppSecret: 'test', cliId: 'claude-code',
      allowArbitraryMention: true, allowedUsers: [], workingDir: dir,
    }]));
    seedPersistedSessionRows(join(dir, 'data'), 'cli_test', {
      'test-member-mention': {
        sessionId: 'test-member-mention', larkAppId: 'cli_test', chatId: 'oc_test',
        scope: 'chat', status: 'active', cliId: 'claude-code', workingDir: dir,
        ownerOpenId: 'ou_owner', createdAt: new Date(0).toISOString(),
      },
    });
    return spawnSyncTsScript(fileURLToPath(new URL('./fixtures/send-member-mention-capture.ts', import.meta.url)), [
      'send', '--mention', 'recipient@example.com:Recipient', 'Please review @Recipient',
    ], {
      env: {
        PATH: process.env.PATH, HOME: dir, SESSION_DATA_DIR: join(dir, 'data'), BOTS_CONFIG: botsPath,
        BOTMUX_LARK_APP_ID: 'cli_test',
        BOTMUX_SESSION_ID: 'test-member-mention', BOTMUX_CHAT_ID: 'oc_test', BOTMUX_SESSION_SCOPE: 'chat',
        TEST_MEMBER_SCENARIO: scenario,
      },
      encoding: 'utf8', timeout: 30_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('cmdSend member display-name fallback', () => {
  it('delivers a real mention when contact lookup misses but the chat name is unique', () => {
    const result = send('unique');
    expect(result.status, String(result.stderr)).toBe(0);
    const stdout = String(result.stdout);
    expect(stdout).toContain('CONTACT_LOOKUP=');
    expect(stdout).toContain('recipient@example.com');
    expect(stdout).toContain('MEMBER_LOOKUP=oc_test');
    const captured = stdout.split('\n').find(line => line.startsWith('CAPTURE_MESSAGE='));
    expect(captured, stdout).toBeTruthy();
    const message = JSON.parse(captured!.slice('CAPTURE_MESSAGE='.length));
    expect(message.receive_id).toBe('oc_test');
    expect(message.content).toContain('<at id=ou_recipient></at>');
    expect(message.content).not.toContain('ou_owner');
  });

  it.each(['duplicate', 'missing'] as const)('exits 2 without sending when the chat name is %s', scenario => {
    const result = send(scenario);
    expect(result.status, String(result.stderr)).toBe(2);
    expect(String(result.stdout)).toContain('CONTACT_LOOKUP=');
    expect(String(result.stdout)).toContain('MEMBER_LOOKUP=oc_test');
    expect(String(result.stderr)).toContain('无法解析这些标识为当前群唯一成员');
    expect(String(result.stdout)).not.toContain('CAPTURE_MESSAGE=');
  });
});

/** The parent owns the proof writer; the CLI can read its own credentials but
 * cannot read the full host registry. No external Lark request is performed. */
async function isolatedSend(permission: boolean | undefined, opts: {
  revoke?: boolean; proofAppId?: string; shiftAppOnRevalidation?: boolean;
  omitPermissionOnRevalidation?: boolean;
  scenario?: 'unique' | 'duplicate' | 'missing' | 'outsider';
  scheduled?: boolean; revokeAfter?: number; failMessage?: boolean;
  privateReply?: boolean; revokeOnMessage?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-isolated-mention-'));
  const dataDir = join(dir, 'data');
  const channelId = 'ab'.repeat(32), capability = 'cd'.repeat(32);
  const markerPath = join(dataDir, '.botmux-cli-pids', String(process.pid));
  const turnId = opts.scheduled
    ? 'schedule:abcdef12:12345678-1234-1234-1234-123456789abc' : 'om_isolated_turn';
  const scheduledRun = opts.scheduled ? { taskId: 'abcdef12', runId: 'run-1', turnId } : undefined;
  const session = { sessionId: 'test-member-mention', larkAppId: 'cli_test', chatId: 'oc_test', scheduledRun };
  const ledger = new TurnSendLedger(dataDir);
  const key = { larkAppId: session.larkAppId, sessionId: session.sessionId, turnId };
  let challenges = 0;
  let messageStarted = false;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => {
      if (req.url === '/test/message-started') {
        messageStarted = true;
        res.writeHead(200).end('{}');
        return;
      }
      let request: any;
      try { request = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      if (req.url !== '/api/session-origin/attest' || request.sessionId !== 'test-member-mention'
        || request.channelId !== channelId || request.originCapability !== capability) {
        res.writeHead(403).end(); return;
      }
      challenges++;
      writeManagedOriginAttestationProof({ dataDir, proof: {
        domain: MANAGED_ORIGIN_PROOF_DOMAIN, version: 1, nonce: request.nonce,
        channelId, sessionId: 'test-member-mention', turnId,
        larkAppId: opts.shiftAppOnRevalidation && challenges > 1 ? 'cli_other' : (opts.proofAppId ?? 'cli_test'),
        // A revalidation proof from an older daemon (or one that lost the
        // field mid-turn) must keep default-deny, not silently allow.
        ...(opts.omitPermissionOnRevalidation && challenges > 1
          ? {}
          : permission === undefined
            ? {}
            : { allowArbitraryMention: (opts.revokeOnMessage && messageStarted)
                || ((opts.revoke || opts.revokeAfter !== undefined)
                  && challenges > (opts.revokeAfter ?? 1)) ? false : permission }),
        requiresCodexAppLedger: false, issuedAtMs: Date.now(),
      } as any });
      // Even an apparently allowing HTTP body is not permission authority.
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ allowArbitraryMention: true }));
    });
  });
  try {
    mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
    writeFileSync(markerPath, JSON.stringify({ sessionId: 'test-member-mention', turnId }));
    chmodSync(markerPath, 0o000);
    expect(() => readFileSync(markerPath)).toThrow();
    const botsPath = join(dir, 'bots.json');
    writeFileSync(botsPath, JSON.stringify([{ larkAppId: 'cli_test', larkAppSecret: 'test',
      cliId: 'claude-code', allowArbitraryMention: true }]));
    chmodSync(botsPath, 0o000);
    expect(() => readFileSync(botsPath)).toThrow();
    const botHome = join(dir, 'bots', 'cli_test');
    mkdirSync(botHome, { recursive: true });
    // A planted permission in the writable credential file must not win.
    writeFileSync(join(botHome, 'send-cred.json'), JSON.stringify({ larkAppSecret: 'test', allowArbitraryMention: true }));
    seedPersistedSessionRows(dataDir, 'cli_test', { 'test-member-mention': {
      sessionId: 'test-member-mention', larkAppId: 'cli_test', chatId: 'oc_test',
      scope: opts.privateReply ? 'thread' : 'chat', status: 'active', cliId: 'claude-code', workingDir: dir,
      ...(opts.privateReply ? { chatType: 'group', rootMessageId: 'om_topic',
        replyTargets: { [turnId]: { senderOpenId: 'ou_requester', updatedAt: new Date().toISOString() } } } : {}),
      ownerOpenId: 'ou_owner', createdAt: new Date(0).toISOString(),
      ...(scheduledRun ? { scheduledRun } : {}),
    } });
    if (opts.privateReply) {
      mkdirSync(join(dataDir, 'roles', 'cli_test'), { recursive: true });
      writeFileSync(join(dataDir, 'roles', 'cli_test', 'oc_test.meta.json'), JSON.stringify({ replyPrivately: true }));
    }
    if (scheduledRun) ledger.enableHandoffFence(key);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    ensureManagedOriginAttestationDirectory(dataDir, 'test-member-mention', channelId);
    rmSync(managedOriginIsolationMarkerPath(dataDir, 'test-member-mention', channelId));
    replaceManagedOriginCapabilityFile(managedOriginCapabilityPath(dataDir, 'test-member-mention', channelId),
      JSON.stringify({ sessionId: 'test-member-mention', channelId, capability, ipcPort: (server.address() as AddressInfo).port }));
    const child = spawnTsScript(fileURLToPath(new URL('./fixtures/send-member-mention-capture.ts', import.meta.url)), [
      'send', ...(scheduledRun ? ['--response-kind', 'final'] : []),
      '--mention', 'recipient@example.com:Recipient', 'Please review @Recipient',
    ], { env: { PATH: process.env.PATH, HOME: dir, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: botsPath,
      BOTMUX_LARK_APP_ID: 'cli_test', BOTMUX_SESSION_ID: 'test-member-mention',
      BOTMUX_ORIGIN_CHANNEL_ID: channelId,
      BOTMUX_CHAT_ID: 'oc_test', BOTMUX_SESSION_SCOPE: opts.privateReply ? 'thread' : 'chat', TEST_MEMBER_SCENARIO: opts.scenario ?? 'unique',
      ...(opts.revokeOnMessage ? { TEST_MESSAGE_STARTED_PORT: String((server.address() as AddressInfo).port) } : {}),
      ...(opts.failMessage ? { TEST_MESSAGE_FAILURE: '1' } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'] });
    return await new Promise<{ status: number | null; stdout: string; stderr: string; challenges: number;
      settlement: ReturnType<typeof settleScheduledSend>; receipt: ReturnType<TurnSendLedger['read']> }>((resolve, reject) => {
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`isolated send timed out: ${stderr}`)); }, 30_000);
      child.stdout!.on('data', chunk => { stdout += String(chunk); });
      child.stderr!.on('data', chunk => { stderr += String(chunk); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr, challenges,
        settlement: settleScheduledSend(dataDir, session, turnId), receipt: ledger.read(key) }); });
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.getuid?.() === 0 || process.platform === 'win32')('cmdSend host-proven isolated mentions', () => {
  it('sends an email mention using host permission while bots.json is unreadable', async () => {
    const result = await isolatedSend(true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('<at id=ou_recipient></at>');
    expect(result.stdout.match(/CAPTURE_MESSAGE=/g)).toHaveLength(1);
    expect(result.challenges).toBeGreaterThan(1);
  }, 40_000);

  it.each([false, undefined])('refuses permission %s despite an allowing credential file and HTTP body', async permission => {
    const result = await isolatedSend(permission);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).not.toContain('CAPTURE_MESSAGE=');
    expect(result.stdout).not.toContain('CONTACT_LOOKUP=');
  }, 40_000);

  it('does not use a proof for another app', async () => {
    const result = await isolatedSend(true, { proofAppId: 'cli_other' });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).not.toContain('CAPTURE_MESSAGE=');
  }, 40_000);

  it('refuses a same-turn permission revocation before the provider sends', async () => {
    const result = await isolatedSend(true, { revoke: true });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('allowArbitraryMention permission revoked before provider effect');
    expect(result.stdout).not.toContain('CAPTURE_MESSAGE=');
    expect(result.challenges).toBeGreaterThan(1);
  }, 40_000);

  it('refuses when a revalidation proof omits the permission field (default-deny)', async () => {
    const result = await isolatedSend(true, { omitPermissionOnRevalidation: true });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('allowArbitraryMention permission revoked before provider effect');
    expect(result.stdout).not.toContain('CAPTURE_MESSAGE=');
    expect(result.challenges).toBeGreaterThan(1);
  }, 40_000);

  it('refuses when the owning app changes between proof and pre-effect revalidation', async () => {
    const result = await isolatedSend(true, { shiftAppOnRevalidation: true });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('managed origin changed before provider effect');
    expect(result.stdout).not.toContain('CAPTURE_MESSAGE=');
    expect(result.challenges).toBeGreaterThan(1);
  }, 40_000);

  it.each(['duplicate', 'missing'] as const)('preserves %s group-member rejection', async scenario => {
    const result = await isolatedSend(true, { scenario });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toContain('MEMBER_LOOKUP=oc_test');
    expect(result.stdout).not.toContain('CAPTURE_MESSAGE=');
  }, 40_000);

  it('rejects a contact-resolved recipient outside the destination group', async () => {
    const result = await isolatedSend(true, { scenario: 'outsider' });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('以下用户不在目标群里');
    expect(result.stdout).toContain('CONTACT_LOOKUP=');
    expect(result.stdout).toContain('MEMBER_LOOKUP=oc_test');
    expect(result.stdout).not.toContain('CAPTURE_MESSAGE=');
  }, 40_000);

  it('settles a host-authorized scheduled mention as delivered', async () => {
    const result = await isolatedSend(true, { scheduled: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/CAPTURE_MESSAGE=/g)).toHaveLength(1);
    expect(result.settlement).toEqual({ state: 'delivered', messageId: 'om_test_sent' });
  }, 40_000);

  it.each([1, 3])('clears a new publication when scheduled mention permission is revoked after proof %s', async revokeAfter => {
    const result = await isolatedSend(true, { scheduled: true, revokeAfter });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).not.toContain('CAPTURE_MESSAGE=');
    expect(result.challenges).toBeGreaterThan(revokeAfter);
    expect(result.receipt?.publication).toBeUndefined();
    expect(result.settlement).toMatchObject({ state: 'failed', runId: 'run-1', errorCode: 'schedule_send_rejected' });
  }, 40_000);

  it('preserves unknown delivery when scheduled permission is revoked after a lost provider response', async () => {
    const result = await isolatedSend(true, { scheduled: true, revokeAfter: 4, failMessage: true });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout.match(/CAPTURE_MESSAGE=/g)).toHaveLength(1);
    expect(result.challenges).toBeGreaterThan(4);
    expect(result.receipt?.publication).toBeDefined();
    expect(result.settlement).toMatchObject({ state: 'failed', runId: 'run-1', errorCode: 'schedule_send_unknown' });
  }, 40_000);

  it('revalidates scheduled private mention permission before retrying an unconfirmed request', async () => {
    const result = await isolatedSend(true, { scheduled: true, privateReply: true, failMessage: true, revokeOnMessage: true });
    expect(result.status, result.stderr).toBe(1);
    const messages = result.stdout.split('\n').filter(line => line.startsWith('CAPTURE_MESSAGE='))
      .map(line => JSON.parse(line.slice('CAPTURE_MESSAGE='.length)));
    expect(messages).toHaveLength(1);
    expect(messages[0].receive_id).toBe('ou_requester');
    expect(result.receipt?.publication).toBeDefined();
    expect(result.settlement).toMatchObject({ state: 'failed', runId: 'run-1', errorCode: 'schedule_send_unknown' });
  }, 40_000);
});
