/**
 * The marker that makes a session's failed turns carry the provider error and
 * the screen tail (session.headless.failureDiagnostics) is persisted with the
 * session at birth — so every later fork of it (restore, resume, cold resume
 * after an idle release) rebuilds the worker init from the stored session —
 * and only when the creator asks for it (the workflow draft's clarifier).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const paths = vi.hoisted(() => {
  // vi.mock factories run before module-level code: the work dir is made here.
  const { mkdirSync, mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'botmux-headless-diag-'));
  const workDir = join(root, 'work');
  mkdirSync(workDir, { recursive: true });
  return { root, workDir };
});
const { root } = paths;

vi.mock('../src/bot-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bot-registry.js')>();
  const bot = { config: { larkAppId: 'cli_main', larkAppSecret: 's', cliId: 'claude-code', workingDir: paths.workDir } };
  return {
    ...actual,
    getBot: (appId: string) => {
      if (appId !== 'cli_main') throw new Error(`unknown bot ${appId}`);
      return bot;
    },
    effectiveDefaultWorkingDir: () => paths.workDir,
  };
});

import { config } from '../src/config.js';
import { createHeadlessSession } from '../src/core/session-manager.js';
import * as sessionStore from '../src/services/session-store.js';

let previousDataDir: string;
let dataDir: string;
beforeEach(() => {
  previousDataDir = config.session.dataDir;
  dataDir = mkdtempSync(join(root, 'data-'));
  config.session.dataDir = dataDir;
  sessionStore.init('cli_main');
});
afterEach(() => {
  config.session.dataDir = previousDataDir;
});

describe('headless session birth: the failure-diagnostics marker', () => {
  it('asked for (the draft clarifier): stored on the session as written, read back from the store', async () => {
    const created = await createHeadlessSession(new Map(), undefined, { larkAppId: 'cli_main', title: 'clarify', failureDiagnostics: true });
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) return;
    expect(sessionStore.getSession(created.sessionId)?.headless).toMatchObject({ failureDiagnostics: true, source: 'cli' });
  });

  it('not asked for (`botmux headless` and everything else): no such key on the stored session', async () => {
    const created = await createHeadlessSession(new Map(), undefined, { larkAppId: 'cli_main', title: 'plain' });
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) return;
    const headless = sessionStore.getSession(created.sessionId)?.headless;
    expect(headless).toMatchObject({ source: 'cli' });
    expect(Object.keys(headless ?? {})).not.toContain('failureDiagnostics');
  });
});

afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
