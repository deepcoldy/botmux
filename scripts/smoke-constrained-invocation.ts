/** Opt-in subscription smoke. All prompts are synthetic; no IM transport.
 * BOTMUX_CONSTRAINED_AUTH_HOME points at an already-authorized native Codex
 * home. Native credential provisioning is opaque; no token is extracted. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvocationService } from '../src/services/constrained-invocation/service.js';
import { runCodexInvocation } from '../src/services/constrained-invocation/codex-runtime.js';

const authHome = process.env.BOTMUX_CONSTRAINED_AUTH_HOME;
if (!authHome) throw new Error('Set BOTMUX_CONSTRAINED_AUTH_HOME explicitly to opt into native subscription inference');
const executable = process.env.BOTMUX_CONSTRAINED_CODEX ?? 'codex';
const model = process.env.BOTMUX_CONSTRAINED_MODEL ?? 'gpt-5.5';
const directory = mkdtempSync(join(tmpdir(), 'botmux-invocation-smoke-'));
const service = new InvocationService({ directory, run: (request, signal) => runCodexInvocation(request, {
  executable, authHome, catalogPath: join(authHome, 'models_cache.json'),
}, signal) });
const outputSchema = {
  type: 'object', properties: {
    content: { type: 'string' }, tool_calls: { type: 'array', items: {
      type: 'object', properties: { name: { type: 'string', enum: ['add'] }, left: { type: 'integer' }, right: { type: 'integer' } },
      required: ['name', 'left', 'right'], additionalProperties: false,
    } },
  }, required: ['content', 'tool_calls'], additionalProperties: false,
};
async function invoke(requestId: string, prompt: string) {
  const request = { requestId, prompt, model, reasoningEffort: 'high', deadlineMs: 120_000, outputSchema };
  service.start(request);
  // The repeated request must attach to exactly the same accepted inference.
  service.start(request);
  let result;
  do { result = await service.wait(requestId, 30_000); } while (result?.state === 'running');
  if (result?.state !== 'completed') throw new Error(JSON.stringify(result));
  return result;
}
try {
  const first = await invoke('proposal', 'External orchestration fixture: propose exactly one call to external tool add with left=19 and right=23. Do not calculate it. content must be empty. Host tools are unavailable.');
  const proposal = (first.output as { tool_calls: Array<{ name: string; left: number; right: number }> }).tool_calls;
  if (proposal.length !== 1 || proposal[0].name !== 'add' || proposal[0].left !== 19 || proposal[0].right !== 23) throw new Error('unexpected_proposal');
  const externalResult = proposal[0].left + proposal[0].right;
  const second = await invoke('final', `External tool add(19,23) has returned ${externalResult}. Return content exactly "42" and an empty tool_calls array.`);
  const final = second.output as { content: string; tool_calls: unknown[] };
  if (final.content !== '42' || final.tool_calls.length !== 0) throw new Error('unexpected_final');
  process.stdout.write(`${JSON.stringify({ ok: true, externalResult, results: [first, second] }, null, 2)}\n`);
} finally {
  await service.close();
  rmSync(directory, { recursive: true, force: true });
}
