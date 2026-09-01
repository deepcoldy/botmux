import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Regression: sandboxed (CLI-data-redirected) bots run Claude with
// CLAUDE_CONFIG_DIR=<botmuxHome>/bots/<appId>/claude, so their transcripts never
// appear under the global ~/.claude. Daemon-side readers (dashboard token
// column, usage ledger, insight) resolved ONLY against the global dir → token
// usage silently showed "-" for every sandboxed bot. The resolver must fall
// back to the BOT_HOME dir when the query carries the owning bot's app id.

// Point homedir at a controllable fake so the "global" ~/.claude is test-owned.
//
// The mutable home lives on the MOCK ITSELF (a `vi.fn` whose return value the tests
// reset), and is reached below via the mocked `homedir`. Three constraints force this:
//   · `vi.hoisted` (the original) is a vitest-only TRANSFORM — no `bun test` equivalent.
//   · A module-level `const fake = {…}` read from the arrow is NOT enough either: the
//     module under test calls `homedir()` while it is being imported, i.e. still inside
//     vitest's hoisted phase → "Cannot access 'fake' before initialization" (measured).
//     So the state has to be created by the factory, not merely read by it.
//   · `require`, not the factory's `importOriginal` argument: that argument is vitest-only
//     (bun passes nothing, so awaiting it throws). The real module is spread in because
//     bun links named exports for real.
vi.mock('node:os', () => {
  const actual = require('node:os') as typeof import('node:os');
  return { ...actual, homedir: vi.fn(() => '/nonexistent-home') };
});

import { homedir } from 'node:os';

/** The controllable fake home, backed by the mocked `homedir`. */
const fake = {
  get home(): string { return homedir(); },
  set home(value: string) { vi.mocked(homedir).mockReturnValue(value); },
};

import {
  __resetTranscriptResolverCacheForTest,
  resolveSessionTranscriptPath,
  cliSupportsNativeUsage,
} from '../src/services/transcript-resolver.js';

const APP_ID = 'cli_testbot0001';

function projectKey(cwd: string): string {
  return realpathSync(cwd).replace(/[^A-Za-z0-9-]/g, '-');
}

