import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runSchedulePrecondition,
  SchedulePreconditionError,
} from '../src/services/schedule-precondition-runner.js';

describe('runSchedulePrecondition', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'botmux-schedule-precondition-'));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('passes only for exit 0 with trimmed stdout exactly equal to 1', async () => {
    writeFileSync(join(workingDir, 'ready'), 'yes');

    await expect(runSchedulePrecondition(
      'test -f ready && printf "  1\\n"',
      workingDir,
    )).resolves.toEqual({ decision: 'pass' });
  });

  it('captures a UTF-8 per-run prompt from file descriptor 3 without trimming it', async () => {
    await expect(runSchedulePrecondition(
      'printf 1; printf "本次补充上下文\\n第二行\\n" >&3',
      workingDir,
    )).resolves.toEqual({
      decision: 'pass',
      additionalPrompt: '本次补充上下文\n第二行\n',
    });
  });

  it.each([
    ['zero', 'printf 0'],
    ['empty', ':'],
    ['additional text', 'printf "1\\nextra"'],
  ])('returns skip for a clean %s result', async (_label, script) => {
    await expect(runSchedulePrecondition(script, workingDir)).resolves.toEqual({
      decision: 'skip',
    });
  });

  it('discards file descriptor 3 output when stdout does not pass the gate', async () => {
    await expect(runSchedulePrecondition(
      'printf 0; printf "must not be forwarded" >&3',
      workingDir,
    )).resolves.toEqual({ decision: 'skip' });
  });

  it('rejects a non-zero exit without persisting potentially-sensitive output', async () => {
    const result = runSchedulePrecondition(
      'printf "dependency is unavailable\\n" >&2; printf "private fd3 context" >&3; exit 7',
      workingDir,
    );

    await expect(result).rejects.toMatchObject({
      name: 'SchedulePreconditionError',
      code: 'non_zero_exit',
      message: expect.stringContaining('exit code 7'),
    });
    await expect(result).rejects.not.toThrow('dependency is unavailable');
    await expect(result).rejects.not.toThrow('private fd3 context');
  });

  it('kills and rejects a script that exceeds the timeout', async () => {
    const startedAt = Date.now();
    const result = runSchedulePrecondition('sleep 30', workingDir, { timeoutMs: 50 });

    await expect(result).rejects.toMatchObject({
      name: 'SchedulePreconditionError',
      code: 'timed_out',
      message: expect.stringContaining('50ms'),
    });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('kills and rejects when combined output exceeds the byte limit', async () => {
    const result = runSchedulePrecondition(
      'printf 123456; printf abcdef >&2; sleep 30',
      workingDir,
      { maxOutputBytes: 10 },
    );

    await expect(result).rejects.toMatchObject({
      name: 'SchedulePreconditionError',
      code: 'output_limit_exceeded',
      message: expect.stringContaining('10-byte output limit'),
    });
  });

  it('enforces an independent byte limit on file descriptor 3 output', async () => {
    const result = runSchedulePrecondition(
      'printf 1; printf "sensitive prompt" >&3; sleep 30',
      workingDir,
      { maxOutputBytes: 1, maxPromptBytes: 8 },
    );

    await expect(result).rejects.toMatchObject({
      name: 'SchedulePreconditionError',
      code: 'output_limit_exceeded',
      message: expect.stringContaining('8-byte prompt output limit'),
    });
    await expect(result).rejects.not.toThrow('sensitive prompt');
  });

  it('rejects invalid UTF-8 prompt output only after stdout passes', async () => {
    const invalidByteScript = "printf 1; printf '\\377' >&3";

    await expect(runSchedulePrecondition(invalidByteScript, workingDir)).rejects.toMatchObject({
      name: 'SchedulePreconditionError',
      code: 'invalid_prompt_encoding',
      message: 'Scheduled task precondition prompt output must be valid UTF-8',
    });
    await expect(runSchedulePrecondition(
      `printf 0; printf '\\377' >&3`,
      workingDir,
    )).resolves.toEqual({ decision: 'skip' });
  });

  it('reports a typed spawn error without exposing the working directory', async () => {
    const missing = join(workingDir, 'missing');
    const result = runSchedulePrecondition('printf 1', missing);

    await expect(result).rejects.toMatchObject({
      name: 'SchedulePreconditionError',
      code: 'spawn_failed',
      message: 'Scheduled task precondition could not start /bin/bash',
    });
    await expect(result).rejects.not.toThrow(missing);
  });

  it('validates execution budgets before spawning Bash', async () => {
    expect(() => runSchedulePrecondition('printf 1', workingDir, { timeoutMs: 0 }))
      .toThrow('timeoutMs must be a positive integer');
    expect(() => runSchedulePrecondition('printf 1', workingDir, { maxOutputBytes: 0 }))
      .toThrow('maxOutputBytes must be a positive integer');
    expect(() => runSchedulePrecondition('printf 1', workingDir, { maxPromptBytes: 0 }))
      .toThrow('maxPromptBytes must be a positive integer');
  });

  it('exposes typed operational failures to the scheduler integration', async () => {
    try {
      await runSchedulePrecondition('exit 2', workingDir);
      throw new Error('expected precondition failure');
    } catch (error) {
      expect(error).toBeInstanceOf(SchedulePreconditionError);
      expect((error as SchedulePreconditionError).code).toBe('non_zero_exit');
    }
  });
});
