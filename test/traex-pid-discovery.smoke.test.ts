import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findTraexRolloutByPid,
  findTraexRolloutSetByPid,
} from '../src/services/traex-transcript.js';

const MAIN_SID = '019fe206-29ee-7a62-8da7-67d37a4fa70c';
const GUARDIAN_SID = '019fe9cf-5c4e-7231-9b5d-799f294fd57d';
const NEW_MAIN_SID = '019fea00-0000-7000-8000-000000000001';
const AMBIGUOUS_A_SID = '019fea00-0000-7000-8000-000000000002';
const AMBIGUOUS_B_SID = '019fea00-0000-7000-8000-000000000003';
const LEGACY_SID = '019fea00-0000-7000-8000-000000000004';
const LEGACY_SECOND_SID = '019fea00-0000-7000-8000-000000000005';
const PARTIAL_SID = '019fea00-0000-7000-8000-000000000006';

let dir: string;
const children: ChildProcessWithoutNullStreams[] = [];
let mainGuardianChild: ChildProcessWithoutNullStreams;
let mainNewChild: ChildProcessWithoutNullStreams;
let ambiguousChild: ChildProcessWithoutNullStreams;
let guardianOnlyChild: ChildProcessWithoutNullStreams;
let legacyChild: ChildProcessWithoutNullStreams;
let legacyAmbiguousChild: ChildProcessWithoutNullStreams;
let mainPartialChild: ChildProcessWithoutNullStreams;
let guardianPartialChild: ChildProcessWithoutNullStreams;
let partialChild: ChildProcessWithoutNullStreams;
let legacyGuardianChild: ChildProcessWithoutNullStreams;

function rolloutPath(sid: string, label: string): string {
  const sessions = join(dir, 'custom-trae-home', 'cli', 'sessions', '2026', '08', '10');
  mkdirSync(sessions, { recursive: true });
  return join(sessions, `rollout-2026-08-10T00-00-00-${label}-${sid}.jsonl`);
}

function writeRollout(
  sid: string,
  label: string,
  timestamp: string,
  threadSource: string,
  source: unknown,
): string {
  const path = rolloutPath(sid, label);
  writeFileSync(path, `${JSON.stringify({
    timestamp,
    type: 'session_meta',
    payload: {
      id: sid,
      timestamp,
      cwd: '/workspace',
      source,
      thread_source: threadSource,
    },
  })}\n`);
  return path;
}

