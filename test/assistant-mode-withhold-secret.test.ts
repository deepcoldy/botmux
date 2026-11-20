/**
 * Personal-assistant mode always withholds the bot's app secret from the
 * sandbox (sandboxWithholdBotSecret): the parsed bot config carries the flag
 * and the per-session decision honours it, so send / history / quoted go
 * through the host relay.
 *
 * Run: npx vitest run --project unit test/assistant-mode-withhold-secret.test.ts
 */
// Must stay the first import: this file fakes node:fs.
import './helpers/require-fenced-data-dir.js';
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  return { ...orig, existsSync: vi.fn(() => false), readFileSync: vi.fn(() => ''), statSync: vi.fn(() => ({ mtimeMs: 0 })) };
});

import { sandboxWithholdsBotSecret } from '../src/adapters/cli/sandbox-mode.js';

async function parse(entry: Record<string, unknown>) {
  vi.resetModules();
  const mod = await import('../src/bot-registry.js');
  return mod.parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'app_assist_001', larkAppSecret: 'secret', cliId: 'claude-code', ...entry }]))[0]!;
}

describe('assistantMode implies sandboxWithholdBotSecret', () => {
  it('parsed config carries the flag when assistantMode is on, not otherwise', async () => {
    expect((await parse({ sandbox: true, assistantMode: true })).sandboxWithholdBotSecret).toBe(true);
    expect((await parse({ sandbox: true })).sandboxWithholdBotSecret).toBeUndefined();
  });

  it('per-session decision is on for an assistant-mode oncall bot even without the explicit flag', () => {
    expect(sandboxWithholdsBotSecret({ sandbox: true, assistantMode: true }, undefined)).toBe(true);
    expect(sandboxWithholdsBotSecret({ sandbox: 'oncall', assistantMode: true }, undefined)).toBe(true);
    // still only for the allowlist sandbox
    expect(sandboxWithholdsBotSecret({ sandbox: 'scratch', assistantMode: true }, undefined)).toBe(false);
    expect(sandboxWithholdsBotSecret({ sandbox: true }, undefined)).toBe(false);
  });
});
