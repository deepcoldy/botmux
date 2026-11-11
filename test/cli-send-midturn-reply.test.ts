import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { beginReplyTargetTurn } from '../src/core/reply-target.js';
import { selectReplyMessageId } from '../src/core/reply-message.js';
import type { DaemonSession } from '../src/core/types.js';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));
function setup({ root, consumed = true, chatType = 'p2p' }: { root?: string; consumed?: boolean; chatType?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'midturn-reply-'));
  const data = join(home, 'data');
  const marker = join(data, '.botmux-cli-pids', String(process.pid));
  mkdirSync(join(data, '.botmux-cli-pids'), { recursive: true });
  writeFileSync(marker, JSON.stringify({ sessionId: 'sid', turnId: 'om_first',
    queuedTurns: [{ turnId: 'om_second', ...(consumed ? { inputConsumed: true } : {}) }] }));
  writeFileSync(join(home, 'bots.json'), JSON.stringify([{
    larkAppId: 'cli_test', larkAppSecret: 'test', cliId: 'codex', replyCardMode: 'legacy',
  }]));
  const ds = { scope: 'chat', chatId: 'oc_test', session: {
    sessionId: 'sid', status: 'active', cliId: 'codex', larkAppId: 'cli_test', chatId: 'oc_test',
    rootMessageId: 'oc_test', scope: 'chat', chatType, workingDir: home,
  } } as DaemonSession;
  for (const [id, target, sender] of [['om_first', 'om_topic', 'ou_first'], ['om_second', root, 'ou_second']]) {
    ds.session.quoteTargetId = id;
    ds.session.quoteTargetSenderOpenId = sender;
    beginReplyTargetTurn(ds, target, id!, new Date().toISOString(), {
      senderOpenId: sender, participants: [{ openId: sender!, isBot: false }], inThread: !!target,
    });
  }
  seedPersistedSessionRows(data, 'cli_test', { sid: ds.session });
  return {
    close: () => rmSync(home, { recursive: true, force: true }),
    marker: () => JSON.parse(readFileSync(marker, 'utf8')),
    run: (args: string[] = []) => {
      const result = spawnSyncTsScript(fixture, ['send', '--mention-back', ...args, 'result'], {
        cwd: repo, encoding: 'utf8', timeout: 30000,
        env: { PATH: process.env.PATH, HOME: home, BOTS_CONFIG: join(home, 'bots.json'), SESSION_DATA_DIR: data,
          BOTMUX_SESSION_ID: 'sid', BOTMUX_TURN_ID: 'om_first', BOTMUX_LARK_APP_ID: 'cli_test' },
      });
      return { ...result, writes: String(result.stdout).split('\n').filter(line => line.startsWith('CAPTURE_REPLY='))
        .map(line => JSON.parse(line.slice('CAPTURE_REPLY='.length))) };
    },
  };
}
describe('send addresses the consumed message without changing final attribution', () => {
  it('replies in the main chat and mentions its sender after a topic-started turn', () => {
    const f = setup();
    try {
      const result = f.run();
      expect(result.status, String(result.stderr)).toBe(0);
      expect(result.writes[0].path).toBe('/open-apis/im/v1/messages');
      expect(result.writes[0].body.receive_id).toBe('oc_test');
      expect(result.writes[0].body.reply_in_thread).not.toBe(true);
      expect(result.writes[0].body.content).toContain('ou_second');
      expect(result.writes[0].body.content).not.toContain('ou_first');
      expect(f.marker().turnId).toBe('om_first');
    } finally { f.close(); }
  });
  it('keeps a followup from the same topic in that topic', () => {
    const f = setup({ root: 'om_topic' });
    try {
      const result = f.run();
      expect(result.status, String(result.stderr)).toBe(0);
      expect(result.writes[0].path).toBe('/open-apis/im/v1/messages/om_topic/reply');
      expect(result.writes[0].body.reply_in_thread).toBe(true);
    } finally { f.close(); }
  });
  it('explicitly addresses an earlier message and its sender', () => {
    const f = setup();
    try {
      const result = f.run(['--reply-to', 'om_first']);
      expect(result.status, String(result.stderr)).toBe(0);
      expect(result.writes[0].path).toBe('/open-apis/im/v1/messages/om_topic/reply');
      expect(result.writes[0].body.content).toContain('ou_first');
    } finally { f.close(); }
  });
  it('does not route to an input that is only queued', () => {
    const f = setup({ consumed: false });
    try {
      const result = f.run();
      expect(result.status, String(result.stderr)).toBe(0);
      expect(result.writes[0].path).toBe('/open-apis/im/v1/messages/om_topic/reply');
    } finally { f.close(); }
  });
  it('rejects unknown message IDs without a provider write', () => {
    const f = setup();
    try {
      const result = f.run(['--reply-to', 'om_unknown']);
      expect(result.status).toBe(2);
      expect(result.writes).toEqual([]);
    } finally { f.close(); }
  });
  it('preserves the group ambiguity gate', () => {
    const f = setup({ chatType: 'group' });
    try {
      const result = f.run();
      expect(result.status).toBe(2);
      expect(result.writes).toEqual([]);
    } finally { f.close(); }
  });
  it.each([
    [['--quote', 'om_first'], '/open-apis/im/v1/messages/om_topic/reply'],
    [['--top-level'], '/open-apis/im/v1/messages'],
  ])('explicit routing %j keeps the execution turn and its sender', (args, path) => {
    const f = setup();
    try {
      const result = f.run(args);
      expect(result.status, String(result.stderr)).toBe(0);
      expect(result.writes[0].path).toBe(path);
      expect(result.writes[0].body.content).toContain('ou_first');
      expect(result.writes[0].body.content).not.toContain('ou_second');
    } finally { f.close(); }
  });
  it('refuses --reply-to combined with explicit routing before any provider write', () => {
    const f = setup();
    try {
      const result = f.run(['--reply-to', 'om_first', '--quote', 'om_first']);
      expect(result.status).toBe(2);
      expect(result.writes).toEqual([]);
    } finally { f.close(); }
  });
  it('keeps a final required for each queued turn', () => {
    const f = setup();
    try {
      const first = f.run(['--response-kind', 'final']);
      expect(first.status, String(first.stderr)).toBe(0);
      expect(f.marker().turnId).toBe('om_second');
      const second = f.run(['--response-kind', 'final']);
      expect(second.status, String(second.stderr)).toBe(0);
      expect(second.writes).toHaveLength(1);
    } finally { f.close(); }
  });
});

