import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isManagedAgentHostCommandContext } from '../src/platform/host-command-context.js';

const roots: string[] = [];

function tempDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-host-command-context-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('managed agent host-command guard', () => {
  it('recognizes detached session and workflow environment hints', () => {
    const dataDir = tempDataDir();
    expect(isManagedAgentHostCommandContext({
      dataDir,
      env: { BOTMUX_SESSION_ID: 'session-1' },
    })).toBe(true);
    expect(isManagedAgentHostCommandContext({
      dataDir,
      env: { BOTMUX_WORKFLOW: '1' },
    })).toBe(true);
    expect(isManagedAgentHostCommandContext({ dataDir, env: {} })).toBe(false);
  });

  it('recognizes a daemon PID marker even when session env was scrubbed', () => {
    const dataDir = tempDataDir();
    const markers = join(dataDir, '.botmux-cli-pids');
    mkdirSync(markers, { recursive: true });
    writeFileSync(join(markers, String(process.pid)), 'session-from-marker');

    expect(isManagedAgentHostCommandContext({
      dataDir,
      env: {},
      startPid: process.pid,
    })).toBe(true);
  });
});
