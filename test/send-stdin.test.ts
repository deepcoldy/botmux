/**
 * `botmux send` 的 stdin 读取策略（src/cli/send-stdin.ts）。
 *
 * 真实 fd 的组合（不关闭的管道、/dev/null、heredoc 管道/文件、慢管道）在
 * cli-send-attachment-stdin.test.ts 里用真实 CLI 覆盖；这里补上测试进程里拿不到的
 * 形态（终端、fstat 失败），以及探测窗口的时序边界。
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  classifySendStdin,
  readSendStdin,
  sendStdinPolicy,
  type StdinFdProbe,
} from '../src/cli/send-stdin.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function fd(kind: 'fifo' | 'socket' | 'file' | 'char', tty = false): StdinFdProbe {
  return {
    isatty: () => tty,
    fstat: () => ({
      isFile: () => kind === 'file',
      isFIFO: () => kind === 'fifo',
      isSocket: () => kind === 'socket',
    }),
  };
}

describe('classifySendStdin + sendStdinPolicy', () => {
  it('never reads a terminal or a non-pipe device', () => {
    const tty = classifySendStdin(fd('char', true));
    expect(sendStdinPolicy(tty, { explicitDash: true, hasAttachments: false })).toBe('skip');
    const devNull = classifySendStdin(fd('char'));
    expect(sendStdinPolicy(devNull, { explicitDash: true, hasAttachments: false })).toBe('skip');
  });

  it('only bounds the wait for an attachment send on a pipe or socket', () => {
    for (const kind of ['fifo', 'socket'] as const) {
      const shape = classifySendStdin(fd(kind));
      expect(sendStdinPolicy(shape, { explicitDash: false, hasAttachments: true })).toBe('probe');
      // The body is the whole message, or the caller named stdin explicitly.
      expect(sendStdinPolicy(shape, { explicitDash: false, hasAttachments: false })).toBe('read-to-eof');
      expect(sendStdinPolicy(shape, { explicitDash: true, hasAttachments: true })).toBe('read-to-eof');
    }
    // A regular file (zsh heredoc, `< file`) always ends.
    expect(sendStdinPolicy(classifySendStdin(fd('file')), { explicitDash: false, hasAttachments: true }))
      .toBe('read-to-eof');
  });

  it('keeps reading an fd it cannot classify instead of dropping its body', () => {
    const shape = classifySendStdin({ isatty: () => false, fstat: () => { throw new Error('EBADF'); } });
    expect(sendStdinPolicy(shape, { explicitDash: false, hasAttachments: false })).toBe('read-to-eof');
  });
});

describe('readSendStdin', () => {
  it('gives up on a silent stream after the probe window and releases it', async () => {
    const stream = new PassThrough();
    const started = Date.now();
    const result = await readSendStdin('probe', { stream: () => stream, probeMs: 50 });
    expect(result.outcome).toBe('no-input');
    expect(result.bytes.length).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
    // Nothing left listening, so an open stdin cannot keep the process alive.
    expect(stream.listenerCount('data')).toBe(0);
    expect(stream.listenerCount('end')).toBe(0);
    expect(stream.isPaused()).toBe(true);
  });

  it('reads a body that started inside the window to EOF, however long it takes', async () => {
    const stream = new PassThrough();
    const pending = readSendStdin('probe', { stream: () => stream, probeMs: 50 });
    stream.write('first ');
    await sleep(150);
    stream.write('second');
    await sleep(50);
    stream.end();
    const result = await pending;
    expect(result.outcome).toBe('eof');
    expect(result.bytes.toString()).toBe('first second');
  });

  it('takes an empty pipe that is already closed as an empty body', async () => {
    const stream = new PassThrough();
    stream.end();
    const result = await readSendStdin('probe', { stream: () => stream, probeMs: 5_000 });
    expect(result).toEqual({ bytes: Buffer.alloc(0), outcome: 'eof' });
  });

  it('waits past the probe window when told to read to EOF', async () => {
    const stream = new PassThrough();
    const pending = readSendStdin('read-to-eof', { stream: () => stream, probeMs: 20 });
    await sleep(120);
    stream.end('late body');
    const result = await pending;
    expect(result.outcome).toBe('eof');
    expect(result.bytes.toString()).toBe('late body');
  });

  it('does not even open the stream when skipping', async () => {
    const result = await readSendStdin('skip', { stream: () => { throw new Error('stdin touched'); } });
    expect(result.outcome).toBe('skipped');
  });

  it('turns a read error into an empty body', async () => {
    const stream = new PassThrough();
    const pending = readSendStdin('read-to-eof', { stream: () => stream });
    stream.write('partial');
    stream.destroy(new Error('EIO'));
    const result = await pending;
    expect(result.bytes.length).toBe(0);
  });
});
