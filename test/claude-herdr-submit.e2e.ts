/** Opt-in real Claude + Herdr input regression; owns a dedicated test session. */
import { describe, expect, it } from 'vitest';
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { HerdrBackend } from '../src/adapters/backend/herdr-backend.js';
import { createClaudeCodeAdapter, claudeJsonlPathForSession } from '../src/adapters/cli/claude-code.js';
import { stripAnsiScreenText } from '../src/utils/idle-detector.js';
import { ensureClaudeFolderTrust } from '../src/core/worker-pool.js';
import { resolveCommand } from '../src/adapters/cli/registry.js';

function records(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((b: any) => typeof b?.text === 'string' ? b.text : textOf(b?.content)).join('\n') : '';
}
// Native Claude may wrap a bracketed paste in a generated attachment tag.
function queuedPayload(content: unknown): unknown {
  if (typeof content !== 'string') return content;
  const match = /^<pasted_content id="([^"]+)">\n([\s\S]*)\n<\/pasted_content id="\1">$/.exec(content);
  return match ? match[2] : content;
}
async function until(predicate: () => boolean, label: string, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error(`timeout: ${label}`);
}
describe.skipIf(process.env.BOTMUX_CLAUDE_HERDR_E2E !== '1')('real Claude Herdr multiline submission', () => {
  it('queues an exact multiline payload during Bash execution and answers both messages', async () => {
    const sid = randomUUID();
    const cwd = mkdtempSync('/tmp/bmx-submit-');
    ensureClaudeFolderTrust(cwd);
    const inherited = { ...process.env };
    for (const key of Object.keys(process.env)) if (key.startsWith('HERDR_') && key !== 'HERDR_BIN_PATH') delete process.env[key];
    process.env.XDG_CONFIG_HOME = cwd + '/xdg';
    process.env.HERDR_CONFIG_PATH = cwd + '/config.toml';
    writeFileSync(process.env.HERDR_CONFIG_PATH, '[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n');
    const backend = new HerdrBackend(`bmx-submit-${sid.slice(0, 8)}`);
    const env = { ...process.env };
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
    // Use this machine's native Claude login rather than inherited API routing.
    for (const key of Object.keys(env)) if (key.startsWith('ANTHROPIC_')) delete env[key];
    const output: string[] = []; backend.onData(data => output.push(data));
    backend.onExit((code, signal) => console.log('test CLI exit', code, signal));
    const testEnvFile = process.env.BOTMUX_CLAUDE_TEST_ENV_FILE;
    const providerEnv = testEnvFile ? JSON.parse(readFileSync(testEnvFile, 'utf8')) : {};
    Object.assign(env, providerEnv);
    const adapter = createClaudeCodeAdapter();
    backend.claudeJsonlPath = claudeJsonlPathForSession(sid, cwd);
    const events = () => records(backend.claudeJsonlPath!);
    // Claude folds a message queued during a tool call into the running turn
    // (queue-operation remove, reason absorbed_mid_turn) and answers it at the
    // model's discretion: given two competing "reply exactly X" asks it answers
    // only one. Keep the two asks compatible — the follow-up recalls a number
    // that only the first message carries.
    const secret = String(randomInt(1000, 10_000));
    const content = '<user_message>\n中文第一行，保持原文。\nsecond line with literal \\ backslash\nReply with RECALLED_ followed by the number I asked you to remember.\n</user_message>';
    try {
      backend.spawn(resolveCommand('claude'), ['--session-id', sid, '--model', process.env.BOTMUX_CLAUDE_TEST_MODEL ?? 'haiku', '--effort', 'low', '--dangerously-skip-permissions', '--settings', JSON.stringify({ disableAllHooks: true, skipDangerousModePermissionPrompt: true, env: providerEnv })], { cwd, cols: 160, rows: 50, env: env as Record<string, string> });
      await until(() => /─+\r?\n❯/.test(stripAnsiScreenText(backend.captureCurrentScreen())), 'Claude ready');
      console.log('test ready', backend.captureCurrentScreen());
      const first = await adapter.writeInput(backend, `Remember the number ${secret} for later. Run Bash with exactly this command: python3 -c "import time; print('BUSY_BEGIN', flush=True); time.sleep(12)".`);
      if (first?.submitted === false && first.recheck) await until(() => first.recheck!() === true, 'first delayed receipt', 20_000);
      else expect(first?.submitted).not.toBe(false);
      await until(() => events().some(e => e.type === 'assistant' && e.message?.content?.some((b: any) => b.type === 'tool_use' && b.name === 'Bash')), 'Bash execution began');
      const next = await adapter.writeInput(backend, content);
      expect(next?.submitted).not.toBe(false);
      await until(() => events().some(e => e.type === 'queue-operation' && e.operation === 'enqueue' && queuedPayload(e.content) === content), 'exact type-ahead enqueue');
      const recalled = new RegExp(`RECALLED_\\s*${secret}\\b`);
      await until(() => events().some(e => e.type === 'assistant' && e.message?.content?.some((b: any) => b.type === 'text' && recalled.test(b.text))), 'queued message answered with the remembered number');
      expect(events().some(e => e.type === 'user' && e.message?.content?.some?.((b: any) => b.type === 'tool_result' && textOf(b.content).includes('BUSY_BEGIN')))).toBe(true);
      const queued = events().filter(e => e.type === 'queue-operation' && e.operation === 'enqueue' && queuedPayload(e.content) === content);
      expect(queued).toHaveLength(1);
      const absorbedMidTurn = events().some(e => e.type === 'queue-operation' && e.operation === 'remove' && e.reason === 'absorbed_mid_turn' && queuedPayload(e.content) === content);
      console.log(JSON.stringify({ sid, transcript: backend.claudeJsonlPath, queued: queued.length, exactMultiline: true, absorbedMidTurn, recalled: true }));
    } catch (error) {
      console.error('test final', backend.captureCurrentScreen(), 'output', output.join('').slice(-6000)); throw error;
    } finally { backend.destroySession();
      for (const key of Object.keys(process.env)) if (!(key in inherited)) delete process.env[key];
      Object.assign(process.env, inherited);
    }
  }, 180_000);
});
