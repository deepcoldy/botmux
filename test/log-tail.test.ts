import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatLogLine,
  lastLinesOfChunk,
  LogFileFollower,
  type LogTailSource,
} from '../src/cli/log-tail.js';

describe('lastLinesOfChunk', () => {
  it('takes the last N complete lines, ignoring the trailing newline', () => {
    expect(lastLinesOfChunk('a\nb\nc\n', 2)).toEqual(['b', 'c']);
    expect(lastLinesOfChunk('a\nb\nc', 2)).toEqual(['b', 'c']);
    expect(lastLinesOfChunk('a\n', 5)).toEqual(['a']);
    expect(lastLinesOfChunk('', 3)).toEqual([]);
    expect(lastLinesOfChunk('a\nb', 0)).toEqual([]);
  });
});

describe('LogFileFollower', () => {
  let dir: string;
  let out: string[];

  const source = (label: string, stream: 'out' | 'err', file: string): LogTailSource =>
    ({ label, stream, file });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-log-tail-'));
    out = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const follower = (sources: LogTailSource[]) =>
    new LogFileFollower({ sources, writeLine: line => out.push(line) });

  it('initial tail prints only the last N lines with labels', () => {
    const file = join(dir, 'daemon-0-out.log');
    writeFileSync(file, 'l1\nl2\nl3\nl4\n');
    const f = follower([source('botmux-0', 'out', file)]);
    f.printInitialTail(2);
    expect(out).toEqual(['botmux-0 | l3', 'botmux-0 | l4']);
  });

  it('follows appends and keeps partial lines until completed', () => {
    const file = join(dir, 'daemon-0-out.log');
    writeFileSync(file, 'old\n');
    const f = follower([source('botmux-0', 'out', file)]);
    f.printInitialTail(10);
    out.length = 0;

    appendFileSync(file, 'new-1\npart');
    f.pollOnce();
    expect(out).toEqual(['botmux-0 | new-1']);

    appendFileSync(file, 'ial\n');
    f.pollOnce();
    expect(out).toEqual(['botmux-0 | new-1', 'botmux-0 | partial']);
  });

  it('in-place truncation (pm2 flush) resets and reads the new content', () => {
    const file = join(dir, 'daemon-0-out.log');
    writeFileSync(file, 'before-1\nbefore-2\n');
    const f = follower([source('botmux-0', 'out', file)]);
    f.printInitialTail(10);
    out.length = 0;

    writeFileSync(file, 'after\n'); // shorter than the old offset
    f.pollOnce();
    expect(out).toEqual(['botmux-0 | after']);
  });

  it('a file that appears after start is picked up from its beginning', () => {
    // The fleet-stopped case: `botmux logs` keeps running while a later
    // `botmux start` creates the log files.
    const file = join(dir, 'daemon-1-out.log');
    const f = follower([source('botmux-1', 'out', file)]);
    f.printInitialTail(10);
    expect(out).toEqual([]);

    f.pollOnce(); // still absent
    writeFileSync(file, 'born\n');
    f.pollOnce();
    expect(out).toEqual(['botmux-1 | born']);
  });

  it('a file that disappears and returns is re-read from the start', () => {
    const file = join(dir, 'daemon-0-out.log');
    writeFileSync(file, 'gen1\n');
    const f = follower([source('botmux-0', 'out', file)]);
    f.printInitialTail(10);
    out.length = 0;

    unlinkSync(file);
    f.pollOnce();
    writeFileSync(file, 'gen2\n');
    f.pollOnce();
    expect(out).toEqual(['botmux-0 | gen2']);
  });

  it('an unterminated trailing line at startup is carried, not emitted, and completes as ONE line', () => {
    // The split-line bug this pins: initial tail must not print "abc" as a
    // finished line when the file ends without a newline — the later "def\n"
    // append belongs to the SAME line.
    const file = join(dir, 'daemon-0-out.log');
    writeFileSync(file, 'done-1\nabc');
    const f = follower([source('botmux-0', 'out', file)]);
    f.printInitialTail(10);
    expect(out).toEqual(['botmux-0 | done-1']);

    appendFileSync(file, 'def\n');
    f.pollOnce();
    expect(out).toEqual(['botmux-0 | done-1', 'botmux-0 | abcdef']);
  });

  it('atomic rotation (rename + recreate, new size ≥ old offset) is detected by file identity', () => {
    // The skipped-prefix bug this pins: with offset-only state, a same-path
    // replacement whose size already exceeds the old offset passes the
    // size<offset check and gets read from the middle ("ND-MORE"). The
    // dev+ino generation check must reset to the top of the new file — with
    // no ENOENT poll in between (true atomic replace).
    const file = join(dir, 'daemon-0-out.log');
    writeFileSync(file, '1234567890\n');
    const f = follower([source('botmux-0', 'out', file)]);
    f.printInitialTail(10);
    out.length = 0;

    renameSync(file, join(dir, 'daemon-0-out.log.old'));
    writeFileSync(file, 'NEW-START-AND-MORE\n');
    f.pollOnce();
    expect(out).toEqual(['botmux-0 | NEW-START-AND-MORE']);
  });

  it('honors --lines larger than the initial 64KiB window', () => {
    const file = join(dir, 'daemon-0-out.log');
    // ~130KiB of 26-byte lines so the last 3 lines sit beyond one window
    // boundary and the window must grow to stay line-aligned.
    const line = (i: number) => `line-${String(i).padStart(6, '0')}-xxxxxxxxxx`;
    const total = 5200;
    writeFileSync(file, Array.from({ length: total }, (_, i) => line(i)).join('\n') + '\n');
    const f = follower([source('botmux-0', 'out', file)]);
    f.printInitialTail(3);
    expect(out).toEqual([
      `botmux-0 | ${line(total - 3)}`,
      `botmux-0 | ${line(total - 2)}`,
      `botmux-0 | ${line(total - 1)}`,
    ]);
  });

  it('error-stream lines carry the (err) marker', () => {
    const file = join(dir, 'daemon-0-error.log');
    writeFileSync(file, 'boom\n');
    const f = follower([source('botmux-0', 'err', file)]);
    f.printInitialTail(1);
    expect(out).toEqual(['botmux-0 (err) | boom']);
    expect(formatLogLine(source('x', 'err', file), 'y')).toBe('x (err) | y');
  });
});
