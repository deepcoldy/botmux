import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseBotConfigsFromText } from '../src/bot-registry.js';
import { createMinimaxAdapter } from '../src/adapters/cli/minimax.js';
import { cliModelSupportsReasoningEffort, reasoningEffortsForCliModel } from '../src/services/codex-reasoning-effort.js';
import { spawnTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';

const supportedModels = ['MiniMax-M3.1-Flash', 'minimax/MiniMax-M3.1-Flash',
  'MiniMax-M3.1-Flash#thinking', 'minimax/MiniMax-M3.1-Flash#thinking'];
const unsupportedModels = [undefined, '', 'minimax/MiniMax-M3', 'MiniMax-M3.1-Flash-Preview',
  'other/MiniMax-M3.1-Flash', 'minimax/another-m3.1-flash-model',
  'minimax/MiniMax-M3.1-Flash#none-thinking', 'm:minimax:MiniMax-M3.1-Flash:v:thinking'];
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function config(model: string | undefined, reasoningEffort: string) {
  return parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'effort-test', larkAppSecret: 'test',
    cliId: 'minimax', model, reasoningEffort }]))[0];
}

describe('MiniMax model-aware effort configuration', () => {
  it.each(supportedModels)('retains supported levels for the launchable model %s', model => {
    expect(reasoningEffortsForCliModel('minimax', model)).toEqual(efforts);
    for (const effort of efforts) expect(config(model, effort).reasoningEffort).toBe(effort);
    expect(cliModelSupportsReasoningEffort('minimax', model, 'ultra')).toBe(false);
    expect(config(model, 'ultra').reasoningEffort).toBeUndefined();
  });

  it.each(unsupportedModels)('does not infer model capabilities for %s', model => {
    expect(reasoningEffortsForCliModel('minimax', model)).toEqual([]);
    expect(config(model, 'xhigh').reasoningEffort).toBeUndefined();
  });

  it('takes the saved bot effort through adapter, runner and ACP on new and resumed turns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-minimax-effort-')); roots.push(root);
    const executable = join(root, 'mcode');
    const runtime = tsRunnerPrefix();
    const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    writeFileSync(executable, `#!/bin/sh\nexec ${[runtime.command, resolve('test/fixtures/fake-minimax-effort-acp.mjs')].map(quote).join(' ')} "$@"\n`, { mode: 0o700 });
    const bot = config('minimax/MiniMax-M3.1-Flash', 'xhigh');
    const args = createMinimaxAdapter(executable).buildArgs({ sessionId: 'effort-test', resume: false,
      workingDir: root, model: bot.model, reasoningEffort: bot.reasoningEffort,
      env: { MINIMAX_DATA_DIR: join(root, 'data') } });
    const child = spawnTsScript(resolve('src/minimax-runner.ts'), args.slice(1),
      { env: { ...process.env, MINIMAX_DATA_DIR: join(root, 'data') } });
    const closed = new Promise<void>(done => child.once('close', () => done()));
    let output = '';
    let errors = '';
    const finals = new Promise<Array<{ content: string; turnId: string; errorCode?: string }>>((done, reject) => {
      const timeout = setTimeout(() => reject(new Error(`effort runner timed out: ${errors}\n${output}`)), 10_000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('close', () => { clearTimeout(timeout); reject(new Error(`effort runner exited: ${errors}\n${output}`)); });
      child.stderr!.on('data', chunk => { errors += chunk.toString(); });
      child.stdout!.on('data', chunk => {
        output += chunk.toString();
        const messages = [...output.matchAll(/\x1b\]777;botmux:final:([A-Za-z0-9+/=]+)\x07/g)]
          .map(m => JSON.parse(Buffer.from(m[1], 'base64').toString()));
        if (messages.length === 2) { clearTimeout(timeout); done(messages); }
      });
    });
    try {
      for (const turnId of ['new', 'resumed']) child.stdin!.write(`::botmux-minimax:${Buffer.from(JSON.stringify({
        type: 'message', content: 'report configured effort', replyTurnId: turnId,
      })).toString('base64')}\n`);
      expect(await finals).toEqual(['new', 'resumed'].map(turnId => expect.objectContaining({
        turnId, content: 'effort-session:m:minimax:MiniMax-M3.1-Flash:v:thinking:xhigh',
      })));
      expect(errors).toBe('');
    } finally { child.kill('SIGTERM'); await closed; }
  });
});
