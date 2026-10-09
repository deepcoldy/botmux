import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { TurnReplyCardStore } from '../src/services/turn-reply-card.js';
import { buildTurnReplyCard } from '../src/im/lark/turn-reply-card.js';
import { OncallGroupStore } from '../src/services/oncall-group-store.js';
import { projectGroupContextCard } from '../src/im/lark/group-context-card.js';
import { setGroupContextSettings } from '../src/services/group-context-settings-store.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { bindGroupContextDelivery, confirmGroupContextDelivery, getDeliveredGroupContextSeqs, writePreparedGroupContext } from '../src/services/group-context-delivery-store.js';
import { groupContextEpoch } from '../src/services/group-context-prompt.js';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const key = { larkAppId: 'cli_test', sessionId: 'sid_reply', turnId: 'om_turn' };
const presentation = { showProcess: true, showToolResults: true, canStop: true };

describe('real CLI send into a running reply card', () => {
  it.each<{
    cliId: string; args: string[]; senderIsBot: boolean | undefined; merged: boolean;
    sandbox?: boolean; sandboxEnv?: NodeJS.ProcessEnv; reserveCard?: boolean; oncall?: boolean;
    responseKind?: 'progress' | 'final' | 'auxiliary' | null;
  }>([
    { cliId: 'claude-code', args: ['--mention-back'], senderIsBot: false, merged: true },
    { cliId: 'codex', args: ['--mention-back'], senderIsBot: false, merged: true },
    { cliId: 'claude-code', args: ['--mention', 'ou_requester'], senderIsBot: false, merged: true },
    { cliId: 'claude-code', args: ['--no-mention'], senderIsBot: false, merged: true },
    { cliId: 'claude-code', args: ['--mention', 'ou_other'], senderIsBot: false, merged: false },
    { cliId: 'claude-code', args: ['--mention-back'], senderIsBot: true, merged: false },
    { cliId: 'claude-code', args: ['--mention-back'], senderIsBot: undefined, merged: false },
    { cliId: 'claude-code', args: ['--no-mention'], senderIsBot: false, merged: false, sandbox: true },
    { cliId: 'codex', args: ['--no-mention'], senderIsBot: false, merged: false, sandbox: true },
    { cliId: 'claude-code', args: ['--no-mention'], senderIsBot: false, merged: false, sandboxEnv: { BOTMUX_READ_ISOLATION: '1' } },
    { cliId: 'codex', args: ['--no-mention'], senderIsBot: false, merged: false, sandboxEnv: { BOTMUX_SANDBOX: '1' } },
    { cliId: 'claude-code', args: ['--no-mention'], senderIsBot: false, merged: false, sandbox: true, reserveCard: false },
    { cliId: 'claude-code', args: ['--no-mention'], senderIsBot: false, merged: true, oncall: true },
    { cliId: 'codex', args: ['--no-mention'], senderIsBot: false, merged: true, oncall: true },
    { cliId: 'claude-code', args: ['--mention', 'ou_other'], senderIsBot: false, merged: false, oncall: true },
    { cliId: 'claude-code', args: ['--no-mention'], senderIsBot: false, merged: false, reserveCard: false, responseKind: 'progress' },
    { cliId: 'claude-code', args: ['--no-mention'], senderIsBot: false, merged: false, reserveCard: false, responseKind: 'auxiliary' },
    { cliId: 'claude-code', args: ['--no-mention'], senderIsBot: false, merged: false, reserveCard: false, responseKind: null },
  ])('$cliId $args senderIsBot=$senderIsBot merged=$merged sandbox=$sandbox env=$sandboxEnv reserved=$reserveCard oncall=$oncall kind=$responseKind', async ({ cliId, args, senderIsBot, merged, sandbox, sandboxEnv, reserveCard = true, oncall = false, responseKind = 'final' }) => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-send-reply-'));
    const dataDir = join(root, 'data');
    try {
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
        sessionId: key.sessionId, turnId: key.turnId,
      }));
      writeFileSync(join(root, 'bots.json'), JSON.stringify([{
        larkAppId: key.larkAppId, larkAppSecret: 'test-secret', cliId, replyCardMode: 'unified',
        oncallGroup: { enabled: oncall, chatIds: ['oc_test'] },
      }]));
      seedPersistedSessionRows(dataDir, key.larkAppId, { [key.sessionId]: {
        ...key, status: 'active', cliId, cliSessionId: 'native_reply', workerGeneration: 1, sandbox, chatId: 'oc_test', rootMessageId: 'om_root',
        scope: 'thread', chatType: 'group', workingDir: root,
        replyTargets: { [key.turnId]: { updatedAt: new Date().toISOString(), senderOpenId: 'ou_requester',
          participants: [{ openId: 'ou_requester', isBot: senderIsBot }] } },
        turnReplyContexts: { [key.turnId]: { target: { mode: 'thread', rootMessageId: 'om_root' },
          replyTargetSenderOpenId: 'ou_requester', replyTargetSenderIsBot: senderIsBot } },
      } });
      await setGroupContextSettings('oc_test', { enabled: true }, dataDir);
      const binding = { appId: key.larkAppId, chatId: 'oc_test', sessionId: key.sessionId, turnId: key.turnId, workerGeneration: 1,
        epoch: groupContextEpoch(key.sessionId, 'native_reply', cliId, key.turnId) };
      writePreparedGroupContext({ ...binding, createdAt: Date.now(), body: '', includedSeqs: [], throughSeq: 0, incomplete: false }, dataDir);
      bindGroupContextDelivery(binding, dataDir);
      const store = new TurnReplyCardStore(dataDir);
      const send = vi.fn(async () => 'om_original_card');
      const patch = vi.fn(async () => {});
      const io = { send, patch, beforeEffect: () => {}, isWithdrawn: () => false,
        render: (record: Parameters<typeof buildTurnReplyCard>[0]) => buildTurnReplyCard(record, presentation) };
      if (reserveCard) {
        await store.prepare(key, { mode: 'unified', chatId: 'oc_test', rootId: 'om_root' });
        await store.update(key, { kind: 'start' }, io);
        await store.update(key, { kind: 'tools', tools: [{ id: 'tool1', name: 'Read', subject: 'README.md' }] }, io);
      }
      const result = spawnSyncTsScript(fixture, ['send', ...args, ...(responseKind ? ['--response-kind', responseKind] : []), 'Hello! 这是完整答复。'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(root, 'bots.json'),
          BOTMUX_SESSION_ID: key.sessionId, BOTMUX_TURN_ID: key.turnId, BOTMUX_LARK_APP_ID: key.larkAppId, ...sandboxEnv },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, String(result.stderr)).toBe(0);
      const requests = String(result.stdout).split('\n').filter(line => line.startsWith('CAPTURE_REPLY='))
        .map(line => JSON.parse(line.slice('CAPTURE_REPLY='.length)));
      expect(requests).toHaveLength(1);
      expect(getDeliveredGroupContextSeqs(binding.appId, binding.chatId, binding.sessionId, binding.epoch, dataDir)).toEqual([]);
      expect(confirmGroupContextDelivery(binding, dataDir)).toBe(true);
      if (responseKind !== 'progress') {
        const journal = openDatabaseSyncOrThrow(join(dataDir, 'group-context', `${key.larkAppId}.sqlite`));
        try {
          const published = journal.prepare('SELECT seq FROM messages WHERE message_id = ? ORDER BY revision DESC LIMIT 1')
            .get(merged ? 'om_original_card' : 'om_separate_message') as { seq: number };
          expect(published).toBeDefined();
          expect(getDeliveredGroupContextSeqs(binding.appId, binding.chatId, binding.sessionId, binding.epoch, dataDir)).toEqual([published.seq]);
          expect(getDeliveredGroupContextSeqs(binding.appId, binding.chatId, binding.sessionId, 'another-native', dataDir)).toEqual([]);
        } finally { journal.close(); }
      } else expect(getDeliveredGroupContextSeqs(binding.appId, binding.chatId, binding.sessionId, binding.epoch, dataDir)).toEqual([]);
      if (!merged && responseKind !== null) {
        expect(projectGroupContextCard(requests[0].body.content)?.kind).toBe(responseKind === 'progress' ? 'runtime' : 'conversation');
        expect(requests[0].body.content).toContain('\u2063'.repeat(responseKind === 'progress' ? 12 : 13));
      } else if (responseKind === null) {
        expect(requests[0].body.content).not.toContain('\u2063'.repeat(12));
      }
      expect(requests[0].body.content.includes('oncall_group_create')).toBe(oncall);
      const oncallSource = new OncallGroupStore(dataDir).findSource(key.larkAppId, merged ? 'om_original_card' : 'om_separate_message');
      if (oncall) expect(oncallSource).toMatchObject({ chatId: 'oc_test', questionId: key.turnId, answer: 'Hello! 这是完整答复。' });
      else expect(oncallSource).toBeUndefined();
      if (merged) {
        expect(requests[0]).toMatchObject({ method: 'PATCH', path: '/open-apis/im/v1/messages/om_original_card' });
        expect(requests[0].body.content).toContain('Hello! 这是完整答复。');
        const journal = openDatabaseSyncOrThrow(join(dataDir, 'group-context', `${key.larkAppId}.sqlite`));
        try {
          const published = journal.prepare('SELECT text, card_content_version FROM messages WHERE message_id = ? ORDER BY revision DESC LIMIT 1').get('om_original_card') as { text: string; card_content_version: number };
          expect(published).toMatchObject({ card_content_version: 1 });
          expect(published.text).toContain('Hello! 这是完整答复。');
          expect(published.text).not.toMatch(/README\.md|处理中|执行过程/);
        } finally { journal.close(); }
        await store.update(key, { kind: 'terminal', phase: 'completed', durationMs: 1200 }, io);
        expect(send).toHaveBeenCalledTimes(1);
        expect(store.read(key)).toMatchObject({ messageId: 'om_original_card', finalDelivered: true, phase: 'completed' });
        expect(store.read(key)?.lastCard).toContain('README.md');
        expect(store.read(key)?.lastCard).not.toContain('本轮没有提供最终答复');
        expect(store.read(key)?.lastCard?.includes('oncall_group_create')).toBe(oncall);
        const markers = readFileSync(join(dataDir, 'turn-sends', `${key.sessionId}.jsonl`), 'utf8');
        expect(JSON.parse(markers.trim())).toMatchObject({
          messageId: 'om_original_card',
          replyCardResponseKind: 'final',
          terminalCarrier: 'standard_reply_card',
        });
      } else {
        expect(requests[0].method).toBe('POST');
        expect(requests[0].body.content).toContain('Hello! 这是完整答复。');
        expect(store.read(key)?.finalDelivered).not.toBe(true);
        const markers = readFileSync(join(dataDir, 'turn-sends', `${key.sessionId}.jsonl`), 'utf8');
        expect(JSON.parse(markers.trim())).not.toHaveProperty('replyCardResponseKind');
        expect(JSON.parse(markers.trim())).toMatchObject({ terminalCarrier: 'standard_reply_card' });
        if (!reserveCard) expect(store.read(key)).toBeUndefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 35_000);

  it('routes a primary-mode final through daemon durable IPC without direct Lark delivery or card PATCH', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-send-durable-'));
    const dataDir = join(root, 'data');
    try {
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
        sessionId: key.sessionId,
        turnId: key.turnId,
      }));
      writeFileSync(join(root, 'bots.json'), JSON.stringify([{
        larkAppId: key.larkAppId,
        larkAppSecret: 'test-secret',
        cliId: 'claude-code',
        replyCardMode: 'unified',
      }]));
      seedPersistedSessionRows(dataDir, key.larkAppId, { [key.sessionId]: {
        ...key,
        status: 'active',
        cliId: 'claude-code',
        chatId: 'oc_test',
        rootMessageId: 'om_root',
        scope: 'thread',
        chatType: 'group',
        workingDir: root,
        replyTargets: { [key.turnId]: {
          updatedAt: new Date().toISOString(),
          senderOpenId: 'ou_requester',
          participants: [{ openId: 'ou_requester', isBot: false }],
        } },
        turnReplyContexts: { [key.turnId]: {
          target: { mode: 'thread', rootMessageId: 'om_root' },
          replyTargetSenderOpenId: 'ou_requester',
          replyTargetSenderIsBot: false,
        } },
      } });

      const result = spawnSyncTsScript(fixture, [
        'send', '--no-mention', '--response-kind', 'final', 'Durable final',
      ], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: {
          PATH: process.env.PATH,
          HOME: root,
          SESSION_DATA_DIR: dataDir,
          BOTS_CONFIG: join(root, 'bots.json'),
          BOTMUX_SESSION_ID: key.sessionId,
          BOTMUX_TURN_ID: key.turnId,
          BOTMUX_LARK_APP_ID: key.larkAppId,
          BOTMUX_COORDINATION_MODE: 'primary',
          BOTMUX_DAEMON_IPC_PORT: '7951',
          BOTMUX_TEST_DURABLE_SEND: '1',
        },
        encoding: 'utf8',
        timeout: 30_000,
      });

      expect(result.status, String(result.stderr)).toBe(0);
      expect(String(result.stdout)).not.toContain('CAPTURE_REPLY=');
      const requests = String(result.stdout).split('\n')
        .filter(line => line.startsWith('CAPTURE_DURABLE='))
        .map(line => JSON.parse(line.slice('CAPTURE_DURABLE='.length)));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: 'POST',
        path: `/api/sessions/${key.sessionId}/durable-send`,
        body: {
          turnId: key.turnId,
          target: { kind: 'reply', messageId: 'om_root', replyInThread: true },
          msgType: 'interactive',
          providerUuid: expect.stringMatching(/^dps_/),
        },
      });
      expect(requests[0].body.content).toContain('Durable final');
      expect(String(result.stdout)).toContain('"messageId":"om_durable_message"');

      const attachment = join(root, 'attachment.txt');
      writeFileSync(attachment, 'must not upload');
      const blocked = spawnSyncTsScript(fixture, [
        'send', '--no-mention', '--response-kind', 'auxiliary', '--files', attachment,
        'Unsupported multi-effect send',
      ], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: {
          PATH: process.env.PATH,
          HOME: root,
          SESSION_DATA_DIR: dataDir,
          BOTS_CONFIG: join(root, 'bots.json'),
          BOTMUX_SESSION_ID: key.sessionId,
          BOTMUX_TURN_ID: key.turnId,
          BOTMUX_LARK_APP_ID: key.larkAppId,
          BOTMUX_COORDINATION_MODE: 'primary',
          BOTMUX_DAEMON_IPC_PORT: '7951',
          BOTMUX_TEST_DURABLE_SEND: '1',
        },
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(blocked.status).toBe(2);
      expect(String(blocked.stderr)).toContain('durable primary 当前只支持单条文本/卡片消息');
      expect(String(blocked.stdout)).not.toContain('CAPTURE_DURABLE=');
      expect(String(blocked.stdout)).not.toContain('CAPTURE_REPLY=');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 35_000);
});
