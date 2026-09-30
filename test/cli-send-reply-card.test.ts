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

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const key = { larkAppId: 'cli_test', sessionId: 'sid_reply', turnId: 'om_turn' };
const presentation = { showProcess: true, showToolResults: true, canStop: true };

describe('real CLI send into a running reply card', () => {
  it.each<{
    cliId: string; args: string[]; senderIsBot: boolean | undefined; merged: boolean;
    sandbox?: boolean; sandboxEnv?: NodeJS.ProcessEnv; reserveCard?: boolean; oncall?: boolean;
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
  ])('$cliId $args senderIsBot=$senderIsBot merged=$merged sandbox=$sandbox env=$sandboxEnv reserved=$reserveCard oncall=$oncall', async ({ cliId, args, senderIsBot, merged, sandbox, sandboxEnv, reserveCard = true, oncall = false }) => {
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
        ...key, status: 'active', cliId, sandbox, chatId: 'oc_test', rootMessageId: 'om_root',
        scope: 'thread', chatType: 'group', workingDir: root,
        replyTargets: { [key.turnId]: { updatedAt: new Date().toISOString(), senderOpenId: 'ou_requester',
          participants: [{ openId: 'ou_requester', isBot: senderIsBot }] } },
        turnReplyContexts: { [key.turnId]: { target: { mode: 'thread', rootMessageId: 'om_root' },
          replyTargetSenderOpenId: 'ou_requester', replyTargetSenderIsBot: senderIsBot } },
      } });
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
      const result = spawnSyncTsScript(fixture, ['send', ...args, '--response-kind', 'final', 'Hello! 这是完整答复。'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(root, 'bots.json'),
          BOTMUX_SESSION_ID: key.sessionId, BOTMUX_TURN_ID: key.turnId, BOTMUX_LARK_APP_ID: key.larkAppId, ...sandboxEnv },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, String(result.stderr)).toBe(0);
      const requests = String(result.stdout).split('\n').filter(line => line.startsWith('CAPTURE_REPLY='))
        .map(line => JSON.parse(line.slice('CAPTURE_REPLY='.length)));
      expect(requests).toHaveLength(1);
      expect(requests[0].body.content.includes('oncall_group_create')).toBe(oncall);
      const oncallSource = new OncallGroupStore(dataDir).findSource(key.larkAppId, merged ? 'om_original_card' : 'om_separate_message');
      if (oncall) expect(oncallSource).toMatchObject({ chatId: 'oc_test', questionId: key.turnId, answer: 'Hello! 这是完整答复。' });
      else expect(oncallSource).toBeUndefined();
      if (merged) {
        expect(requests[0]).toMatchObject({ method: 'PATCH', path: '/open-apis/im/v1/messages/om_original_card' });
        expect(requests[0].body.content).toContain('Hello! 这是完整答复。');
        await store.update(key, { kind: 'terminal', phase: 'completed', durationMs: 1200 }, io);
        expect(send).toHaveBeenCalledTimes(1);
        expect(store.read(key)).toMatchObject({ messageId: 'om_original_card', finalDelivered: true, phase: 'completed' });
        expect(store.read(key)?.lastCard).toContain('README.md');
        expect(store.read(key)?.lastCard).not.toContain('本轮没有提供最终答复');
        expect(store.read(key)?.lastCard?.includes('oncall_group_create')).toBe(oncall);
        const markers = readFileSync(join(dataDir, 'turn-sends', `${key.sessionId}.jsonl`), 'utf8');
        expect(JSON.parse(markers.trim())).toMatchObject({ messageId: 'om_original_card', replyCardResponseKind: 'final' });
      } else {
        expect(requests[0].method).toBe('POST');
        expect(requests[0].body.content).toContain('Hello! 这是完整答复。');
        expect(store.read(key)?.finalDelivered).not.toBe(true);
        const markers = readFileSync(join(dataDir, 'turn-sends', `${key.sessionId}.jsonl`), 'utf8');
        expect(JSON.parse(markers.trim())).not.toHaveProperty('replyCardResponseKind');
        if (!reserveCard) expect(store.read(key)).toBeUndefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 35_000);
});
