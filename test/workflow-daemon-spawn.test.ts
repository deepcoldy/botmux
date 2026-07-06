import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createWorkflowDaemonSpawn,
  syntheticSessionUuid,
  type WorkerHandle,
  type WorkerProcessFactory,
} from '../src/workflows/daemon-spawn.js';
import {
  WORKFLOW_OUTPUT_BEGIN,
  WORKFLOW_OUTPUT_END,
} from '../src/workflows/spawn-bot.js';
import { ATTEMPT_TERMINAL_SIDECAR } from '../src/workflows/attempt-terminal.js';

// ─── scripted worker process ──────────────────────────────────────────────

type Script = (handle: ScriptHandle) => void;

interface ScriptHandle {
  emit(msg: unknown): void;
  emitExit(code: number | null): void;
  onSend(cb: (msg: unknown) => void): void;
}

function scriptedFactory(script: Script): WorkerProcessFactory {
  return {
    spawn(_opts) {
      const bus = new EventEmitter();
      const sendListeners: Array<(msg: unknown) => void> = [];
      const handle: WorkerHandle = {
        send: (msg) => {
          for (const cb of sendListeners) cb(msg);
        },
        on: (event, cb) => bus.on(event, cb as never),
        kill: () => {
          /* no-op for tests */
        },
        pid: 1234,
      };
      const scriptHandle: ScriptHandle = {
        emit: (msg) => bus.emit('message', msg),
        emitExit: (code) => bus.emit('exit', code),
        onSend: (cb) => sendListeners.push(cb),
      };
      // Run script async so the caller can hook .on('message') first.
      setImmediate(() => script(scriptHandle));
      return handle;
    },
  };
}

function scriptedFactoryWithOpts(
  script: Script,
  onSpawn: (opts: { cwd: string; workerPath: string }) => void,
): WorkerProcessFactory {
  return {
    spawn(opts) {
      onSpawn(opts);
      return scriptedFactory(script).spawn(opts);
    },
  };
}

const baseInput = {
  botName: 'claude-loopy',
  botSnapshot: { larkAppId: 'cli_x', cliId: 'claude-code', displayName: 'Claude' },
  prompt: 'do thing',
  runId: 'run-x',
  nodeId: 'n',
  activityId: 'act',
  attemptId: 'att',
  workingDir: '/tmp',
};

const fakeCreds = { larkAppId: 'cli_x', larkAppSecret: 'secret' };

// ─── tests ────────────────────────────────────────────────────────────────

