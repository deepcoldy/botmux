/**
 * `botmux send` 只带附件、不带正文时与 stdin 的契约。
 *
 * 用户反馈的两种坏形态，这里都用真实 CLI（fixtures/send-reply-card-capture.ts
 * 截获全部飞书读写）复现：
 *   - stdin 是一直不关闭的管道/套接字（Claude Code 的 Bash 工具在同一次调用里含
 *     heredoc 时就不接 /dev/null）：发送入口先等 stdin EOF，附件发送永久卡住；
 *   - stdin 是 /dev/null：正文读成空串，多附件或带 @ 的组合走卡片路径，发出一张
 *     没有正文的主卡片（飞书在页脚也为空时直接回 230099 parse card json err，
 *     附件随之一起没发出去）。
 *
 * 期望：只发附件（单个 --files 且不 @）时不等 stdin、允许没有正文；需要正文卡片的
 * 组合（多个附件、带 @）在没有正文时立即拒绝且不产生任何飞书写入；heredoc / 管道
 * 提供的正文照常使用，纯文本发送仍会等慢管道写完。
 */
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { SEND_STDIN_PROBE_MS } from '../src/cli/send-stdin.js';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));

/** A hung CLI is killed after this long; generous enough for a loaded CI box,
 *  far shorter than the old behaviour (waiting for an EOF that never comes). */
const HANG_KILL_MS = 25_000;

/** A "slow producer" writes its body only after the CLI has started up AND an
 *  attachment send's probe window has elapsed; anything sooner is already in
 *  the pipe when the CLI first looks. The margin covers child start-up on a
 *  loaded machine. */
const SLOW_BODY_DELAY_MS = SEND_STDIN_PROBE_MS + 7_000;

type StdinInput =
  | { kind: 'open' }
  | { kind: 'dev-null' }
  | { kind: 'pipe'; body: string; delayMs?: number }
  | { kind: 'file'; body: string };

interface Capture { method: string; path: string; body: { msg_type?: string; content?: string } }
interface SendResult { status: number | null; stdout: string; stderr: string; writes: Capture[]; hung: boolean }

