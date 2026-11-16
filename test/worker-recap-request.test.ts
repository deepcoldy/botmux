/**
 * The worker answers every「本轮回顾」model recap request exactly once: with
 * the recap, or with why there is none — the daemon logs the cost or reason.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { runRecapModel } from '../src/services/turn-recap-runner.js';

const ANSWER = readFileSync(resolve('test/fixtures/turn-recap/claude-p-recap.json'), 'utf8');

function worker(recapModelLaunch: unknown) {
  const sent: unknown[] = [];
  const scope: Record<string, unknown> = { recapModelLaunch, runRecapModel, send: (msg: unknown) => sent.push(msg) };
  const answer = loadWorkerFunction<(requestId: string, prompt: string) => Promise<void>>('answerRecapRequest', scope);
  return { sent, answer };
}

describe('worker recap_request', () => {
  it('answers with the recap and its cost', async () => {
    const run = worker({ bin: 'cat', args: [], env: process.env });
    await run.answer('req-1', ANSWER);
    expect(run.sent).toEqual([{
      type: 'recap_result', requestId: 'req-1',
      text: expect.stringMatching(/^PR #3489/), costUsd: 0.0014919, inputTokens: 10724, outputTokens: 839,
    }]);
  });

  it('answers with a reason when this CLI cannot make the call', async () => {
    const run = worker(undefined);
    await run.answer('req-2', 'prompt');
    expect(run.sent).toEqual([{ type: 'recap_result', requestId: 'req-2', error: 'unavailable for this CLI' }]);
  });

  it('answers with the CLI\'s own error', async () => {
    const error = readFileSync(resolve('test/fixtures/turn-recap/claude-p-model-error.json'), 'utf8');
    const run = worker({ bin: 'cat', args: [], env: process.env });
    await run.answer('req-3', error);
    expect(run.sent).toEqual([{ type: 'recap_result', requestId: 'req-3', error: expect.stringMatching(/^There's an issue/) }]);
  });
});
