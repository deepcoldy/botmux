import { describe, expect, it } from 'vitest';
import {
  findLatestClosedTopicSession,
  parseBotSessionDirective,
  topicResumeBlockReason,
  withBotSessionDirective,
} from '../src/core/topic-session-continuity.js';
import { parseDispatchArgs } from '../src/cli/dispatch-args.js';
import { normalizeSessionRow } from '../src/services/session-observe.js';

const row = (extra: Record<string, unknown> = {}): any => ({
  sessionId: 's1', chatId: 'oc_c', rootMessageId: 'om_r', status: 'closed', scope: 'thread',
  larkAppId: 'app', cliSessionId: 'cli-s1', closedAt: '2026-11-04T18:20:27.000Z', createdAt: '2026-11-04T07:00:00.000Z', ...extra,
});

describe('parseBotSessionDirective', () => {
  it.each([
    ['@session fresh\nbody', 'fresh', 'body'],
    ['@session resume\nbody', 'resume', 'body'],
    ['@SESSION Fresh\nbody', 'fresh', 'body'],
    ['@session fresh 独立评审', 'fresh', '独立评审'],
    ['\n\n@session fresh\nbody', 'fresh', '\n\nbody'],
    ['@Worker\n@session fresh\nbody', 'fresh', '@Worker\nbody'],
    ['@steer\n@session fresh\nbody', 'fresh', '@steer\nbody'],
  ])('%j → %s', (input, mode, content) => {
    expect(parseBotSessionDirective(input)).toEqual({ mode, content });
  });
  it.each([
    'body\n@session fresh',
    '@session',
    '@session later\nbody',
    '@sessionfresh\nbody',
    '请用 @session fresh 新开',
  ])('ignores %j', (input) => {
    expect(parseBotSessionDirective(input)).toEqual({ content: input });
  });
  it('withBotSessionDirective adds the line once', () => {
    expect(withBotSessionDirective('body', 'fresh')).toBe('@session fresh\nbody');
    expect(withBotSessionDirective('@session resume\nbody', 'fresh')).toBe('@session resume\nbody');
  });
});

describe('topicResumeBlockReason', () => {
  it('a plainly closed session may be resumed', () => {
    expect(topicResumeBlockReason(row())).toBeUndefined();
  });
  it.each([
    ['not_closed', { status: 'active' }],
    ['user_closed', { userClosedAt: '2026-11-04T18:20:27.000Z' }],
    ['workspace_retired', { workspaceRetirement: { reason: 'x' } }],
    ['adopt_unsupported', { title: 'Adopt: tmux' }],
  ])('%s', (reason, extra) => {
    expect(topicResumeBlockReason(row(extra))).toBe(reason);
  });
});

describe('findLatestClosedTopicSession', () => {
  const target = { larkAppId: 'app', chatId: 'oc_c', anchor: 'om_r' };
  it('newest close wins; other bots, chats, topics, chat scope and active rows are ignored', () => {
    const found = findLatestClosedTopicSession([
      row({ sessionId: 'old', closedAt: '2026-11-04T10:00:00.000Z' }),
      row({ sessionId: 'new', closedAt: '2026-11-05T00:47:55.000Z' }),
      row({ sessionId: 'bot', larkAppId: 'other', closedAt: '2026-11-06T00:00:00.000Z' }),
      row({ sessionId: 'chat', chatId: 'oc_other', closedAt: '2026-11-06T00:00:00.000Z' }),
      row({ sessionId: 'topic', rootMessageId: 'om_other', closedAt: '2026-11-06T00:00:00.000Z' }),
      row({ sessionId: 'scope', scope: 'chat', closedAt: '2026-11-06T00:00:00.000Z' }),
      row({ sessionId: 'live', status: 'active', closedAt: undefined }),
    ], target);
    expect(found?.sessionId).toBe('new');
  });
  it('none → undefined', () => {
    expect(findLatestClosedTopicSession([], target)).toBeUndefined();
  });
  it('a closed shell with no conversation history (e.g. a `/help` row) does not shadow the real conversation', () => {
    const found = findLatestClosedTopicSession([
      row({ sessionId: 'real', closedAt: '2026-11-04T10:00:00.000Z' }),
      row({ sessionId: 'shell', cliSessionId: undefined, closedAt: '2026-11-05T09:00:00.000Z' }),
    ], target);
    expect(found?.sessionId).toBe('real');
    expect(findLatestClosedTopicSession([row({ cliSessionId: undefined })], target)).toBeUndefined();
    expect(findLatestClosedTopicSession([row({ cliSessionId: undefined, lastUserPrompt: 'x' })], target)?.sessionId).toBe('s1');
  });
});

describe('dispatch --session-mode', () => {
  it('parses as a value flag', () => {
    const parsed = parseDispatchArgs(['--into', 'om_x', '--bot-app', 'cli_x', '--session-mode', 'fresh', '--brief', 'b']);
    expect(parsed.ok && parsed.value.sessionMode).toBe('fresh');
    const eq = parseDispatchArgs(['--into=om_x', '--bot-app', 'cli_x', '--session-mode=resume', '--brief', 'b']);
    expect(eq.ok && eq.value.sessionMode).toBe('resume');
  });
  it('requires a value', () => {
    const parsed = parseDispatchArgs(['--into', 'om_x', '--session-mode']);
    expect(parsed.ok).toBe(false);
  });
});

describe('observe: continuity and resumability', () => {
  const observedAt = 1;
  it('closed rows carry resumable / resumeBlockedReason; continuity passes through', () => {
    const closed = normalizeSessionRow({ sessionId: 's', status: 'closed', resumable: false, resumeBlockedReason: 'user_closed' }, { observedAt });
    expect(closed.resumable).toBe(false);
    expect(closed.resumeBlockedReason).toBe('user_closed');
    const ok = normalizeSessionRow({ sessionId: 's', status: 'closed', resumable: true }, { observedAt });
    expect(ok.resumable).toBe(true);
    expect(ok.resumeBlockedReason).toBeUndefined();
    const live = normalizeSessionRow({
      sessionId: 's', status: 'idle', resumable: true,
      continuity: { mode: 'resumed', previousSessionId: 'old', at: 'x', junk: 1 },
    }, { observedAt });
    expect(live.resumable).toBeUndefined();
    expect(live.continuity).toEqual({ mode: 'resumed', previousSessionId: 'old', at: 'x' });
  });
});
