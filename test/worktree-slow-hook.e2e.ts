/** Real Git checkout hook longer than the default budget. Kept in the e2e
 * project so ordinary unit runs do not pay the minute-long hook delay. */
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveWorktreeCreateTimeoutMs } from '../src/config.js';

let tempRoot: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

it('creates an automatic session worktree when the hook exceeds the default but fits the configured budget', async () => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-slow-hook-')));
  const repo = join(tempRoot, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
  git('init', '-b', 'master');
  git('commit', '--allow-empty', '-m', 'init');
  const defaultBudget = resolveWorktreeCreateTimeoutMs({});
  const hookSeconds = Math.ceil(defaultBudget / 1000) + 1;
  vi.stubEnv('BOTMUX_WORKTREE_CREATE_TIMEOUT_MS', String(defaultBudget + 30_000));
  vi.stubEnv('BOTMUX_WORKTREE_SLUG_AI_ENABLED', 'false');
  vi.stubEnv('BOTMUX_SANDBOX', undefined);
  writeFileSync(join(repo, '.git/hooks/post-checkout'), `#!/bin/sh\nsleep ${hookSeconds}\ntouch hook-completed\n`, { mode: 0o755 });
  const botsPath = join(tempRoot, 'bots.json');
  writeFileSync(botsPath, JSON.stringify([{
    larkAppId: 'slow_hook_bot', larkAppSecret: 'unused', cliId: 'codex',
    backendType: 'tmux', sandbox: 'oncall', defaultWorkingDir: repo,
    defaultWorkingDirAutoWorktree: true,
  }]));
  vi.stubEnv('BOTS_CONFIG', botsPath);
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  registry.loadBotConfigs().forEach(bot => registry.registerBot(bot));
  const { maybeCreateDefaultWorktree } = await import('../src/services/default-worktree.js');
  const notices: string[] = [];
  const result = await maybeCreateDefaultWorktree('slow_hook_bot', repo, {
    isBotDefaultDir: true, locale: 'zh', notify: message => { notices.push(message); },
    sandboxSnapshot: { sandbox: 'oncall', cliId: 'codex', backendType: 'tmux' },
  });

  expect(result.dir).not.toBe(repo);
  expect(existsSync(join(result.dir, 'hook-completed'))).toBe(true);
  expect(notices).toHaveLength(2);
  expect(execFileSync('git', ['branch', '--show-current'], { cwd: result.dir, encoding: 'utf8' }).trim()).toMatch(/^wt\//);
}, 100_000);
