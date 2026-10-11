import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const fixture = fileURLToPath(new URL('./fixtures/send-doc-comment-capture.ts', import.meta.url));
const target = {
  fileToken: 'doc_test', fileType: 'docx', commentId: 'comment_test',
  turnId: 'reply_user', replyToOpenId: 'ou_requester',
};

function runSend(options: {
  cliId?: string;
  markerTurn?: string | null;
  marker?: boolean;
  mentionBack?: boolean;
  session?: Record<string, unknown>;
  args?: string[];
  responseKind?: 'progress' | 'final' | 'auxiliary';
  previousSend?: { turnId: string; responseKind?: 'progress' | 'final' | 'auxiliary' };
  sendHistory?: Record<string, unknown>[];
  env?: NodeJS.ProcessEnv;
  repeat?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-send-doc-'));
  const dataDir = join(root, 'data');
  const cliId = options.cliId ?? 'codex';
  try {
    mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
    const pidMarkerPath = join(dataDir, '.botmux-cli-pids', String(process.pid));
    writeFileSync(join(root, 'bots.json'), JSON.stringify([{
      larkAppId: 'cli_test', larkAppSecret: 'test-secret', cliId,
    }]));
    seedPersistedSessionRows(dataDir, 'cli_test', {
      sid_doc: {
        sessionId: 'sid_doc', status: 'active', larkAppId: 'cli_test', cliId,
        scope: 'chat', chatType: 'group', chatId: 'doc:doc_test:comment_test',
        workingDir: root, docCommentTargets: { [target.turnId]: target },
        ...options.session,
      },
      sid_other: {
        sessionId: 'sid_other', status: 'active', larkAppId: 'cli_test', cliId,
        scope: 'chat', chatType: 'group', chatId: 'oc_other', workingDir: root,
      },
    });
    const markerPath = join(dataDir, 'turn-sends', 'sid_doc.jsonl');
    if (options.sendHistory) {
      mkdirSync(join(dataDir, 'turn-sends'), { recursive: true });
      writeFileSync(markerPath, options.sendHistory.map(marker => JSON.stringify(marker)).join('\n') + '\n');
    }
    const send = (responseKind: typeof options.responseKind, args: string[] = []) => spawnSyncTsScript(fixture, [
      'send', options.mentionBack === false ? '--no-mention' : '--mention-back',
      ...(responseKind ? ['--response-kind', responseKind] : []),
      '缺少电子表格读取权限，请授权后继续。', ...args,
    ], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: join(root, 'bots.json'), BOTMUX_SESSION_ID: 'sid_doc',
        // A spawn-time turn can be stale; it must never pick the reply target.
        BOTMUX_TURN_ID: 'stale_turn', BOTMUX_LARK_APP_ID: 'cli_test',
        ...options.env,
      },
      encoding: 'utf8', timeout: 30_000,
    });
    let previous;
    if (options.previousSend) {
      writeFileSync(pidMarkerPath, JSON.stringify({
        sessionId: 'sid_doc', turnId: options.previousSend.turnId,
      }));
      previous = send(options.previousSend.responseKind);
    } else if (options.repeat) {
      writeFileSync(pidMarkerPath, JSON.stringify({
        sessionId: 'sid_doc', turnId: target.turnId,
      }));
      previous = send(options.responseKind);
    }
    // A restart removes the old worker marker or reattaches with only a session.
    if (options.marker === false) {
      rmSync(pidMarkerPath, { force: true });
    } else {
      writeFileSync(pidMarkerPath, JSON.stringify({
        sessionId: 'sid_doc', turnId: options.markerTurn ?? null,
      }));
    }
    const result = send(options.responseKind, options.args);
    const requests = String(result.stdout).split('\n')
      .filter(line => line.startsWith('CAPTURE_REQUEST='))
      .map(line => JSON.parse(line.slice('CAPTURE_REQUEST='.length)));
    const sends = existsSync(markerPath)
      ? readFileSync(markerPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr), requests, sends, previous };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('real CLI document-comment reply routing', () => {
  it.each(['codex', 'claude-code'])('recovers %s comment replies after a worker reattach loses the marker turn', cliId => {
    const result = runSend({ cliId });
    expect(result.status, result.stderr).toBe(0);
    expect(result.requests).toEqual([{
      method: 'POST', path: '/open-apis/drive/v1/files/doc_test/comments/comment_test/replies',
      body: { content: { elements: [
        { type: 'person', person: { user_id: 'ou_requester' } },
        { type: 'text_run', text_run: { text: ' ' } },
        { type: 'text_run', text_run: { text: expect.stringContaining('缺少电子表格读取权限') } },
      ] } },
    }]);
    expect(result.sends).toEqual([expect.objectContaining({
      messageId: 'doc:comment_test', turnId: 'reply_user', responseKind: 'final',
    })]);
    expect(result.stdout).toContain('"kind":"doc-comment"');
  }, 35_000);

  it('treats an omitted response kind as the one final document reply', () => {
    const result = runSend({ responseKind: undefined });
    expect(result.status, result.stderr).toBe(0);
    expect(result.requests).toHaveLength(1);
    expect(result.sends).toEqual([expect.objectContaining({
      turnId: target.turnId,
      responseKind: 'final',
    })]);
    expect(result.stdout).toContain('"kind":"doc-comment"');
  }, 35_000);

  it.each(['progress', 'auxiliary'] as const)(
    'rejects an explicit %s reply with actionable guidance before any provider request',
    responseKind => {
    const result = runSend({ responseKind });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('文档评论轮只允许一条 final 回复');
    expect(result.stderr).not.toContain('Non-idempotent delivery sequences require a final response');
    expect(result.requests).toEqual([]);
    expect(result.sends).toEqual([]);
    },
    35_000,
  );

  it('retries after a provider business response proves the first request was not delivered', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-send-doc-reject-'));
    const rejectOnceMarker = join(root, 'reject-once');
    try {
      const result = runSend({
        env: { BOTMUX_TEST_DOC_REJECT_ONCE: rejectOnceMarker },
        repeat: true,
      });
      expect(result.previous?.status).toBe(1);
      expect(String(result.previous?.stderr)).toContain('User Token');
      expect(result.status, result.stderr).toBe(0);
      expect(result.requests).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 70_000);

  it.each([true, false])('recovers the second turn after a real final reply and restart (reattached=%s)', marker => {
    const result = runSend({
      marker,
      previousSend: { turnId: target.turnId, responseKind: 'final' },
      session: { docCommentTargets: {
        [target.turnId]: target,
        next_reply: { ...target, turnId: 'next_reply', replyToOpenId: 'ou_next_requester' },
      } },
    });
    expect(result.previous?.status, String(result.previous?.stderr)).toBe(0);
    expect(result.status, result.stderr).toBe(0);
    expect(result.requests).toEqual([expect.objectContaining({
      path: '/open-apis/drive/v1/files/doc_test/comments/comment_test/replies',
      body: { content: { elements: [
        { type: 'person', person: { user_id: 'ou_next_requester' } },
        { type: 'text_run', text_run: { text: ' ' } },
        { type: 'text_run', text_run: { text: expect.stringContaining('缺少电子表格读取权限') } },
      ] } },
    })]);
    expect(result.sends.map(({ turnId, responseKind }) => ({ turnId, responseKind }))).toEqual([
      { turnId: 'reply_user', responseKind: 'final' },
      { turnId: 'next_reply', responseKind: 'final' },
    ]);
  }, 70_000);

  it.each([
    { sentAtMs: 1, turnId: target.turnId },
    { sentAtMs: 1, responseKind: 'progress', turnId: target.turnId },
    { sentAtMs: 1, responseKind: 'auxiliary', turnId: target.turnId },
    { sentAtMs: 1, responseKind: 'final' },
    { sentAtMs: 1, responseKind: 'final', turnId: 'unrelated_turn' },
    { sentAtMs: 1, responseKind: 'FINAL', turnId: target.turnId },
    { responseKind: 'final', turnId: target.turnId },
  ])('does not infer completion from an unattributable or non-final marker: %j', marker => {
    const result = runSend({
      sendHistory: [marker],
      session: { docCommentTargets: {
        [target.turnId]: target, next_reply: { ...target, turnId: 'next_reply' },
      } },
    });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('cannot resolve the exact document-comment reply target');
    expect(result.requests).toEqual([]);
    expect(result.sends).toEqual([marker]);
  }, 35_000);

  it('refuses recovery when the only target already has a final reply', () => {
    const result = runSend({ previousSend: { turnId: target.turnId, responseKind: 'final' } });
    expect(result.previous?.status, String(result.previous?.stderr)).toBe(0);
    expect(result.status, result.stderr).toBe(2);
    expect(result.requests).toEqual([]);
    expect(result.sends).toHaveLength(1);
  }, 70_000);

  it('keeps exact-turn comment routing when the marker is available', () => {
    const result = runSend({ markerTurn: 'reply_user' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.requests[0]?.path).toBe('/open-apis/drive/v1/files/doc_test/comments/comment_test/replies');
  }, 35_000);

  it('delivers the permission notice through Drive even when no mention was requested', () => {
    const result = runSend({ mentionBack: false });
    expect(result.status, result.stderr).toBe(0);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]?.path).toBe('/open-apis/drive/v1/files/doc_test/comments/comment_test/replies');
    expect(result.requests[0]?.body.content.elements).toEqual([
      { type: 'text_run', text_run: { text: expect.stringContaining('缺少电子表格读取权限') } },
    ]);
  }, 35_000);

  it('supports the legacy document-only anchor when one pending reply remains', () => {
    const result = runSend({ session: { chatId: 'doc:doc_test' } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.requests[0]?.path).toBe('/open-apis/drive/v1/files/doc_test/comments/comment_test/replies');
  }, 35_000);

  it('recovers the fixed comment destination while its worker is stopped and the PID marker is absent', () => {
    const result = runSend({ marker: false, mentionBack: false });
    expect(result.status, result.stderr).toBe(0);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]?.path).toBe('/open-apis/drive/v1/files/doc_test/comments/comment_test/replies');
    expect(result.sends[0]?.turnId).toBe('reply_user');
  }, 35_000);

  it.each([
    { name: 'missing target', session: { docCommentTargets: {} } },
    { name: 'ambiguous turns', session: { docCommentTargets: {
      [target.turnId]: target, another_reply: { ...target, turnId: 'another_reply' },
    } } },
    { name: 'different comment', session: { chatId: 'doc:doc_test:another_comment' } },
    { name: 'different document', session: { chatId: 'doc:another_doc:comment_test' } },
    { name: 'inconsistent target key', session: { docCommentTargets: { wrong_turn: target } } },
    { name: 'closed session', session: { status: 'closed' } },
    { name: 'stale marker turn', markerTurn: 'another_turn' },
    { name: 'shared chat with no exact turn', session: { chatId: 'oc_shared' } },
    { name: 'Codex App without exact authority', cliId: 'codex-app' },
  ])('refuses $name before any provider request', options => {
    const result = runSend(options);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('cannot resolve the exact document-comment reply target');
    expect(result.requests).toEqual([]);
    expect(result.sends).toEqual([]);
  }, 35_000);

  it.each([
    ['--session-id', 'sid_other'],
    ['--chat-id', 'oc_other'],
    ['--images', '/does-not-exist.png'],
  ])('keeps recovered comment output pinned to its plain-text origin (%s)', (...args) => {
    const result = runSend({ args });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('a document-comment turn supports only its exact plain-text comment reply');
    expect(result.requests).toEqual([]);
    expect(result.sends).toEqual([]);
  }, 35_000);

  it.each([false, true])('leaves an ordinary chat on the chat interface even with an older pending comment (noQuote=%s)', noQuote => {
    const result = runSend({
      markerTurn: 'om_chat_turn', mentionBack: false, session: { chatId: 'oc_chat' },
      args: noQuote ? ['--no-quote'] : [],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.requests).toHaveLength(1);
    if (noQuote) {
      expect(result.requests[0]?.path).toBe('/open-apis/im/v1/messages');
      expect(result.requests[0]?.body.receive_id).toBe('oc_chat');
    } else {
      expect(result.requests[0]?.path).toBe('/open-apis/im/v1/messages/om_chat_turn/reply');
      expect(result.requests[0]?.body.reply_in_thread).not.toBe(true);
    }
    expect(result.sends).toEqual([expect.objectContaining({
      messageId: 'om_sent', turnId: 'om_chat_turn',
    })]);
  }, 35_000);
});
