import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { OncallPrivateIntakeStore } from '../src/services/oncall-private-intake.js';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));

const APP = 'cli_test';
const DM_CHAT = 'oc_dm';
const DM_ROOT = 'om_dm_root';
const GROUP_CHAT = 'oc_group';
const OTHER_GROUP_CHAT = 'oc_other';

function spawnSend(args: {
  root: string;
  dataDir: string;
  ambient: string;
  extraArgs?: string[];
}) {
  return spawnSyncTsScript(fixture, ['send', '--no-mention', '--response-kind', 'progress', ...(args.extraArgs ?? []), 'result'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, HOME: args.root, SESSION_DATA_DIR: args.dataDir, BOTS_CONFIG: join(args.root, 'bots.json'),
      BOTMUX_SESSION_ID: args.ambient, BOTMUX_TURN_ID: 'om_turn', BOTMUX_LARK_APP_ID: APP,
      BOTMUX_TEST_TOPIC_STATES: JSON.stringify({
        [DM_ROOT]: 'live', om_group_root: 'live', om_other_root: 'live', om_else: 'live',
      }) },
  });
}

function setup(opts: { withIntakeBinding: boolean; ambient: string }) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-private-oncall-send-'));
  const dataDir = join(root, 'data');
  mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
  writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)),
    JSON.stringify({ sessionId: opts.ambient, turnId: 'om_turn' }));
  writeFileSync(join(root, 'bots.json'), JSON.stringify([{
    larkAppId: APP, larkAppSecret: 'test', cliId: 'codex', replyCardMode: 'legacy',
    topicUnavailablePolicy: 'stop',
    oncallGroup: { enabled: true, chatIds: [GROUP_CHAT], privateIntakeChatIds: [GROUP_CHAT] },
  }]));
  const common = { status: 'active', cliId: 'codex', larkAppId: APP, scope: 'thread', workingDir: root, ownerOpenId: 'ou_requester' };
  seedPersistedSessionRows(dataDir, APP, {
    dm: { ...common, sessionId: 'dm', chatType: 'p2p', chatId: DM_CHAT, rootMessageId: DM_ROOT },
    grp: { ...common, sessionId: 'grp', chatType: 'group', chatId: GROUP_CHAT, rootMessageId: 'om_group_root' },
    grp2: { ...common, sessionId: 'grp2', chatType: 'group', chatId: OTHER_GROUP_CHAT, rootMessageId: 'om_other_root' },
  });
  if (opts.withIntakeBinding) {
    new OncallPrivateIntakeStore(dataDir).record({
      appId: APP, groupChatId: GROUP_CHAT, groupMessageId: 'om_group_seed',
      chatId: DM_CHAT, rootMessageId: DM_ROOT, ownerOpenId: 'ou_requester', createdAtMs: Date.now(),
    });
  }
  return { root, dataDir };
}

const BLOCK_NOTICE = '只能在对应的私聊话题里回复';
const GROUP_BLOCK_NOTICE = '此群已设为仅私聊处理';

describe('botmux send private Oncall containment guards', () => {
  it.each([
    ['top-level redirect', ['--top-level']],
    ['--into another topic', ['--into', 'om_else']],
    ['--quote another message', ['--quote', 'om_else']],
    ['chat override', ['--chat-id', OTHER_GROUP_CHAT]],
  ])('blocks %s from leaving the bound private consultation', (_label, extraArgs) => {
    const { root, dataDir } = setup({ withIntakeBinding: true, ambient: 'dm' });
    try {
      const result = spawnSend({ root, dataDir, ambient: 'dm', extraArgs });
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain(BLOCK_NOTICE);
      expect(result.stdout.split('\n').filter(line => line.startsWith('CAPTURE_REPLY='))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks a private consultation session from sending through another session', () => {
    const { root, dataDir } = setup({ withIntakeBinding: true, ambient: 'dm' });
    try {
      const result = spawnSend({ root, dataDir, ambient: 'dm', extraArgs: ['--session-id', 'grp'] });
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain(BLOCK_NOTICE);
      expect(result.stdout.split('\n').filter(line => line.startsWith('CAPTURE_REPLY='))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still allows an ordinary reply inside the bound private topic', () => {
    const { root, dataDir } = setup({ withIntakeBinding: true, ambient: 'dm' });
    try {
      const result = spawnSend({ root, dataDir, ambient: 'dm' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.split('\n').filter(line => line.startsWith('CAPTURE_REPLY='))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not constrain redirects from a DM without a private Oncall binding', () => {
    const { root, dataDir } = setup({ withIntakeBinding: false, ambient: 'dm' });
    try {
      const result = spawnSend({ root, dataDir, ambient: 'dm', extraArgs: ['--top-level'] });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain(BLOCK_NOTICE);
      expect(result.stdout.split('\n').filter(line => line.startsWith('CAPTURE_REPLY='))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses sends from a session whose group is configured as private-intake only', () => {
    const { root, dataDir } = setup({ withIntakeBinding: true, ambient: 'grp' });
    try {
      const result = spawnSend({ root, dataDir, ambient: 'grp' });
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain(GROUP_BLOCK_NOTICE);
      expect(result.stdout.split('\n').filter(line => line.startsWith('CAPTURE_REPLY='))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps ordinary group sessions outside the private-intake list working', () => {
    const { root, dataDir } = setup({ withIntakeBinding: true, ambient: 'grp2' });
    try {
      const result = spawnSend({ root, dataDir, ambient: 'grp2' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain(GROUP_BLOCK_NOTICE);
      expect(result.stdout.split('\n').filter(line => line.startsWith('CAPTURE_REPLY='))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
