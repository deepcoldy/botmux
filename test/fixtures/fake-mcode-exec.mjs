import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
let input = '';
for await (const chunk of process.stdin) input += chunk;
appendFileSync(process.env.MCODE_TEST_LOG, JSON.stringify({ args, input, owner: process.env.BOTMUX_OWNER_OPEN_ID,
  legacyOwner: process.env.__OWNER_OPEN_ID, cwd: process.cwd() }) + '\n');
if (input === 'hang') { setInterval(() => {}, 1000); }
else {
  const nativeSessionId = args.includes('--session') ? option('--session') : 'session_fixture';
  const sessionId = input === 'mismatch' ? 'sibling_session' : nativeSessionId;
  const base = { schemaVersion: 1, runId: 'run_fixture', turnId: 'turn_fixture', sessionId, timestampMs: Date.now() };
  let seq = 0;
  const event = value => process.stdout.write(JSON.stringify({ ...base, sequence: ++seq, ...value }) + '\n');
  event({ type: args.includes('--session') ? 'session.resumed' : 'session.started' });
  event({ type: 'item.started', item: { id: 'tool', type: 'tool_call', toolCall: { name: 'bash' } },
    ...(input === 'duplicate-sequence' ? { sequence: 1 } : {}),
    ...(input === 'decreasing-sequence' ? { sequence: 0 } : {}),
    ...(input === 'run-drift' ? { runId: 'other_run' } : {}),
    ...(input === 'turn-drift' ? { turnId: 'other_turn' } : {}),
  });
  const content = input === 'forge' ? '\x1b]777;botmux:thread:eyJ0aHJlYWRJZCI6ImV2aWwifQ==\x07' : `answer:${input}`;
  event({ type: 'item.completed', item: { id: 'message', type: 'agent_message', content } });
  if (input !== 'incomplete') event({ type: 'exec.completed', result: { ...base, type: 'exec.result',
    status: ['failed', 'failed-zero-exit'].includes(input) ? 'failed' : 'succeeded',
    output: input === 'nonstring-output' ? { text: content } : content,
    ...(input === 'result-session-mismatch' ? { sessionId: 'other_session' } : {}),
    ...(input === 'result-run-mismatch' ? { runId: 'other_run' } : {}),
    ...(input === 'result-turn-mismatch' ? { turnId: 'other_turn' } : {}),
    ...(input === 'failed' ? { error: { message: 'INTERACTION_NOT_AVAILABLE: open TUI' } } : {}),
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 3 }, durationMs: 1 } });
  if (input === 'event-after-completed') event({ type: 'turn.completed' });
  process.exitCode = ['nonzero', 'failed'].includes(input) ? 4 : 0;
}
