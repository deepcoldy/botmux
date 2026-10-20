/**
 * `botmux send` 把**附件消息 id** 交给调用方（#1327）。
 *
 * `sendFileAttachments` / `sendVideoAttachments` 返回的 `sent` 在 cli-send-dispatch.test.ts
 * 里已有覆盖，但 helper 全绿不能证明 cmdSend 没有把它丢掉——缺陷恰好发生在这一层：
 * 调用处长期只解构 `failed`，`sent` 从未进入输出，于是调用方「核验刚发出的消息带不带
 * 附件」的判据永远不成立，把成功判成静默失败并重发（实测一份文件被重发 3 次）。
 *
 * 这里跑真实 CLI（fixtures/send-reply-card-capture.ts 截获全部飞书读写），检查成功 JSON：
 * 每个送达的附件都有 id；失败的附件进失败字段，且不冒充成功。
 *
 * Run: bunx vitest run test/send-attachment-message-ids-wiring.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));

/** Run `botmux send` from a live topic turn; `@name` args become files in a temp dir. */
function send(args: string[], env: Record<string, string> = {}): Record<string, any> {
  const root = mkdtempSync(join(tmpdir(), 'cli-send-attachment-ids-'));
  try {
    const data = join(root, 'data');
    mkdirSync(join(data, '.botmux-cli-pids'), { recursive: true });
    writeFileSync(join(data, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: 'sid', turnId: 'om_turn' }));
    writeFileSync(join(root, 'bots.json'), JSON.stringify([{
      larkAppId: 'cli_test', larkAppSecret: 'test', cliId: 'codex', replyCardMode: 'legacy',
    }]));
    seedPersistedSessionRows(data, 'cli_test', { sid: {
      sessionId: 'sid', status: 'active', cliId: 'codex', larkAppId: 'cli_test', chatId: 'oc_test',
      rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
    } });
    const resolved = args.map(arg => {
      if (!arg.startsWith('@')) return arg;
      const path = join(root, arg.slice(1));
      writeFileSync(path, 'attachment bytes');
      return path;
    });
    const result = spawnSyncTsScript(fixture, ['send', '--no-mention', ...resolved], {
      cwd: repo, encoding: 'utf8', timeout: 30000,
      env: { PATH: process.env.PATH, HOME: root, BOTS_CONFIG: join(root, 'bots.json'), SESSION_DATA_DIR: data,
        BOTMUX_SESSION_ID: 'sid', BOTMUX_TURN_ID: 'om_turn', BOTMUX_LARK_APP_ID: 'cli_test',
        BOTMUX_TEST_ALLOW_IMAGE_UPLOAD: '1', ...env },
    });
    expect(result.status, String(result.stderr)).toBe(0);
    const json = String(result.stdout).split('\n').find(line => line.startsWith('{') && line.includes('"messageId"'));
    expect(json, String(result.stdout)).toBeDefined();
    return JSON.parse(json!);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('botmux send 成功 JSON 带出附件消息 id', () => {
  it('每个送达的文件附件都有消息 id，没有失败字段', () => {
    const out = send(['result', '--files', '@a.txt', '--files', '@b.txt']);
    expect(out.attachmentMessageIds).toHaveLength(2);
    expect(out.failedAttachments ?? []).toEqual([]);
  }, 40000);

  it('附件全部上传失败时只报失败，不冒充成功', () => {
    const out = send(['result', '--files', '@a.txt'], { BOTMUX_TEST_FAIL_FILE_UPLOAD: '1' });
    expect(out.attachmentMessageIds).toBeUndefined();
    expect(out.failedAttachments).toHaveLength(1);
  }, 40000);

  it('视频附件在正文之后发送和纯视频发送两条路径上都带出消息 id', () => {
    const withText = send(['result', '--videos', '@v.mp4', '--video-covers', '@c.png']);
    expect(withText.videoMessageIds).toHaveLength(1);
    expect(withText.failedVideoAttachments ?? []).toEqual([]);
    const pureVideo = send(['--videos', '@v.mp4', '--video-covers', '@c.png']);
    expect(pureVideo.videoMessageIds).toHaveLength(1);
  }, 80000);
});