describe('resolveSessionTranscriptPath — sandboxed-bot BOT_HOME fallback', () => {
  const trash: string[] = [];
  let base: string;
  let cwd: string;
  let savedSessionDataDir: string | undefined;
  let savedCodexHome: string | undefined;

  beforeEach(() => {
    savedSessionDataDir = process.env.SESSION_DATA_DIR;
    savedCodexHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    __resetTranscriptResolverCacheForTest();
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
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
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

  function writeCodexRollout(codexHome: string, sid: string): string {
    const dir = join(codexHome, 'sessions', '2026', '07', '29');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `rollout-2026-07-29T12-00-00-${sid}.jsonl`);
    writeFileSync(p, '{}');
    return p;
  }

  function writeCodexHistory(codexHome: string, botmuxSid: string, codexSid: string): void {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'history.jsonl'), JSON.stringify({
      session_id: codexSid,
      text: `resume <session_id>${botmuxSid}</session_id>`,
    }) + '\n');
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

  it('resolves a Codex rollout under the sandboxed bot CODEX_HOME', () => {
    const sid = '019dd80d-d922-7a11-8339-0208d8c5b4ec';
    const expected = writeCodexRollout(
      join(base, '.botmux', 'bots', APP_ID, 'codex'),
      sid,
    );

    expect(resolveSessionTranscriptPath({
      cliId: 'codex',
      sessionId: 'botmux-codex-1',
      cliSessionId: sid,
      larkAppId: APP_ID,
      fresh: true,
    })).toEqual({ path: expected, kind: 'codex' });
  });

  it('maps a botmux session through sandboxed Codex history when cliSessionId is absent', () => {
    const botmuxSid = 'botmux-codex-2';
    const codexSid = '019dd80d-d922-7a11-8339-0208d8c5b4ed';
    const codexHome = join(base, '.botmux', 'bots', APP_ID, 'codex');
    writeCodexHistory(codexHome, botmuxSid, codexSid);
    const expected = writeCodexRollout(codexHome, codexSid);

    expect(resolveSessionTranscriptPath({
      cliId: 'codex',
      sessionId: botmuxSid,
      larkAppId: APP_ID,
      fresh: true,
    })).toEqual({ path: expected, kind: 'codex' });
  });

  it('picks the newer Codex rollout when a session straddles a sandbox flip', () => {
    const sid = '019dd80d-d922-7a11-8339-0208d8c5b4ee';
    const global = writeCodexRollout(join(fake.home, '.codex'), sid);
    const botHome = writeCodexRollout(
      join(base, '.botmux', 'bots', APP_ID, 'codex'),
      sid,
    );
    utimesSync(global, new Date('2026-01-01'), new Date('2026-01-01'));
    utimesSync(botHome, new Date('2026-01-02'), new Date('2026-01-02'));

    expect(resolveSessionTranscriptPath({
      cliId: 'codex',
      sessionId: 'botmux-codex-flip',
      cliSessionId: sid,
      larkAppId: APP_ID,
      fresh: true,
    })?.path).toBe(botHome);
  });

  it('keys the Codex path cache by the effective CODEX_HOME', () => {
    const sid = '019dd80d-d922-7a11-8339-0208d8c5b4f0';
    const firstHome = join(base, 'codex-global-first');
    const secondHome = join(base, 'codex-global-second');
    const first = writeCodexRollout(firstHome, sid);
    const second = writeCodexRollout(secondHome, sid);
    process.env.CODEX_HOME = firstHome;

    const query = {
      cliId: 'codex' as const,
      sessionId: 'botmux-codex-dynamic-home',
      cliSessionId: sid,
      fresh: true,
    };
    expect(resolveSessionTranscriptPath(query)?.path).toBe(first);

    process.env.CODEX_HOME = secondHome;
    expect(resolveSessionTranscriptPath(query)?.path).toBe(second);
  });

  it('keeps normal CODEX_HOME root symlinks compatible', () => {
    const sid = '019dd80d-d922-7a11-8339-0208d8c5b4f6';
    const actualHome = join(base, 'codex-global-symlink-target');
    writeCodexRollout(actualHome, sid);
    const linkedHome = join(base, 'codex-global-symlink');
    symlinkSync(actualHome, linkedHome, 'dir');
    process.env.CODEX_HOME = linkedHome;

    expect(resolveSessionTranscriptPath({
      cliId: 'codex',
      sessionId: 'botmux-codex-global-symlink',
      cliSessionId: sid,
      fresh: true,
    })?.path).toBe(join(
      linkedHome,
      'sessions',
      '2026',
      '07',
      '29',
      `rollout-2026-07-29T12-00-00-${sid}.jsonl`,
    ));
  });

  it('falls back to BOT_HOME when a cached global Codex rollout disappears', () => {
    const sid = '019dd80d-d922-7a11-8339-0208d8c5b4f1';
    const globalHome = join(base, 'codex-global-stale');
    process.env.CODEX_HOME = globalHome;
    const global = writeCodexRollout(globalHome, sid);
    const botHome = writeCodexRollout(
      join(base, '.botmux', 'bots', APP_ID, 'codex'),
      sid,
    );
    utimesSync(global, new Date('2026-01-02'), new Date('2026-01-02'));
    utimesSync(botHome, new Date('2026-01-01'), new Date('2026-01-01'));
    const query = {
      cliId: 'codex' as const,
      sessionId: 'botmux-codex-stale-global',
      cliSessionId: sid,
      larkAppId: APP_ID,
      fresh: true,
    };
    expect(resolveSessionTranscriptPath(query)?.path).toBe(global);

    unlinkSync(global);
    expect(resolveSessionTranscriptPath(query)?.path).toBe(botHome);
  });

  it('does not follow a sandboxed Codex sessions symlink outside BOT_HOME', () => {
    const sid = '019dd80d-d922-7a11-8339-0208d8c5b4f2';
    const siblingHome = join(base, '.botmux', 'bots', 'cli_sibling', 'codex');
    writeCodexRollout(siblingHome, sid);
    const botCodexHome = join(base, '.botmux', 'bots', APP_ID, 'codex');
    mkdirSync(botCodexHome, { recursive: true });
    symlinkSync(join(siblingHome, 'sessions'), join(botCodexHome, 'sessions'), 'dir');

    expect(resolveSessionTranscriptPath({
      cliId: 'codex',
      sessionId: 'botmux-codex-symlink',
      cliSessionId: sid,
      larkAppId: APP_ID,
      fresh: true,
    })).toBeNull();
  });

  it('does not follow a sandboxed Codex root symlink outside BOT_HOME', () => {
    const sid = '019dd80d-d922-7a11-8339-0208d8c5b4f5';
    const siblingHome = join(base, '.botmux', 'bots', 'cli_sibling_root', 'codex');
    writeCodexRollout(siblingHome, sid);
    const botHome = join(base, '.botmux', 'bots', APP_ID);
    mkdirSync(botHome, { recursive: true });
    symlinkSync(siblingHome, join(botHome, 'codex'), 'dir');

    expect(resolveSessionTranscriptPath({
      cliId: 'codex',
      sessionId: 'botmux-codex-root-symlink',
      cliSessionId: sid,
      larkAppId: APP_ID,
      fresh: true,
    })).toBeNull();
  });

  it('does not follow a nested directory symlink while scanning Codex sessions', () => {
    const sid = '019dd80d-d922-7a11-8339-0208d8c5b4f4';
    const siblingHome = join(base, '.botmux', 'bots', 'cli_sibling_nested', 'codex');
    writeCodexRollout(siblingHome, sid);
    const botCodexHome = join(base, '.botmux', 'bots', APP_ID, 'codex');
    mkdirSync(join(botCodexHome, 'sessions'), { recursive: true });
    symlinkSync(
      join(siblingHome, 'sessions', '2026'),
      join(botCodexHome, 'sessions', '2026'),
      'dir',
    );

    expect(resolveSessionTranscriptPath({
      cliId: 'codex',
      sessionId: 'botmux-codex-nested-symlink',
      cliSessionId: sid,
      larkAppId: APP_ID,
      fresh: true,
    })).toBeNull();
  });

  it('invalidates a cached Codex rollout after a parent directory becomes a symlink', () => {
    const sid = '019dd80d-d922-7a11-8339-0208d8c5b4f7';
    const botCodexHome = join(base, '.botmux', 'bots', APP_ID, 'codex');
    writeCodexRollout(botCodexHome, sid);
    const query = {
      cliId: 'codex' as const,
      sessionId: 'botmux-codex-cached-parent-symlink',
      cliSessionId: sid,
      larkAppId: APP_ID,
      fresh: true,
    };
    expect(resolveSessionTranscriptPath(query)).not.toBeNull();

    const siblingHome = join(base, '.botmux', 'bots', 'cli_sibling_cached', 'codex');
    writeCodexRollout(siblingHome, sid);
    rmSync(join(botCodexHome, 'sessions'), { recursive: true });
    symlinkSync(join(siblingHome, 'sessions'), join(botCodexHome, 'sessions'), 'dir');

    expect(resolveSessionTranscriptPath(query)).toBeNull();
  });

  it('does not follow a sandboxed Claude projects symlink outside BOT_HOME', () => {
    const sid = 'claude-projects-symlink';
    const siblingClaude = join(base, '.botmux', 'bots', 'cli_sibling_claude', 'claude');
    const siblingProject = join(siblingClaude, 'projects', projectKey(cwd));
    mkdirSync(siblingProject, { recursive: true });
    writeFileSync(join(siblingProject, `${sid}.jsonl`), '{}');
    const botClaude = join(base, '.botmux', 'bots', APP_ID, 'claude');
    mkdirSync(botClaude, { recursive: true });
    symlinkSync(join(siblingClaude, 'projects'), join(botClaude, 'projects'), 'dir');

    expect(resolveSessionTranscriptPath({
      cliId: 'claude-code',
      sessionId: sid,
      cwd,
      larkAppId: APP_ID,
    })).toBeNull();
  });

  it('does not follow a sandboxed Codex history symlink', () => {
    const botmuxSid = 'botmux-codex-history-symlink';
    const codexSid = '019dd80d-d922-7a11-8339-0208d8c5b4f3';
    const siblingHome = join(base, '.botmux', 'bots', 'cli_sibling', 'codex');
    writeCodexHistory(siblingHome, botmuxSid, codexSid);
    const botCodexHome = join(base, '.botmux', 'bots', APP_ID, 'codex');
    writeCodexRollout(botCodexHome, codexSid);
    symlinkSync(
      join(siblingHome, 'history.jsonl'),
      join(botCodexHome, 'history.jsonl'),
      'file',
    );

    expect(resolveSessionTranscriptPath({
      cliId: 'codex',
      sessionId: botmuxSid,
      larkAppId: APP_ID,
      fresh: true,
    })).toBeNull();
  });
});

describe('cliSupportsNativeUsage', () => {
  it('is true only for CLIs with a resolvable transcript (sync with the resolver switch)', () => {
    for (const id of ['claude-code', 'aiden', 'seed', 'relay', 'codex', 'coco', 'cursor', 'traex', 'grok', 'antigravity']) {
      expect(cliSupportsNativeUsage(id)).toBe(true);
    }
    // CLIs the resolver's switch has no case for → no native usage → hide the UI.
    for (const id of ['gemini', 'opencode', 'pi', 'mtr', 'hermes', 'kiro-cli', 'unknown', undefined]) {
      expect(cliSupportsNativeUsage(id)).toBe(false);
    }
  });
});
