import { describe, expect, it } from 'vitest';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { traexRestoredComposerReady } from '../src/adapters/cli/traex-footer.js';
import { shouldFenceTraexStartupInput } from '../src/core/traex-startup-input.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function launchMode(options: {
  requestedResume?: boolean;
  actualResume: boolean;
  id?: string;
  persistent?: boolean;
  adopt?: boolean;
  remote?: boolean;
  programStatus?: boolean;
}) {
  const adapter = createTraexAdapter('/bin/true');
  const scope = {
    cliAdapter: adapter,
    programStatusStream: options.programStatus === false ? null : {},
    remoteWsUrl: options.remote ? 'ws://fixture-only' : undefined,
    shouldFenceTraexStartupInput,
    traexRestoredComposerReady,
    traexNativeStartupInputPending: false,
    traexFirstInputAdmissionPending: false,
  };
  const apply = loadWorkerFunction<(cfg: unknown, launch: unknown) => void>(
    'applyTraexStartupLaunchMode', scope,
  );
  apply({ cliId: 'traex', resume: options.requestedResume, adoptMode: options.adopt }, {
    resume: options.actualResume,
    nativeSessionId: options.id,
    persistentReattach: options.persistent ?? false,
  });
  return { scope, adapter };
}

describe('resolved TraeX startup launch mode', () => {
  it('fences a requested resume that actually falls back to fresh', () => {
    const { scope, adapter } = launchMode({ requestedResume: true, actualResume: false });
    expect(scope.traexNativeStartupInputPending).toBe(true);
    expect(scope.traexFirstInputAdmissionPending).toBe(true);
    expect(scope.cliAdapter).toBe(adapter);
  });

  it('declares the missing-ID fresh behavior used by the real adapter', () => {
    const { scope, adapter } = launchMode({ requestedResume: true, actualResume: false });
    expect(adapter.resumeRequiresCliSessionId).toBe(true);
    const args = adapter.buildArgs({
      sessionId: 'fixture-no-native-id', resume: true, resumeSessionId: '',
    });
    expect(args).not.toContain('resume');
    expect(scope.traexFirstInputAdmissionPending).toBe(true);
  });

  it('fences a genuine exact resume like a fresh launch and keeps its restored-screen recognizer', () => {
    // A cold resume paints the same provisional composer before its thread
    // can submit (recorded on 0.216.0), so its first input is fenced too.
    const { scope, adapter } = launchMode({
      requestedResume: true, actualResume: true, id: '00000000-0000-4000-8000-000000000009',
    });
    expect(scope.traexNativeStartupInputPending).toBe(true);
    expect(scope.traexFirstInputAdmissionPending).toBe(true);
    expect(scope.cliAdapter.startupReadyFromHistory).not.toBe(adapter.startupReadyFromHistory);
  });

  it.each([
    { persistent: true },
    { adopt: true },
    { remote: true },
    { programStatus: false },
  ])('preserves existing non-fresh-fence contracts: %j', extra => {
    const { scope } = launchMode({ actualResume: false, ...extra });
    expect(scope.traexNativeStartupInputPending).toBe(false);
    expect(scope.traexFirstInputAdmissionPending).toBe(false);
  });

  // 源码结构护栏(K3)：合并曾删掉 spawn 前的首轮输入闸初始化，导致 TRAE 首条输入可能丢失；此处只守初始化顺序，不断言实现文本块全文。
  it('keeps the early startup input fence initialized before backend launch setup', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const spawn = source.indexOf('async function spawnCliBody');
    const capability = source.indexOf('cliAdapter.supportsProgramStatus', spawn);
    const initialization = source.indexOf('traexNativeStartupInputPending = shouldFenceTraexStartupInput({', capability);
    const launchSetup = source.indexOf('const cardActionCapabilities', capability);
    expect(spawn).toBeGreaterThanOrEqual(0);
    expect(capability).toBeGreaterThan(spawn);
    expect(initialization).toBeGreaterThan(capability);
    expect(launchSetup).toBeGreaterThan(initialization);
  });
});
