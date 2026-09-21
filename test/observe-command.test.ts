import { afterEach, describe, expect, it, vi } from 'vitest';
import { runObserveCommand } from '../src/cli/observe-command.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('botmux observe arguments', () => {
  it.each([
    ['--session-id', 'session-1'],
    ['--lark-app-id', 'cli_app_1'],
    ['--app', 'cli_app_1'],
    ['--jsonl'],
  ])('rejects removed argument %s', async (...args) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(runObserveCommand(args)).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`未知参数：${args[0]}`));
  });

  it('documents only the canonical JSON interface', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runObserveCommand(['--help'])).resolves.toBe(0);
    const help = String(stdout.mock.calls[0]?.[0]);
    expect(help).toContain('botmux observe --session <id>');
    expect(help).toContain('botmux observe --lark-app <appId>');
    expect(help).not.toContain('--jsonl');
    expect(help).not.toContain('--session-id');
    expect(help).not.toContain('--lark-app-id');
  });
});
