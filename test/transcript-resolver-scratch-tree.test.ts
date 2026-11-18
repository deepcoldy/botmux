import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A scratch session's Claude transcript is read through its merged view, a
// tree the session's CLI writes to: the resolver names the view root so the
// reader can re-check the file it opens.
const sessions = vi.hoisted(() => new Map<string, { larkAppId: string; sandbox?: string; cliConfigDir?: string }>());
vi.mock('../src/services/session-store.js', () => ({
  getSession: (id: string) => sessions.get(id),
}));

import { config } from '../src/config.js';
import {
  __resetTranscriptResolverCacheForTest,
  resolveSessionTranscriptPath,
} from '../src/services/transcript-resolver.js';

describe('resolveSessionTranscriptPath — scratch view', () => {
  let base: string;
  let savedDataDir: string;

  beforeEach(() => {
    __resetTranscriptResolverCacheForTest();
    base = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-scratch-tree-')));
    savedDataDir = config.session.dataDir;
    config.session.dataDir = join(base, 'data');
  });

  afterEach(() => {
    sessions.clear();
    config.session.dataDir = savedDataDir;
    rmSync(base, { recursive: true, force: true });
  });

  it('names the merged view root as the tree to re-check', () => {
    const sid = 'scratch-1';
    const profile = join(base, 'claude-profile');
    const cwd = join(base, 'work');
    mkdirSync(profile, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const merged = join(base, 'data', 'sandboxes', sid, 'merged');
    mkdirSync(join(base, 'data', 'sandboxes', sid), { recursive: true });
    writeFileSync(join(base, 'data', 'sandboxes', sid, 'scratch.json'), JSON.stringify({ mappings: [{ from: '/', to: merged }] }));
    // Inside the view: the cwd and the profile's transcript, at their host paths.
    const viewCwd = join(merged, cwd);
    mkdirSync(viewCwd, { recursive: true });
    const key = realpathSync(viewCwd).replace(/[^A-Za-z0-9-]/g, '-');
    const transcript = join(merged, profile, 'projects', key, `${sid}.jsonl`);
    mkdirSync(join(merged, profile, 'projects', key), { recursive: true });
    writeFileSync(transcript, '{}');
    sessions.set(sid, { larkAppId: 'cli_owner', sandbox: 'scratch', cliConfigDir: profile });

    expect(resolveSessionTranscriptPath({ cliId: 'claude-code', sessionId: sid, cwd, larkAppId: 'cli_owner' }))
      .toEqual({ path: transcript, kind: 'claude', writableTreeRoot: merged });
  });
});
