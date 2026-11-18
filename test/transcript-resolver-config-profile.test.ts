import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A session launched on a Claude config profile (Session.cliConfigDir) wrote its
// transcript under that profile; usage / insight readers must look there, and
// only for the bot that owns the session.
const sessions = vi.hoisted(() => new Map<string, { larkAppId: string; cliConfigDir?: string; adoptedFrom?: unknown }>());
vi.mock('../src/services/session-store.js', () => ({
  getSession: (id: string) => sessions.get(id),
}));

import {
  __resetTranscriptResolverCacheForTest,
  resolveSessionTranscriptPath,
  resolveSessionTranscriptPaths,
} from '../src/services/transcript-resolver.js';

it('excludes a falsely named continuation with a foreign native session header', () => {
  const root = mkdtempSync(join(tmpdir(), 'botmux-rollout-identity-'));
  const sid = '11111111-1111-1111-1111-111111111111';
  try {
    vi.stubEnv('CODEX_HOME', root);
    const day = join(root, 'sessions', '2026', '01', '01');
    mkdirSync(day, { recursive: true });
    const write = (hour: string, id: string) => {
      const path = join(day, `rollout-2026-01-01T${hour}-00-00-${sid}.jsonl`);
      writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n');
      return path;
    };
    const first = write('10', sid);
    write('11', '22222222-2222-2222-2222-222222222222');
    const last = write('12', sid);
    expect(resolveSessionTranscriptPaths({ cliId: 'codex', sessionId: 'recovery', cliSessionId: sid }))
      .toEqual([first, last]);
  } finally {
    vi.unstubAllEnvs();
    __resetTranscriptResolverCacheForTest();
    rmSync(root, { recursive: true, force: true });
  }
});

describe('resolveSessionTranscriptPath — Claude config profile', () => {
  let base: string;
  let cwd: string;
  let profile: string;

  beforeEach(() => {
    __resetTranscriptResolverCacheForTest();
    base = mkdtempSync(join(tmpdir(), 'botmux-profile-'));
    cwd = join(base, 'work');
    profile = join(base, 'claude-api');
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    sessions.clear();
    rmSync(base, { recursive: true, force: true });
  });

  function writeProfileTranscript(sid: string): string {
    const dir = join(profile, 'projects', realpathSync(cwd).replace(/[^A-Za-z0-9-]/g, '-'));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${sid}.jsonl`);
    writeFileSync(path, '{}');
    return path;
  }

  it('reads the transcript from the session-frozen profile dir', () => {
    const expected = writeProfileTranscript('p-1');
    sessions.set('p-1', { larkAppId: 'cli_owner', cliConfigDir: profile });
    expect(resolveSessionTranscriptPath({ cliId: 'claude-code', sessionId: 'p-1', cwd, larkAppId: 'cli_owner' }))
      .toEqual({ path: expected, kind: 'claude' });
  });

  it('ignores a profile an older build froze onto an adopted session', () => {
    writeProfileTranscript('p-3');
    sessions.set('p-3', { larkAppId: 'cli_owner', cliConfigDir: profile, adoptedFrom: { source: 'tmux', tmuxTarget: 'x', cwd } });
    expect(resolveSessionTranscriptPath({ cliId: 'claude-code', sessionId: 'p-3', cwd, larkAppId: 'cli_owner' }))
      .toBeNull();
  });

  it('ignores the profile when the query is for another bot', () => {
    writeProfileTranscript('p-2');
    sessions.set('p-2', { larkAppId: 'cli_owner', cliConfigDir: profile });
    expect(resolveSessionTranscriptPath({ cliId: 'claude-code', sessionId: 'p-2', cwd, larkAppId: 'cli_other' }))
      .toBeNull();
  });
});