describe('createWorkflowDaemonSpawn', () => {
  it('happy path: resolves with last final_output content when worker quiesces', async () => {
    const deps = createWorkflowDaemonSpawn({
      resolveLarkCredentials: () => fakeCreds,
      quiesceMs: 30,
      factory: scriptedFactory((s) => {
        s.emit({ type: 'ready', port: 7878, token: 'tok' });
        s.emit({
          type: 'final_output',
          content: `${WORKFLOW_OUTPUT_BEGIN}{"answer":"hi"}${WORKFLOW_OUTPUT_END}`,
          lastUuid: 'u1',
          turnId: 't1',
        });
        s.emit({ type: 'screen_update', content: '', status: 'idle' });
      }),
    });
    const result = await deps.runOneShot(baseInput);
    expect(result.finalTranscript).toContain(WORKFLOW_OUTPUT_BEGIN);
    expect(result.session.larkAppId).toBe('cli_x');
    expect(result.session.cliId).toBe('claude-code');
    expect(result.session.botName).toBe('claude-loopy');
    expect(result.session.webPort).toBe(7878);
  });

  it('uses last final_output when multiple turns arrive (multi-step agent)', async () => {
    const deps = createWorkflowDaemonSpawn({
      resolveLarkCredentials: () => fakeCreds,
      quiesceMs: 30,
      factory: scriptedFactory((s) => {
        s.emit({ type: 'ready', port: 1, token: 't' });
        s.emit({
          type: 'final_output',
          content: 'draft v1',
          lastUuid: 'a',
          turnId: 't1',
        });
        s.emit({
          type: 'final_output',
          content: `revised\n${WORKFLOW_OUTPUT_BEGIN}{"v":2}${WORKFLOW_OUTPUT_END}`,
          lastUuid: 'b',
          turnId: 't2',
        });
        s.emit({ type: 'prompt_ready' });
      }),
    });
    const result = await deps.runOneShot(baseInput);
    expect(result.finalTranscript).toContain('"v":2');
    expect(result.finalTranscript).not.toContain('draft v1');
  });

  it('rejects when CLI exits without final_output', async () => {
    const deps = createWorkflowDaemonSpawn({
      resolveLarkCredentials: () => fakeCreds,
      quiesceMs: 30,
      factory: scriptedFactory((s) => {
        s.emit({ type: 'ready', port: 1, token: 't' });
        s.emit({ type: 'claude_exit', code: 1, signal: null });
      }),
    });
    await expect(deps.runOneShot(baseInput)).rejects.toThrow(/before producing final_output/);
  });

  it('rejects on worker error event', async () => {
    const deps = createWorkflowDaemonSpawn({
      resolveLarkCredentials: () => fakeCreds,
      factory: scriptedFactory((s) => {
        s.emit({ type: 'ready', port: 1, token: 't' });
        s.emit({ type: 'error', message: 'cli adapter missing' });
      }),
    });
    await expect(deps.runOneShot(baseInput)).rejects.toThrow(/cli adapter missing/);
  });

  it('honors per-step timeout when worker hangs', async () => {
    const deps = createWorkflowDaemonSpawn({
      resolveLarkCredentials: () => fakeCreds,
      factory: scriptedFactory((s) => {
        // Worker becomes ready but never emits final_output.
        s.emit({ type: 'ready', port: 1, token: 't' });
      }),
    });
    await expect(
      deps.runOneShot({ ...baseInput, timeoutMs: 80 }),
    ).rejects.toThrow(/timeout after 80/);
  });

  it('sends init message with synthetic chatId / rootMessageId and prompt', async () => {
    const sent: unknown[] = [];
    const factory = scriptedFactory((s) => {
      s.onSend((msg) => sent.push(msg));
      s.emit({ type: 'ready', port: 1, token: 't' });
      s.emit({
        type: 'final_output',
        content: `${WORKFLOW_OUTPUT_BEGIN}{}${WORKFLOW_OUTPUT_END}`,
        lastUuid: 'u',
        turnId: 't1',
      });
      s.emit({ type: 'screen_update', content: '', status: 'idle' });
    });
    const deps = createWorkflowDaemonSpawn({
      resolveLarkCredentials: () => fakeCreds,
      quiesceMs: 30,
      factory,
    });
    await deps.runOneShot(baseInput);
    const init = sent.find(
      (m): m is Record<string, unknown> =>
        typeof m === 'object' && m !== null && (m as Record<string, unknown>).type === 'init',
    );
    expect(init).toBeDefined();
    expect(init!.prompt).toBe('do thing');
    expect(init!.cliId).toBe('claude-code');
    expect(init!.larkAppId).toBe('cli_x');
    expect(init!.larkAppSecret).toBe('secret');
    // sessionId is now UUID-v4-shaped (Claude CLI 2.1.146 requires it).
    // Deterministically derived from runId/activityId/attemptId, so it
    // must equal syntheticSessionUuid of the same raw concatenation.
    const UUID_V4_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(init!.sessionId).toMatch(UUID_V4_RE);
    expect(init!.sessionId).toBe(
      syntheticSessionUuid(
        `wf-${baseInput.runId}-${baseInput.activityId}-${baseInput.attemptId}`,
      ),
    );
    expect(init!.chatId).toContain('wf-chat');
  });

  it('passes frozen sandbox policy to the one-shot worker init', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-sandbox-'));
    const sent: unknown[] = [];
    const factory = scriptedFactory((s) => {
      s.onSend((msg) => sent.push(msg));
      s.emit({ type: 'ready', port: 1, token: 't' });
      s.emit({
        type: 'final_output',
        content: `${WORKFLOW_OUTPUT_BEGIN}{}${WORKFLOW_OUTPUT_END}`,
        lastUuid: 'u',
        turnId: 't1',
      });
      s.emit({ type: 'screen_update', content: '', status: 'idle' });
    });
    const deps = createWorkflowDaemonSpawn({
      resolveLarkCredentials: () => fakeCreds,
      quiesceMs: 30,
      factory,
    });

    try {
      await deps.runOneShot({
        ...baseInput,
        attemptLogPath: join(dir, 'terminal.log'),
        botSnapshot: {
          ...baseInput.botSnapshot,
          sandbox: true,
          sandboxHidePaths: ['~/.ssh'],
          sandboxReadonlyPaths: ['/srv/readonly'],
          sandboxNetwork: false,
        },
      });

      const init = sent.find(
        (m): m is Record<string, unknown> =>
          typeof m === 'object' && m !== null && (m as Record<string, unknown>).type === 'init',
      );
      expect(init).toMatchObject({
        sandbox: true,
        sandboxHidePaths: ['~/.ssh'],
        sandboxReadonlyPaths: ['/srv/readonly'],
        sandboxNetwork: false,
      });
      const sidecar = JSON.parse(readFileSync(join(dir, ATTEMPT_TERMINAL_SIDECAR), 'utf-8'));
      expect(sidecar).toMatchObject({
        sandbox: true,
        sandboxHidePaths: ['~/.ssh'],
        sandboxReadonlyPaths: ['/srv/readonly'],
        sandboxNetwork: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('credential resolver gets the bot name from input', async () => {
    const resolver = vi.fn(() => fakeCreds);
    const deps = createWorkflowDaemonSpawn({
      resolveLarkCredentials: resolver,
      quiesceMs: 30,
      factory: scriptedFactory((s) => {
        s.emit({ type: 'ready', port: 1, token: 't' });
        s.emit({
          type: 'final_output',
          content: 'x',
          lastUuid: 'u',
          turnId: 't',
        });
        s.emit({ type: 'screen_update', content: '', status: 'idle' });
      }),
    });
    await deps.runOneShot({ ...baseInput, botName: 'codex-loopy' });
    expect(resolver).toHaveBeenCalledWith('codex-loopy');
  });

  it('expands tilde workingDir before spawning and initializing the worker', async () => {
    const sent: unknown[] = [];
    let spawnedCwd: string | undefined;
    const deps = createWorkflowDaemonSpawn({
      resolveLarkCredentials: () => fakeCreds,
      quiesceMs: 30,
      factory: scriptedFactoryWithOpts(
        (s) => {
          s.onSend((msg) => sent.push(msg));
          s.emit({ type: 'ready', port: 1, token: 't' });
          s.emit({
            type: 'final_output',
            content: `${WORKFLOW_OUTPUT_BEGIN}{}${WORKFLOW_OUTPUT_END}`,
            lastUuid: 'u',
            turnId: 't',
          });
          s.emit({ type: 'screen_update', content: '', status: 'idle' });
        },
        (opts) => {
          spawnedCwd = opts.cwd;
        },
      ),
    });

    const expectedCwd = join(homedir(), 'claude-code-workspace');
    const result = await deps.runOneShot({
      ...baseInput,
      workingDir: '~/claude-code-workspace',
    });

    const init = sent.find(
      (m): m is Record<string, unknown> =>
        typeof m === 'object' && m !== null && (m as Record<string, unknown>).type === 'init',
    );
    expect(spawnedCwd).toBe(expectedCwd);
    expect(init?.workingDir).toBe(expectedCwd);
    expect(result.session.workingDir).toBe(expectedCwd);
  });

  it('writes per-attempt execution log when attemptLogPath is provided', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'wf-daemon-log-'));
    try {
      const attemptLogPath = join(tmp, 'terminal.log');
      const deps = createWorkflowDaemonSpawn({
        resolveLarkCredentials: () => fakeCreds,
        quiesceMs: 30,
        factory: scriptedFactory((s) => {
          s.emit({ type: 'ready', port: 1, token: 't' });
          s.emit({
            type: 'final_output',
            content: `${WORKFLOW_OUTPUT_BEGIN}{"ok":true}${WORKFLOW_OUTPUT_END}`,
            lastUuid: 'u',
            turnId: 'turn-1',
          });
          s.emit({ type: 'screen_update', content: '', status: 'idle' });
          s.emitExit(0);
        }),
      });

      const result = await deps.runOneShot({ ...baseInput, attemptLogPath });

      expect(result.session.logPath).toBe(attemptLogPath);
      const log = readFileSync(attemptLogPath, 'utf-8');
      expect(log).toContain('system starting workflow worker');
      expect(log).toContain('system worker ready port=1');
      expect(log).toContain('final_output:turn-1');
      expect(log).toContain(WORKFLOW_OUTPUT_BEGIN);

      const terminal = JSON.parse(readFileSync(join(tmp, 'terminal.json'), 'utf-8'));
      expect(terminal).toMatchObject({
        schemaVersion: 1,
        sessionId: result.session.sessionId,
        webPort: 1,
        status: 'closed',
        larkAppId: 'cli_x',
        botName: 'claude-loopy',
        cliId: 'claude-code',
        workingDir: '/tmp',
        logPath: attemptLogPath,
      });
      expect(typeof terminal.startedAt).toBe('number');
      expect(typeof terminal.updatedAt).toBe('number');
      expect(typeof terminal.closedAt).toBe('number');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('persists CLI-native session id into the result and terminal sidecar', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'wf-daemon-cli-session-'));
    try {
      const attemptLogPath = join(tmp, 'terminal.log');
      const deps = createWorkflowDaemonSpawn({
        resolveLarkCredentials: () => fakeCreds,
        quiesceMs: 30,
        factory: scriptedFactory((s) => {
          s.emit({ type: 'ready', port: 1, token: 't' });
          s.emit({ type: 'cli_session_id', cliSessionId: 'native-cli-session-123' });
          s.emit({
            type: 'final_output',
            content: `${WORKFLOW_OUTPUT_BEGIN}{"ok":true}${WORKFLOW_OUTPUT_END}`,
            lastUuid: 'u',
            turnId: 'turn-1',
          });
          s.emit({ type: 'screen_update', content: '', status: 'idle' });
          s.emitExit(0);
        }),
      });

      const result = await deps.runOneShot({ ...baseInput, attemptLogPath });

      expect(result.session.cliSessionId).toBe('native-cli-session-123');
      const log = readFileSync(attemptLogPath, 'utf-8');
      expect(log).toContain('CLI session id observed native-cli-session-123');

      const terminal = JSON.parse(readFileSync(join(tmp, 'terminal.json'), 'utf-8'));
      expect(terminal).toMatchObject({
        sessionId: result.session.sessionId,
        cliSessionId: 'native-cli-session-123',
        status: 'closed',
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('syntheticSessionUuid', () => {
  const UUID_V4_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('produces a valid UUID v4 shape (Claude CLI session-id validator accepts it)', () => {
    const id = syntheticSessionUuid(
      'wf-run-2026-05-21T07-06-16-028Z-e072e865-run::work::root-run::work::root::att-1',
    );
    expect(id).toMatch(UUID_V4_RE);
  });

  it('is deterministic — same raw id maps to the same uuid (jsonl bridge path + resume both rely on this)', () => {
    const raw = 'wf-some-run-some::activity-some::attempt';
    expect(syntheticSessionUuid(raw)).toBe(syntheticSessionUuid(raw));
  });

  it('different inputs map to different uuids (no collisions across attempts)', () => {
    const a = syntheticSessionUuid('wf-run-act-att-1');
    const b = syntheticSessionUuid('wf-run-act-att-2');
    expect(a).not.toBe(b);
    expect(a).toMatch(UUID_V4_RE);
    expect(b).toMatch(UUID_V4_RE);
  });

  it('accepts ids with `::` separators that broke the raw string form', () => {
    const id = syntheticSessionUuid('wf-r::a::b');
    expect(id).toMatch(UUID_V4_RE);
    expect(id).not.toContain('::');
  });
});
