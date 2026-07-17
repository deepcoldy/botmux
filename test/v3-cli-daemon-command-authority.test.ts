import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  V3DaemonCommandAuthorityError,
  authorizeV3DaemonCommand,
} from '../src/workflows/v3/cli-daemon-command-authority.js';
import { readProcessStartIdentity } from '../src/core/session-marker.js';
import { birthRun, type RunChatBinding } from '../src/workflows/v3/grill-state.js';
import {
  makeManualCliRunEnvelope,
  serializeRunEnvelope,
  type Sha256Digest,
} from '../src/workflows/v3/run-envelope.js';

const DIGEST = `sha256:${'a'.repeat(64)}` as Sha256Digest;
const BINDING: RunChatBinding = {
  larkAppId: 'cli_owner',
  chatId: 'oc_owner',
  rootMessageId: 'om_root',
  sessionId: 'sess-1',
  ownerOpenId: 'ou_caller',
};

describe('agent-facing v3 daemon command authority', () => {
  let root: string;
  let dataDir: string;
  let baseDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'v3-daemon-command-auth-'));
    dataDir = join(root, 'data');
    baseDir = join(root, 'runs');
    mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
    mkdirSync(baseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeMarker(turnId = 'turn-current'): void {
    const procStart = readProcessStartIdentity(process.pid);
    if (!procStart) throw new Error('test process start identity unavailable');
    writeFileSync(
      join(dataDir, '.botmux-cli-pids', String(process.pid)),
      JSON.stringify({ sessionId: 'sess-1', turnId, procStart }),
    );
  }

  function writeSession(overrides: Record<string, unknown> = {}): void {
    writeFileSync(join(dataDir, 'sessions-cli_owner.json'), JSON.stringify({
      'sess-1': {
        sessionId: 'sess-1',
        status: 'active',
        scope: 'thread',
        larkAppId: 'cli_owner',
        chatId: 'oc_owner',
        rootMessageId: 'om_root',
        lastCallerOpenId: 'ou_caller',
        quoteTargetId: 'turn-current',
        ...overrides,
      },
    }));
  }

  function writeEnvelope(runId: string, binding?: RunChatBinding): void {
    const runDir = join(baseDir, runId);
    mkdirSync(runDir, { recursive: true });
    const envelope = makeManualCliRunEnvelope({
      runId,
      createdAt: '2026-07-10T10:00:00.000Z',
      authorizedAt: '2026-07-10T10:00:00.000Z',
      ...(binding ? { chatBinding: binding } : {}),
      artifacts: {
        dag: { path: 'dag.json', sha256: DIGEST },
        botSnapshots: { path: 'bots.snapshot.json', sha256: DIGEST },
      },
    });
    writeFileSync(join(runDir, 'run.json'), serializeRunEnvelope(envelope));
  }

  function authorize(runId: string, overrides: Partial<Parameters<typeof authorizeV3DaemonCommand>[0]> = {}) {
    return authorizeV3DaemonCommand({
      runId,
      dataDir,
      baseDir,
      envSessionId: 'sess-1',
      startPid: process.pid,
      ...overrides,
    });
  }

  it('uses the exact current caller/chat/app and returns the target daemon app', () => {
    writeMarker();
    writeSession();
    writeEnvelope('bound-ok', BINDING);

    expect(authorize('bound-ok')).toMatchObject({
      larkAppId: 'cli_owner',
      mode: 'chat',
      bindingSource: 'run-envelope',
      runDir: join(baseDir, 'bound-ok'),
    });
    expect(authorize('bound-ok', { requestedLarkAppId: 'cli_owner' }).larkAppId)
      .toBe('cli_owner');
  });

  it.each([
    ['callerOpenId', { lastCallerOpenId: 'ou_someone_else' }],
    ['chatId', { chatId: 'oc_other' }],
    ['larkAppId', { larkAppId: 'cli_other' }],
  ])('rejects a bound run when current %s differs', (field, sessionOverrides) => {
    writeMarker();
    writeSession(sessionOverrides);
    writeEnvelope(`bound-wrong-${field.toLowerCase()}`, BINDING);

    expect(() => authorize(`bound-wrong-${field.toLowerCase()}`)).toThrow(
      new RegExp(`不匹配.*${field}`),
    );
  });

  it('does not let --bot override the authenticated current/target app', () => {
    writeMarker();
    writeSession();
    writeEnvelope('bound-bot-override', BINDING);

    expect(() => authorize('bound-bot-override', { requestedLarkAppId: 'cli_attacker' }))
      .toThrow(/--bot cli_attacker.*cli_owner/);
  });

  it('does not let an authenticated chat caller mutate an unbound run', () => {
    writeMarker();
    writeSession();
    writeEnvelope('unbound-from-chat');

    expect(() => authorize('unbound-from-chat', { requestedLarkAppId: 'cli_owner' }))
      .toThrow(/未绑定的 standalone\/legacy run.*chat turn/);
  });

  it('allows a genuine standalone caller only for an unbound run with explicit --bot', () => {
    writeEnvelope('unbound-standalone');

    expect(authorize('unbound-standalone', {
      envSessionId: undefined,
      requestedLarkAppId: 'cli_explicit',
    })).toMatchObject({
      larkAppId: 'cli_explicit',
      mode: 'standalone',
      bindingSource: 'run-envelope',
    });
    expect(() => authorize('unbound-standalone', { envSessionId: undefined }))
      .toThrow(/standalone.*必须显式提供 --bot/);
    expect(authorize('unbound-standalone', {
      envSessionId: undefined,
      allowStandaloneLocal: true,
    })).toMatchObject({ larkAppId: '', mode: 'standalone' });
  });

  it('does not let a standalone caller mutate a chat-bound run', () => {
    writeEnvelope('bound-from-standalone', BINDING);

    expect(() => authorize('bound-from-standalone', {
      envSessionId: undefined,
      requestedLarkAppId: 'cli_owner',
    })).toThrow(/绑定了 chat caller.*standalone/);
  });

  it('fails closed for detached and stale in-session invocations', () => {
    writeSession();
    writeEnvelope('bound-detached', BINDING);
    expect(() => authorize('bound-detached')).toThrow(/脱离 botmux CLI 进程树/);

    writeMarker('turn-stale');
    expect(() => authorize('bound-detached')).toThrow(/turn-stale.*turn-current/);
  });

  it('falls back to grill chatBinding only when run.json is missing', () => {
    writeMarker();
    writeSession();
    birthRun({ goal: 'legacy grill', baseDir, runId: 'legacy-grill', chatBinding: BINDING });

    expect(authorize('legacy-grill')).toMatchObject({
      larkAppId: 'cli_owner',
      mode: 'chat',
      bindingSource: 'legacy-grill',
    });
  });

  it('fails closed on invalid run.json instead of falling back to grill state', () => {
    writeMarker();
    writeSession();
    const { runDir } = birthRun({
      goal: 'invalid envelope',
      baseDir,
      runId: 'invalid-envelope',
      chatBinding: BINDING,
    });
    writeFileSync(join(runDir, 'run.json'), '{not-json');

    expect(() => authorize('invalid-envelope')).toThrow(/run.json 无效.*拒绝降级/);
  });

  it('fails closed when run.json is a dangling symlink instead of falling back to grill', () => {
    writeMarker();
    writeSession();
    const { runDir } = birthRun({
      goal: 'dangling envelope',
      baseDir,
      runId: 'dangling-envelope',
      chatBinding: BINDING,
    });
    // Replace any pre-created envelope with a dangling symlink. existsSync would
    // report missing and previously opened the missing-only legacy path.
    try { unlinkSync(join(runDir, 'run.json')); } catch { /* optional */ }
    symlinkSync(join(runDir, 'missing-target.json'), join(runDir, 'run.json'));

    expect(() => authorize('dangling-envelope')).toThrow(/run.json 无效.*拒绝降级/);
  });

  it('keeps the old unbound manual-run fallback but rejects empty unknown dirs', () => {
    const legacyDir = join(baseDir, 'legacy-manual');
    mkdirSync(legacyDir);
    writeFileSync(join(legacyDir, 'dag.json'), '{}');
    expect(authorize('legacy-manual', {
      envSessionId: undefined,
      requestedLarkAppId: 'cli_explicit',
    })).toMatchObject({ bindingSource: 'legacy-unbound', mode: 'standalone' });

    mkdirSync(join(baseDir, 'empty-run'));
    expect(() => authorize('empty-run', {
      envSessionId: undefined,
      requestedLarkAppId: 'cli_explicit',
    })).toThrow(V3DaemonCommandAuthorityError);
  });
});
