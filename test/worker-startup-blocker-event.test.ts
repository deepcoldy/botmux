import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectCliStartupBlocker, startupBlockerKey } from '../src/core/cli-startup-blocker.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import type { WorkerToDaemon } from '../src/types.js';

// probeStartupBlocker runs the real detector on a captured startup screen; the
// v3 workflow pool fails a node on the structured event it sends.

function harness(opts: { workflow?: boolean; alreadyExplained?: boolean } = {}) {
  const messages: WorkerToDaemon[] = [];
  const scope = {
    backend: {}, lastInitConfig: { workingDir: '/workspace', backendType: 'tmux' },
    freshCliNeverReady: () => true,
    isRemoteBackendType: () => false,
    backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    captureBackendScreen: () => readFileSync(join(process.cwd(), 'test/fixtures/startup-blockers/grok-1.0.67-folder-trust.txt'), 'utf8'),
    detectCliStartupBlocker, startupBlockerKey,
    startupBlocker: null, cliSpawnGeneration: 1,
    reportedUntrustedWorkspaces: new Set(opts.alreadyExplained ? ['/root/ec-apply-access'] : []),
    cliName: () => 'Grok', log: () => {},
    startupBlockerNotice: () => 'workspace needs trust', currentBotmuxTurnId: 'turn',
    send: (event: WorkerToDaemon) => messages.push(event),
    isWorkflowWorker: () => opts.workflow === true,
  };
  return { messages, probe: loadWorkerFunction<(source: string) => unknown>('probeStartupBlocker', scope) };
}

describe('worker startup blocker IPC', () => {
  it('publishes the matched blocker once per CLI generation as a structured notice', () => {
    const { probe, messages } = harness();
    probe('first-prompt');
    probe('ready-fallback');
    expect(messages).toEqual([expect.objectContaining({ type: 'user_notify', kind: 'cli_startup_blocked',
      message: 'workspace needs trust', startupBlocker: { kind: 'folder_trust', rule: 'grok-folder-trust' } })]);
  });

  it('still tells a workflow pool when the chat notice was already explained at spawn', () => {
    const { probe, messages } = harness({ workflow: true, alreadyExplained: true });
    probe('first-prompt');
    expect(messages).toEqual([expect.objectContaining({ kind: 'cli_startup_blocked',
      startupBlocker: { kind: 'folder_trust', rule: 'grok-folder-trust' } })]);
  });

  it('keeps an already-explained chat notice deduplicated', () => {
    const { probe, messages } = harness({ alreadyExplained: true });
    probe('first-prompt');
    expect(messages).toEqual([]);
  });
});
