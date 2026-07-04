import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aidenWorkspaceKey, findAidenLatestCheckpointByBotmuxSessionId, findAidenLatestCheckpointBySessionId } from '../src/services/aiden-checkpoints.js';

function writeCheckpoint(root: string, cwd: string, sessionId: string, checkpointId: string, body: unknown): string {
  const sessionDir = join(root, aidenWorkspaceKey(cwd), sessionId);
  const checkpointPath = join(sessionDir, `${checkpointId}.json`);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'latest.json'), JSON.stringify({ latest: checkpointId }));
  writeFileSync(checkpointPath, JSON.stringify(body));
  return checkpointPath;
}

describe('aidenWorkspaceKey', () => {
  it('matches Aiden checkpoint workspace hashing', () => {
    expect(aidenWorkspaceKey('/Users/bytedance/git/botmux')).toBe('76aea787c17c');
  });
});

describe('findAidenLatestCheckpointBySessionId', () => {
  it('resolves latest.json to the pointed checkpoint file', () => {
    const root = mkdtempSync(join(tmpdir(), 'aiden-checkpoints-'));
    const sessionDir = join(root, 'workspace-hash', 'aiden-session-id');
    const checkpointPath = join(sessionDir, 'checkpoint-1.json');
    try {
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'latest.json'), JSON.stringify({ latest: 'checkpoint-1' }));
      writeFileSync(checkpointPath, JSON.stringify({ checkpoint: { channel_values: { messages: [] } } }));

      expect(findAidenLatestCheckpointBySessionId('aiden-session-id', root)).toBe(checkpointPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns undefined when the session checkpoint is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'aiden-checkpoints-'));
    try {
      expect(findAidenLatestCheckpointBySessionId('missing-session', root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back by matching botmux session id inside the latest checkpoint', () => {
    const root = mkdtempSync(join(tmpdir(), 'aiden-checkpoints-'));
    const sessionDir = join(root, 'workspace-hash', 'native-aiden-session');
    const checkpointPath = join(sessionDir, 'checkpoint-1.json');
    try {
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'latest.json'), JSON.stringify({ latest: 'checkpoint-1' }));
      writeFileSync(checkpointPath, JSON.stringify({
        checkpoint: {
          channel_values: {
            messages: [
              { type: 'human', content: '<session_id>botmux-session-id</session_id>' },
            ],
          },
        },
      }));

      expect(findAidenLatestCheckpointByBotmuxSessionId('botmux-session-id', root)).toBe(checkpointPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scopes botmux session id fallback to cwd when provided', () => {
    const root = mkdtempSync(join(tmpdir(), 'aiden-checkpoints-'));
    const botmuxSessionId = 'botmux-session-id';
    const currentCwd = '/workspace/current';
    const otherCwd = '/workspace/other';
    try {
      const currentCheckpoint = writeCheckpoint(root, currentCwd, 'current-native-session', 'checkpoint-1', {
        checkpoint: {
          channel_values: {
            messages: [
              { type: 'human', content: `<session_id>${botmuxSessionId}</session_id>` },
            ],
          },
        },
      });
      const otherCheckpoint = writeCheckpoint(root, otherCwd, 'other-native-session', 'checkpoint-1', {
        checkpoint: {
          channel_values: {
            messages: [
              { type: 'human', content: `<session_id>${botmuxSessionId}</session_id>` },
            ],
          },
        },
      });
      utimesSync(currentCheckpoint, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
      utimesSync(otherCheckpoint, new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));

      expect(findAidenLatestCheckpointByBotmuxSessionId(botmuxSessionId, root, currentCwd)).toBe(currentCheckpoint);
      expect(findAidenLatestCheckpointByBotmuxSessionId(botmuxSessionId, root)).toBe(otherCheckpoint);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
