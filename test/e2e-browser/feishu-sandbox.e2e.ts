/**
 * File sandbox in a real Feishu private chat: the ClaudeSandbox bot runs
 * Claude Code with `sandbox: true` (oncall). One probe asks the mock LLM to
 * report, from inside the session's shell, what the sandbox lets it see
 * (test/helpers/mock-llm-server/sandbox-probe.ts). The reply line is matched
 * exactly; the host side is checked here too, so a check cannot pass because
 * its target was missing: the canary and both secret files exist on the host,
 * the outside write never reached it, and the working-directory write did.
 *
 * Mock LLM only: a real model would not run the probe's fixed shell checks.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, beforeAll, afterAll } from './midscene-suite.js';
import {
  SANDBOX_PROBE_EXPECTED,
  SANDBOX_PROBE_TOKEN,
  sandboxCanaryDir,
  sandboxSecretPaths,
} from '../helpers/mock-llm-server/sandbox-probe.js';
import {
  mockLlmEnabled,
  openChat,
  openThreadForMessage,
  recordTextEvidence,
  reopenTopic,
  sendMessage,
  waitForReplyLine,
} from './helpers.js';
import { openFeishuSession, releaseFeishuSession, type FeishuSession } from './feishu-session.js';

export const SANDBOX_BOT = 'ClaudeSandbox';

function sandboxProbeMessage(): { tag: string; message: string } {
  const tag = `e2e-sbx-${Date.now()}`;
  return {
    tag,
    message:
      `${tag} ${SANDBOX_PROBE_TOKEN} 请立刻调用 botmux send 在本话题里回复一行内容：` +
      `"ACK-${tag} SBX <沙盒检查结果>"。做完这一步就结束本轮工作。`,
  };
}

/** The sandboxed bot's working directory, as scripts/run-e2e.ts left it in the bots config. */
function sandboxWorkingDir(): string {
  const { bots } = sandboxSecretPaths();
  const config = JSON.parse(readFileSync(bots, 'utf8')) as Array<{ name?: string; workingDir?: string }>;
  const dir = config.find((bot) => bot.name === SANDBOX_BOT)?.workingDir;
  if (!dir) throw new Error(`${bots} has no ${SANDBOX_BOT} bot with a workingDir`);
  return path.resolve(dir);
}

/** The probe's actual reply line, for a failure message that says which check broke. */
async function actualProbeLine(session: FeishuSession, tag: string): Promise<string> {
  const text = await session.page.locator('body').innerText().catch(() => '');
  return text.split('\n').find((line) => line.startsWith(`ACK-${tag} SBX pid1=`)) ?? '(no probe reply on the page)';
}

export function registerMidsceneSuites(): void {
  describe('sandbox file isolation', () => {
    let session: FeishuSession | undefined;
    const canary = sandboxCanaryDir();

    beforeAll(async () => {
      if (!mockLlmEnabled()) throw new Error('The sandbox case needs BOTMUX_MOCK_LLM=1: the probe is answered by the mock LLM');
      mkdirSync(canary, { recursive: true });
      writeFileSync(path.join(canary, 'secret.txt'), `canary-${Date.now()}\n`);
      session = await openFeishuSession((page, agent) => openChat(page, agent, SANDBOX_BOT));
    }, 180_000);

    afterAll(async () => {
      // Runs even when beforeAll or the case failed, so the host canary dir
      // (secret.txt plus any blocked-write attempt) never accumulates.
      rmSync(canary, { recursive: true, force: true });
      await releaseFeishuSession(session ?? {}, { closeBotSession: true, publishVideo: true });
    });

    it('hides the home directory and the harness secrets and keeps writes inside the working directory', async () => {
      const live = session!;
      const { bots, state } = sandboxSecretPaths();
      // Each HIDDEN below means something only because the file is there.
      for (const file of [path.join(canary, 'secret.txt'), bots, state]) {
        if (!existsSync(file)) throw new Error(`Host file ${file} is missing, so the sandbox check on it would prove nothing`);
      }
      const workingDir = sandboxWorkingDir();
      const { tag, message } = sandboxProbeMessage();

      await sendMessage(live.agent, message, live.page);
      await openThreadForMessage(live.agent, { timeoutMs: 120_000, msgHint: message, page: live.page });
      const expected = `ACK-${tag} SBX ${SANDBOX_PROBE_EXPECTED}`;
      try {
        await waitForReplyLine(live.page, expected, { agent: live.agent, reopen: reopenTopic(live.agent, live.page, message) });
      } catch (error) {
        throw new Error(`${(error as Error).message}\nSandbox probe replied: ${await actualProbeLine(live, tag)}`);
      }
      await recordTextEvidence(live.agent, live.page, expected, 'Sandbox probe reply');

      const outside = path.join(canary, `w-${tag}`);
      const inside = path.join(workingDir, `sbx-${tag}`);
      try {
        if (existsSync(outside)) throw new Error(`The sandboxed shell wrote ${outside} on the host`);
        if (!existsSync(inside)) throw new Error(`The sandboxed shell's write to its working directory did not reach ${inside}`);
      } finally {
        rmSync(outside, { force: true });
        rmSync(inside, { force: true });
      }
    }, 900_000);
  });
}
