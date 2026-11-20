import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import type { CliId } from '../src/adapters/cli/types.js';
import { STRUCTURED_BRIDGE_ALWAYS_CLI_IDS } from '../src/services/structured-bridge-clis.js';
import { t } from '../src/i18n/index.js';
import { GOAL_ENV } from '../src/workflows/v3/contract.js';

// Adapters that inject the Botmux routing into their own system prompt (instead
// of the first-turn envelope) must build it from the replyDelivery the daemon
// froze for the session. One that ignores it would tell a transcript-default
// session to `botmux send` every answer while the daemon also forwards the
// final reply. Enumerated from the transcript-capable set, so a new adapter
// joining it is covered without editing this file.
describe('system-prompt adapters follow replyDelivery', () => {
  const workingDir = mkdtempSync(join(tmpdir(), 'botmux-transcript-prompt-'));
  afterAll(() => rmSync(workingDir, { recursive: true, force: true }));
  const transcriptIntro = t('ai.routing.intro_transcript', undefined, 'zh');
  const sendIntro = t('ai.routing.intro', undefined, 'zh');

  function systemPrompt(cliId: CliId, replyDelivery: 'send' | 'transcript'): string | undefined {
    const adapter = createCliAdapterSync(cliId, `/usr/bin/${cliId}`);
    if (!adapter.injectsSessionContext) return undefined;
    const env: Record<string, string> = {};
    const args = adapter.buildArgs({
      sessionId: '6f4a3c2e-1b2d-4e5f-8a9b-0c1d2e3f4a5b', resume: false, workingDir,
      botName: 'Bot', botOpenId: 'ou_bot', locale: 'zh', replyDelivery, env,
    });
    return [...args, env.BOTMUX_APPEND_SYSTEM_PROMPT ?? ''].join('\n');
  }

  it('rewords the routing for transcript and keeps the send wording otherwise', () => {
    const checked: string[] = [];
    for (const cliId of ['claude-code', ...STRUCTURED_BRIDGE_ALWAYS_CLI_IDS] as CliId[]) {
      const transcript = systemPrompt(cliId, 'transcript');
      if (transcript === undefined) continue;
      expect(transcript, cliId).toContain(transcriptIntro);
      expect(transcript, cliId).not.toContain(sendIntro);
      const send = systemPrompt(cliId, 'send')!;
      expect(send, cliId).toContain(sendIntro);
      expect(send, cliId).not.toContain(transcriptIntro);
      checked.push(cliId);
    }
    expect(checked).toEqual(expect.arrayContaining(['claude-code', 'pi', 'oh-my-pi', 'grok']));
  });

  it('keeps the send wording in v3 workflow nodes, whose results ride botmux send', () => {
    const previous = process.env[GOAL_ENV.V3_MARKER];
    process.env[GOAL_ENV.V3_MARKER] = '1';
    try {
      for (const cliId of ['claude-code', 'pi', 'oh-my-pi', 'grok'] as CliId[]) {
        const prompt = systemPrompt(cliId, 'transcript')!;
        expect(prompt, cliId).toContain(sendIntro);
        expect(prompt, cliId).not.toContain(transcriptIntro);
      }
    } finally {
      if (previous === undefined) delete process.env[GOAL_ENV.V3_MARKER];
      else process.env[GOAL_ENV.V3_MARKER] = previous;
    }
  });
});
