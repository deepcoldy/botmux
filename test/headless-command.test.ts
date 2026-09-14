import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseHeadlessArgs } from '../src/cli/headless-command.js';
import {
  createHeadlessRecord,
  headlessChatId,
  isHeadlessChatId,
  isHeadlessId,
  newHeadlessId,
  readHeadlessSession,
  saveHeadlessSession,
} from '../src/services/headless-session-store.js';
import { isHttpVirtualSession } from '../src/core/types.js';

describe('headless command parsing', () => {
  it('parses run with a session prefix and wait options', () => {
    const parsed = parseHeadlessArgs([
      'run',
      'hl_123',
      'say',
      'hello',
      '--wait',
      '--timeout',
      '7',
      '--json',
    ]);
    expect(parsed).toMatchObject({
      ok: true,
      kind: 'run',
      session: 'hl_123',
      prompt: 'say hello',
      wait: true,
      timeoutMs: 7000,
      json: true,
    });
  });

  it('parses send as an existing-session run', () => {
    const parsed = parseHeadlessArgs(['send', '--session', 'bmx-session', '--prompt', 'continue']);
    expect(parsed).toMatchObject({
      ok: true,
      kind: 'run',
      session: 'bmx-session',
      prompt: 'continue',
    });
  });

  it('rejects invalid reasoning effort and unknown flags', () => {
    expect(parseHeadlessArgs(['create', '--reasoning-effort', 'extreme']).ok).toBe(false);
    expect(parseHeadlessArgs(['result', 'hl_1', '--wat']).ok).toBe(false);
  });

  it('parses publish and bind targets', () => {
    expect(parseHeadlessArgs([
      'publish', 'hl_1', '--into', 'om_1', '--trigger-id', 'trg_1', '--json',
    ])).toMatchObject({
      ok: true,
      kind: 'publish',
      session: 'hl_1',
      rootMessageId: 'om_1',
      triggerId: 'trg_1',
      json: true,
    });

    expect(parseHeadlessArgs([
      'bind', 'hl_1', '--chat-id', 'oc_1', '--scope', 'thread', '--title', 'Hello replay',
      '--trigger-id', 'trg_1',
    ])).toMatchObject({
      ok: true,
      kind: 'bind',
      session: 'hl_1',
      chatId: 'oc_1',
      scope: 'thread',
      title: 'Hello replay',
      replay: 'latest',
      triggerId: 'trg_1',
    });

    expect(parseHeadlessArgs(['publish', 'hl_1', '--chat-id']).ok).toBe(false);
    expect(parseHeadlessArgs(['bind', 'hl_1', '--chat-id', 'oc_1', '--into', 'om_1', '--scope']).ok).toBe(false);
    expect(parseHeadlessArgs(['bind', 'hl_1', '--chat-id', 'oc_1', '--scope', 'chat']).ok).toBe(false);
  });

  it('parses result lookup with an explicit trigger id', () => {
    expect(parseHeadlessArgs([
      'result', 'hl_1', '--trigger-id', 'trg_1', '--json',
    ])).toMatchObject({
      ok: true,
      kind: 'result',
      session: 'hl_1',
      triggerId: 'trg_1',
      wait: false,
      json: true,
    });
  });
});

describe('headless session store', () => {
  let dir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-headless-store-'));
    prevDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = dir;
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = prevDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses stable hl/headless ids and reads by id or session id', () => {
    const id = newHeadlessId();
    expect(id.startsWith('hl_')).toBe(true);
    expect(isHeadlessId(id)).toBe(true);
    expect(isHeadlessId('hl_../x')).toBe(false);
    expect(isHeadlessChatId(headlessChatId(id))).toBe(true);
    expect(isHttpVirtualSession(headlessChatId(id))).toBe(true);

    const record = createHeadlessRecord({
      id,
      sessionId: 'session-1',
      larkAppId: 'app_1',
      title: 'Headless',
      workingDir: dir,
      model: 'gpt-5.6-terra',
      reasoningEffort: 'high',
    });
    saveHeadlessSession(record);

    expect(readHeadlessSession(id)).toMatchObject({
      id,
      sessionId: 'session-1',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'high',
    });
    expect(readHeadlessSession('session-1')?.id).toBe(id);
  });
});
