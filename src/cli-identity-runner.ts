import { parseArgs } from 'node:util';
import { resolveCurrentExecutionIdentity } from './cli/current-execution.js';

// Governed tools plus the Codebase CLI companion that mirrors bytedcli's
// identity; kept in sync with CODEBASE_COMPANION_TOOL in core/cli-identity.ts
// (a compile-entry test pins the runner wiring end to end).
const IDENTITY_TOOLS = ['lark-cli', 'bytedcli', 'codebase'] as const;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '__cli-identity-runner') args.shift();
  const { values } = parseArgs({ args, options: {
    'data-dir': { type: 'string' }, 'session-id': { type: 'string' },
    'app-id': { type: 'string' }, 'ipc-port': { type: 'string' }, tool: { type: 'string' },
  } });
  const tool = values.tool;
  if (!values['session-id'] || !values['app-id']
    || !(IDENTITY_TOOLS as readonly string[]).includes(tool ?? '')) {
    throw new Error('Invalid managed CLI identity invocation');
  }
  const execution = await resolveCurrentExecutionIdentity({
    ipcPort: Number(values['ipc-port']), sessionId: values['session-id'], larkAppId: values['app-id'],
    tool: tool!,
  });
  // The daemon proved the caller's lineage and returns the identity env
  // ASSIGNMENTS themselves. Print only the body for the wrapper to eval; the
  // body never names a disk path, so nothing in the session can redirect it.
  process.stdout.write(execution.env);
}

await main().catch(error => {
  process.stderr.write(`botmux: ${error instanceof Error ? error.message : 'current_execution_unverified'}\n`);
  process.exitCode = 77;
});