async function send(
  args: string[],
  stdin: StdinInput,
  extraEnv: Record<string, string> = {},
  opts: { session?: boolean; sessionRow?: Record<string, unknown> } = {},
): Promise<SendResult> {
  const root = mkdtempSync(join(tmpdir(), 'cli-send-attachment-stdin-'));
  let stdinFd: number | undefined;
  try {
    const data = join(root, 'data');
    mkdirSync(join(data, '.botmux-cli-pids'), { recursive: true });
    if (opts.session !== false) {
      writeFileSync(join(data, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: 'sid', turnId: 'om_turn' }));
    }
    writeFileSync(join(root, 'bots.json'), JSON.stringify([{
      larkAppId: 'cli_test', larkAppSecret: 'test', cliId: 'codex', replyCardMode: 'legacy',
    }]));
    seedPersistedSessionRows(data, 'cli_test', { sid: {
      sessionId: 'sid', status: 'active', cliId: 'codex', larkAppId: 'cli_test', chatId: 'oc_test',
      rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
      ...opts.sessionRow,
    } });
    const resolved = args.map(arg => {
      if (!arg.startsWith('@')) return arg;
      const path = join(root, arg.slice(1));
      // `@empty.md` stands for an empty --content-file.
      writeFileSync(path, arg.startsWith('@empty') ? '' : `bytes of ${arg.slice(1)}`);
      return path;
    });
    if (stdin.kind === 'file') {
      // zsh (and bash for large documents) hands a heredoc over as a regular file.
      const bodyPath = join(root, 'heredoc.txt');
      writeFileSync(bodyPath, stdin.body);
      stdinFd = openSync(bodyPath, 'r');
    }
    const child = spawnTsScript(fixture, ['send', ...resolved], {
      cwd: repo,
      env: { PATH: process.env.PATH, HOME: root, BOTS_CONFIG: join(root, 'bots.json'), SESSION_DATA_DIR: data,
        ...(opts.session === false ? {} : { BOTMUX_SESSION_ID: 'sid', BOTMUX_TURN_ID: 'om_turn', BOTMUX_LARK_APP_ID: 'cli_test' }),
        ...extraEnv },
      stdio: [stdin.kind === 'dev-null' ? 'ignore' : stdin.kind === 'file' ? stdinFd! : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.stdin?.on('error', () => { /* the CLI may exit before a delayed body is written */ });
    let bodyTimer: NodeJS.Timeout | undefined;
    if (stdin.kind === 'pipe') {
      // A shell heredoc/pipeline: the body arrives (possibly late) and the
      // writer closes. `open` keeps the write end held for the CLI's lifetime,
      // like a parent process that never wires stdin to /dev/null.
      const write = () => child.stdin!.end(stdin.body);
      if (stdin.delayMs) bodyTimer = setTimeout(write, stdin.delayMs);
      else write();
    }
    let hung = false;
    const killer = setTimeout(() => { hung = true; child.kill('SIGKILL'); }, HANG_KILL_MS);
    const status = await new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
    clearTimeout(killer);
    if (bodyTimer) clearTimeout(bodyTimer);
    child.stdin?.destroy();
    const writes = stdout.split('\n')
      .filter(line => line.startsWith('CAPTURE_REPLY='))
      .map(line => JSON.parse(line.slice('CAPTURE_REPLY='.length)) as Capture);
    return { status, stdout, stderr, writes, hung };
  } finally {
    if (stdinFd !== undefined) closeSync(stdinFd);
    rmSync(root, { recursive: true, force: true });
  }
}

const msgTypes = (result: SendResult) => result.writes.map(write => write.body.msg_type);

const MENTION = ['--mention', 'ou_reviewer:Reviewer'];
const NO_MENTION = ['--no-mention'];

const bodylessStdins: Array<[string, StdinInput]> = [
  ['stdin 一直不关闭', { kind: 'open' }],
  ['stdin 是 /dev/null', { kind: 'dev-null' }],
];

describe('botmux send 只带附件时不等 stdin', () => {
  it.each(bodylessStdins)('%s：单个文件、不 @ 直接作为文件消息发出', async (_name, stdin) => {
    const result = await send([...NO_MENTION, '--files', '@a.json'], stdin);
    expect(result.hung, result.stderr).toBe(false);
    expect(result.status, result.stderr).toBe(0);
    // The file itself is the primary message: no card (empty or otherwise).
    expect(msgTypes(result)).toEqual(['file']);
  }, 60_000);

  it('stdin 一直不关闭：只发视频也不卡住', async () => {
    const result = await send([...NO_MENTION, '--videos', '@v.mp4', '--video-covers', '@c.png'], { kind: 'open' },
      { BOTMUX_TEST_ALLOW_IMAGE_UPLOAD: '1' });
    expect(result.hung, result.stderr).toBe(false);
    expect(result.status, result.stderr).toBe(0);
    expect(msgTypes(result)).toEqual(['media']);
  }, 60_000);
});

describe('需要正文卡片的附件组合没有正文时立即拒绝，不发空卡片', () => {
  const combos: Array<[string, string[]]> = [
    ['单个文件 + @', [...MENTION, '--files', '@a.json']],
    ['单个文件 + --mention-back', ['--mention-back', '--files', '@a.json']],
    ['多个文件、不 @', [...NO_MENTION, '--files', '@a.json', '--files', '@b.json']],
    ['多个文件 + @', [...MENTION, '--files', '@a.json', '--files', '@b.json']],
  ];
  for (const [stdinName, stdin] of bodylessStdins) {
    it.each(combos)(`${stdinName}：%s`, async (_name, args) => {
      const result = await send(args, stdin);
      expect(result.hung, result.stderr).toBe(false);
      expect(result.status, result.stderr).toBe(2);
      // Nothing reached Feishu: neither an empty primary card nor the files.
      expect(result.writes).toEqual([]);
      // The refusal says how to supply a body without stdin.
      expect(result.stderr).toContain('--content-file');
    }, 60_000);
  }

  // The refusal comes from the earliest send gate, ahead of session, relay and
  // transport resolution: without any session the command still reports the
  // missing body (exit 2) rather than failing to infer a session (exit 1).
  it.each([
    ['多个文件、不 @', [...NO_MENTION, '--files', '@a.json', '--files', '@b.json']],
    ['单个文件 + @', [...MENTION, '--files', '@a.json']],
    ['单个文件 + --mention-back', ['--mention-back', '--files', '@a.json']],
  ])('在解析会话之前就拒绝：%s', async (_name, args) => {
    const result = await send(args, { kind: 'open' }, {}, { session: false });
    expect(result.hung, result.stderr).toBe(false);
    expect(result.status, result.stderr).toBe(2);
    expect(result.writes).toEqual([]);
    expect(result.stderr).toContain('--content-file');
  }, 60_000);
});

describe('其它正文来源为空时同样不发空卡片', () => {
  it('空 --content-file + 多个文件：拒绝且没有任何飞书写入', async () => {
    const result = await send([...NO_MENTION, '--content-file', '@empty.md', '--files', '@a.json', '--files', '@b.json'],
      { kind: 'dev-null' });
    expect(result.status, result.stderr).toBe(2);
    expect(result.writes).toEqual([]);
    expect(result.stderr).toContain('--content-file');
  }, 60_000);

  it('空 --content-file + 单个文件、不 @：仍按纯文件发出', async () => {
    const result = await send([...NO_MENTION, '--content-file', '@empty.md', '--files', '@a.json'], { kind: 'dev-null' });
    expect(result.status, result.stderr).toBe(0);
    expect(msgTypes(result)).toEqual(['file']);
  }, 60_000);

  it('空 --content-file + 单个文件 + --mention-back：拒绝，不发只有页脚的卡片', async () => {
    // A resolvable reply target, so only the missing body can stop this send.
    const result = await send(['--mention-back', '--content-file', '@empty.md', '--files', '@a.json'], { kind: 'dev-null' }, {}, {
      sessionRow: {
        replyTargets: { om_turn: { updatedAt: new Date().toISOString(), senderOpenId: 'ou_requester',
          participants: [{ openId: 'ou_requester', isBot: false }] } },
        turnReplyContexts: { om_turn: { target: { mode: 'thread', rootMessageId: 'om_root' },
          replyTargetSenderOpenId: 'ou_requester', replyTargetSenderIsBot: false } },
      },
    });
    expect(result.status, result.stderr).toBe(2);
    expect(result.writes).toEqual([]);
  }, 60_000);
});

describe('正文由参数合成时不要求正文', () => {
  it('--as 带多个附件、没有正文：照常发出正文卡片和附件', async () => {
    const result = await send(['--as', 'independent', ...NO_MENTION, '--files', '@a.json', '--files', '@b.json'],
      { kind: 'dev-null' });
    expect(result.status, result.stderr).toBe(0);
    expect(msgTypes(result)).toEqual(['interactive', 'file', 'file']);
  }, 60_000);
});

describe('heredoc / 管道正文照常使用', () => {
  it.each([
    ['管道（bash heredoc 形态）', { kind: 'pipe', body: 'REAL BODY\n' } as StdinInput],
    ['普通文件（zsh heredoc 形态）', { kind: 'file', body: 'REAL BODY\n' } as StdinInput],
  ])('%s 正文 + 多个附件 + @：正文卡片在前，附件随后', async (_name, stdin) => {
    const result = await send([...MENTION, '--files', '@a.json', '--files', '@b.json'], stdin);
    expect(result.status, result.stderr).toBe(0);
    expect(msgTypes(result)).toEqual(['interactive', 'file', 'file']);
    expect(result.writes[0]!.body.content).toContain('REAL BODY');
  }, 60_000);

  it('管道正文 + 单个文件：正文不被丢掉', async () => {
    const result = await send([...NO_MENTION, '--files', '@a.json'], { kind: 'pipe', body: 'REAL BODY\n' });
    expect(result.status, result.stderr).toBe(0);
    expect(msgTypes(result)).toEqual(['interactive', 'file']);
    expect(result.writes[0]!.body.content).toContain('REAL BODY');
  }, 60_000);

  it('纯文本发送仍会等写得慢的管道写完', async () => {
    const result = await send(NO_MENTION, { kind: 'pipe', body: 'SLOW BODY\n', delayMs: SLOW_BODY_DELAY_MS });
    expect(result.status, result.stderr).toBe(0);
    expect(msgTypes(result)).toEqual(['interactive']);
    expect(result.writes[0]!.body.content).toContain('SLOW BODY');
  }, 60_000);

  it("显式 '-' 带附件时也等慢管道写完", async () => {
    const result = await send([...NO_MENTION, '--files', '@a.json', '--files', '@b.json', '-'],
      { kind: 'pipe', body: 'SLOW BODY\n', delayMs: SLOW_BODY_DELAY_MS });
    expect(result.status, result.stderr).toBe(0);
    expect(msgTypes(result)).toEqual(['interactive', 'file', 'file']);
    expect(result.writes[0]!.body.content).toContain('SLOW BODY');
  }, 60_000);
});