async function spawnHolder(paths: string[]): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
        const fs = require('fs');
        for (const path of ${JSON.stringify(paths)}) fs.openSync(path, 'a');
        process.stdout.write('ready\\n');
        setTimeout(() => {}, 60000);
      `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rollout holder not ready in 5s')), 5000);
    child.stdout.once('data', (buffer: Buffer) => {
      if (!buffer.toString().includes('ready')) return;
      clearTimeout(timer);
      resolve();
    });
    child.once('error', reject);
  });
  return child;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bmx-traex-pid-'));
  const main = writeRollout(MAIN_SID, 'main', '2026-08-08T15:38:02.000Z', 'user', 'cli');
  const guardian = writeRollout(
    GUARDIAN_SID,
    'guardian',
    '2026-08-10T03:55:08.000Z',
    'subagent',
    { subagent: { other: 'guardian' } },
  );
  const newMain = writeRollout(
    NEW_MAIN_SID,
    'new-main',
    '2026-08-10T04:00:00.000Z',
    'user',
    'cli',
  );
  const ambiguousA = writeRollout(
    AMBIGUOUS_A_SID,
    'ambiguous-a',
    '2026-08-10T05:00:00.000Z',
    'user',
    'cli',
  );
  const ambiguousB = writeRollout(
    AMBIGUOUS_B_SID,
    'ambiguous-b',
    '2026-08-10T05:00:00.000Z',
    'user',
    'cli',
  );
  const legacy = rolloutPath(LEGACY_SID, 'legacy');
  const legacySecond = rolloutPath(LEGACY_SECOND_SID, 'legacy-second');
  const partial = rolloutPath(PARTIAL_SID, 'partial');
  writeFileSync(legacy, `${JSON.stringify({ type: 'turn_context', payload: { model: 'legacy' } })}\n`);
  writeFileSync(
    legacySecond,
    `${JSON.stringify({ type: 'turn_context', payload: { model: 'legacy-second' } })}\n`,
  );
  writeFileSync(partial, '{"type":"session_meta","payload":{"thread_source":"subagent"');

  mainGuardianChild = await spawnHolder([guardian, main]);
  mainNewChild = await spawnHolder([main, guardian, newMain]);
  ambiguousChild = await spawnHolder([ambiguousA, ambiguousB]);
  guardianOnlyChild = await spawnHolder([guardian]);
  legacyChild = await spawnHolder([legacy]);
  legacyAmbiguousChild = await spawnHolder([legacy, legacySecond]);
  mainPartialChild = await spawnHolder([partial, main]);
  guardianPartialChild = await spawnHolder([partial, guardian]);
  partialChild = await spawnHolder([partial]);
  legacyGuardianChild = await spawnHolder([legacy, guardian]);
});

afterAll(() => {
  for (const child of children) {
    if (!child.killed) child.kill('SIGKILL');
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('findTraexRolloutByPid', () => {
  it('filters a newer guardian rollout and keeps the visible user session', () => {
    const hit = findTraexRolloutByPid(mainGuardianChild.pid!);
    expect(hit?.cliSessionId).toBe(MAIN_SID);
  });

  it('keeps the preferred visible session when the only newer rollout is guardian', () => {
    const hit = findTraexRolloutByPid(mainGuardianChild.pid!, MAIN_SID);
    expect(hit?.cliSessionId).toBe(MAIN_SID);
  });

  it('follows a newer top-level user rollout as a legitimate in-process /new', () => {
    const hit = findTraexRolloutByPid(mainNewChild.pid!, MAIN_SID);
    expect(hit?.cliSessionId).toBe(NEW_MAIN_SID);
  });

  it('fails closed when two top-level candidates are equally new', () => {
    expect(findTraexRolloutByPid(ambiguousChild.pid!)).toBeUndefined();
  });

  it('fails closed when the process exposes only internal rollouts', () => {
    expect(findTraexRolloutByPid(guardianOnlyChild.pid!)).toBeUndefined();
  });

  it('keeps one legacy rollout without session_meta compatible', () => {
    expect(findTraexRolloutByPid(legacyChild.pid!)?.cliSessionId).toBe(LEGACY_SID);
  });

  it('does not guess between multiple legacy rollouts without session_meta', () => {
    expect(findTraexRolloutByPid(legacyAmbiguousChild.pid!)).toBeUndefined();
  });

  it('does not let a partially-written helper rollout displace a visible user rollout', () => {
    expect(findTraexRolloutByPid(mainPartialChild.pid!)?.cliSessionId).toBe(MAIN_SID);
  });

  it('fails closed when internal and partially-written rollouts are the only candidates', () => {
    expect(findTraexRolloutByPid(guardianPartialChild.pid!)).toBeUndefined();
  });

  it('does not bind a non-empty rollout whose session_meta line is incomplete', () => {
    expect(findTraexRolloutByPid(partialChild.pid!)).toBeUndefined();
  });

  it('keeps a complete legacy rollout selectable when guardian is also open', () => {
    expect(findTraexRolloutByPid(legacyGuardianChild.pid!)?.cliSessionId).toBe(LEGACY_SID);
  });
});

describe('findTraexRolloutSetByPid', () => {
  it('excludes guardian session ids from ownership decisions', () => {
    const set = findTraexRolloutSetByPid(mainGuardianChild.pid!);
    expect(set).toEqual(new Set([MAIN_SID.toLowerCase()]));
    expect(set?.has(GUARDIAN_SID.toLowerCase())).toBe(false);
  });

  it('excludes a partially-written helper while a visible user rollout is owned', () => {
    expect(findTraexRolloutSetByPid(mainPartialChild.pid!)).toEqual(
      new Set([MAIN_SID.toLowerCase()]),
    );
  });
});
