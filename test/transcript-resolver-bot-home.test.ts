import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Regression: sandboxed (CLI-data-redirected) bots run Claude with
// CLAUDE_CONFIG_DIR=<botmuxHome>/bots/<appId>/claude, so their transcripts never
// appear under the global ~/.claude. Daemon-side readers (dashboard token
// column, usage ledger, insight) resolved ONLY against the global dir → token
// usage silently showed "-" for every sandboxed bot. The resolver must fall
// back to the BOT_HOME dir when the query carries the owning bot's app id.

// Point homedir at a controllable fake so the "global" ~/.claude is test-owned.
// vi.hoisted: the mock factory runs at import time, before module-level lets.
const fake = vi.hoisted(() => ({ home: '/nonexistent-home' }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => fake.home,
}));

import { resolveSessionTranscriptPath } from '../src/services/transcript-resolver.js';

const APP_ID = 'cli_testbot0001';

function projectKey(cwd: string): string {
  return realpathSync(cwd).replace(/[^A-Za-z0-9-]/g, '-');
}

describe('resolveSessionTranscriptPath — sandboxed-bot BOT_HOME fallback', () => {
  const trash: string[] = [];
  let base: string;
  let cwd: string;
  let savedSessionDataDir: string | undefined;

  beforeEach(() => {
    savedSessionDataDir = process.env.SESSION_DATA_DIR;
    base = mkdtempSync(join(tmpdir(), 'botmux-bot-home-'));
    trash.push(base);
    fake.home = join(base, 'home');
    cwd = join(base, 'work');
    mkdirSync(cwd, { recursive: true });
    // botmuxHome = <base>/.botmux, exactly like ~/.botmux with data dir inside.
    process.env.SESSION_DATA_DIR = join(base, '.botmux', 'data');
  });

  afterEach(() => {
    if (savedSessionDataDir === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = savedSessionDataDir;
    for (const d of trash.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function writeBotHomeTranscript(sid: string): string {
    const dir = join(base, '.botmux', 'bots', APP_ID, 'claude', 'projects', projectKey(cwd));
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${sid}.jsonl`);
    writeFileSync(p, '{}');
    return p;
  }

  function writeGlobalTranscript(sid: string): string {
    const dir = join(fake.home, '.claude', 'projects', projectKey(cwd));
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${sid}.jsonl`);
    writeFileSync(p, '{}');
    return p;
  }

  it('falls back to <botmuxHome>/bots/<appId>/claude when the global dir misses', () => {
    const expected = writeBotHomeTranscript('sb-1');
    const resolved = resolveSessionTranscriptPath({
      cliId: 'claude-code', sessionId: 'sb-1', cwd, larkAppId: APP_ID,
    });
    expect(resolved).toEqual({ path: expected, kind: 'claude' });
  });

  it('resolves the global dir when only it has the transcript (non-redirected bot)', () => {
    const global = writeGlobalTranscript('sb-2');
    const resolved = resolveSessionTranscriptPath({
      cliId: 'claude-code', sessionId: 'sb-2', cwd, larkAppId: APP_ID,
    });
    expect(resolved?.path).toBe(global);
  });

  // A persistent session that straddles a sandbox flip keeps its session id but
  // moves data dirs — the stale copy stops growing, the live one stays fresh.
  it('picks the newer file when both dirs have the transcript (sandbox flipped ON)', () => {
    const global = writeGlobalTranscript('sb-flip');
    const botHome = writeBotHomeTranscript('sb-flip');
    utimesSync(global, new Date('2026-01-01'), new Date('2026-01-01'));
    utimesSync(botHome, new Date('2026-01-02'), new Date('2026-01-02'));
    expect(resolveSessionTranscriptPath({
      cliId: 'claude-code', sessionId: 'sb-flip', cwd, larkAppId: APP_ID,
    })?.path).toBe(botHome);
  });

  it('picks the newer file when both dirs have the transcript (sandbox flipped OFF)', () => {
    const global = writeGlobalTranscript('sb-flop');
    const botHome = writeBotHomeTranscript('sb-flop');
    utimesSync(global, new Date('2026-01-02'), new Date('2026-01-02'));
    utimesSync(botHome, new Date('2026-01-01'), new Date('2026-01-01'));
    expect(resolveSessionTranscriptPath({
      cliId: 'claude-code', sessionId: 'sb-flop', cwd, larkAppId: APP_ID,
    })?.path).toBe(global);
  });

  it('keeps the global path on an exact mtime tie (byte-identical copy)', () => {
    const global = writeGlobalTranscript('sb-tie');
    const botHome = writeBotHomeTranscript('sb-tie');
    const t = new Date('2026-01-01');
    utimesSync(global, t, t);
    utimesSync(botHome, t, t);
    expect(resolveSessionTranscriptPath({
      cliId: 'claude-code', sessionId: 'sb-tie', cwd, larkAppId: APP_ID,
    })?.path).toBe(global);
  });

  it('returns null without larkAppId (no fallback target)', () => {
    writeBotHomeTranscript('sb-3');
    expect(resolveSessionTranscriptPath({ cliId: 'claude-code', sessionId: 'sb-3', cwd })).toBeNull();
  });

  it('returns null without SESSION_DATA_DIR (no redirect ever happened)', () => {
    writeBotHomeTranscript('sb-4');
    delete process.env.SESSION_DATA_DIR;
    expect(resolveSessionTranscriptPath({
      cliId: 'claude-code', sessionId: 'sb-4', cwd, larkAppId: APP_ID,
    })).toBeNull();
  });

  it('never builds a path from an unsafe app id (returns null instead of throwing)', () => {
    writeBotHomeTranscript('sb-5');
    for (const evil of ['../evil', 'a/b', '..', '']) {
      expect(resolveSessionTranscriptPath({
        cliId: 'claude-code', sessionId: 'sb-5', cwd, larkAppId: evil,
      })).toBeNull();
    }
  });

  it('applies the same fallback for aiden claude-format transcripts', () => {
    const expected = writeBotHomeTranscript('sb-6');
    const resolved = resolveSessionTranscriptPath({
      cliId: 'aiden', sessionId: 'sb-6', cwd, larkAppId: APP_ID,
    });
    expect(resolved).toEqual({ path: expected, kind: 'claude' });
  });
});
