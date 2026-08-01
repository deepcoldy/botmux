import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { buildSessionMessagePreview } from '../src/core/session-message-preview.js';
import type { Session } from '../src/types.js';

let dataDir = '';
let previousDataDir: string | undefined;

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    scope: 'thread',
    status: 'active',
    createdAt: new Date(1_000).toISOString(),
    ...overrides,
  };
}

function writeJsonl(relative: string, rows: unknown[]): void {
  const path = join(dataDir, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

beforeEach(() => {
  previousDataDir = process.env.SESSION_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-session-preview-'));
  config.session.dataDir = dataDir;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previousDataDir;
});

describe('buildSessionMessagePreview', () => {
  it('returns the latest user message and bot marker as a replied exchange', () => {
    writeJsonl('queues/om_root.jsonl', [
      { senderType: 'user', content: 'old question', createTime: '1500' },
      { senderType: 'app', content: 'ignored app queue row', createTime: '1600' },
      { senderType: 'user', content: ' latest   user\nquestion ', createTime: '2000' },
    ]);
    writeJsonl('turn-sends/session-1.jsonl', [
      { sentAtMs: 1_800, messageId: 'om_old', previewText: 'old answer' },
      { sentAtMs: 2_100, messageId: 'om_new', previewText: ' latest   bot\nanswer ' },
    ]);

    expect(buildSessionMessagePreview(session())).toEqual({
      previewUserText: 'latest user question',
      previewBotText: 'latest bot answer',
      previewUserFullText: 'latest user question',
      previewBotFullText: 'latest bot answer',
      previewUserAt: 2_000,
      previewBotAt: 2_100,
      previewBotState: 'replied',
    });
  });

  it('marks a stale bot marker as waiting for the latest user message', () => {
    writeJsonl('queues/om_root.jsonl', [
      { senderType: 'user', content: 'follow-up', createTime: '3000' },
    ]);
    writeJsonl('turn-sends/session-1.jsonl', [
      { sentAtMs: 2_900, previewText: 'reply to the prior turn' },
    ]);

    expect(buildSessionMessagePreview(session())).toMatchObject({
      previewUserText: 'follow-up',
      previewBotText: 'reply to the prior turn',
      previewUserAt: 3_000,
      previewBotAt: 2_900,
      previewBotState: 'waiting',
    });
  });

  it('uses chatId for chat-scope queues and persisted prompt as active fallback', () => {
    writeJsonl('queues/oc_chat.jsonl', [
      { senderType: 'user', content: 'chat scope message', createTime: '4000' },
    ]);
    expect(buildSessionMessagePreview(session({ scope: 'chat' }))).toMatchObject({
      previewUserText: 'chat scope message',
      previewUserAt: 4_000,
      previewBotState: 'waiting',
    });

    rmSync(join(dataDir, 'queues'), { recursive: true, force: true });
    expect(buildSessionMessagePreview(session({
      lastUserPrompt: 'persisted prompt',
      lastMessageAt: new Date(5_000).toISOString(),
    }))).toMatchObject({
      previewUserText: 'persisted prompt',
      previewUserAt: 5_000,
      previewBotState: 'waiting',
    });
  });

  it('clears previews for a closed chat-scope session even when stale fields remain persisted', () => {
    writeJsonl('queues/oc_chat.jsonl', [
      { senderType: 'user', content: 'new session message', createTime: '8000' },
    ]);
    writeJsonl('turn-sends/session-1.jsonl', [
      { sentAtMs: 7_100, previewText: 'closed session answer' },
    ]);

    expect(buildSessionMessagePreview(session({
      scope: 'chat',
      status: 'closed',
      lastUserPrompt: 'closed session question',
      lastMessageAt: new Date(7_000).toISOString(),
      closedAt: new Date(7_500).toISOString(),
    }))).toEqual({
      previewUserText: null,
      previewBotText: null,
      previewUserFullText: null,
      previewBotFullText: null,
      previewUserAt: null,
      previewBotAt: null,
      previewBotState: null,
    });
  });

  it('clears previews for a closed thread-scope session even when stale fields remain persisted', () => {
    writeJsonl('queues/om_root.jsonl', [
      { senderType: 'user', content: 'new thread session message', createTime: '8500' },
    ]);
    writeJsonl('turn-sends/session-1.jsonl', [
      { sentAtMs: 8_100, previewText: 'closed thread answer' },
    ]);

    expect(buildSessionMessagePreview(session({
      status: 'closed',
      lastUserPrompt: 'closed thread question',
      lastMessageAt: new Date(8_000).toISOString(),
      closedAt: new Date(8_300).toISOString(),
    }))).toEqual({
      previewUserText: null,
      previewBotText: null,
      previewUserFullText: null,
      previewBotFullText: null,
      previewUserAt: null,
      previewBotAt: null,
      previewBotState: null,
    });
  });

  it('invalidates the bounded tail cache when an append changes the file', () => {
    writeJsonl('queues/om_root.jsonl', [
      { senderType: 'user', content: 'first question', createTime: '9000' },
    ]);
    expect(buildSessionMessagePreview(session())).toMatchObject({
      previewUserText: 'first question',
      previewBotState: 'waiting',
    });

    appendFileSync(
      join(dataDir, 'queues', 'om_root.jsonl'),
      JSON.stringify({ senderType: 'user', content: 'second question', createTime: '9100' }) + '\n',
    );
    expect(buildSessionMessagePreview(session())).toMatchObject({
      previewUserText: 'second question',
      previewUserAt: 9_100,
      previewBotState: 'waiting',
    });
  });

  it('skips malformed and legacy marker rows without breaking the session list', () => {
    writeJsonl('queues/om_root.jsonl', [
      { senderType: 'user', content: 'safe question', createTime: '6000' },
    ]);
    const markerPath = join(dataDir, 'turn-sends/session-1.jsonl');
    mkdirSync(join(dataDir, 'turn-sends'), { recursive: true });
    writeFileSync(markerPath, '{malformed\n');
    appendFileSync(markerPath, JSON.stringify({ sentAtMs: 6_100, contentLength: 12 }) + '\n');

    expect(buildSessionMessagePreview(session())).toMatchObject({
      previewUserText: 'safe question',
      previewBotText: undefined,
      previewBotState: 'waiting',
    });
  });

  it('rejects unsafe queue/session path segments instead of reading outside data dirs', () => {
    expect(buildSessionMessagePreview(session({
      sessionId: '../other',
      rootMessageId: '../other',
      lastUserPrompt: 'safe fallback',
      lastMessageAt: new Date(7_000).toISOString(),
    }))).toMatchObject({
      previewUserText: 'safe fallback',
      previewUserAt: 7_000,
      previewBotText: undefined,
      previewBotState: 'waiting',
    });
  });
});
