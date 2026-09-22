import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { decideTmuxReattach, tmuxPaneHasTargetCli } from '../src/adapters/backend/tmux-reattach-decision.js';

describe('workflow tmux reattach proof', () => {
  it('keeps ordinary tmux reattach behavior even without Agent proof', () => {
    expect(decideTmuxReattach({
      workflowWorker: false,
      sessionExists: true,
      targetCliAlive: false,
    })).toEqual({ reattach: true });
  });

  it('reattaches a workflow worker when its target Agent CLI is alive', () => {
    expect(decideTmuxReattach({
      workflowWorker: true,
      sessionExists: true,
      targetCliAlive: true,
    })).toEqual({ reattach: true });
  });

  it('cleans an existing workflow session when the target Agent is not proven alive', () => {
    expect(decideTmuxReattach({
      workflowWorker: true,
      sessionExists: true,
      targetCliAlive: false,
    })).toEqual({
      reattach: false,
      cleanupStale: true,
      reason: 'workflow tmux pane has no live target Agent CLI',
    });
  });

  it('cold-spawns without cleanup when no session exists', () => {
    expect(decideTmuxReattach({
      workflowWorker: true,
      sessionExists: false,
      targetCliAlive: false,
    })).toEqual({ reattach: false, cleanupStale: false });
  });
});

describe('workflow tmux target CLI proof', () => {
  it('rejects missing pane processes', () => {
    expect(tmuxPaneHasTargetCli(null, 'codex')).toBe(false);
  });

  it('finds the configured Agent beneath a shell-owned real tmux pane and rejects a shell husk', () => {
    const socket = `botmux-reattach-${process.pid}`;
    const fixtureDir = join(process.cwd(), '.test-tmp', socket);
    mkdirSync(fixtureDir, { recursive: true });
    symlinkSync('/usr/bin/sleep', join(fixtureDir, 'codex'));
    const tmux = (...args: string[]) => execFileSync('tmux', ['-L', socket, ...args], {
      encoding: 'utf8',
      env: { ...process.env, TMUX: undefined },
    }).trim();
    try {
      tmux('new-session', '-d', '-s', 'healthy', `bash -c '${fixtureDir}/codex 20 & wait'`);
      tmux('new-session', '-d', '-s', 'stale', 'bash');
      const healthyPanePid = Number(tmux('display-message', '-p', '-t', 'healthy', '#{pane_pid}'));
      const stalePanePid = Number(tmux('display-message', '-p', '-t', 'stale', '#{pane_pid}'));

      expect(tmuxPaneHasTargetCli(healthyPanePid, 'codex')).toBe(true);
      expect(tmuxPaneHasTargetCli(stalePanePid, 'codex')).toBe(false);
    } finally {
      try { tmux('kill-server'); } catch { /* already gone */ }
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
