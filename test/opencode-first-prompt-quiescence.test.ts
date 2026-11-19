import { describe, expect, it } from 'vitest';
import { createOpenCodeAdapter } from '../src/adapters/cli/opencode.js';
import { createOpenCode2Adapter } from '../src/adapters/cli/opencode2.js';

// OpenCode 没有可靠的 ready 提示符，worker 只能等输出静默后再贴第一条消息；
// 这个等待一旦被去掉，首条消息会在 TUI 还没就绪时贴进去而丢失。IdleDetector 只在首条静默窗口
// 长于它的默认静默窗口（src/utils/idle-detector.ts 的 QUIESCENCE_MS，2s）时才采用加长窗口，
// 不超过它就等于没有加长。
const DETECTOR_DEFAULT_QUIESCENCE_MS = 2_000;
describe('OpenCode first-prompt quiescence', () => {
  it.each([
    ['v1', createOpenCodeAdapter],
    ['v2', createOpenCode2Adapter],
  ])('%s adapter has no ready pattern, so it waits for output to go quiet before the first paste', (_label, create) => {
    const cli = create('/bin/true');
    expect(cli.readyPattern).toBeUndefined();
    expect(cli.firstPromptQuiescenceMs).toBeGreaterThan(DETECTOR_DEFAULT_QUIESCENCE_MS);
  });
});
