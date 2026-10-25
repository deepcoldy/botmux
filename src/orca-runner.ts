import { createInterface } from 'node:readline';
import { z } from 'zod';
import { OrcaRuntimeClient, orcaUserDataPath } from './services/orca-runtime-client.js';
import { OrcaRunner } from './services/orca-runner.js';
import { REMOTE_RUNNER_PROTOCOL, REMOTE_RUNNER_PROTOCOL_VERSION, MAX_REMOTE_RUNNER_LINE_BYTES } from './adapters/backend/remote-runner-protocol.js';
import type { RemoteRunnerCommand } from './adapters/backend/remote-runner-protocol.js';

const base = z.object({
  protocol: z.literal(REMOTE_RUNNER_PROTOCOL), version: z.literal(REMOTE_RUNNER_PROTOCOL_VERSION),
  requestId: z.string().min(1).max(512),
});
const session = { sessionId: z.string().min(1).max(512), cwd: z.string().min(1),
  model: z.string().optional(), reasoningEffort: z.string().optional() };
const commandSchema = z.discriminatedUnion('type', [
  base.extend({ type: z.literal('hello'), sessionId: z.string(), requiredCapabilities: z.array(z.string()) }),
  base.extend({ type: z.literal('start'), ...session }),
  base.extend({ type: z.literal('resume'), ...session, state: z.object({
    version: z.literal(1), provider: z.string(), generation: z.number().int().positive(),
    remoteSessionId: z.string().optional(), agentThreadId: z.string().optional(), providerState: z.record(z.unknown()).optional(),
  }), resumeMode: z.enum(['reattach', 'rebuild']).optional() }),
  base.extend({ type: z.literal('turn'), turnId: z.string().min(1), content: z.string(), dispatchAttempt: z.number().int().optional() }),
  base.extend({ type: z.literal('outbound_message_result'), operationId: z.string(), turnId: z.string(),
    generation: z.number().int().positive(), result: z.discriminatedUnion('outcome', [
      z.object({ outcome: z.literal('delivered'), messageId: z.string() }),
      z.object({ outcome: z.literal('rejected'), code: z.string(), message: z.string() }),
      z.object({ outcome: z.literal('unknown'), code: z.string(), message: z.string() }),
    ]) }),
  ...(['cancel', 'detach', 'reattach', 'status'] as const).map(type => base.extend({ type: z.literal(type) })),
]);

async function main(): Promise<void> {
  const agent = process.argv.at(-1);
  if (agent !== 'codex' && agent !== 'claude') throw new Error('Orca runner requires codex or claude');
  if (!process.env.SESSION_DATA_DIR) throw new Error('SESSION_DATA_DIR is required');
  const profile = orcaUserDataPath();
  const runner = new OrcaRunner({ agent, profile, dataDir: process.env.SESSION_DATA_DIR,
    runtime: new OrcaRuntimeClient(profile),
    emit: event => process.stdout.write(JSON.stringify({ protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION, ...event }) + '\n'),
  });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const shutdown = () => {
    input.close();
    void runner.dispose().then(() => process.exit(0), exitWithError);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > MAX_REMOTE_RUNNER_LINE_BYTES) throw new Error('Orca input exceeds protocol limit');
      const command = commandSchema.parse(JSON.parse(line)) as RemoteRunnerCommand;
      await runner.handle(command);
    }
  } finally { await runner.dispose(); }
}

function exitWithError(error: unknown): void {
  process.stderr.write(String(error instanceof Error ? error.message : error) + '\n', () => process.exit(1));
}

// Bun's compiled CLI graph can retain handles after readline closes. This entry
// owns only the bridge; disposal releases its lock without terminating the Orca Agent.
main().then(() => process.exit(0), exitWithError);
