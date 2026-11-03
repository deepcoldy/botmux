import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { constants as bufferConstants } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));
const detailBase = 'https://detail.example.test/preview_platform/problem';
const fullUrl = `${detailBase}?problemId=13085&previewId=218`;

function runSend(content: string, expectedLinks: string[], equalsForm = false) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-expected-link-'));
  const dataDir = join(root, 'data');
  const sessionId = 'sid_expected_link';
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(root, 'bots.json'), JSON.stringify([{
    larkAppId: 'cli_test', larkAppSecret: 'test-secret', cliId: 'codex', replyCardMode: 'legacy',
  }]));
  seedPersistedSessionRows(dataDir, 'cli_test', { [sessionId]: {
    sessionId, status: 'active', cliId: 'codex', larkAppId: 'cli_test',
    chatId: 'oc_test', rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
  } });
  const args = ['send', '--no-mention', '--response-kind', 'auxiliary',
    ...expectedLinks.flatMap(link => equalsForm ? [`--expected-link=${link}`] : ['--expected-link', link]), content];
  const result = spawnSyncTsScript(fixture, args, {
    cwd: repo,
    env: { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir,
      BOTS_CONFIG: join(root, 'bots.json'), BOTMUX_SESSION_ID: sessionId, BOTMUX_LARK_APP_ID: 'cli_test' },
    encoding: 'utf8', timeout: 30_000,
  });
  const requests = String(result.stdout).split('\n').filter(line => line.startsWith('CAPTURE_REPLY='));
  return { root, result, requests };
}

function runCardSend(card: Record<string, unknown>, expectedLink: string) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-expected-link-card-'));
  const dataDir = join(root, 'data');
  const sessionId = 'sid_expected_link_card';
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(root, 'bots.json'), JSON.stringify([{
    larkAppId: 'cli_test', larkAppSecret: 'test-secret', cliId: 'codex', replyCardMode: 'legacy',
  }]));
  seedPersistedSessionRows(dataDir, 'cli_test', { [sessionId]: {
    sessionId, status: 'active', cliId: 'codex', larkAppId: 'cli_test',
    chatId: 'oc_test', rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
  } });
  const result = spawnSyncTsScript(fixture, [
    'send', '--no-mention', '--response-kind', 'auxiliary',
    '--expected-link', expectedLink, '--card-json', JSON.stringify(card),
  ], {
    cwd: repo,
    env: { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir,
      BOTS_CONFIG: join(root, 'bots.json'), BOTMUX_SESSION_ID: sessionId, BOTMUX_LARK_APP_ID: 'cli_test' },
    encoding: 'utf8', timeout: 30_000,
  });
  const requests = String(result.stdout).split('\n').filter(line => line.startsWith('CAPTURE_REPLY='));
  return { root, result, requests };
}