describe('selectReplyMessageId', () => {
  const retained = () => ({ target: { mode: 'plain', chatId: 'oc_test' } });
  const s = { sessionId: 'sid', turnReplyContexts: { om_a: retained(), om_b: retained(), om_c: retained() } };
  const marker = (over: Record<string, unknown> = {}) => ({
    sessionId: 'sid', turnId: 'om_a',
    queuedTurns: [{ turnId: 'om_b', inputConsumed: true as const }, { turnId: 'om_c', inputConsumed: true as const }, { turnId: 'om_d' }],
    ...over,
  });
  it('follows the newest consumed message that this session retained', () => {
    expect(selectReplyMessageId(s, 'om_a', marker())).toBe('om_c');
    expect(selectReplyMessageId(s, 'om_a', marker({ queuedTurns: [{ turnId: 'om_b', inputConsumed: true }, { turnId: 'om_gone', inputConsumed: true }] }))).toBe('om_a');
  });
  it('ignores a marker for another session or another execution turn', () => {
    expect(selectReplyMessageId(s, 'om_a', marker({ sessionId: 'other' }))).toBe('om_a');
    expect(selectReplyMessageId(s, 'om_a', marker({ turnId: 'om_older' }))).toBe('om_a');
    expect(selectReplyMessageId(s, 'om_a', null)).toBe('om_a');
  });
  it('accepts only a retained message id from this session for --reply-to', () => {
    expect(selectReplyMessageId(s, 'om_a', marker(), 'om_b')).toBe('om_b');
    expect(() => selectReplyMessageId(s, 'om_a', marker(), 'om_unknown')).toThrow();
    expect(() => selectReplyMessageId({ ...s, turnReplyContexts: { ...s.turnReplyContexts, x_b: retained() } }, 'om_a', marker(), 'x_b')).toThrow();
  });
});
