import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

describe('TRAE worker structured-bridge wiring', () => {
  it('dispatches TRAE rollouts to the dedicated task_complete reader', () => {
    const start = workerSource.indexOf('function structuredBridgeIngestPath');
    const end = workerSource.indexOf('\n}\n', start);
    const body = workerSource.slice(start, end);

    expect(body).toContain('if (structuredBridgeIsCodex()) return drainCodexRollout(path, offset);');
    expect(body).toContain('if (structuredBridgeIsTraex()) return drainTraexRollout(path, offset);');
  });

  it('drains the retired rollout before reattaching a newly verified TRAE session', () => {
    const start = workerSource.indexOf('function codexBridgeNotifyCliSessionId');
    const end = workerSource.indexOf('function maybeFollowGrokSessionRotationViaPid', start);
    const notify = workerSource.slice(start, end);
    const traexStart = notify.indexOf('if (structuredBridgeIsTraex())');
    const traexEnd = notify.indexOf('// Grok', traexStart);
    const traex = notify.slice(traexStart, traexEnd);

    expect(traexStart).toBeGreaterThanOrEqual(0);
    expect(traex).toContain("resolveFileBridgePath('traex', { sessionId: cliSessionId })");
    expect(traex.indexOf('codexBridgeIngest();')).toBeLessThan(traex.indexOf('codexBridgeDetachFile();'));
    expect(traex.indexOf('codexBridgeDetachFile();')).toBeLessThan(traex.indexOf("codexBridgeAttach(next, 'fresh-empty');"));
    expect(traex).toContain('codexBridgePendingSessionId = cliSessionId;');
  });

  it('follows the adopted TRAE pid so direct local /new rotation is observable', () => {
    expect(workerSource).toContain('maybeFollowTraexSessionRotationViaPid();');
    const start = workerSource.indexOf('function maybeFollowTraexSessionRotationViaPid');
    const end = workerSource.indexOf('\n}\n', start);
    const follower = workerSource.slice(start, end);

    expect(follower).toContain('findTraexRolloutByPid(pid)');
    expect(follower).toContain('persistCliSessionId(observed.cliSessionId);');
    expect(follower).toContain('codexBridgeNotifyCliSessionId(observed.cliSessionId);');
  });
});
