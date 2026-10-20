/**
 * Real `botmux send` in a silent fresh-topic schedule run whose CLI cannot
 * create `<dataDir>/deferred-topics` (sandbox / read isolation, simulated by a
 * file squatting the directory name). The first-message claim must go through
 * the daemon route instead of failing with EPERM, and a writable data dir must
 * keep the local sidecar with no daemon round-trip.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const key = { larkAppId: 'cli_test', sessionId: 'sid_deferred', turnId: 'schedule:task-1:run-1' };

function runSend(sidecarWritable: boolean, rootFacts?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-send-deferred-'));
  const dataDir = join(root, 'data');
  const daemonDataDir = join(root, 'daemon-data');
  const run = {
    taskId: 'task-1',
    turnId: key.turnId,
    routingAnchor: 'schedule-run:task-1:run-1',
    createdAt: new Date(Date.now() - 5_000).toISOString(),
  };
  mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
  writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
    sessionId: key.sessionId,
    turnId: key.turnId,
  }));
  if (!sidecarWritable) writeFileSync(join(dataDir, 'deferred-topics'), 'not a directory');
  writeFileSync(join(root, 'bots.json'), JSON.stringify([{
    larkAppId: key.larkAppId, larkAppSecret: 'test-secret', cliId: 'claude-code',
  }]));
  seedPersistedSessionRows(dataDir, key.larkAppId, { [key.sessionId]: {
    ...key,
    status: 'active',
    cliId: 'claude-code',
    chatId: 'oc_test',
    rootMessageId: 'schedule-run:task-1:run-1',
    scope: 'chat',
    chatType: 'group',
    workingDir: root,
    deferredScheduleRun: run,
  } });
  const daemonSession = {
    session: { sessionId: key.sessionId, status: 'active', deferredScheduleRun: run },
    larkAppId: key.larkAppId,
    chatId: 'oc_test',
    managedTurnOrigin: { capability: 'cap', turnId: key.turnId },
  };
  const result = spawnSyncTsScript(fixture, ['send', '--no-mention', '刷新成功'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      PATH: process.env.PATH,
      HOME: root,
      SESSION_DATA_DIR: dataDir,
      BOTS_CONFIG: join(root, 'bots.json'),
      BOTMUX_SESSION_ID: key.sessionId,
      BOTMUX_TURN_ID: key.turnId,
      BOTMUX_LARK_APP_ID: key.larkAppId,
      BOTMUX_DAEMON_IPC_PORT: '7951',
      BOTMUX_TEST_DEFERRED_TOPIC_DAEMON: '1',
      BOTMUX_TEST_DAEMON_DATA_DIR: daemonDataDir,
      BOTMUX_TEST_DEFERRED_DAEMON_SESSION: JSON.stringify(daemonSession),
      ...(rootFacts ? { BOTMUX_TEST_DEFERRED_ROOT_FACTS: JSON.stringify(rootFacts) } : {}),
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  const lines = String(result.stdout).split('\n');
  const parse = (prefix: string) => lines.filter(l => l.startsWith(prefix)).map(l => JSON.parse(l.slice(prefix.length)));
  return { root, dataDir, daemonDataDir, result, daemon: parse('CAPTURE_DAEMON='), lark: parse('CAPTURE_REPLY=') };
}

describe('botmux send in a deferred schedule run', () => {
  it('claims the topic through the daemon when the sidecar is not writable', () => {
    const run = runSend(false);
    try {
      expect(run.result.status, String(run.result.stderr)).toBe(0);
      expect(String(run.result.stderr)).not.toContain('EPERM');
      const roots = run.lark.filter(r => r.method === 'POST' && r.path === '/open-apis/im/v1/messages');
      expect(roots).toHaveLength(1);
      expect(roots[0].body.uuid).toBe(key.sessionId);
      const actions = run.daemon.map(r => r.body.action);
      expect(actions).toContain('claim');
      expect(actions).toContain('commit');
      expect(actions.indexOf('claim')).toBeLessThan(actions.indexOf('commit'));
      expect(run.daemon.find(r => r.body.action === 'commit')).toMatchObject({
        path: `/api/sessions/${key.sessionId}/deferred-topic`,
        body: { rootMessageId: 'om_separate_message' },
      });
      const binding = JSON.parse(readFileSync(join(run.daemonDataDir, 'deferred-topics', `${key.sessionId}.json`), 'utf8'));
      expect(binding).toMatchObject({ sessionId: key.sessionId, turnId: key.turnId, chatId: 'oc_test', rootMessageId: 'om_separate_message' });
      // Correlation is the daemon's to derive: the CLI never names a turn or chat.
      for (const r of run.daemon) {
        for (const field of ['turnId', 'chatId', 'larkAppId', 'routingAnchor']) expect(r.body).not.toHaveProperty(field);
      }
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  }, 35_000);

  it('fails the send and records nothing when the daemon rejects the published root', () => {
    const run = runSend(false, { chatId: 'oc_elsewhere', senderAppId: key.larkAppId, isReply: false, createdAtMs: Date.now() });
    try {
      expect(run.result.status).not.toBe(0);
      expect(String(run.result.stderr)).toContain('root_outside_target_chat');
      expect(existsSync(join(run.daemonDataDir, 'deferred-topics', `${key.sessionId}.json`))).toBe(false);
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  }, 35_000);

  it('keeps the local sidecar and never calls the daemon when it is writable', () => {
    const run = runSend(true);
    try {
      expect(run.result.status, String(run.result.stderr)).toBe(0);
      expect(run.daemon).toHaveLength(0);
      const bindingPath = join(run.dataDir, 'deferred-topics', `${key.sessionId}.json`);
      expect(existsSync(bindingPath)).toBe(true);
      expect(JSON.parse(readFileSync(bindingPath, 'utf8'))).toMatchObject({ rootMessageId: 'om_separate_message' });
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  }, 35_000);
});