describe('botmux send --expected-link', () => {
  it('sends when the final rendered text contains the exact URL', () => {
    const { root, result, requests } = runSend(`问题详情：${fullUrl}`, [fullUrl]);
    try {
      expect(result.status, String(result.stderr)).toBe(0);
      expect(requests).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fails closed before dispatch when a query string was truncated', () => {
    const truncated = detailBase;
    const { root, result, requests } = runSend(`问题详情：${truncated}`, [fullUrl]);
    try {
      expect(result.status).toBe(2);
      expect(String(result.stderr)).toContain('expected link missing from rendered content');
      expect(requests).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('enforces every repeated expected-link flag', () => {
    const second = 'https://example.test/second';
    const { root, result, requests } = runSend(`问题详情：${fullUrl}`, [fullUrl, second]);
    try {
      expect(result.status).toBe(2);
      expect(String(result.stderr)).toContain(second);
      expect(requests).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('preserves positional content when expected links use --flag=value', () => {
    const { root, result, requests } = runSend(`问题详情：${fullUrl}`, [fullUrl], true);
    try {
      expect(result.status, String(result.stderr)).toBe(0);
      expect(requests).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not accept a custom-card URL that exists only in hidden JSON metadata', () => {
    const { root, result, requests } = runCardSend({
      schema: '2.0',
      body: {
        elements: [{
          tag: 'markdown',
          content: '问题详情链接缺失',
          extra: { source_url: fullUrl },
        }],
      },
    }, fullUrl);
    try {
      expect(result.status).toBe(2);
      expect(String(result.stderr)).toContain('expected link missing from rendered content');
      expect(requests).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('accepts a custom-card URL in visible markdown', () => {
    const { root, result, requests } = runCardSend({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: `问题详情：${fullUrl}` }] },
    }, fullUrl);
    try {
      expect(result.status, String(result.stderr)).toBe(0);
      expect(requests).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('accepts an expected link in a file-only final and sends that file as the primary message', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-expected-link-file-'));
    const dataDir = join(root, 'data');
    const sessionId = 'sid_expected_link_file';
    const turnId = 'turn_expected_link_file';
    const attachment = join(root, 'dacu-problems.md');
    mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
    writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId, turnId }));
    writeFileSync(attachment, `问题详情：${fullUrl}`);
    writeFileSync(join(root, 'bots.json'), JSON.stringify([{
      larkAppId: 'cli_test', larkAppSecret: 'test-secret', cliId: 'codex', replyCardMode: 'legacy',
    }]));
    seedPersistedSessionRows(dataDir, 'cli_test', { [sessionId]: {
      sessionId, status: 'active', cliId: 'codex', larkAppId: 'cli_test',
      chatId: 'oc_test', rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
    } });
    try {
      const result = spawnSyncTsScript(fixture, [
        'send', '--no-mention', '--response-kind', 'final',
        '--expected-link', fullUrl, '--files', attachment,
      ], {
        cwd: repo,
        env: { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir,
          BOTS_CONFIG: join(root, 'bots.json'), BOTMUX_SESSION_ID: sessionId,
          BOTMUX_TURN_ID: turnId, BOTMUX_LARK_APP_ID: 'cli_test' },
        encoding: 'utf8', timeout: 30_000,
      });
      const requests = String(result.stdout).split('\n')
        .filter(line => line.startsWith('CAPTURE_REPLY='))
        .map(line => JSON.parse(line.slice('CAPTURE_REPLY='.length)));
      expect(result.status, String(result.stderr)).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0].body.msg_type).toBe('file');
      expect(JSON.parse(requests[0].body.content)).toEqual({ file_key: 'file_test_upload' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not decode a file-only attachment when neither expected-link nor turn fencing needs inspection', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-file-no-prescan-'));
    const dataDir = join(root, 'data');
    const sessionId = 'sid_file_no_prescan';
    const attachment = join(root, 'large.bin');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(attachment, '');
    truncateSync(attachment, bufferConstants.MAX_STRING_LENGTH + 1);
    writeFileSync(join(root, 'bots.json'), JSON.stringify([{
      larkAppId: 'cli_test', larkAppSecret: 'test-secret', cliId: 'codex', replyCardMode: 'legacy',
    }]));
    seedPersistedSessionRows(dataDir, 'cli_test', { [sessionId]: {
      sessionId, status: 'active', cliId: 'codex', larkAppId: 'cli_test',
      chatId: 'oc_test', rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
    } });
    try {
      const result = spawnSyncTsScript(fixture, [
        'send', '--no-mention', '--response-kind', 'auxiliary', '--files', attachment,
      ], {
        cwd: repo,
        env: { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir,
          BOTS_CONFIG: join(root, 'bots.json'), BOTMUX_SESSION_ID: sessionId,
          BOTMUX_LARK_APP_ID: 'cli_test', BOTMUX_TURN_ID: '',
          BOTMUX_TEST_STUB_LARGE_FILE_UPLOAD: attachment },
        encoding: 'utf8', timeout: 60_000,
      });
      expect(result.status, String(result.stderr)).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 70_000);

  it('rejects a different file-only final for the same turn even without expected-link', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-file-final-fingerprint-'));
    const dataDir = join(root, 'data');
    const sessionId = 'sid_file_final_fingerprint';
    const turnId = 'turn_file_final_fingerprint';
    const attachment = join(root, 'answer.md');
    mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
    writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId, turnId }));
    writeFileSync(join(root, 'bots.json'), JSON.stringify([{
      larkAppId: 'cli_test', larkAppSecret: 'test-secret', cliId: 'codex', replyCardMode: 'legacy',
    }]));
    seedPersistedSessionRows(dataDir, 'cli_test', { [sessionId]: {
      sessionId, status: 'active', cliId: 'codex', larkAppId: 'cli_test',
      chatId: 'oc_test', rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
    } });
    const run = () => spawnSyncTsScript(fixture, [
      'send', '--no-mention', '--response-kind', 'final', '--files', attachment,
    ], {
      cwd: repo,
      env: { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: join(root, 'bots.json'), BOTMUX_SESSION_ID: sessionId,
        BOTMUX_TURN_ID: turnId, BOTMUX_LARK_APP_ID: 'cli_test' },
      encoding: 'utf8', timeout: 30_000,
    });
    try {
      writeFileSync(attachment, 'first attachment');
      expect(run().status).toBe(0);
      writeFileSync(attachment, 'different attachment');
      const changed = run();
      expect(changed.status).toBe(2);
      expect(String(changed.stderr)).toContain('目标、提及或附件与已投递请求不同');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 40_000);

  it('reports a missing file-only final with the existing Chinese attachment error', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-file-missing-friendly-'));
    const dataDir = join(root, 'data');
    const sessionId = 'sid_file_missing_friendly';
    const turnId = 'turn_file_missing_friendly';
    const attachment = join(root, 'missing.zip');
    mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
    writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId, turnId }));
    writeFileSync(join(root, 'bots.json'), JSON.stringify([{
      larkAppId: 'cli_test', larkAppSecret: 'test-secret', cliId: 'codex', replyCardMode: 'legacy',
    }]));
    seedPersistedSessionRows(dataDir, 'cli_test', { [sessionId]: {
      sessionId, status: 'active', cliId: 'codex', larkAppId: 'cli_test',
      chatId: 'oc_test', rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
    } });
    try {
      const result = spawnSyncTsScript(fixture, [
        'send', '--no-mention', '--response-kind', 'final', '--files', attachment,
      ], {
        cwd: repo,
        env: { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir,
          BOTS_CONFIG: join(root, 'bots.json'), BOTMUX_SESSION_ID: sessionId,
          BOTMUX_TURN_ID: turnId, BOTMUX_LARK_APP_ID: 'cli_test' },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status).toBe(1);
      expect(String(result.stderr)).toContain(`文件不存在: ${attachment}`);
      expect(String(result.stderr)).not.toContain('ENOENT');
      expect(String(result.stderr)).not.toContain('node:fs');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
