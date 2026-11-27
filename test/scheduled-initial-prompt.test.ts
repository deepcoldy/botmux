import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPiAdapter } from '../src/adapters/cli/pi.js';
import { createOpenCodeAdapter } from '../src/adapters/cli/opencode.js';
import { createCursorAdapter } from '../src/adapters/cli/cursor.js';
import { createMtrAdapter } from '../src/adapters/cli/mtr.js';
import { createGrokAdapter } from '../src/adapters/cli/grok.js';
import { PI_INITIAL_PROMPT_COMMAND } from '../src/adapters/cli/pi-initial-prompt-extension.js';
import { shouldQueueInitialPrompt } from '../src/codex-rpc-lifecycle.js';
import { resolveInitialPromptDelivery, shouldDeferScheduledInitialPrompt } from '../src/utils/pending-input-queue.js';

const turnId = 'schedule:abcdef12:00000000-0000-4000-8000-000000000001';
const adapters = [
  ['Pi', createPiAdapter('/bin/pi')],
  ['OpenCode', createOpenCodeAdapter('/bin/opencode')],
  ['Cursor', createCursorAdapter('/bin/cursor')],
  ['MTR', createMtrAdapter('/bin/mtr')],
  ['Grok', createGrokAdapter('/bin/grok')],
] as const;

describe('scheduled first-prompt submission', () => {
  it.each(adapters)('routes the %s first prompt through the host admission queue', (_name, adapter) => {
    const prompt = 'check the current deployment status';
    const defer = shouldDeferScheduledInitialPrompt({ turnId });
    const delivery = resolveInitialPromptDelivery({ originalPrompt: prompt, defer });
    const args = adapter.buildArgs({ sessionId: 'scheduled-first', resume: false, initialPrompt: delivery.argvPrompt });

    expect(adapter.passesInitialPromptViaArgs).toBe(true);
    expect(args).not.toContain(prompt);
    expect(delivery.queuedContent).toBe(prompt);
    expect(shouldQueueInitialPrompt({ hasPrompt: true, rpcEngineActive: false, queuePrompt: false,
      passesInitialPromptViaArgs: adapter.passesInitialPromptViaArgs === true, deferInitialPrompt: defer })).toBe(true);
  });

  it('keeps transformed Pi delivery and logical text while deferring a long scheduled prompt', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'scheduled-pi-prompt-'));
    try {
      const adapter = createPiAdapter('/bin/pi');
      const prompt = 'inspect the current state\n'.repeat(1_000);
      const prepared = adapter.prepareInitialPromptArg!({ initialPrompt: prompt, sessionId: 'scheduled-pi', sessionDataDir: dataDir });
      const delivery = resolveInitialPromptDelivery({ originalPrompt: prompt, preparedArg: prepared.initialPrompt,
        preparedDeferredContent: prepared.deferredInput?.content, defer: shouldDeferScheduledInitialPrompt({ turnId }) });
      const args = adapter.buildArgs({ sessionId: 'scheduled-pi', resume: false, initialPrompt: delivery.argvPrompt });

      expect(delivery.queuedContent).toBe(PI_INITIAL_PROMPT_COMMAND);
      expect(delivery.logicalContent).toBe(prompt);
      expect(args).not.toContain(prompt);
      expect(args).not.toContain(prepared.initialPrompt);
      expect(prepared.deferredInput?.additionalArgs?.length).toBeGreaterThan(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.each([undefined, 'om_human', 'schedule:invalid'])('keeps ordinary initial prompt behavior for %s', turnId => {
    expect(shouldDeferScheduledInitialPrompt({ turnId })).toBe(false);
  });

  it('leaves an adopted process alone and avoids repeating an RPC-accepted first prompt', () => {
    expect(shouldDeferScheduledInitialPrompt({ turnId, adoptMode: true })).toBe(false);
    expect(shouldQueueInitialPrompt({ hasPrompt: true, rpcEngineActive: true, queuePrompt: false,
      passesInitialPromptViaArgs: false, deferInitialPrompt: true })).toBe(false);
  });
});
