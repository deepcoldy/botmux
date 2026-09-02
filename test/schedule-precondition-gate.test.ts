import { describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ScheduledTask } from '../src/types.js';
import { executeScheduledTaskWithPrecondition } from '../src/services/schedule-precondition-gate.js';
import { logger } from '../src/utils/logger.js';

const task: ScheduledTask = {
  id: 'task-1',
  name: 'guarded',
  schedule: 'every 1h',
  parsed: { kind: 'interval', minutes: 60, display: 'every hour' },
  prompt: 'run model',
  workingDir: '/tmp/project',
  chatId: 'oc_chat',
  larkAppId: 'cli_app',
  enabled: true,
  createdAt: '2026-08-28T00:00:00.000Z',
};

describe('executeScheduledTaskWithPrecondition', () => {
  it('keeps legacy and unconfigured tasks on the original execution path', async () => {
    const execute = vi.fn(async () => undefined);
    const run = vi.fn();
    const readFile = vi.fn();

    await expect(executeScheduledTaskWithPrecondition(task, 'cli_app', execute, {
      resolve: () => ({ kind: 'none' }),
      readFile,
      run,
    })).resolves.toBe('executed');

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith();
    expect(readFile).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('bypasses file reads and Bash for an explicitly disabled definition', async () => {
    const execute = vi.fn(async () => undefined);
    const readFile = vi.fn();
    const run = vi.fn();

    await expect(executeScheduledTaskWithPrecondition(task, 'cli_app', execute, {
      resolve: () => ({
        kind: 'configured',
        enabled: false,
        source: { kind: 'file', path: 'guard.sh' },
      }),
      readFile,
      run,
    })).resolves.toBe('executed');

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith();
    expect(readFile).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('continues into the model path only after an inline Bash result passes', async () => {
    const execute = vi.fn(async () => undefined);
    const readFile = vi.fn();
    const run = vi.fn(async () => ({ decision: 'pass' as const }));

    await expect(executeScheduledTaskWithPrecondition(task, 'cli_app', execute, {
      resolve: () => ({
        kind: 'configured',
        enabled: true,
        source: { kind: 'inline', script: 'printf 1' },
      }),
      readFile,
      run,
    })).resolves.toBe('executed');

    expect(readFile).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith('printf 1', task.workingDir);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith();
    expect(run.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]);
  });

  it('forwards a passing file descriptor 3 prompt only to the execution callback', async () => {
    const execute = vi.fn(async (_additionalPrompt?: string) => undefined);
    const additionalPrompt = '本次补充上下文\n第二行\n';

    await expect(executeScheduledTaskWithPrecondition(task, 'cli_app', execute, {
      resolve: () => ({
        kind: 'configured',
        enabled: true,
        source: { kind: 'inline', script: 'printf 1; printf context >&3' },
      }),
      readFile: vi.fn(),
      run: async () => ({ decision: 'pass', additionalPrompt }),
    })).resolves.toBe('executed');

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(additionalPrompt);
  });

  it('reads a file source live before each Bash invocation', async () => {
    const execute = vi.fn(async () => undefined);
    const readFile = vi.fn()
      .mockReturnValueOnce('printf first')
      .mockReturnValueOnce('printf second');
    const run = vi.fn(async () => ({ decision: 'pass' as const }));
    const dependencies = {
      resolve: () => ({
        kind: 'configured' as const,
        enabled: true,
        source: { kind: 'file' as const, path: 'conditions/guard.sh' },
      }),
      readFile,
      run,
    };

    await expect(executeScheduledTaskWithPrecondition(
      task,
      'cli_app',
      execute,
      dependencies,
    )).resolves.toBe('executed');
    await expect(executeScheduledTaskWithPrecondition(
      task,
      'cli_app',
      execute,
      dependencies,
    )).resolves.toBe('executed');

    expect(readFile).toHaveBeenNthCalledWith(1, 'conditions/guard.sh', task.workingDir);
    expect(readFile).toHaveBeenNthCalledWith(2, 'conditions/guard.sh', task.workingDir);
    expect(run).toHaveBeenNthCalledWith(1, 'printf first', task.workingDir);
    expect(run).toHaveBeenNthCalledWith(2, 'printf second', task.workingDir);
    expect(readFile.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]);
    expect(run.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]);
  });

  it('expands ~ before resolving a relative file and running Bash', async () => {
    const homeTask: ScheduledTask = { ...task, workingDir: '~' };
    const execute = vi.fn(async () => undefined);
    const readFile = vi.fn(() => 'printf 1');
    const run = vi.fn(async () => ({ decision: 'pass' as const }));

    await expect(executeScheduledTaskWithPrecondition(homeTask, 'cli_app', execute, {
      resolve: () => ({
        kind: 'configured',
        enabled: true,
        source: { kind: 'file', path: 'conditions/guard.sh' },
      }),
      readFile,
      run,
    })).resolves.toBe('executed');

    expect(readFile).toHaveBeenCalledWith('conditions/guard.sh', homedir());
    expect(run).toHaveBeenCalledWith('printf 1', homedir());
    expect(homeTask.workingDir).toBe('~');
  });

  it('expands a ~/ directory to one absolute runner cwd without mutating the task', async () => {
    const nestedHomeTask: ScheduledTask = { ...task, workingDir: '~/projects/demo' };
    const execute = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({ decision: 'pass' as const }));

    await expect(executeScheduledTaskWithPrecondition(nestedHomeTask, 'cli_app', execute, {
      resolve: () => ({
        kind: 'configured',
        enabled: true,
        source: { kind: 'inline', script: 'printf 1' },
      }),
      readFile: vi.fn(),
      run,
    })).resolves.toBe('executed');

    expect(run).toHaveBeenCalledWith('printf 1', join(homedir(), 'projects/demo'));
    expect(nestedHomeTask.workingDir).toBe('~/projects/demo');
  });

  it('stops cleanly when Bash returns a false result', async () => {
    const execute = vi.fn(async () => undefined);

    await expect(executeScheduledTaskWithPrecondition(task, 'cli_app', execute, {
      resolve: () => ({
        kind: 'configured',
        enabled: true,
        source: { kind: 'inline', script: 'printf 0' },
      }),
      readFile: vi.fn(),
      run: async () => ({ decision: 'skip' as const }),
    })).resolves.toBe('skipped');

    expect(execute).not.toHaveBeenCalled();
  });

  it('does not enter the model path when sidecar resolution fails', async () => {
    const execute = vi.fn(async () => undefined);
    const error = new Error('precondition sidecar is invalid');

    await expect(executeScheduledTaskWithPrecondition(task, 'cli_app', execute, {
      resolve: () => { throw error; },
      readFile: vi.fn(),
      run: vi.fn(),
    })).rejects.toBe(error);

    expect(execute).not.toHaveBeenCalled();
  });

  it('does not invoke Bash or the model path when a live file read fails', async () => {
    const execute = vi.fn(async () => undefined);
    const run = vi.fn();
    const error = new Error('file read failed closed');

    await expect(executeScheduledTaskWithPrecondition(task, 'cli_app', execute, {
      resolve: () => ({
        kind: 'configured',
        enabled: true,
        source: { kind: 'file', path: 'guard.sh' },
      }),
      readFile: () => { throw error; },
      run,
    })).rejects.toBe(error);

    expect(run).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not enter the model path when Bash errors', async () => {
    const execute = vi.fn(async () => undefined);
    const error = new Error('bash failed');

    await expect(executeScheduledTaskWithPrecondition(task, 'cli_app', execute, {
      resolve: () => ({
        kind: 'configured',
        enabled: true,
        source: { kind: 'inline', script: 'exit 2' },
      }),
      readFile: vi.fn(),
      run: async () => { throw error; },
    })).rejects.toBe(error);

    expect(execute).not.toHaveBeenCalled();
  });

  it('reports each gate state without exposing Bash or prompt content', async () => {
    const observations: Array<{ precondition: string; additionalPrompt: boolean }> = [];
    const observe = (observation: { precondition: string; additionalPrompt: boolean }) => {
      observations.push(observation);
    };
    const execute = vi.fn(async () => undefined);

    await executeScheduledTaskWithPrecondition(task, 'cli_app', execute, {
      resolve: () => ({ kind: 'none' }),
      readFile: vi.fn(),
      run: vi.fn(),
    }, observe);
    await executeScheduledTaskWithPrecondition(task, 'cli_app', execute, {
      resolve: () => ({
        kind: 'configured',
        enabled: false,
        source: { kind: 'inline', script: 'private disabled source' },
      }),
      readFile: vi.fn(),
      run: vi.fn(),
    }, observe);
    await executeScheduledTaskWithPrecondition(task, 'cli_app', execute, {
      resolve: () => ({
        kind: 'configured',
        enabled: true,
        source: { kind: 'inline', script: 'private passing source' },
      }),
      readFile: vi.fn(),
      run: vi.fn(async () => ({ decision: 'pass', additionalPrompt: 'private prompt' })),
    }, observe);
    await executeScheduledTaskWithPrecondition(task, 'cli_app', execute, {
      resolve: () => ({
        kind: 'configured',
        enabled: true,
        source: { kind: 'inline', script: 'private skipping source' },
      }),
      readFile: vi.fn(),
      run: vi.fn(async () => ({ decision: 'skip' as const })),
    }, observe);
    await expect(executeScheduledTaskWithPrecondition(task, 'cli_app', execute, {
      resolve: () => ({
        kind: 'configured',
        enabled: true,
        source: { kind: 'inline', script: 'private failing source' },
      }),
      readFile: vi.fn(),
      run: vi.fn(async () => { throw new Error('private runner failure'); }),
    }, observe)).rejects.toThrow('private runner failure');

    expect(observations).toEqual([
      { precondition: 'none', additionalPrompt: false },
      { precondition: 'disabled', additionalPrompt: false },
      { precondition: 'passed', additionalPrompt: true },
      { precondition: 'skipped', additionalPrompt: false },
      { precondition: 'error', additionalPrompt: false },
    ]);
    expect(JSON.stringify(observations)).not.toContain('private');
  });

  it('keeps gate and model semantics unchanged when the observer throws', async () => {
    const execute = vi.fn(async () => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(executeScheduledTaskWithPrecondition(task, 'cli_app', execute, {
      resolve: () => ({
        kind: 'configured',
        enabled: true,
        source: { kind: 'inline', script: 'printf 1' },
      }),
      readFile: vi.fn(),
      run: vi.fn(async () => ({ decision: 'pass' as const })),
    }, () => { throw new Error('observer unavailable'); })).resolves.toBe('executed');

    expect(execute).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Precondition observer failed'));
    warn.mockRestore();
  });
});
