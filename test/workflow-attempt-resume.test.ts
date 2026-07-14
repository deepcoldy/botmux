import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AttemptResumeManager,
  RESUME_USES_SESSION_ID,
  type AttemptResumeBot,
} from '../src/workflows/attempt-resume.js';
import {
  ATTEMPT_TERMINAL_SCHEMA_VERSION,
  ATTEMPT_TERMINAL_SIDECAR,
} from '../src/workflows/attempt-terminal.js';
import type {
  WorkerHandle,
  WorkerProcessFactory,
  WorkerSpawnOptions,
} from '../src/workflows/daemon-spawn.js';

type ScriptHandle = {
  emit(msg: unknown): void;
  emitExit(code: number | null): void;
  sent: unknown[];
  kills: Array<string | undefined>;
};

function makeFactory(script?: (h: ScriptHandle) => void): {
  factory: WorkerProcessFactory;
  handles: ScriptHandle[];
  spawns: WorkerSpawnOptions[];
} {
  const handles: ScriptHandle[] = [];
  const spawns: WorkerSpawnOptions[] = [];
  return {
    handles,
    spawns,
    factory: {
      spawn(opts) {
        spawns.push(opts);
        const bus = new EventEmitter();
        const h: ScriptHandle = {
          sent: [],
          kills: [],
          emit: (msg) => bus.emit('message', msg),
          emitExit: (code) => bus.emit('exit', code),
        };
        handles.push(h);
        const worker: WorkerHandle = {
          send: (msg) => h.sent.push(msg),
          on: (event, cb) => bus.on(event, cb as never),
          kill: (signal) => h.kills.push(signal),
          pid: 1234,
        };
        if (script) setImmediate(() => script(h));
        return worker;
      },
    },
  };
}

const bot: AttemptResumeBot = {
  larkAppId: 'cli_x',
  larkAppSecret: 'secret',
  cliId: 'claude-code',
  botName: 'Claude',
  locale: 'zh',
};

function seedAttempt(tmp: string, opts: { cliSessionId?: string | null; cliId?: string } = {}): {
  runId: string;
  activityId: string;
  attemptId: string;
} {
  const runId = 'r-resume';
  const activityId = 'r-resume::work::node';
  const attemptId = 'r-resume::work::node::att-1';
  const attemptDir = join(tmp, runId, 'attempts', activityId, attemptId);
  mkdirSync(attemptDir, { recursive: true });
  writeFileSync(
    join(attemptDir, ATTEMPT_TERMINAL_SIDECAR),
    JSON.stringify({
      schemaVersion: ATTEMPT_TERMINAL_SCHEMA_VERSION,
      sessionId: 'synthetic-session',
      ...(opts.cliSessionId === null ? {} : { cliSessionId: opts.cliSessionId ?? 'native-cli-session' }),
      webPort: 32123,
      status: 'closed',
      larkAppId: 'cli_x',
      botName: 'Claude',
      cliId: opts.cliId ?? 'claude-code',
      workingDir: '/tmp',
      logPath: join(attemptDir, 'terminal.log'),
      startedAt: 1,
      updatedAt: 2,
      closedAt: 3,
    }),
    'utf-8',
  );
  return { runId, activityId, attemptId };
}

describe('RESUME_USES_SESSION_ID', () => {
  it('treats mir as session-id-resumable (mir runner continues via --session-id)', () => {
    expect(RESUME_USES_SESSION_ID.has('mir')).toBe(true);
  });
});

