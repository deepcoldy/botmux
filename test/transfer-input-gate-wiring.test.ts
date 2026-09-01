import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';

const daemonSource = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
const workerPoolSource = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');
const dashboardSource = readFileSync(
  new URL('../src/core/dashboard-ipc-server.ts', import.meta.url),
  'utf8',
);
const cardHandlerSource = readFileSync(
  new URL('../src/im/lark/card-handler.ts', import.meta.url),
  'utf8',
);

describe('transfer input gate wiring', () => {
  it('routes literal passthrough and pending raw input through the gate', () => {
    const passthroughStart = daemonSource.indexOf('function deliverPassthroughToExistingSession(');
    const passthroughEnd = daemonSource.indexOf('async function startInitialPassthroughSession(', passthroughStart);
    const passthrough = daemonSource.slice(passthroughStart, passthroughEnd);
    expect(passthrough).toContain('sendWorkerSessionInput(ds, {');
    expect(passthrough).toContain("type: 'raw_input'");
    expect(passthrough).not.toContain("ds.worker.send({\n      type: 'raw_input'");

    const promptReadyStart = workerPoolSource.indexOf("case 'prompt_ready':");
    const promptReadyEnd = workerPoolSource.indexOf("case 'runner_build_ready':", promptReadyStart);
    const promptReady = workerPoolSource.slice(promptReadyStart, promptReadyEnd);
    expect(promptReady).toContain('sendWorkerSessionInput(ds, {');
    expect(promptReady).toContain("type: 'raw_input'");
  });

  it('routes dashboard and card input controls through the same gate', () => {
    expect(dashboardSource).toContain(
      "sendWorkerSessionInput(ds, { type: 'inject_command', command: v.command })",
    );
    expect(daemonSource).toContain('sendWorkerSessionInput(cocoDs, {');
    expect(cardHandlerSource).toContain(
      "sendWorkerSessionInput(ds, { type: 'term_action', key })",
    );
    expect(cardHandlerSource).toContain(
      "sendWorkerSessionInput(ds, { type: 'refresh_screen' })",
    );
    expect(cardHandlerSource).toContain(
      "sendWorkerSessionInput(ds, { type: 'set_display_mode', mode: next })",
    );
  });
});
