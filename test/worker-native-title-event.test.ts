/** Exercise the real worker title-sync function without launching its IPC runtime. */
import { describe, expect, it, vi } from 'vitest';
import { buildBotmuxLarkNativeSessionTitle } from '../src/core/session-title.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

/** Inject only external title generation and application into the production function. */
function harness(semanticCore: string | undefined) {
  const send = vi.fn();
  const generate = vi.fn(async () => semanticCore);
  const apply = vi.fn(async () => true);
  const scope: Record<string, unknown> = {
    lastInitConfig: { cliId: 'codex', nativeSessionTitle: '[BotMux·Lark] 原始标题', nativeSessionTitlePrompt: '原始标题', model: 'configured-model' },
    nativeSessionTitleAppliedThreadId: undefined,
    nativeSessionTitleSyncInFlight: undefined,
    nativeSessionTitleRevision: 1,
    nativeSessionTitleCurrentGenerationResume: false,
    nativeSessionTitleSyncAbortControllers: new Set(),
    applyCodexNativeSessionTitle: apply,
    generateCodexAppThreadTitle: generate,
    buildBotmuxLarkNativeSessionTitle,
    codexNativeTitleEnv: () => ({}),
    createCliAdapterSync: () => ({ resolvedBin: 'codex' }),
    registerNativeTitleForceClose: vi.fn(),
    log: vi.fn(), send,
  };
  const sync = loadWorkerFunction<(threadId: string) => Promise<void>>('syncFreshCodexNativeSessionTitle', scope);
  return { sync, send, generate, apply };
}

describe('native semantic title notifications', () => {
  it.each(['原始标题', '模型生成的新标题'])('publishes successful generation even when the title is unchanged: %s', async core => {
    const h = harness(core);
    await h.sync('thread-id');
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.generate).toHaveBeenCalledWith(expect.objectContaining({ model: 'configured-model' }));
    expect(h.send).toHaveBeenCalledExactlyOnceWith({ type: 'native_session_title_generated', title: `[BotMux·Lark] ${core}` });
  });
  it('does not publish the fallback as a generated title when generation fails', async () => {
    const h = harness(undefined);
    await h.sync('thread-id');
    expect(h.send).not.toHaveBeenCalled();
    expect(h.apply).toHaveBeenCalledTimes(1);
  });
});
