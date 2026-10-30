import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncTsScript, spawnTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { RELAY_ORIGIN_CAPABILITY_BASENAME, replaceManagedOriginCapabilityFile } from '../src/core/managed-origin-capability.js';
import { buildCardBodyElements } from '../src/im/lark/md-card.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const patch = '--- a/doc.md\n+++ b/doc.md\n@@ -1 +1 @@\n-old\n+new\n';
const captured = (stdout: unknown) => String(stdout).split('\n')
  .filter(line => line.startsWith('CAPTURE_REPLY='))
  .map(line => JSON.parse(line.slice('CAPTURE_REPLY='.length)));
const posixIt = process.platform === 'win32' ? it.skip : it;

function preview(args: string[], bytes: string | Buffer = patch, input = '', summaryContent = 'file summary\n', filePolicy?: 'forbid_read' | 'grow_after_stat') {
  const root = mkdtempSync(join(tmpdir(), 'botmux-diff-dry-'));
  try {
    const path = join(root, 'change.diff');
    const summary = join(root, 'summary.md');
    writeFileSync(path, bytes);
    writeFileSync(summary, summaryContent);
    return spawnSyncTsScript(filePolicy ? fixture : cli, ['send', '--dry-run', ...args.map(arg => arg.replace('@diff', path).replace('@summary', summary))], {
      env: {
        PATH: process.env.PATH, SESSION_DATA_DIR: join(root, 'data'), BOTS_CONFIG: join(root, 'missing.json'),
        ...(filePolicy === 'forbid_read' ? { BOTMUX_TEST_FORBID_DIFF_READ: path } : {}),
        ...(filePolicy === 'grow_after_stat' ? { BOTMUX_TEST_GROW_DIFF_AFTER_STAT: path } : {}),
      },
      input, encoding: 'utf8', timeout: 30_000,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('send --diff CLI', () => {
  it('dry-run uses the real request budget without session or transport', () => {
    const result = preview(['--diff', '@diff', 'summary']);
    expect(result.status, String(result.stderr)).toBe(0);
    const output = JSON.parse(String(result.stdout));
    expect(output.dryRun).toBe(true);
    expect(output.bytes).toBeGreaterThan(Buffer.byteLength(JSON.stringify(output.card)));
    expect(output.fits).toBe(true);
    expect(output.diff.stats).toEqual({ files: 1, added: 1, removed: 1 });
    expect(output.card.body.elements.some((element: { tag: string }) => element.tag === 'collapsible_panel')).toBe(true);
  });

  it.each([
    { args: ['--diff', '@diff', '--content-file', '@summary', 'ignored'], input: 'ignored stdin', expected: 'file summary\n' },
    { args: ['--diff=@diff', 'first\\n\\nsecond'], input: 'ignored stdin', expected: 'first\n\nsecond' },
    { args: ['--diff', '@diff'], input: 'stdin\nsummary', expected: 'stdin\nsummary' },
  ])('uses ordinary body precedence for $args', ({ args, input, expected }) => {
    const result = preview(args, patch, input);
    expect(result.status, String(result.stderr)).toBe(0);
    const elements = JSON.parse(String(result.stdout)).card.body.elements;
    const summaryElements = buildCardBodyElements(expected);
    expect(elements.slice(0, summaryElements.length)).toEqual(summaryElements);
  });

  it.each([
    { args: ['--diff'], bytes: patch },
    { args: ['--diff', '@diff', '--diff=@diff'], bytes: patch },
    { args: ['--diff', '@diff', '--card-json={}'], bytes: patch },
    { args: ['--diff', '@diff', '--files=@summary'], bytes: patch },
    { args: ['--diff', '@diff', '--voice'], bytes: patch },
    { args: ['--diff', '@diff'], bytes: Buffer.from([0xff]) },
    { args: ['--diff', '@diff'], bytes: '--- a/x\n+++ b/x\n@@ -1,2 +1 @@\n-a\n+b\n' },
  ])('rejects invalid inputs and conflicting flags for $args', ({ args, bytes }) => {
    const result = preview(args, bytes);
    expect(result.status).not.toBe(0);
    expect(captured(result.stdout)).toHaveLength(0);
  });

  it('accepts a diff without a summary and a genuinely empty diff', () => {
    const diff = preview(['--diff', '@diff']);
    expect(diff.status, String(diff.stderr)).toBe(0);
    expect(JSON.parse(String(diff.stdout)).diff.stats.added).toBe(1);
    const empty = preview(['--diff', '@diff'], '');
    expect(empty.status, String(empty.stderr)).toBe(0);
    expect(JSON.parse(String(empty.stdout)).diff.stats.files).toBe(0);
  });

  posixIt('rejects a FIFO without waiting for a writer', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-diff-fifo-'));
    try {
      const path = join(root, 'change.fifo');
      execFileSync('mkfifo', [path], { timeout: 5_000 });
      const result = spawnSyncTsScript(cli, ['send', '--dry-run', '--diff', path, '--no-mention'], {
        env: { PATH: process.env.PATH, SESSION_DATA_DIR: join(root, 'data'), BOTS_CONFIG: join(root, 'missing.json') },
        encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL',
      });
      expect(result.status, String(result.stderr)).toBe(2);
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(String(result.stderr).trim()).toBe('botmux send: diff 需要普通 UTF-8 文件');
      expect(String(result.stdout)).toBe('');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  posixIt('accepts a symlink to a regular diff file', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-diff-symlink-'));
    try {
      const path = join(root, 'actual.diff');
      const link = join(root, 'linked.diff');
      writeFileSync(path, patch);
      symlinkSync(path, link);
      const result = spawnSyncTsScript(cli, ['send', '--dry-run', '--diff', link, '--no-mention'], {
        env: { PATH: process.env.PATH, SESSION_DATA_DIR: join(root, 'data'), BOTS_CONFIG: join(root, 'missing.json') },
        encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL',
      });
      expect(result.status, String(result.stderr)).toBe(0);
      expect(result.error).toBeUndefined();
      const output = JSON.parse(String(result.stdout));
      expect(output.fits).toBe(true);
      expect(output.diff.stats).toEqual({ files: 1, added: 1, removed: 1 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it.each([
    { name: '摘要字节超限', summary: 'x'.repeat(4001), reason: '摘要过长' },
    {
      name: '表格渲染超预算',
      summary: [
        '|' + Array.from({ length: 200 }, (_, i) => 'c' + i).join('|') + '|',
        '|' + Array(200).fill('---').join('|') + '|',
        ...Array(4).fill('|' + Array(200).fill('1').join('|') + '|'),
      ].join('\n'),
      reason: '卡片摘要超过预览预算',
    },
  ])('reports $name as a clean input error', ({ summary, reason }) => {
    if (reason === '卡片摘要超过预览预算') expect(Buffer.byteLength(summary)).toBeLessThan(4000);
    const result = preview(['--diff', '@diff', '--content-file', '@summary'], patch, '', summary);
    expect(result.status).toBe(2);
    expect(String(result.stderr)).toContain('botmux send: ' + reason);
    expect(String(result.stderr)).not.toMatch(/\n\s+at\s|md-card\.ts:\d/);
    expect(captured(result.stdout)).toHaveLength(0);
  });

  it('reads a bounded prefix and shows partial diff when the file exceeds the input budget', () => {
    const rows = Array.from({ length: 100_000 }, (_, i) => '+requirement ' + i + ' with extra details');
    const input = '--- a/spec.md\n+++ b/spec.md\n@@ -0,0 +1,100000 @@\n' + rows.join('\n') + '\n';
    const result = preview(['--diff', '@diff', '需求文档的完整差异较大。'], input, '', '', 'forbid_read');
    expect(result.status, String(result.stderr)).toBe(0);
    const output = JSON.parse(String(result.stdout));
    expect(output.diff.preview.reason).toBe('input_too_large');
    expect(output.diff.statsScope).toBe('preview');
    expect(output.diff.stats.added).toBeGreaterThan(0);
    expect(JSON.stringify(output.card)).toContain('+requirement 0');
    expect(JSON.stringify(output.card)).toContain('diff 超限，仅显示前60行');
    expect(JSON.stringify(output.card)).not.toContain('未检测到内容差异');
    expect(output.fits).toBe(true);
  });

  it('keeps a bounded partial line when the diff grows after the size check', () => {
    const result = preview(['--diff', '@diff'], patch, '', '', 'grow_after_stat');
    expect(result.status, String(result.stderr)).toBe(0);
    const output = JSON.parse(String(result.stdout));
    expect(output.diff.preview.reason).toBe('input_too_large');
    expect(output.diff.preview.inputBytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(output.diff.statsScope).toBe('preview');
    expect(output.diff.stats.added).toBe(1);
    expect(JSON.stringify(output.card)).toContain('+xxx');
    expect(JSON.stringify(output.card)).toContain('长行已截断');
    expect(output.fits).toBe(true);
  });

  it('keeps Unicode valid when the input budget ends inside a multibyte character', () => {
    const header = '--- a/spec.md\n+++ b/spec.md\n@@ -0,0 +1 @@\n+';
    const beginning = '😀需求';
    const padding = 'a'.repeat(2 * 1024 * 1024 - Buffer.byteLength(header + beginning) - 1);
    const input = header + beginning + padding + '😀尾部\n';
    const result = preview(['--diff', '@diff'], input, '', '', 'forbid_read');
    expect(result.status, String(result.stderr)).toBe(0);
    const output = JSON.parse(String(result.stdout));
    expect(output.diff.statsScope).toBe('preview');
    expect(JSON.stringify(output.card)).toContain('😀需求');
    expect(JSON.stringify(output.card)).not.toContain('\ufffd');
  });

  it.each([
    { cliId: 'codex', scope: 'thread', summary: '已修改', largeInput: false },
    { cliId: 'claude-code', scope: 'chat', summary: '已修改', largeInput: false },
    { cliId: 'codex', scope: 'thread', summary: '## 摘要\n\n已修改', largeInput: false },
    { cliId: 'codex', scope: 'thread', summary: '## 摘要\n\n已修改', largeInput: true },
  ])('uses ordinary final/mention/replay for $cliId/$scope/$summary large=$largeInput', ({ cliId, scope, summary, largeInput }) => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-diff-send-'));
    const dataDir = join(root, 'data');
    const appId = 'cli_diff_test';
    const sessionId = 'sid_diff_test';
    const turnId = 'om_diff_turn';
    try {
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId, turnId }));
      writeFileSync(join(root, 'bots.json'), JSON.stringify([{
        larkAppId: appId, larkAppSecret: 'test-secret', cliId, replyCardMode: 'unified',
        brandLabel: 'Example assistant', feedback: { enabled: false },
      }]));
      seedPersistedSessionRows(dataDir, appId, { [sessionId]: {
        sessionId, status: 'active', cliId, cliSessionId: 'native_diff', larkAppId: appId,
        chatId: 'oc_test', rootMessageId: 'om_root', scope, chatType: 'group', workingDir: root,
        ownerOpenId: 'ou_requester', lastCallerOpenId: 'ou_requester',
        replyTargets: { [turnId]: { updatedAt: new Date().toISOString(), senderOpenId: 'ou_requester', participants: [{ openId: 'ou_requester', isBot: false }] } },
        turnReplyContexts: { [turnId]: { replyTargetSenderOpenId: 'ou_requester', replyTargetSenderIsBot: false } },
      } });
      const path = join(root, 'change.diff');
      writeFileSync(path, largeInput ? '--- a/spec.md\n+++ b/spec.md\n@@ -0,0 +1 @@\n+' + 'x'.repeat(2 * 1024 * 1024) + '\n' : patch);
      const run = (extra: string[] = [], kind = 'final', body = summary) => spawnSyncTsScript(fixture, ['send', '--diff', path, '--response-kind', kind, '--mention-back', ...extra, body], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { PATH: process.env.PATH, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(root, 'bots.json'), BOTMUX_SESSION_ID: sessionId, BOTMUX_TURN_ID: turnId, BOTMUX_LARK_APP_ID: appId },
        encoding: 'utf8', timeout: 30_000,
      });
      const incompatiblePlugin = run(['--plugin-card-action', 'example']);
      expect(incompatiblePlugin.status, String(incompatiblePlugin.stderr)).toBe(2);
      expect(captured(incompatiblePlugin.stdout)).toHaveLength(0);
      expect(String(incompatiblePlugin.stderr)).toContain('--plugin-card-action');
      const oversizedSummary = run([], 'final', 'x'.repeat(4001));
      expect(oversizedSummary.status).toBe(2);
      expect(String(oversizedSummary.stderr)).toContain('botmux send: 摘要过长');
      expect(String(oversizedSummary.stderr)).not.toMatch(/\n\s+at\s|md-card\.ts:\d/);
      expect(captured(oversizedSummary.stdout)).toHaveLength(0);
      const attention = run(['--attention=decision'], 'progress');
      expect(attention.status, String(attention.stderr)).toBe(0);
      expect(captured(attention.stdout)).toHaveLength(1);
      expect(String(attention.stderr)).not.toContain('需要文本 reason');
      const first = run();
      expect(first.status, String(first.stderr)).toBe(0);
      const requests = captured(first.stdout);
      expect(requests).toHaveLength(1);
      const card = JSON.parse(requests[0].body.content);
      expect(JSON.stringify(card)).toContain('已修改');
      expect(JSON.stringify(card)).not.toContain('botmux_md_h');
      expect(card.body.elements.some((element: { tag: string }) => element.tag === 'collapsible_panel')).toBe(true);
      expect(requests[0].body.content.match(/"element_id":"botmux_reply_footer"/g)).toHaveLength(1);
      expect((requests[0].body.content.match(/<at id=ou_requester>/g) ?? [])).toHaveLength(1);
      const replay = run();
      expect(replay.status, String(replay.stderr)).toBe(0);
      expect(captured(replay.stdout)).toHaveLength(0);
      expect(String(replay.stdout)).toContain('"replayed":true');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('relays the generated card through the existing bounded cardFile protocol', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-diff-relay-'));
    const relay = join(root, 'relay');
    mkdirSync(relay);
    const channel = 'ab'.repeat(32);
    replaceManagedOriginCapabilityFile(join(relay, RELAY_ORIGIN_CAPABILITY_BASENAME), JSON.stringify({
      sessionId: 'sid_diff_relay', channelId: channel, capability: 'cd'.repeat(32), turnId: 'om_diff_relay', ipcPort: 7951,
    }));
    const path = join(root, 'change.diff');
    writeFileSync(path, patch);
    writeFileSync(join(root, 'bots.json'), JSON.stringify([{ larkAppId: 'cli_diff_test', larkAppSecret: 'test-secret', cliId: 'codex' }]));
    let acceptRequest!: (file: string) => void;
    const request = new Promise<string>(resolve => { acceptRequest = resolve; });
    const watcher = watch(relay, (_event, file) => {
      if (file?.toString().endsWith('.req.json')) acceptRequest(file.toString());
    });
    const child = spawnTsScript(cli, ['send', '--diff', path, '--response-kind', 'final', '--mention-back', '## relay summary'], {
      env: {
        PATH: process.env.PATH, SESSION_DATA_DIR: join(root, 'data'), BOTS_CONFIG: join(root, 'bots.json'),
        BOTMUX_SESSION_ID: 'sid_diff_relay', BOTMUX_TURN_ID: 'om_diff_relay', BOTMUX_LARK_APP_ID: 'cli_diff_test',
        BOTMUX_SEND_RELAY: relay, BOTMUX_ORIGIN_CHANNEL_ID: channel,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout!.on('data', chunk => { stdout += chunk; });
    child.stderr!.on('data', chunk => { stderr += chunk; });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    });
    try {
      const file = await Promise.race([request, closed.then(() => { throw new Error(`relay exited before request: ${stderr}`); })]);
      const payload = JSON.parse(readFileSync(join(relay, file), 'utf8'));
      expect(payload.cardFile).toMatch(/^[a-f0-9]+\.card\.json$/);
      const card = JSON.parse(readFileSync(join(relay, payload.cardFile), 'utf8'));
      expect(card.body.elements[0]).toEqual({ tag: 'markdown', text_size: 'heading-2', content: 'relay summary' });
      expect(JSON.stringify(card)).not.toContain('botmux_md_h');
      expect(card.body.elements.some((element: { tag: string }) => element.tag === 'collapsible_panel')).toBe(true);
      expect(payload.flags).toEqual(['--response-kind', 'final', '--mention-back']);
      expect(JSON.stringify(payload)).not.toContain(path);
      writeFileSync(join(relay, file.replace('.req.json', '.res.json')), JSON.stringify({ code: 0, stdout: '{"success":true,"messageId":"om_relay"}', stderr: '' }));
      expect(await closed, stderr).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ success: true, messageId: 'om_relay' });
    } finally {
      watcher.close();
      if (child.exitCode === null) child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
