#!/usr/bin/env tsx
import { MockLlmServer, type MockServerMode } from '../test/helpers/mock-llm-server/index.js';

const args = process.argv.slice(2);

function getArgValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const port = Number(getArgValue('--port') ?? process.env.MOCK_PORT ?? '9999');
const mode = (getArgValue('--mode') ?? process.env.MOCK_MODE ?? 'synthetic') as MockServerMode;
const upstreamUrl = getArgValue('--upstream') ?? process.env.UPSTREAM_URL;
const fixturesDir = getArgValue('--fixtures-dir') ?? process.env.FIXTURES_DIR;

console.log(`[mock-llm-server] Starting server on port=${port}, mode=${mode}...`);

const server = new MockLlmServer({
  port,
  mode,
  upstreamUrl,
  fixturesDir,
  verbose: true,
});

const { baseUrl } = await server.start();
console.log(`[mock-llm-server] ✅ Ready at ${baseUrl}`);
console.log(`[mock-llm-server] To route Claude Code through this mock server, set:`);
console.log(`  export ANTHROPIC_BASE_URL=${baseUrl}`);
console.log(`  export ANTHROPIC_API_KEY=mock-key`);
console.log(`[mock-llm-server] Press Ctrl+C to stop.`);

const shutdown = async () => {
  console.log('\n[mock-llm-server] Stopping server...');
  await server.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