describe('AttemptResumeManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a dashboard-only resume worker from the attempt terminal sidecar', async () => {
    const tmp = join(tmpdir(), `wf-resume-${Date.now()}-${Math.random()}`);
    const ids = seedAttempt(tmp);
    const { factory, handles, spawns } = makeFactory((h) => {
      h.emit({ type: 'ready', port: 4567, token: 'write-token' });
    });
    try {
      const manager = new AttemptResumeManager({
        runsDir: tmp,
        externalHost: 'dash.local',
        workerPath: '/worker.js',
        factory,
        resolveBot: () => bot,
      });

      const result = await manager.start(ids);

      expect(result).toMatchObject({
        ok: true,
        cliSessionId: 'native-cli-session',
        originalSessionId: 'synthetic-session',
        webPort: 4567,
        writeToken: 'write-token',
        url: 'http://dash.local:4567?token=write-token',
        alreadyRunning: false,
      });
      expect(spawns[0]?.env.BOTMUX_WORKFLOW_RESUME).toBe('1');
      const init = handles[0]?.sent.find(
        (msg): msg is Record<string, unknown> =>
          typeof msg === 'object' && msg !== null && (msg as any).type === 'init',
      );
      expect(init).toMatchObject({
        resume: true,
        originalSessionId: 'synthetic-session',
        cliSessionId: 'native-cli-session',
        prompt: '',
        larkAppId: 'cli_x',
      });

      const sidecar = JSON.parse(readFileSync(result.ok ? result.sidecarPath : '', 'utf-8'));
      expect(sidecar).toMatchObject({
        schemaVersion: 1,
        resumeId: result.ok ? result.resumeId : '',
        status: 'live',
        originalSessionId: 'synthetic-session',
        cliSessionId: 'native-cli-session',
        webPort: 4567,
        writeToken: 'write-token',
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('passes sandbox policy to the dashboard resume worker init', async () => {
    const tmp = join(tmpdir(), `wf-resume-${Date.now()}-${Math.random()}`);
    const ids = seedAttempt(tmp);
    const { factory, handles } = makeFactory((h) => {
      h.emit({ type: 'ready', port: 4567, token: 'write-token' });
    });
    try {
      const manager = new AttemptResumeManager({
        runsDir: tmp,
        externalHost: 'dash.local',
        workerPath: '/worker.js',
        factory,
        resolveBot: () => ({
          ...bot,
          sandbox: true,
          sandboxHidePaths: ['~/.ssh'],
          sandboxReadonlyPaths: ['/srv/readonly'],
          sandboxNetwork: false,
        }),
      });

      const result = await manager.start(ids);

      expect(result.ok).toBe(true);
      const init = handles[0]?.sent.find(
        (msg): msg is Record<string, unknown> =>
          typeof msg === 'object' && msg !== null && (msg as any).type === 'init',
      );
      expect(init).toMatchObject({
        sandbox: true,
        sandboxHidePaths: ['~/.ssh'],
        sandboxReadonlyPaths: ['/srv/readonly'],
        sandboxNetwork: false,
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('allows session-id based CLIs to resume without a native cliSessionId', async () => {
    const tmp = join(tmpdir(), `wf-resume-${Date.now()}-${Math.random()}`);
    const ids = seedAttempt(tmp, { cliSessionId: null, cliId: 'coco' });
    const { factory, handles } = makeFactory((h) => {
      h.emit({ type: 'ready', port: 4567, token: 'write-token' });
    });
    try {
      const manager = new AttemptResumeManager({
        runsDir: tmp,
        externalHost: 'dash.local',
        workerPath: '/worker.js',
        factory,
        resolveBot: () => ({ ...bot, cliId: 'coco' }),
      });

      const result = await manager.start(ids);

      expect(result).toMatchObject({
        ok: true,
        originalSessionId: 'synthetic-session',
        webPort: 4567,
      });
      if (result.ok) expect(result.cliSessionId).toBeUndefined();
      const init = handles[0]?.sent.find(
        (msg): msg is Record<string, unknown> =>
          typeof msg === 'object' && msg !== null && (msg as any).type === 'init',
      );
      expect(init).toMatchObject({
        type: 'init',
        resume: true,
        originalSessionId: 'synthetic-session',
        cliId: 'coco',
      });
      expect(init?.sessionId).not.toBe('synthetic-session');
      expect(init).not.toHaveProperty('cliSessionId');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each(['cursor', 'kiro-cli'])('requires native cliSessionId for %s', async (cliId) => {
    const tmp = join(tmpdir(), `wf-resume-${Date.now()}-${Math.random()}`);
    const ids = seedAttempt(tmp, { cliSessionId: null, cliId });
    const { factory, spawns } = makeFactory();
    try {
      const manager = new AttemptResumeManager({
        runsDir: tmp,
        externalHost: 'dash.local',
        workerPath: '/worker.js',
        factory,
        resolveBot: () => ({ ...bot, cliId }),
      });

      const result = await manager.start(ids);

      expect(result).toMatchObject({ ok: false, error: 'missing_cli_session_id' });
      expect(spawns).toHaveLength(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects CLIs without precise resume support', async () => {
    const tmp = join(tmpdir(), `wf-resume-${Date.now()}-${Math.random()}`);
    const ids = seedAttempt(tmp, { cliSessionId: null, cliId: 'gemini' });
    const { factory, spawns } = makeFactory();
    try {
      const manager = new AttemptResumeManager({
        runsDir: tmp,
        externalHost: 'dash.local',
        workerPath: '/worker.js',
        factory,
        resolveBot: () => ({ ...bot, cliId: 'gemini' }),
      });

      const result = await manager.start(ids);

      expect(result).toMatchObject({ ok: false, error: 'resume_unsupported_cli' });
      expect(spawns).toHaveLength(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('opencode requires a captured native cliSessionId (no <session_id> block in workflow prompts)', async () => {
    const tmp = join(tmpdir(), `wf-resume-${Date.now()}-${Math.random()}`);
    const ids = seedAttempt(tmp, { cliSessionId: null, cliId: 'opencode' });
    const { factory, spawns } = makeFactory();
    try {
      const manager = new AttemptResumeManager({
        runsDir: tmp,
        externalHost: 'dash.local',
        workerPath: '/worker.js',
        factory,
        resolveBot: () => ({ ...bot, cliId: 'opencode' }),
      });

      const result = await manager.start(ids);

      expect(result).toMatchObject({ ok: false, error: 'missing_cli_session_id' });
      expect(spawns).toHaveLength(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('deduplicates concurrent resume starts for the same attempt', async () => {
    const tmp = join(tmpdir(), `wf-resume-${Date.now()}-${Math.random()}`);
    const ids = seedAttempt(tmp);
    const { factory, spawns } = makeFactory((h) => {
      h.emit({ type: 'ready', port: 4567, token: 'write-token' });
    });
    try {
      const manager = new AttemptResumeManager({
        runsDir: tmp,
        externalHost: 'dash.local',
        workerPath: '/worker.js',
        factory,
        resolveBot: () => bot,
      });

      const [a, b] = await Promise.all([manager.start(ids), manager.start(ids)]);

      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (a.ok && b.ok) {
        expect(b.resumeId).toBe(a.resumeId);
        expect(b.alreadyRunning).toBe(false);
      }
      expect(spawns).toHaveLength(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('ends a running resume session and freezes its sidecar', async () => {
    const tmp = join(tmpdir(), `wf-resume-${Date.now()}-${Math.random()}`);
    const ids = seedAttempt(tmp);
    const { factory, handles } = makeFactory((h) => {
      h.emit({ type: 'ready', port: 4567, token: 'write-token' });
    });
    try {
      const manager = new AttemptResumeManager({
        runsDir: tmp,
        externalHost: 'dash.local',
        workerPath: '/worker.js',
        factory,
        resolveBot: () => bot,
      });
      const started = await manager.start(ids);
      expect(started.ok).toBe(true);

      const ended = await manager.end({ ...ids, reason: 'test-end' });

      expect(ended).toMatchObject({ ok: true, status: 'closed', closeReason: 'test-end' });
      expect(handles[0]?.kills).toContain('SIGINT');
      const sidecar = JSON.parse(readFileSync(started.ok ? started.sidecarPath : '', 'utf-8'));
      expect(sidecar).toMatchObject({
        status: 'closed',
        closeReason: 'test-end',
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
