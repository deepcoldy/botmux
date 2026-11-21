import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { settleScheduledSend } from '../src/core/scheduled-send.js';
import type { Session } from '../src/types.js';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const turnId = 'schedule:abcdef12:12345678-1234-1234-1234-123456789abc';

function send(options: { owner?: string; previousOwnerOnly?: boolean; marker?: string; audience?: string; args?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'schedule-feedback-cli-'));
  const dataDir = join(root, 'data');
  const session = { sessionId: 'sid_schedule', status: 'active', cliId: 'codex',
    larkAppId: 'cli_test', chatId: 'oc_test', rootMessageId: 'om_root', scope: 'thread',
    chatType: 'group', workingDir: root, ownerOpenId: options.owner,
    scheduledRun: { taskId: 'abcdef12', runId: 'run-1', turnId,
      requesterSubjectId: options.previousOwnerOnly ? undefined : options.owner } } as Session;
  try {
    mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
    writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
      sessionId: session.sessionId, turnId: options.marker ?? turnId,
    }));
    writeFileSync(join(root, 'bots.json'), JSON.stringify([{
      larkAppId: 'cli_test', larkAppSecret: 'test-secret', cliId: 'codex', replyCardMode: 'legacy',
      feedback: { enabled: true, audience: options.audience ?? 'requester' },
    }]));
    seedPersistedSessionRows(dataDir, 'cli_test', { [session.sessionId]: session });
    const result = spawnSyncTsScript(fixture, ['send', 'scheduled notice', '--response-kind', 'final',
      '--no-mention', ...(options.args ?? [])], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: join(root, 'bots.json'), BOTMUX_SESSION_ID: session.sessionId,
        BOTMUX_TURN_ID: turnId, BOTMUX_LARK_APP_ID: 'cli_test' },
    });
    const requests = String(result.stdout).split('\n').filter(line => line.startsWith('CAPTURE_REPLY='))
      .map(line => JSON.parse(line.slice('CAPTURE_REPLY='.length)));
    return { status: result.status, stderr: String(result.stderr), requests,
      settlement: settleScheduledSend(dataDir, session, turnId) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('real scheduled final send', () => {
  it('delivers an ownerless notification with requester feedback configured', () => {
    const result = send();
    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.length).toBeGreaterThan(0);
    expect(result.settlement.state).toBe('delivered');
  });

  it('does not trust a forged schedule env over an ordinary human-turn marker', () => {
    const result = send({ marker: 'om_human' });
    expect(result.status).toBe(2);
    expect(result.requests).toEqual([]);
  });

  it('does not give requester feedback to the previous owner of a reused session', () => {
    const result = send({ owner: 'ou_previous_owner', previousOwnerOnly: true, args: ['--top-level'] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.settlement.state).toBe('delivered');
  });

  it('records a final send policy rejection on its exact scheduled execution', () => {
    const result = send({ owner: 'ou_requester', args: ['--top-level'] });
    expect(result.status).toBe(2);
    expect(result.settlement).toMatchObject({ state: 'failed', runId: 'run-1', errorCode: 'schedule_send_rejected' });
    expect(result.requests).toEqual([]);
  });

  it('does not attribute a pure argv rejection before origin authentication', () => {
    const result = send({ args: ['--card-file'] });
    expect(result.status).toBe(2);
    expect(result.requests).toEqual([]);
    expect(result.settlement).toEqual({ state: 'silent' });
  });
});
