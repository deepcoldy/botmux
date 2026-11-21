import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { waitForJsonFile } from './helpers/wait-for-json-file.js';
import { t } from '../src/i18n/index.js';

const WORKER_RESULT_WAIT_MS = 60_000;

// A real worker builds the system prompt from the replyDelivery the daemon froze
// into init, and freezes the same value into the CLI env: `botmux send` reads it
// to word its post-send hint (transcript: "the final reply is forwarded, no
// progress sends needed"; otherwise the send-mode wording). An init without the
// field is send — the daemon always resolves the per-CLI default before init.
it.each(['transcript', 'send', undefined] as const)('a real worker carries replyDelivery=%s into the system prompt and the CLI env', async replyDelivery => {
  const root = mkdtempSync(join(tmpdir(), 'worker-reply-delivery-'));
  const dataDir = join(root, 'data'); mkdirSync(dataDir);
  const output = join(root, 'prompt-result.json');
  const fakeCli = join(root, 'fake-pi');
  writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({prompt:process.env.BOTMUX_APPEND_SYSTEM_PROMPT,snapshot:process.env.BOTMUX_REPLY_DELIVERY ?? null}));
process.stdout.write('Ready\\n');
setInterval(()=>{},1000);
`, { mode: 0o755 });
  const env = { ...process.env, HOME: root, USERPROFILE: root, BOTMUX_HOME: join(root, '.botmux'),
    SESSION_DATA_DIR: dataDir, PATH: process.env.PATH, BOTMUX_NO_CLAIM: '1' };
  // An inherited value must never leak into the pane: the worker always sets it.
  (env as Record<string, string | undefined>).BOTMUX_REPLY_DELIVERY = 'stale-inherited';
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], { env, cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = ''; child.stdout?.on('data', b => logs += b); child.stderr?.on('data', b => logs += b);
  const exit = new Promise(resolveExit => child.once('exit', resolveExit));
  try {
    child.send!({ type: 'init', sessionId: randomUUID(), chatId: 'oc_test', rootMessageId: 'om_root',
      workingDir: dataDir, cliId: 'pi', cliPathOverride: fakeCli, backendType: 'pty', prompt: '',
      larkAppId: 'cli_current_app', larkAppSecret: 'test-only-secret', locale: 'zh',
      ...(replyDelivery ? { replyDelivery } : {}) });
    // 不能只等 existsSync：fake CLI 的 writeFileSync 在 truncate 后、内容写完前
    // 文件就已存在，立刻 readFileSync 会读到空/截断内容、JSON.parse 抛 EOF（#3692）。
    // waitForJsonFile 会对空读/半截内容重试，直到能完整解析；子进程退出则提前失败。
    let result: { prompt: string; snapshot: unknown };
    try {
      result = await waitForJsonFile<{ prompt: string; snapshot: unknown }>(output, {
        timeoutMs: WORKER_RESULT_WAIT_MS,
        shouldStop: () => child.exitCode !== null,
      });
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- worker logs ---\n${logs}`);
    }
    const { prompt, snapshot } = result;
    expect(prompt).toContain('<botmux_routing>');
    const transcriptIntro = t('ai.routing.intro_transcript', undefined, 'zh');
    if (replyDelivery === 'transcript') {
      expect(prompt).toContain(transcriptIntro);
      expect(snapshot).toBe('transcript');
    } else {
      expect(prompt).not.toContain(transcriptIntro);
      expect(prompt).toContain(t('ai.routing.intro', undefined, 'zh'));
      expect(snapshot).toBe('send');
    }
  } finally {
    if (child.connected) child.send!({ type: 'close' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exit; clearTimeout(timer); rmSync(root, { recursive: true, force: true });
  }
}, WORKER_RESULT_WAIT_MS + 15_000);
