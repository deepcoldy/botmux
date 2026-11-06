import { describe, expect, it } from 'vitest';
import { runFeedbackHook } from '../src/services/feedback-hook-runner.js';
import { normalizeFeedbackHook } from '../src/services/feedback-hook-config.js';
import { tsEvalArgs } from './helpers/ts-runner.js';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const event = { schemaVersion: 1 as const, executionId: 'execution', eventId: 'event', idempotencyKey: 'key',
  type: 'action.requested' as const, bot: { appId: 'app' }, scope: { chatId: 'chat' }, action: { id: 'help' } };
function hook(script: string, timeoutMs = 1000) {
  const runner = tsEvalArgs(script);
  return normalizeFeedbackHook({
    id: 'hook', version: 1, protocolVersion: 1, hostId: 'host',
    command: [runner.command, ...runner.args], cwd: process.cwd(),
    allowedBotAppIds: ['app'], allowedChatIds: ['chat'], allowedActionIds: ['help'],
    timeoutMs, concurrency: 1, enabled: true, envRefs: {},
  });
}

describe('feedback hook execution', () => {
  it('delivers stdin as data and accepts an execution-bound receipt', async () => {
    const registration = hook(`let raw='';for await (const chunk of process.stdin) raw+=chunk;
      const input=JSON.parse(raw);process.stdout.write(JSON.stringify({schemaVersion:1,executionId:input.executionId,
      outcome:'succeeded',publicMessage:'done',receiptRefs:['message:example']}));`);
    expect(await runFeedbackHook({ hook: registration, event, hostId: 'host', env: {} }))
      .toMatchObject({ outcome: 'succeeded', receiptRefs: ['message:example'] });
  });
  it('never runs a disabled or scope-mismatched registration', async () => {
    const registration = hook('process.exit(99)');
    for (const changed of [{ ...registration, enabled: false }, { ...registration, allowedChatIds: ['other'] }]) {
      expect(await runFeedbackHook({ hook: changed, event, hostId: 'host', env: {} })).toMatchObject({ outcome: 'blocked' });
    }
  });
  it.each(['process.exit(1)', "process.stdout.write('invalid')", 'setInterval(()=>{},1000)'])('keeps post-spawn failure unknown: %s', async script => {
    expect(await runFeedbackHook({ hook: hook(script, 150), event, hostId: 'host', env: {} })).toMatchObject({ outcome: 'unknown' });
  });
  it('does not inherit ambient environment or accept a receipt for another execution', async () => {
    const script = `process.stdout.write(JSON.stringify({schemaVersion:1,executionId:'other',outcome:'succeeded',
      publicMessage:process.env.HOME||'clean',receiptRefs:['message:example']}))`;
    expect(await runFeedbackHook({ hook: hook(script), event, hostId: 'host', env: {} })).toMatchObject({ outcome: 'unknown' });
  });
  it('rejects invalid secret values before spawning and never reflects them in errors', async () => {
    for (const secret of ['bad\0value', 'secret'.repeat(40000)]) {
      const registration = { ...hook('process.exit(99)'), envRefs: { TOKEN: 'token' } };
      const outcome = await runFeedbackHook({ hook: registration, event, hostId: 'host', env: { TOKEN: secret } });
      expect(outcome.outcome).toBe('failed_before_effect');
      expect(JSON.stringify(outcome)).not.toContain(secret);
    }
  });
  it.skipIf(process.platform === 'win32')('terminates ordinary descendants when the hook times out', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hook-descendants-'));
    const marker = join(directory, 'late-effect');
    const script = `import {spawn} from 'node:child_process';
      spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),700)`)}],{stdio:'ignore'});
      setInterval(()=>{},1000);`;
    try {
      expect((await runFeedbackHook({ hook: hook(script, 150), event, hostId: 'host', env: {} })).outcome).toBe('unknown');
      await new Promise(resolve => setTimeout(resolve, 900));
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
